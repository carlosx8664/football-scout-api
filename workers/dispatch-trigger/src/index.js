/**
 * Reliable 15-minute trigger for the odds refresh.
 *
 * GitHub's own `schedule` is best-effort and was running hours late on this repo, so a
 * Cloudflare Cron Trigger dispatches the workflow instead. All scraping still happens on
 * GitHub runners, which are known to reach the bookmakers.
 *
 * Secrets:
 *   GH_DISPATCH_TOKEN  fine-grained PAT, "Actions: Read and write" on the repo
 *   TRIGGER_KEY        optional shared secret for the manual HTTP endpoint
 */

const REPO = "carlosx8664/football-scout-api";
const WORKFLOW = "odds-refresh.yml";
const REF = "main";
// Must match the second entry in wrangler.jsonc `triggers.crons`.
const HORIZON_CRON = "0 */3 * * *";

/**
 * `mode=hot` refreshes the 2-day feed every 15 minutes; `mode=horizon` rebuilds the 6-day
 * feed with a single market pass every 3 hours. They write different KV keys, so neither
 * can overwrite the other.
 */
async function dispatch(env, mode = "hot") {
  if (!env.GH_DISPATCH_TOKEN) {
    throw new Error("GH_DISPATCH_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "oddtor-dispatch-trigger",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REF, inputs: { mode } }),
    },
  );

  // GitHub answers 204 No Content on success.
  if (response.status !== 204) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`GitHub dispatch failed (HTTP ${response.status}): ${detail}`);
  }

  console.log(`Dispatched ${WORKFLOW} (${mode}) on ${REF}`);
}

export default {
  async scheduled(controller, env, ctx) {
    const mode = controller.cron === HORIZON_CRON ? "horizon" : "hot";

    // waitUntil keeps the invocation alive until the dispatch settles. Errors are logged
    // rather than thrown so a transient GitHub hiccup does not surface as a Worker crash.
    ctx.waitUntil(
      dispatch(env, mode).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Scheduled ${mode} dispatch failed: ${message}`);
      }),
    );
  },

  /**
   * Manual trigger for testing: POST /?key=<TRIGGER_KEY>[&mode=horizon]
   * Returns 403 when TRIGGER_KEY is configured and does not match.
   */
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("POST to trigger the odds refresh.\n", { status: 405 });
    }

    const url = new URL(request.url);

    if (env.TRIGGER_KEY) {
      const key = url.searchParams.get("key");
      if (key !== env.TRIGGER_KEY) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const mode = url.searchParams.get("mode") === "horizon" ? "horizon" : "hot";

    try {
      await dispatch(env, mode);
      return Response.json({ dispatched: true, workflow: WORKFLOW, ref: REF, mode });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      return Response.json({ error: message }, { status: 502 });
    }
  },
};

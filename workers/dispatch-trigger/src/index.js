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

async function dispatch(env) {
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
      body: JSON.stringify({ ref: REF }),
    },
  );

  // GitHub answers 204 No Content on success.
  if (response.status !== 204) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`GitHub dispatch failed (HTTP ${response.status}): ${detail}`);
  }

  console.log(`Dispatched ${WORKFLOW} on ${REF}`);
}

export default {
  async scheduled(_controller, env, ctx) {
    // waitUntil keeps the invocation alive until the dispatch settles. Errors are logged
    // rather than thrown so a transient GitHub hiccup does not surface as a Worker crash.
    ctx.waitUntil(
      dispatch(env).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Scheduled dispatch failed: ${message}`);
      }),
    );
  },

  /**
   * Manual trigger for testing: POST /?key=<TRIGGER_KEY>
   * Returns 403 when TRIGGER_KEY is configured and does not match.
   */
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("POST to trigger the odds refresh.\n", { status: 405 });
    }

    if (env.TRIGGER_KEY) {
      const key = new URL(request.url).searchParams.get("key");
      if (key !== env.TRIGGER_KEY) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    try {
      await dispatch(env);
      return Response.json({ dispatched: true, workflow: WORKFLOW, ref: REF });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      return Response.json({ error: message }, { status: 502 });
    }
  },
};

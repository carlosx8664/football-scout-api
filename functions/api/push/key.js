/**
 * GET /api/push/key
 *
 * Hands the browser the VAPID public key it needs to create a push subscription.
 * Served from the environment rather than baked into the bundle so rotating the
 * keypair only means updating one Pages variable.
 */
export async function onRequestGet({ env }) {
  const publicKey = env?.VAPID_PUBLIC_KEY;

  if (!publicKey) {
    return Response.json(
      { error: "VAPID_PUBLIC_KEY is not configured on this deployment." },
      { status: 503 },
    );
  }

  return Response.json(
    { publicKey },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}

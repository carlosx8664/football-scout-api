// scripts/generate-vapid-keys.js
// Prints a fresh VAPID keypair for Web Push.
//
//   npm run push:keys
//
// Where the two halves go:
//   VAPID_PUBLIC_KEY   Cloudflare Pages variable (browser fetches it via /api/push/key)
//                      AND a GitHub secret (the sender signs with the pair).
//   VAPID_PRIVATE_KEY  GitHub secret only. Never commit it or expose it to the client.
//   VAPID_SUBJECT      GitHub secret, either "mailto:you@example.com" or your site URL.
//
// Rotating the pair invalidates every existing subscription; users have to press
// "Allow alerts" again.

import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log('Add these to the repo secrets (Settings -> Secrets and variables -> Actions):\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
console.log(
  '\nAlso set VAPID_PUBLIC_KEY as a Pages variable so /api/push/key can serve it:\n' +
    '  npx wrangler pages secret put VAPID_PUBLIC_KEY\n',
);

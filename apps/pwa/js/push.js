// push.js — Web Push seam. When the app is closed, the homeserver's push
// gateway (operator-run) wakes the service worker; the notification carries
// NO content (privacy: ciphertext or nothing), just a nudge to sync.
export async function enablePush(vapidPublicKey, onReady) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8(vapidPublicKey),
  });
  // The subscription (endpoint + keys) is registered as a pusher on the
  // homeserver by app.js via POST /_matrix/client/v3/pushers/set
  if (onReady) onReady(sub);
  return sub;
}

function urlB64ToUint8(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

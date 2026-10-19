# Android shell

The Android app is the PWA inside a Capacitor (Apache-2.0) WebView shell —
one codebase, no parallel native UI to drift.

Build:

```sh
sh apps/pwa/build.sh          # vendor matrix-lite into the PWA
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap add android
npx cap sync
npx cap open android          # Android Studio: build APK/AAB
```

Notes:

- The whole app shell is precached by the service worker, so the WebView
  opens fully offline; IndexedDB (events, outbox, media blobs) persists
  natively in the WebView.
- Minimum SDK 24 (Android 7) — covers the low-end devices that dominate
  Nigerian clinics.
- Keep `allowMixedContent: false` — TLS everywhere, even on clinic LANs
  (the relay can terminate its own CA; see SECURITY.md).
- Push notifications: FCM is optional and degradable. With no Google Play
  services (common), the sync loop's long-poll already covers foreground
  delivery; background polling is a phase-2 WorkManager task.

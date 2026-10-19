# iOS shell

Same PWA, Capacitor (Apache-2.0) WKWebView shell.

Build:

```sh
sh apps/pwa/build.sh
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap add ios
npx cap sync
npx cap open ios              # Xcode: archive
```

Notes:

- WKWebView gives IndexedDB + service-worker-grade caching offline.
- Background delivery on iOS is best-effort by platform design; the pull
  sync model means nothing is lost — messages land on next open, and the
  clinic side always sees delivery state from the homeserver.
- App Store review: the app is a patient client for an operator-run
  homeserver; no third-party accounts, no tracking, no attestation issues.

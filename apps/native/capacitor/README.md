# gamez: iOS and Android shell (Capacitor)

A thin native wrapper around the web client. It is **not** a pnpm workspace package: nothing here
is installed by `vp install`, and CI does not build it. Install and run it by hand, as below.
Background and store checklists: [`docs/ship.md`](../../../docs/ship.md).

Two modes:

| Mode        | What the app loads                                        | Works offline?                           | Needs               |
| ----------- | --------------------------------------------------------- | ---------------------------------------- | ------------------- |
| **bundled** | the built client copied into the app (`webDir`)           | the shell and single-player classic, yes | nothing             |
| **live**    | the hosted game (`server.url`, set with `GAMEZ_LIVE_URL`) | no (it is a webview on the live site)    | the production host |

Bundled mode has no API origin: the client builds `/api` and `/ws` URLs from `location.origin`,
which is `capacitor://localhost` in the app. Accounts, the bank, market, shops and arena need
**live** mode. Ship store builds in live mode unless the bundle is tested end to end.

## 0. Prerequisites

- Node 22.18 or newer.
- iOS: a Mac with Xcode (current), CocoaPods, an Apple Developer account for devices and TestFlight.
- Android: Android Studio with an SDK, a JDK that Capacitor 7 supports (17 or 21).

Versions in `package.json` are the Capacitor 7 major (`^7.0.0`). They were **not** checked against
the registry when this folder was written. Run `npm view @capacitor/core version` and pick the
current major before the first `npm install`.

## 1. Install (once)

```sh
cd apps/native/capacitor
npm install
```

## 2. Build the web client

Run from the repository root. `webDir` points at the client output:

```sh
node_modules/.bin/vp -C apps/game build
# output: apps/game/.cloudflare/output/v0/workers/default/assets  (index.html, assets/, art/, icons/, manifest, sw.js)
```

Note: the native shell does not need the service worker. Capacitor serves the bundle itself. The
worker is registered only on production builds on a real host (`src/client/pwa/registration.ts`),
so it stays inactive inside the app's `capacitor://localhost` origin.

## 3. Add the native projects (once)

```sh
npx cap add ios        # creates ios/ (commit it if you customise it)
npx cap add android    # creates android/
```

## 4. Sync after every web build

```sh
npx cap sync           # copies webDir into ios/ and android/, and updates plugins
```

## 5. Run

```sh
npx cap open ios       # Xcode: pick a simulator or device, then Run
npx cap open android   # Android Studio: Run
npx cap run android    # or run from the terminal with a connected device or emulator
```

## 6. Live mode (hosted game in the webview)

```sh
GAMEZ_LIVE_URL=https://<production-host> npx cap sync
```

The config adds `server.url`, so the webview opens the hosted game. Remove the variable and sync
again to go back to bundled mode. For local testing against the Vite dev server, use the same
variable with the dev URL (for example `http://<your-machine>.ts.net:5173`). Cleartext is allowed
only for `http://` URLs. On iOS, the dev URL needs an App Transport Security exception in
`Info.plist`. Do not ship it.

## 7. Deep links for sign-in and payment returns

The web client expects the return fragments the Worker sends (`session.ts`):

- OAuth: `…/#auth=<token>` on success and `…/#auth_error=<code>` on failure.
- Payments (planned, T-pay in `docs/design/wave-C.md` §8): `…/#store=<orderId>`.

On a phone the provider's page opens in the system browser. It returns to the app through a link
that the OS hands to the app:

1. **Custom scheme** (simple): register `dev.gamez.app` in iOS URL Types (`Info.plist`,
   `CFBundleURLTypes`) and in Android (`android/app/src/main/AndroidManifest.xml`, an intent filter
   with `android:scheme="dev.gamez.app"`). A return looks like `dev.gamez.app://callback#auth=…`.
2. **Universal and App Links** (preferred, for production): serve
   `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` from the production
   host, then add the associated domain to each platform. Links then open the app directly.

The app receives the URL through `@capacitor/app` (`appUrlOpen`) and hands the fragment to the
webview. This glue is **not in the repo yet**. A minimal version looks like this (for a later
change in `apps/game/src/client`, not here):

```ts
import { App } from "@capacitor/app";

App.addListener("appUrlOpen", ({ url }) => {
  const returned = new URL(url);
  // Keep only the fragment (#auth=… or #store=…) and load the game with it.
  if (returned.hash) window.location.replace(`${GAME_URL}${returned.hash}`);
});
```

`GAME_URL` is the live origin. Bundled mode cannot finish a sign-in, so use live mode for accounts.

## 8. Store notes (read before submitting)

- **Sign in with Apple.** The App Store requires it when another third-party social login is
  offered. Wave C keeps Sign in with Apple as a stub (docs/secrets.md). Make it real before any
  iOS submission that offers Google or Discord sign-in.
- **In-app purchase.** Digital goods bought inside the iOS or Android app must use the platform
  billing (StoreKit, Google Play Billing). Web checkout (Stripe, Asaas, Mercado Pago) cannot sell
  them in the app. The planned route is RevenueCat, which is **documented only** in wave C. Until
  it exists, hide the store and any web checkout in native builds. Do not link out to purchase.
- **Privacy and permissions.** The shell asks for no permissions (no camera, location, contacts or
  photos). Declare the data the game collects (account email, gameplay, purchases) in the App
  Privacy and Data Safety forms. See `docs/ship.md`.

## 9. Troubleshooting

- A blank page in bundled mode: run `vp -C apps/game build` again, then `npx cap sync`.
- "API unreachable" or sign-in errors in bundled mode: expected. Use live mode.
- Changes are not visible: `npx cap sync` after every build, and reload the app.

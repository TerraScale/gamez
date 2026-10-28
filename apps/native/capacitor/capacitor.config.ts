/**
 * Capacitor config for the gamez iOS and Android shells (see README.md in this folder).
 *
 * Bundled mode (default): the web client built by `vp -C apps/game build` is copied into the
 * native app. Single-player classic works offline, but there is no API origin in the bundle, so
 * anything that calls /api or /ws (accounts, bank, market, arena) needs live mode.
 *
 * Live mode: set GAMEZ_LIVE_URL (for example https://your-host) before `cap sync`. The webview then
 * loads the hosted game, and the API calls go to that origin.
 *
 * Untyped on purpose: this project has no installed dependencies in the repo, so `@capacitor/cli`
 * types are not resolvable during `vp check`. The Capacitor CLI accepts an untyped default export.
 */
interface ProcessLike {
  env?: Record<string, string | undefined>;
}

const processLike = (globalThis as { process?: ProcessLike }).process;
const liveUrl = processLike?.env?.GAMEZ_LIVE_URL?.trim() || undefined;

const config = {
  appId: "dev.gamez.app",
  appName: "gamez",
  // Relative to this folder: the client output of `vp -C apps/game build`.
  webDir: "../../game/.cloudflare/output/v0/workers/default/assets",
  ...(liveUrl ? { server: { url: liveUrl, cleartext: liveUrl.startsWith("http://") } } : {}),
  ios: { backgroundColor: "#10131a" },
  android: { backgroundColor: "#10131a" },
};

export default config;

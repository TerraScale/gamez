import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

// Test servers (tools/e2e, tools/loadtest, QA) set these so they never share Durable
// Object / D1 SQLite files or the dep-optimizer cache with the live dev server (:5173).
// Unset (the normal `vp dev`), the defaults apply: .cloudflare/state and node_modules/.vite.
const persistPath = process.env.GAMEZ_PERSIST_STATE;
const cacheDir = process.env.GAMEZ_VITE_CACHE_DIR;

export default defineConfig({
  plugins: [cloudflare(persistPath ? { persistState: { path: persistPath } } : {})],
  ...(cacheDir ? { cacheDir } : {}),
  // Dev server is shared on the tailnet (MagicDNS names end in .ts.net).
  server: { host: "0.0.0.0", allowedHosts: [".ts.net"] },
});

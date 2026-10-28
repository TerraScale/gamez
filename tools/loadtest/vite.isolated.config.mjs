/**
 * Vite config for the swarm's private dev server: the game app as-is, but with
 * its own Durable Object / D1 state directory (GAMEZ_LOADTEST_STATE), so a load
 * test never shares SQLite files with the user's live dev server (:5173) or the
 * e2e servers, which all persist into apps/game/.cloudflare/state.
 */
import { fileURLToPath } from "node:url";
// Resolved through the game app's own dependency (tools/loadtest adds no dependencies).
import { cloudflare } from "../../apps/game/node_modules/@cloudflare/vite-plugin/dist/index.mjs";

const root = fileURLToPath(new URL("../../apps/game/", import.meta.url));
const state = process.env.GAMEZ_LOADTEST_STATE ?? "/tmp/gamez-loadtest-state";

export default {
  root,
  plugins: [cloudflare({ persistState: { path: state } })],
  server: { host: "127.0.0.1" },
};

/**
 * Dev-only Vite config for the arena screens (not used by apps/game): serves
 * the replay and the screen with local fixtures, for screenshots. Port 5186
 * (never 5173, the user's dev server). Run from the repo root:
 *   node_modules/.bin/vp dev --config modules/arena/dev/vite.config.ts
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root: here,
  server: {
    port: 5186,
    strictPort: true,
    fs: { allow: [repo] },
  },
});

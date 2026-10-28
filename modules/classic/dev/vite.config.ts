/**
 * Dev-only Vite config for the classic client harness (not used by apps/game).
 * Serves the Kenney art from apps/game/public as the public directory.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root: here,
  publicDir: fileURLToPath(new URL("../../../apps/game/public", import.meta.url)),
  server: {
    port: 5180,
    strictPort: true,
    fs: { allow: [repo] },
  },
});

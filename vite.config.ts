import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
    tasks: {
      // Talk to a live dev server, so a cached result would be a lie.
      e2e: { command: "node tools/e2e/src/e2e.ts", cache: false },
      "migrate-local": { command: "node tools/e2e/src/migrate-local.ts", cache: false },
    },
  },
});

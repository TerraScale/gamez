import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        // Determinism guard for sim code (kernel and module sim/data/setup):
        // use ctx.rng and ctx.tick/ctx.timeMs instead. Client/UI code is exempt.
        files: ["packages/kernel/src/**", "modules/*/src/**"],
        excludeFiles: ["modules/*/src/client/**", "**/*.tsx"],
        rules: {
          "no-restricted-globals": [
            "error",
            ...["Date", "performance", "crypto"].map((name) => ({
              name,
              message: "Not deterministic in sim code: use ctx.tick / ctx.timeMs / ctx.rng.",
            })),
            ...[
              "setTimeout",
              "setInterval",
              "setImmediate",
              "requestAnimationFrame",
              "queueMicrotask",
            ].map((name) => ({
              name,
              message: "No timers in sim code: systems run on ticks and actions.",
            })),
          ],
          "no-restricted-properties": [
            "error",
            {
              object: "Math",
              property: "random",
              message: "Not deterministic in sim code: use ctx.rng.",
            },
            {
              object: "globalThis",
              property: "Date",
              message: "Not deterministic in sim code: use ctx.tick.",
            },
            {
              object: "globalThis",
              property: "performance",
              message: "Not deterministic in sim code.",
            },
            { object: "globalThis", property: "setTimeout", message: "No timers in sim code." },
            { object: "globalThis", property: "setInterval", message: "No timers in sim code." },
          ],
        },
      },
    ],
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

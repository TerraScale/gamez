import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/server/index.ts" with { type: "cf-worker" };

const WORKER = "gamez";

export default defineConfig({
  worker: {
    name: WORKER,
    compatibilityDate: "2026-10-19",
    entrypoint,
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/ws"],
    },
    exports: {
      RelayDO: exports.durableObject({ storage: "sqlite" }),
      ChunkDO: exports.durableObject({ storage: "sqlite" }),
      CharacterDO: exports.durableObject({ storage: "sqlite" }),
    },
    triggers: [triggers.queue({ name: "gamez-sync", maxBatchSize: 100, maxBatchTimeout: 1 })],
    env: {
      ASSETS: bindings.assets(),
      RELAY: bindings.durableObject({ worker: WORKER, exportName: "RelayDO" }),
      CHUNK: bindings.durableObject({ worker: WORKER, exportName: "ChunkDO" }),
      CHARACTER: bindings.durableObject({ worker: WORKER, exportName: "CharacterDO" }),
      DB: bindings.d1({ name: "gamez-read" }),
      SYNC_QUEUE: bindings.queue({ name: "gamez-sync" }),
      AUTH_SECRET: bindings.secret(),
    },
  },
});

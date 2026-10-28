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
      runWorkerFirst: ["/api/*", "/ws", "/ws/*"],
    },
    exports: {
      RelayDO: exports.durableObject({ storage: "sqlite" }),
      ChunkDO: exports.durableObject({ storage: "sqlite" }),
      CharacterDO: exports.durableObject({ storage: "sqlite" }),
      InstanceDO: exports.durableObject({ storage: "sqlite" }),
    },
    triggers: [
      triggers.queue({
        name: "gamez-sync",
        maxBatchSize: 100,
        maxBatchTimeout: 1,
        maxRetries: 10,
        deadLetterQueue: "gamez-sync-dlq",
      }),
    ],
    env: {
      ASSETS: bindings.assets(),
      RELAY: bindings.durableObject({ worker: WORKER, exportName: "RelayDO" }),
      CHUNK: bindings.durableObject({ worker: WORKER, exportName: "ChunkDO" }),
      CHARACTER: bindings.durableObject({ worker: WORKER, exportName: "CharacterDO" }),
      INSTANCE: bindings.durableObject({ worker: WORKER, exportName: "InstanceDO" }),
      DB: bindings.d1({ name: "gamez-read" }),
      SYNC_QUEUE: bindings.queue({ name: "gamez-sync" }),
      AUTH_SECRET: bindings.secret(),
    },
  },
});

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
      // wave B (docs/design/wave-B.md)
      AccountDO: exports.durableObject({ storage: "sqlite" }),
      IdentityDO: exports.durableObject({ storage: "sqlite" }),
      ChatChannelDO: exports.durableObject({ storage: "sqlite" }),
      GuildDO: exports.durableObject({ storage: "sqlite" }),
      // wave C (docs/design/wave-C.md)
      EscrowDO: exports.durableObject({ storage: "sqlite" }),
      MarketDO: exports.durableObject({ storage: "sqlite" }),
      PlotAuctionDO: exports.durableObject({ storage: "sqlite" }),
      ShopDO: exports.durableObject({ storage: "sqlite" }),
      ArenaDO: exports.durableObject({ storage: "sqlite" }),
      ConfigDO: exports.durableObject({ storage: "sqlite" }),
      // admin dashboard (docs/design/admin-dashboard.md): local analytics stub
      MetricsDO: exports.durableObject({ storage: "sqlite" }),
    },
    triggers: [
      // 4 x (FLUSH_BATCH 200 + 1) <= 1000, the paid plan's D1 queries per invocation.
      // The consumer also enforces SYNC_STATEMENT_BUDGET (sync-consumer.ts). Free plan: see docs/deploy.md.
      triggers.queue({
        name: "gamez-sync",
        maxBatchSize: 4,
        maxBatchTimeout: 1,
        maxRetries: 10,
        // Default delay for a retried message. The consumer sets a per-message backoff.
        retryDelay: 10,
        deadLetterQueue: "gamez-sync-dlq",
      }),
      // Drains dead-lettered batches. Re-applying is idempotent (version-guarded).
      // It has no DLQ of its own, so after 100 retries a message is dropped.
      triggers.queue({
        name: "gamez-sync-dlq",
        maxBatchSize: 4,
        maxRetries: 100,
        retryDelay: 900,
      }),
    ],
    env: {
      ASSETS: bindings.assets(),
      RELAY: bindings.durableObject({ worker: WORKER, exportName: "RelayDO" }),
      CHUNK: bindings.durableObject({ worker: WORKER, exportName: "ChunkDO" }),
      CHARACTER: bindings.durableObject({ worker: WORKER, exportName: "CharacterDO" }),
      INSTANCE: bindings.durableObject({ worker: WORKER, exportName: "InstanceDO" }),
      ACCOUNT: bindings.durableObject({ worker: WORKER, exportName: "AccountDO" }),
      IDENTITY: bindings.durableObject({ worker: WORKER, exportName: "IdentityDO" }),
      CHAT: bindings.durableObject({ worker: WORKER, exportName: "ChatChannelDO" }),
      GUILD: bindings.durableObject({ worker: WORKER, exportName: "GuildDO" }),
      ESCROW: bindings.durableObject({ worker: WORKER, exportName: "EscrowDO" }),
      MARKET: bindings.durableObject({ worker: WORKER, exportName: "MarketDO" }),
      PLOTS: bindings.durableObject({ worker: WORKER, exportName: "PlotAuctionDO" }),
      SHOP: bindings.durableObject({ worker: WORKER, exportName: "ShopDO" }),
      ARENA: bindings.durableObject({ worker: WORKER, exportName: "ArenaDO" }),
      CONFIG: bindings.durableObject({ worker: WORKER, exportName: "ConfigDO" }),
      METRICS: bindings.durableObject({ worker: WORKER, exportName: "MetricsDO" }),
      ANALYTICS: bindings.analyticsEngineDataset({ name: "gamez_events" }),
      DB: bindings.d1({ name: "gamez-read" }),
      SYNC_QUEUE: bindings.queue({ name: "gamez-sync" }),
      AUTH_SECRET: bindings.secret(),
    },
  },
});

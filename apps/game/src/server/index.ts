import type { Env } from "./contracts.ts";
import { analyticsFor } from "./analytics/index.ts";
import { recordRequest } from "./analytics/http.ts";
import { recordSyncMessage } from "./analytics/sync.ts";
import { consumeSyncBatch, defaultSyncDeps } from "./sync-consumer.ts";
import { connectInstance, INSTANCE_PATH } from "./instance/route.ts";
import { ROUTES } from "./routes/index.ts";
import type { ReplicationBatch } from "@gamez/sync";

export { RelayDO } from "./do/relay.ts";
export { ChunkDO } from "./do/chunk.ts";
export { CharacterDO } from "./do/character.ts";
export { InstanceDO } from "./do/instance.ts";
// wave B (docs/design/wave-B.md)
export { AccountDO } from "./do/account.ts";
export { IdentityDO } from "./do/identity.ts";
export { ChatChannelDO } from "./do/chat.ts";
export { GuildDO } from "./do/guild.ts";
// wave C (docs/design/wave-C.md)
export { EscrowDO } from "./do/escrow.ts";
export { MarketDO } from "./do/market.ts";
export { PlotAuctionDO } from "./do/plots.ts";
export { ShopDO } from "./do/shop.ts";
export { ArenaDO } from "./do/arena.ts";
export { ConfigDO } from "./do/config.ts";
// admin dashboard (docs/design/admin-dashboard.md)
export { MetricsDO } from "./do/metrics.ts";

/** The Worker's routing, without instrumentation. */
async function handle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/api/health") return Response.json({ ok: true });
  if (url.pathname === INSTANCE_PATH) return connectInstance(request, env, url);
  for (const route of ROUTES) {
    const res = await route({ request, env, url, ctx });
    if (res) return res;
  }
  if (url.pathname.startsWith("/api/")) {
    return Response.json(
      { error: { code: "not_found", message: "no such endpoint" } },
      { status: 404 },
    );
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const analytics = analyticsFor(env, (p) => ctx.waitUntil(p));
    const started = Date.now();
    let response: Response | null = null;
    try {
      response = await handle(request, env, ctx, url);
      return response;
    } finally {
      // A thrown handler is recorded as a 500 and the error still propagates.
      recordRequest(analytics, request, url, response, Date.now() - started);
      ctx.waitUntil(analytics.flush());
    }
  },

  /**
   * Sync consumer: each message is one ReplicationBatch from a DO outbox (see
   * sync-consumer.ts: backoff, statement budget, DLQ). Main-queue outcomes are
   * recorded for the admin dashboard (analytics/sync.ts).
   */
  async queue(batch, env, ctx) {
    const analytics = analyticsFor(env, (p) => ctx.waitUntil(p));
    try {
      await consumeSyncBatch(batch, env, {
        ...defaultSyncDeps,
        record: (sample) => recordSyncMessage(analytics, sample),
      });
    } finally {
      ctx.waitUntil(analytics.flush());
    }
  },
} satisfies ExportedHandler<Env, ReplicationBatch>;

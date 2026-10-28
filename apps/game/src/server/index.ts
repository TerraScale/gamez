import { applyBatch, type ReplicationBatch } from "@gamez/sync";
import type { Env } from "./contracts.ts";
import { projections } from "./projections.ts";
import { connectInstance, INSTANCE_PATH } from "./instance/route.ts";
import { ROUTES } from "./routes/index.ts";

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
  },

  /** Sync consumer: each message is one ReplicationBatch from a DO outbox. */
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const res = await applyBatch(env.DB, msg.body, projections);
        if (res.unknown > 0) console.warn("sync: records without projection", msg.body.source, res);
        msg.ack();
      } catch (err) {
        console.error("sync: apply failed", msg.body.source, err);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, ReplicationBatch>;

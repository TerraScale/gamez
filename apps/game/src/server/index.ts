import type { Env } from "./contracts.ts";
import { consumeSyncBatch } from "./sync-consumer.ts";
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

  /** Sync consumer: each message is one ReplicationBatch from a DO outbox (see sync-consumer.ts). */
  async queue(batch, env) {
    await consumeSyncBatch(batch, env);
  },
} satisfies ExportedHandler<Env, ReplicationBatch>;

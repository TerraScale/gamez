import { applyBatch, type ReplicationBatch } from "@gamez/sync";
import { newGuest, signToken, verifyToken } from "./auth.ts";
import { RELAY_HEADERS, type Env } from "./contracts.ts";
import { projections } from "./projections.ts";
import { relayLocation } from "./routing.ts";
import { CLOSE_UNAUTHORIZED } from "../shared/codec.ts";

export { RelayDO } from "./do/relay.ts";
export { ChunkDO } from "./do/chunk.ts";
export { CharacterDO } from "./do/character.ts";
export { InstanceDO } from "./do/instance.ts";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });
    if (url.pathname === "/api/guest" && request.method === "POST") return guestLogin(env);
    if (url.pathname === "/ws") return connect(request, env, url);
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

async function guestLogin(env: Env): Promise<Response> {
  const identity = newGuest();
  const token = await signToken(env.AUTH_SECRET, identity);
  return Response.json({ token, accountId: identity.accountId, name: identity.name });
}

async function connect(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const identity = await verifyToken(env.AUTH_SECRET, url.searchParams.get("token") ?? "");
  if (!identity) return rejectSocket();

  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const continent = typeof cf?.continent === "string" ? cf.continent : "XX";
  const relay = `relay:${continent}:0`;
  const locationHint = relayLocation(continent, Number(cf?.longitude));
  const stub = env.RELAY.getByName(relay, locationHint ? { locationHint } : undefined);

  // Identity travels in headers we set ourselves; anything the client sent is overwritten.
  const headers = new Headers(request.headers);
  headers.set(RELAY_HEADERS.accountId, identity.accountId);
  headers.set(RELAY_HEADERS.name, identity.name);
  headers.set(RELAY_HEADERS.relay, relay);
  return stub.fetch(new Request(request, { headers }));
}

/**
 * Accepts the upgrade only to send a close code: browsers hide HTTP status
 * codes of failed upgrades, and the client needs to know to log in again.
 */
function rejectSocket(): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(CLOSE_UNAUTHORIZED, "unauthorized");
  return new Response(null, { status: 101, webSocket: client });
}

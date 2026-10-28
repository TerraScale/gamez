/**
 * WS /ws?token=…[&world=<id>] (presence; wave-B.md §7). OWNER: T-presence.
 * Without `world` (phase 0 clients) the world is "plaza". Unknown worlds get a
 * 404 before the upgrade. The relay name per world comes from shared/worlds.ts
 * relayName(); the world travels in RELAY_HEADERS.world.
 */
import { authenticateRequest } from "../auth/session.ts";
import { RELAY_HEADERS } from "../contracts.ts";
import { rejectSocket } from "../http.ts";
import { relayLocation } from "../routing.ts";
import { CLOSE_UNAUTHORIZED } from "../../shared/codec.ts";
import { relayName } from "../../shared/worlds.ts";
import { worldFromParam } from "../presence/world.ts";
import type { RouteHandler } from "./types.ts";

export const presenceRoutes: RouteHandler = async ({ request, env, url }) => {
  if (url.pathname !== "/ws") return null;
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const world = worldFromParam(url.searchParams.get("world"));
  if (!world) return new Response("unknown world", { status: 404 });

  const identity = await authenticateRequest(request, env, url);
  if (!identity) return rejectSocket(CLOSE_UNAUTHORIZED, "unauthorized");

  const cf = request.cf as IncomingRequestCfProperties | undefined;
  const continent = typeof cf?.continent === "string" ? cf.continent : "XX";
  const relay = relayName(continent, world);
  const locationHint = relayLocation(continent, Number(cf?.longitude));
  const stub = env.RELAY.getByName(relay, locationHint ? { locationHint } : undefined);

  // Identity and world travel in headers we set ourselves; anything the client sent is overwritten.
  const headers = new Headers(request.headers);
  headers.set(RELAY_HEADERS.accountId, identity.accountId);
  headers.set(RELAY_HEADERS.name, identity.name);
  headers.set(RELAY_HEADERS.relay, relay);
  headers.set(RELAY_HEADERS.world, world.id);
  return stub.fetch(new Request(request, { headers }));
};

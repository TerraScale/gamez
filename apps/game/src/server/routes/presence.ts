/**
 * WS /ws?token=…[&world=<id>] (presence; wave-B.md §7, wave-C.md §12).
 * Without `world` (phase 0 clients) the world is "plaza". Unknown worlds get a
 * 404 before the upgrade. The relay comes from shared/worlds.ts relayName()
 * with the account's shard (relayShard: stable hash of the account id), so all
 * sockets of one account meet on one relay; the world travels in RELAY_HEADERS.world.
 *
 * Dev hosts only (isDevHost, else 404), for e2e and tools/loadtest:
 *   POST /api/dev/presence/fixtures {world, group, fixtures}  ChunkDO.setFixtures
 *   GET  /api/dev/presence/stats?world=<id>                    ChunkDO.stats
 */
import type { EntityState } from "@gamez/protocol";
import { authenticateRequest } from "../auth/session.ts";
import { RELAY_HEADERS } from "../contracts.ts";
import { apiError, isDevHost, json, readJson, rejectSocket } from "../http.ts";
import { relayLocation } from "../routing.ts";
import { CLOSE_UNAUTHORIZED } from "../../shared/codec.ts";
import { presenceWorld, relayName, relayShard } from "../../shared/worlds.ts";
import { worldFromParam } from "../presence/world.ts";
import type { RouteContext, RouteHandler } from "./types.ts";

const DEV_PREFIX = "/api/dev/presence/";

export const presenceRoutes: RouteHandler = async (c) => {
  const { request, env, url } = c;
  if (url.pathname.startsWith(DEV_PREFIX)) return devPresence(c);
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
  const relay = relayName(continent, world, relayShard(identity.accountId, world));
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

/** The "<code>: message" a FixtureError carries across RPC, split back up. */
function fixtureFailure(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  const m = /^([a-z-]+): (.*)$/s.exec(message);
  return m ? apiError(400, m[1]!, m[2]!) : apiError(500, "internal", "could not set fixtures");
}

async function devPresence({ request, env, url }: RouteContext): Promise<Response> {
  // Dev-only: invisible (404) on production hosts, whatever the caller sends.
  if (!isDevHost(url, env)) return apiError(404, "not_found", "no such endpoint");
  const action = url.pathname.slice(DEV_PREFIX.length);

  if (action === "fixtures") {
    if (request.method !== "POST") return apiError(405, "method_not_allowed", "use POST");
    const body = await readJson(request);
    if (!body) return apiError(400, "bad_request", "expected a JSON object");
    const world = typeof body.world === "string" ? presenceWorld(body.world) : null;
    if (!world) return apiError(404, "unknown_world", "no such presence world");
    if (typeof body.group !== "string") return apiError(400, "bad-group", "group is required");
    const chunk = env.CHUNK.getByName(world.chunk);
    try {
      // Shape unknown: the chunk validates every field (presence/fixtures.ts).
      await chunk.setFixtures(body.group, body.fixtures as EntityState[]);
    } catch (err) {
      return fixtureFailure(err);
    }
    return json({ ok: true, fixtures: await chunk.fixtures(body.group) });
  }

  if (action === "stats") {
    if (request.method !== "GET") return apiError(405, "method_not_allowed", "use GET");
    const world = worldFromParam(url.searchParams.get("world"));
    if (!world) return apiError(404, "unknown_world", "no such presence world");
    return json(await env.CHUNK.getByName(world.chunk).stats());
  }

  return apiError(404, "not_found", "no such endpoint");
}

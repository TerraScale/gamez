/**
 * /api/arena/* and the dev build injection (docs/design/wave-C.md §6.3).
 * OWNER: T-arena. Each request is routed to the ArenaDO of the current
 * season ("classic:<seasonId>"); a ticket or match id carries its season
 * ("<seasonId>.<16 hex>") so later reads reach the ladder that holds it.
 *
 *   POST /api/arena/queue            registered; builds from the verified hero (409 not_eligible)
 *   GET  /api/arena/queue/:ticket    poll (resolves due matches)
 *   GET  /api/arena/status           the caller's rating, limits and recent matches
 *   GET  /api/arena/match/:id        one match (replay data)
 *   GET  /api/arena/ladder           D1 read model (public, cached 15 s)
 *   POST /api/dev/arena/build        dev hosts only: a build override for the caller
 */
import { currentSeason } from "@gamez/economy";
import type {
  ArenaBuild,
  ArenaLadderResponse,
  ArenaMatch,
  ArenaStatus,
  ArenaTicket,
} from "@gamez/protocol";
import { checkBuild } from "../arena/build.ts";
import { readLadder } from "../arena/read.ts";
import { economyCaller, opIdOf, statusOf } from "../economy/guards.ts";
import { apiError, isDevHost, json, readJson } from "../http.ts";
import type { RouteHandler, RouteContext } from "./types.ts";

const LADDER_CACHE = "public, max-age=15";
const MODE = "classic";
/** "<seasonId>.<16 hex>" (tickets and matches). */
const SCOPED_ID = /^([a-z0-9-]{1,32})\.([0-9a-f]{16})$/;
const CLASS_ID = /^[a-z0-9_.]{1,60}$/;

/** The mode of a request (body or query); only "classic" has a verified build today. */
function modeOf(value: unknown): string | Response {
  if (value === undefined || value === null || value === "") return MODE;
  return value === MODE ? MODE : apiError(400, "bad_request", "mode must be classic");
}

/** Decodes one path segment; a malformed escape decodes to "" (no such id). */
function segment(path: string, prefix: string): string {
  try {
    return decodeURIComponent(path.slice(prefix.length));
  } catch {
    return "";
  }
}

function arenaStub(env: RouteContext["env"], seasonId: string) {
  return env.ARENA.getByName(`${MODE}:${seasonId}`);
}

export const arenaRoutes: RouteHandler = async (c) => {
  const { url } = c;
  if (url.pathname === "/api/dev/arena/build") return devBuild(c);
  if (!url.pathname.startsWith("/api/arena/")) return null;
  try {
    return await arenaRoute(c);
  } catch (err) {
    console.error("arena: request failed", err);
    return apiError(500, "internal", "the arena is unavailable right now");
  }
};

async function arenaRoute(c: RouteContext): Promise<Response> {
  const { request, env, url } = c;
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/arena/queue" && method === "POST") return queue(c);

  if (path === "/api/arena/status" && (method === "GET" || method === "HEAD")) {
    const who = await economyCaller(c, "arena");
    if (who instanceof Response) return who;
    const mode = modeOf(url.searchParams.get("mode"));
    if (mode instanceof Response) return mode;
    const status: ArenaStatus = await arenaStub(env, currentSeason(Date.now()).id).status(
      who.party.accountId,
    );
    return json(status);
  }

  if (path.startsWith("/api/arena/queue/") && (method === "GET" || method === "HEAD")) {
    const who = await economyCaller(c, "arena");
    if (who instanceof Response) return who;
    const ticket = segment(path, "/api/arena/queue/");
    const scoped = SCOPED_ID.exec(ticket);
    if (!scoped) return apiError(404, "not_found", "no such ticket");
    const found: ArenaTicket | null = await arenaStub(env, scoped[1]!).poll({
      accountId: who.party.accountId,
      ticket,
    });
    return found ? json(found) : apiError(404, "not_found", "no such ticket");
  }

  if (path.startsWith("/api/arena/match/") && (method === "GET" || method === "HEAD")) {
    const who = await economyCaller(c, "arena");
    if (who instanceof Response) return who;
    const id = segment(path, "/api/arena/match/");
    const scoped = SCOPED_ID.exec(id);
    if (!scoped) return apiError(404, "not_found", "no such match");
    const match: ArenaMatch | null = await arenaStub(env, scoped[1]!).match(id);
    return match ? json(match) : apiError(404, "not_found", "no such match");
  }

  if (path === "/api/arena/ladder" && (method === "GET" || method === "HEAD")) {
    return ladder(c);
  }

  return apiError(404, "not_found", "no such endpoint");
}

async function queue(c: RouteContext): Promise<Response> {
  const { request, env, url } = c;
  const who = await economyCaller(c, "arena", { write: true });
  if (who instanceof Response) return who;
  const body = await readJson(request);
  const opId = opIdOf(body);
  if (opId instanceof Response) return opId;
  const mode = modeOf(body?.mode);
  if (mode instanceof Response) return mode;

  const { accountId, displayName } = who.party;
  const season = currentSeason(Date.now());
  const arena = arenaStub(env, season.id);

  let build: ArenaBuild | null = null;
  if (isDevHost(url, env)) build = await arena.devBuild(accountId);
  if (!build) {
    try {
      build = await env.INSTANCE.getByName(`${MODE}:${accountId}`).exportBuild(displayName);
    } catch (err) {
      console.error("arena: exportBuild failed", err);
      return apiError(503, "unavailable", "could not read your hero, try again");
    }
  }
  if (!build) {
    return apiError(409, "not_eligible", "Play classic first: your hero fights as a ghost");
  }
  build = { ...build, accountId, displayName };

  const res = await arena.enqueue({ opId, build });
  if (!res.ok) return apiError(statusOf(res.code), res.code, res.message);
  const fresh = !res.replayed && res.value.status === "waiting";
  return json(res.value, fresh ? 202 : 200);
}

async function ladder(c: RouteContext): Promise<Response> {
  const { env, url } = c;
  const mode = modeOf(url.searchParams.get("mode"));
  if (mode instanceof Response) return mode;
  const classParam = url.searchParams.get("classId");
  if (classParam && !CLASS_ID.test(classParam)) {
    return apiError(400, "bad_request", "classId: a class id such as classic.warrior");
  }
  const limitParam = url.searchParams.get("limit");
  let limit = 50;
  if (limitParam !== null && limitParam !== "") {
    const n = Number(limitParam);
    if (!Number.isInteger(n)) return apiError(400, "bad_request", "limit must be a whole number");
    limit = Math.min(100, Math.max(1, n));
  }
  const season = currentSeason(Date.now());
  const body: ArenaLadderResponse = await readLadder(env.DB, {
    seasonId: season.id,
    mode,
    classId: classParam || null,
    limit,
  });
  return json(body, 200, { "cache-control": LADDER_CACHE });
}

/** POST /api/dev/arena/build {build}: stores the caller's build override (dev hosts only). */
async function devBuild(c: RouteContext): Promise<Response> {
  const { request, env, url } = c;
  if (!isDevHost(url, env)) return apiError(404, "not_found", "no such endpoint");
  if (request.method !== "POST") return apiError(405, "method_not_allowed", "use POST");
  const who = await economyCaller(c, "arena", { write: true });
  if (who instanceof Response) return who;
  const body = await readJson(request);
  const build = checkBuild(body?.build, who.party);
  if (!build) return apiError(400, "bad_request", "build: not a valid arena build");
  await arenaStub(env, currentSeason(Date.now()).id).devSetBuild(build);
  return json({ build });
}

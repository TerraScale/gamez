/**
 * Admin dashboard metric endpoints (docs/design/admin-dashboard.md §7).
 * CONTRACT (architect, implemented): dispatch, admin check, range parsing and
 * caching live here; each section's reads live in admin/metrics/<section>.ts.
 * Runs before admin.ts and answers only its own paths:
 *
 *   GET  /api/admin/overview | players | gameplay?mode= | economy/details
 *        | monetization | social | tech                       (range: from, to, bucket; fresh=1)
 *   GET  /api/admin/players/search?q=&cursor=
 *   GET  /api/admin/players/<accountId>                       (range for "recent")
 *   GET  /api/admin/tunables
 *   POST /api/admin/tunables {values: {key: number}}
 */
import { requireAdmin } from "../admin/auth.ts";
import {
  cached,
  cacheKey,
  METRICS_CACHE_MS,
  resetMetricsCache,
  TECH_CACHE_MS,
} from "../admin/metrics/cache.ts";
import { readEconomyDetails } from "../admin/metrics/economy.ts";
import { readGameplay } from "../admin/metrics/gameplay.ts";
import { readPlayer, searchPlayers } from "../admin/metrics/lookup.ts";
import { readMonetization } from "../admin/metrics/monetization.ts";
import { readOverview } from "../admin/metrics/overview.ts";
import { readPlayers } from "../admin/metrics/players.ts";
import { parseRange } from "../admin/metrics/range.ts";
import { readSocial } from "../admin/metrics/social.ts";
import { readTech } from "../admin/metrics/tech.ts";
import { parseTunablesPatch, readTunables, writeTunables } from "../admin/metrics/tunables.ts";
import type { MetricsDeps } from "../admin/metrics/util.ts";
import { analyticsFor, analyticsQueryFor } from "../analytics/index.ts";
import { resetFlagsCache } from "../config/flags.ts";
import { apiError, json, readJson } from "../http.ts";
import type { AdminRange } from "@gamez/protocol";
import type { RouteContext, RouteHandler } from "./types.ts";

const PREFIX = "/api/admin/";
/** Account ids are opaque tokens; anything else in /players/<id> is a 400. */
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MODE_ID = /^[a-z][a-z0-9-]{0,31}$/;

type SectionReader = (d: MetricsDeps, range: AdminRange, url: URL) => Promise<unknown>;

const SECTIONS: Record<string, SectionReader> = {
  overview: (d, r) => readOverview(d, r),
  players: (d, r) => readPlayers(d, r),
  gameplay: (d, r, url) => {
    const mode = url.searchParams.get("mode") ?? "classic";
    return readGameplay(d, r, MODE_ID.test(mode) ? mode : "classic");
  },
  "economy/details": (d, r) => readEconomyDetails(d, r),
  monetization: (d, r) => readMonetization(d, r),
  social: (d, r) => readSocial(d, r),
  tech: (d, r) => readTech(d, r),
};

function depsOf(c: RouteContext, now: number): MetricsDeps {
  return {
    env: c.env,
    db: c.env.DB,
    aq: analyticsQueryFor(c.env),
    analytics: analyticsFor(c.env, (p) => c.ctx.waitUntil(p)),
    now,
  };
}

/** Sections whose reads are slow enough to cache longer than METRICS_CACHE_MS. */
const SECTION_TTL: Partial<Record<string, number>> = { tech: TECH_CACHE_MS };

async function cachedJson<T>(
  url: URL,
  now: number,
  load: () => Promise<T>,
  ttlMs: number = METRICS_CACHE_MS,
  keep?: (body: T) => boolean,
): Promise<Response> {
  const fresh = url.searchParams.get("fresh") === "1";
  const { body, hit } = await cached(cacheKey(url), now, fresh, load, ttlMs, keep);
  return json(body, 200, { "x-admin-cache": hit ? "hit" : "miss" });
}

async function tunablesRoute(c: RouteContext, by: string): Promise<Response> {
  try {
    if (c.request.method === "GET") return json(await readTunables(c.env));
    if (c.request.method !== "POST") return apiError(405, "method_not_allowed", "use GET or POST");
    const patch = parseTunablesPatch(await readJson(c.request));
    if (typeof patch === "string") return apiError(400, "bad_request", patch);
    const out = await writeTunables(c.env, patch, by);
    resetFlagsCache();
    resetMetricsCache();
    return json(out);
  } catch (err) {
    console.error("admin: tunables failed", err);
    return apiError(503, "unavailable", "config unavailable");
  }
}

export const adminMetricsRoutes: RouteHandler = async (c) => {
  const { request, env, url } = c;
  const path = url.pathname;
  if (!path.startsWith(PREFIX)) return null;
  const rest = path.slice(PREFIX.length);
  const isSection = Object.hasOwn(SECTIONS, rest);
  const isPlayer = rest.startsWith("players/");
  if (!isSection && !isPlayer && rest !== "tunables") return null;

  const admin = await requireAdmin(request, env, url);
  if (admin instanceof Response) return admin;
  if (rest === "tunables") return tunablesRoute(c, `admin:${admin.accountId}`);
  if (request.method !== "GET") return apiError(405, "method_not_allowed", "use GET");

  const now = Date.now();
  const deps = depsOf(c, now);

  if (isSection) {
    const range = parseRange(url.searchParams, now);
    return cachedJson(
      url,
      now,
      () => SECTIONS[rest]!(deps, range, url),
      SECTION_TTL[rest] ?? METRICS_CACHE_MS,
    );
  }

  if (rest === "players/search") {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 64);
    const cursor = url.searchParams.get("cursor");
    // An empty page is not cached: a new account reaches D1 through the outbox a few
    // seconds after it exists, and a cached miss would hide it for METRICS_CACHE_MS.
    return cachedJson(
      url,
      now,
      () => searchPlayers(deps, q, cursor),
      METRICS_CACHE_MS,
      (page) => page.rows.length > 0,
    );
  }

  const accountId = decodeURIComponent(rest.slice("players/".length));
  if (!ACCOUNT_ID.test(accountId)) return apiError(400, "bad_request", "bad account id");
  const fresh = url.searchParams.get("fresh") === "1";
  const range = parseRange(url.searchParams, now);
  // A missing account (null) is not cached, for the same reason as an empty search.
  const { body: detail, hit } = await cached(
    cacheKey(url),
    now,
    fresh,
    () => readPlayer(deps, accountId, range),
    METRICS_CACHE_MS,
    (found) => found !== null,
  );
  if (!detail) return apiError(404, "not_found", "no such account");
  return json(detail, 200, { "x-admin-cache": hit ? "hit" : "miss" });
};

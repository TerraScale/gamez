/**
 * /api/config, /api/admin/{me,economy,flags,moderation} and /api/dev/admin/self
 * (wave-C.md §9). OWNER: T-admin. Runs before chat.ts: it answers only its own
 * paths. Mute, hide and reports are the wave B admin endpoints; they are
 * forwarded after the admin check here so dev admins can use them too.
 */
import { currentSeason } from "@gamez/economy";
import { FEATURE_FLAGS, type ConfigResponse, type FeatureFlag } from "@gamez/protocol";
import { requireAdmin } from "../admin/auth.ts";
import type { AdminMe } from "../admin/types.ts";
import { readEconomyTelemetry, parseDays } from "../admin/telemetry.ts";
import { readModeration } from "../admin/moderation.ts";
import { adminRoute } from "./chat.ts";
import { currentConfig, DEFAULT_FLAGS, resetFlagsCache } from "../config/flags.ts";
import type { Env } from "../contracts.ts";
import { authenticateRequest } from "../auth/session.ts";
import { apiError, isDevHost, json, readJson } from "../http.ts";
import type { RouteContext, RouteHandler } from "./types.ts";

/** Public config is cacheable for 30 s by shared caches. */
const CONFIG_CACHE = "public, max-age=30";
/** Wave B admin endpoints that this file forwards (after its own admin check). */
const FORWARDED = new Set(["/api/admin/mute", "/api/admin/hide", "/api/admin/reports"]);

/** GET /api/config: flags and season. A ConfigDO failure answers the defaults. */
async function configRoute(env: Env): Promise<Response> {
  const now = Date.now();
  const config =
    (await currentConfig(env)) ??
    ({
      flags: { ...DEFAULT_FLAGS },
      seasonId: currentSeason(now).id,
      serverTime: now,
    } satisfies ConfigResponse);
  return json(config, 200, { "cache-control": CONFIG_CACHE });
}

/** POST /api/admin/flags {flags: {market: false, …}} -> ConfigResponse. */
async function flagsRoute(c: RouteContext, by: string): Promise<Response> {
  if (c.request.method !== "POST") return apiError(405, "method_not_allowed", "use POST");
  const body = await readJson(c.request);
  const flags = body?.flags;
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    return apiError(400, "bad_request", "flags: object of booleans");
  }
  const patch: Partial<Record<FeatureFlag, boolean>> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (!(FEATURE_FLAGS as readonly string[]).includes(name)) {
      return apiError(400, "bad_request", `unknown flag ${name}`);
    }
    if (typeof value !== "boolean") return apiError(400, "bad_request", `${name}: boolean`);
    patch[name as FeatureFlag] = value;
  }
  try {
    const config = await c.env.CONFIG.getByName("global").setFlags(patch, by);
    resetFlagsCache();
    return json(config);
  } catch (err) {
    console.error("admin: flags write failed", err);
    return apiError(503, "unavailable", "config unavailable");
  }
}

/** POST /api/dev/admin/self: dev hosts only. Makes the caller a dev admin. */
async function devSelfRoute(c: RouteContext): Promise<Response> {
  if (!isDevHost(c.url, c.env)) return apiError(404, "not_found", "no such endpoint");
  if (c.request.method !== "POST") return apiError(405, "method_not_allowed", "use POST");
  const identity = await authenticateRequest(c.request, c.env, c.url);
  if (!identity) return apiError(401, "unauthorized", "log in first");
  try {
    await c.env.CONFIG.getByName("global").grantDevAdmin(identity.accountId);
  } catch (err) {
    console.error("admin: dev grant failed", err);
    return apiError(503, "unavailable", "config unavailable");
  }
  return json({ ok: true, accountId: identity.accountId, admin: "dev" });
}

/**
 * GET /api/admin/me: whether the caller is an admin, without a 403. The
 * dashboard asks this first so a player sees "not an admin" with no failed
 * requests, and learns from the server whether the dev self-grant exists here.
 */
async function meRoute(c: RouteContext): Promise<Response> {
  if (c.request.method !== "GET") return apiError(405, "method_not_allowed", "use GET");
  const devHost = isDevHost(c.url, c.env);
  const admin = await requireAdmin(c.request, c.env, c.url);
  if (admin instanceof Response) {
    if (admin.status === 401) return admin;
    return json({ admin: false, devHost } satisfies AdminMe);
  }
  return json({
    admin: true,
    via: admin.via,
    accountId: admin.accountId,
    devHost,
  } satisfies AdminMe);
}

export const adminRoutes: RouteHandler = async (c) => {
  const { request, env, url } = c;
  const path = url.pathname;

  if (path === "/api/config") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return apiError(405, "method_not_allowed", "use GET");
    }
    return configRoute(env);
  }
  if (path === "/api/dev/admin/self") return devSelfRoute(c);
  if (path === "/api/admin/me") return meRoute(c);

  if (path === "/api/admin/economy") {
    const admin = await requireAdmin(request, env, url);
    if (admin instanceof Response) return admin;
    if (request.method !== "GET") return apiError(405, "method_not_allowed", "use GET");
    const days = parseDays(url.searchParams.get("days"));
    return json(await readEconomyTelemetry(env.DB, days, Date.now()));
  }

  if (path === "/api/admin/flags") {
    const admin = await requireAdmin(request, env, url);
    if (admin instanceof Response) return admin;
    return flagsRoute(c, `admin:${admin.accountId}`);
  }

  if (path === "/api/admin/moderation") {
    const admin = await requireAdmin(request, env, url);
    if (admin instanceof Response) return admin;
    if (request.method !== "GET") return apiError(405, "method_not_allowed", "use GET");
    return json(await readModeration(env.DB, Date.now()));
  }

  if (FORWARDED.has(path)) {
    const admin = await requireAdmin(request, env, url);
    if (admin instanceof Response) return admin;
    // The caller is verified above; the wave B handler re-checks against this single id,
    // so a dev admin (not in ADMIN_ACCOUNT_IDS) gets the same behaviour as an env admin.
    return adminRoute(request, { ...env, ADMIN_ACCOUNT_IDS: admin.accountId }, url);
  }

  return null;
};

/**
 * Worker request instrumentation (docs/design/admin-dashboard.md §2.7, §3).
 * One "http.request" point per Worker fetch, written by server/index.ts.
 *
 * Route keys are bounded: a path is matched against the templates below and
 * written as the template ("/api/admin/players/:id"), never as the raw path.
 * Anything under /api/ that matches no template is "/api/other". Non-API paths
 * (the SPA shell and static assets) are "/app", and the WebSocket endpoints
 * keep their own paths.
 */
import type { Analytics } from "./types.ts";

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "101";

/**
 * Every /api route the Worker answers, one template per route. `:name` matches
 * any single segment. Literal templates come before parameter templates that
 * would also match them (for example "/api/guilds/mine" before "/api/guilds/:id").
 * Keep in sync with routes/*.ts (see routes/index.ts for the owners).
 */
const API_TEMPLATES: readonly string[] = [
  "/api/health",
  // auth.ts
  "/api/guest",
  "/api/me",
  "/api/account/name",
  "/api/auth/providers",
  "/api/auth/register",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/oauth/:provider/start",
  "/api/auth/oauth/:provider/callback",
  "/api/auth/oauth/:provider/stub",
  // vault.ts, account.ts
  "/api/account/vault",
  "/api/account/notices",
  "/api/account/notices/read",
  "/api/account/wallet",
  "/api/account/stash",
  "/api/account/cosmetics",
  "/api/account/cosmetics/equip",
  // leaderboards.ts, guilds.ts
  "/api/leaderboards",
  "/api/guilds",
  "/api/guilds/mine",
  "/api/guilds/leave",
  "/api/guilds/kick",
  "/api/guilds/:id",
  "/api/guilds/:id/join",
  // telemetry.ts, admin.ts, admin-metrics.ts
  "/api/telemetry",
  "/api/config",
  "/api/admin/me",
  "/api/admin/economy",
  "/api/admin/economy/details",
  "/api/admin/flags",
  "/api/admin/moderation",
  "/api/admin/overview",
  "/api/admin/gameplay",
  "/api/admin/monetization",
  "/api/admin/social",
  "/api/admin/tech",
  "/api/admin/tunables",
  "/api/admin/players/search",
  "/api/admin/players/:id",
  // chat.ts (admin forwards)
  "/api/admin/reports",
  "/api/admin/mute",
  "/api/admin/hide",
  // trade.ts
  "/api/trade",
  "/api/trade/:id",
  "/api/trade/:id/offer",
  "/api/trade/:id/accept",
  "/api/trade/:id/cancel",
  // market.ts
  "/api/market/search",
  "/api/market/mine",
  "/api/market/list",
  "/api/market/bid",
  "/api/market/buy",
  "/api/market/cancel",
  // shops.ts
  "/api/shops",
  "/api/shops/plots/bid",
  "/api/shops/:world/:plotId",
  "/api/shops/:world/:plotId/:action",
  // arena.ts
  "/api/arena/queue",
  "/api/arena/queue/:ticket",
  "/api/arena/status",
  "/api/arena/ladder",
  "/api/arena/match/:id",
  // pass.ts
  "/api/pass",
  "/api/pass/claim",
  "/api/pass/premium",
  // store.ts
  "/api/store",
  "/api/store/checkout",
  "/api/store/orders",
  "/api/pay/webhook/:provider",
  "/api/pay/stub/checkout",
  "/api/pay/stub/complete",
  // dev-only routes (404 outside stub hosts, still bounded)
  "/api/dev/grant",
  "/api/dev/economy/grant",
  "/api/dev/admin/self",
  "/api/dev/admin/seed-metrics",
  "/api/dev/arena/build",
  "/api/dev/pass/xp",
  "/api/dev/shops/advance",
  "/api/dev/presence/fixtures",
  "/api/dev/presence/stats",
];

/** The WebSocket endpoints keep their paths (exact matches only). */
const WS_PATHS: ReadonlySet<string> = new Set(["/ws", "/ws/instance", "/ws/chat"]);

const TEMPLATE_SEGMENTS = API_TEMPLATES.map((t) => t.split("/").slice(1));

const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

function matchesTemplate(template: readonly string[], segments: readonly string[]): boolean {
  if (template.length !== segments.length) return false;
  for (let i = 0; i < template.length; i++) {
    const t = template[i]!;
    if (t.startsWith(":")) {
      if (segments[i]!.length === 0) return false;
    } else if (t !== segments[i]) {
      return false;
    }
  }
  return true;
}

/**
 * The bounded route key of a pathname: the matching /api template, "/api/other"
 * for unknown /api paths, "/app" for everything else that is not a WebSocket path.
 */
export function routeKey(pathname: string): string {
  if (WS_PATHS.has(pathname)) return pathname;
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return "/app";
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const segments = trimmed.split("/").slice(1);
  for (let i = 0; i < TEMPLATE_SEGMENTS.length; i++) {
    if (matchesTemplate(TEMPLATE_SEGMENTS[i]!, segments)) return API_TEMPLATES[i]!;
  }
  return "/api/other";
}

/**
 * The status class of a response status. 101 is its own class (WebSocket
 * upgrades). Statuses outside 200..499 (including 1xx other than 101 and
 * out-of-range values) count as "5xx": they mean the server answered badly.
 */
export function statusClass(status: number): StatusClass {
  if (status === 101) return "101";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  return "5xx";
}

/** Method blob: the standard methods, everything else as "OTHER" (bounded). */
function methodOf(method: string): string {
  const m = method.toUpperCase();
  return METHODS.has(m) ? m : "OTHER";
}

/** Country blob: a two-letter code (Cloudflare adds "T1" for Tor), else "XX". */
function countryOf(request: Request): string {
  const country = request.cf?.country;
  return typeof country === "string" && /^[A-Z0-9]{2}$/.test(country) ? country : "XX";
}

/**
 * Writes one "http.request" point. `response` null means the handler threw, which
 * counts as a 500. Never throws, and never reads or changes the response body.
 */
export function recordRequest(
  analytics: Analytics,
  request: Request,
  url: URL,
  response: Response | null,
  ms: number,
): void {
  try {
    const status = response ? response.status : 500;
    analytics.write(
      "http.request",
      {
        route: routeKey(url.pathname),
        method: methodOf(request.method),
        statusClass: statusClass(status),
        country: countryOf(request),
      },
      { ms: Number.isFinite(ms) && ms > 0 ? ms : 0, status },
    );
  } catch {
    // Analytics never changes a response.
  }
}

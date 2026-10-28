/** GET /api/leaderboards (docs/design/wave-B.md §4). OWNER: T-leaderboards. Public, no auth. */
import { apiError, json } from "../http.ts";
import { parseLeaderboardQuery } from "../leaderboards/query.ts";
import { readLeaderboard } from "../leaderboards/read.ts";
import type { RouteHandler } from "./types.ts";

/** Read models change at most every few seconds; let shared caches hold a response briefly. */
const CACHE_CONTROL = "public, max-age=15";

export const leaderboardRoutes: RouteHandler = async ({ request, env, url }) => {
  if (url.pathname !== "/api/leaderboards") return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return apiError(405, "method_not_allowed", "use GET");
  }
  const parsed = parseLeaderboardQuery(url.searchParams);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  try {
    const body = await readLeaderboard(env.DB, parsed.query);
    return json(body, 200, { "cache-control": CACHE_CONTROL });
  } catch {
    return apiError(500, "internal", "leaderboard query failed");
  }
};

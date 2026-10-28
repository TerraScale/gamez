/**
 * LeaderboardApi (wave-B.md §4): GET /api/leaderboards. The response is the
 * D1 read model's LeaderboardResponse; `available: false` means the table is
 * not migrated yet (rows empty), which the UI shows as "not yet".
 */
import type { LeaderboardQuery, LeaderboardResponse } from "@gamez/protocol";
import type { ApiResult, LeaderboardApi } from "@gamez/ui-host";
import { badResponse, type HttpClient } from "./http.ts";

export function createLeaderboardApi(http: HttpClient): LeaderboardApi {
  return {
    async fetch(q: LeaderboardQuery): Promise<ApiResult<LeaderboardResponse>> {
      const res = await http.request<LeaderboardResponse>({
        method: "GET",
        path: "/api/leaderboards",
        query: {
          board: q.board,
          mode: q.mode ?? "classic",
          classId: q.classId,
          limit: q.limit,
        },
      });
      if (!res.ok) return res;
      const body = res.value as Partial<LeaderboardResponse> | undefined;
      if (!body || !Array.isArray(body.rows)) return badResponse("/api/leaderboards");
      return { ok: true, value: body as LeaderboardResponse };
    },
  };
}

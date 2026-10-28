/**
 * ArenaApi over /api/arena/* (wave-C.md §6.3). OWNER: T-arena. Queueing is a
 * write, so it carries an opId (generated when absent; reuse it on retries).
 * Status, poll, ladder and match are reads.
 */
import type { ArenaLadderResponse, ArenaMatch, ArenaStatus, ArenaTicket } from "@gamez/protocol";
import type { ApiResult, ArenaApi } from "@gamez/ui-host";
import { badResponse, type HttpClient } from "./http.ts";
import { newOpId } from "./pending.ts";

function isStatus(v: unknown): v is ArenaStatus {
  return !!v && typeof v === "object" && typeof (v as ArenaStatus).seasonId === "string";
}

function isTicket(v: unknown): v is ArenaTicket {
  return !!v && typeof v === "object" && typeof (v as ArenaTicket).ticket === "string";
}

function isMatch(v: unknown): v is ArenaMatch {
  return !!v && typeof v === "object" && typeof (v as ArenaMatch).id === "string";
}

function isLadder(v: unknown): v is ArenaLadderResponse {
  return !!v && typeof v === "object" && Array.isArray((v as ArenaLadderResponse).rows);
}

/** Checks the shape of a successful body; a wrong shape becomes bad_response. */
function shaped<T>(
  res: ApiResult<unknown>,
  what: string,
  check: (v: unknown) => v is T,
): ApiResult<T> {
  if (!res.ok) return res;
  return check(res.value) ? { ok: true, value: res.value } : badResponse(what);
}

export function createArenaApi(http: HttpClient): ArenaApi {
  return {
    async status(mode?: string): Promise<ApiResult<ArenaStatus>> {
      const res = await http.request<ArenaStatus>({
        method: "GET",
        path: "/api/arena/status",
        query: { mode },
      });
      return shaped(res, "arena status", isStatus);
    },

    async queue(mode?: string, opId?: string): Promise<ApiResult<ArenaTicket>> {
      const res = await http.request<ArenaTicket>({
        method: "POST",
        path: "/api/arena/queue",
        body: { opId: opId ?? newOpId(), mode: mode ?? "classic" },
      });
      return shaped(res, "arena queue", isTicket);
    },

    async poll(ticket: string): Promise<ApiResult<ArenaTicket>> {
      const res = await http.request<ArenaTicket>({
        method: "GET",
        path: `/api/arena/queue/${encodeURIComponent(ticket)}`,
      });
      return shaped(res, "arena ticket", isTicket);
    },

    async ladder(q?: {
      mode?: string;
      classId?: string;
      limit?: number;
    }): Promise<ApiResult<ArenaLadderResponse>> {
      const res = await http.request<ArenaLadderResponse>({
        method: "GET",
        path: "/api/arena/ladder",
        query: { mode: q?.mode, classId: q?.classId, limit: q?.limit },
      });
      return shaped(res, "arena ladder", isLadder);
    },

    async match(id: string): Promise<ApiResult<ArenaMatch>> {
      const res = await http.request<ArenaMatch>({
        method: "GET",
        path: `/api/arena/match/${encodeURIComponent(id)}`,
      });
      return shaped(res, "arena match", isMatch);
    },
  };
}

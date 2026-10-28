/**
 * VaultApi over /api/account/vault and /api/account/notices* (wave-C.md §3).
 * OWNER: T-econ-ui. Also exports retryNetwork(), shared by the economy SDK
 * files (trade, market, shops): a retry reuses the same opId, so the server
 * answers a replayed op with its stored result instead of applying it twice.
 */
import type { NoticesResponse, VaultResponse } from "@gamez/protocol";
import type { ApiResult, VaultApi } from "@gamez/ui-host";
import { badResponse, type HttpClient } from "./http.ts";

/** Extra attempts after a "network" failure (same opId every time). */
export const NETWORK_RETRIES = 2;

/** Runs `attempt` again while it fails with code "network" (at most NETWORK_RETRIES times). */
export async function retryNetwork<T>(attempt: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  let res = await attempt();
  for (let i = 0; i < NETWORK_RETRIES && !res.ok && res.code === "network"; i++) {
    res = await attempt();
  }
  return res;
}

function isVault(v: unknown): v is VaultResponse {
  return !!v && typeof v === "object" && Array.isArray((v as VaultResponse).items);
}

function isNotices(v: unknown): v is NoticesResponse {
  return (
    !!v &&
    typeof v === "object" &&
    Array.isArray((v as NoticesResponse).notices) &&
    typeof (v as NoticesResponse).unread === "number"
  );
}

export function createVaultApi(http: HttpClient): VaultApi {
  return {
    async vault(): Promise<ApiResult<VaultResponse>> {
      const res = await http.request<unknown>({ method: "GET", path: "/api/account/vault" });
      if (!res.ok) return res;
      return isVault(res.value)
        ? { ok: true, value: res.value }
        : badResponse("/api/account/vault");
    },

    async notices(sinceId?: string | null): Promise<ApiResult<NoticesResponse>> {
      const res = await http.request<unknown>({
        method: "GET",
        path: "/api/account/notices",
        query: { since: sinceId ? sinceId : undefined },
      });
      if (!res.ok) return res;
      return isNotices(res.value)
        ? { ok: true, value: res.value }
        : badResponse("/api/account/notices");
    },

    async markRead(upToId: string): Promise<ApiResult<{ marked: number }>> {
      const res = await http.request<unknown>({
        method: "POST",
        path: "/api/account/notices/read",
        body: { upTo: upToId },
      });
      if (!res.ok) return res;
      const marked = (res.value as { marked?: unknown } | undefined)?.marked;
      return typeof marked === "number"
        ? { ok: true, value: { marked } }
        : badResponse("/api/account/notices/read");
    },
  };
}

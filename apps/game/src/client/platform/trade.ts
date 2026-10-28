/**
 * TradeApi over /api/trade* (wave-C.md §3.3). OWNER: T-econ-ui. Open is
 * idempotent by opId (generated when absent, reused on network retries).
 * Offer, accept and cancel are state writes: retrying them is harmless.
 */
import type { TradeListResponse, TradeView } from "@gamez/protocol";
import type { ApiResult, TradeApi } from "@gamez/ui-host";
import { badResponse, type HttpClient } from "./http.ts";
import { newOpId } from "./pending.ts";
import { retryNetwork } from "./vault.ts";

function isTrade(v: unknown): v is TradeView {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as TradeView).id === "string" &&
    !!(v as TradeView).offers
  );
}

function tradeResult(res: ApiResult<unknown>, what: string): ApiResult<TradeView> {
  if (!res.ok) return res;
  return isTrade(res.value) ? { ok: true, value: res.value } : badResponse(what);
}

export function createTradeApi(http: HttpClient): TradeApi {
  const tradePath = (tradeId: string, rest = "") =>
    `/api/trade/${encodeURIComponent(tradeId)}${rest}`;

  return {
    async list(): Promise<ApiResult<TradeListResponse>> {
      const res = await http.request<unknown>({ method: "GET", path: "/api/trade" });
      if (!res.ok) return res;
      const trades = (res.value as { trades?: unknown } | undefined)?.trades;
      return Array.isArray(trades)
        ? { ok: true, value: { trades: trades as TradeView[] } }
        : badResponse("/api/trade");
    },

    open(withAccountId: string, opId?: string): Promise<ApiResult<TradeView>> {
      const id = opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: "/api/trade",
          body: { opId: id, with: withAccountId },
        }),
      ).then((res) => tradeResult(res, "/api/trade"));
    },

    get(tradeId: string): Promise<ApiResult<TradeView>> {
      return http
        .request<unknown>({ method: "GET", path: tradePath(tradeId) })
        .then((res) => tradeResult(res, "/api/trade/:id"));
    },

    offer(tradeId: string, coin: number, uids: string[]): Promise<ApiResult<TradeView>> {
      return http
        .request<unknown>({
          method: "POST",
          path: tradePath(tradeId, "/offer"),
          body: { coin, uids },
        })
        .then((res) => tradeResult(res, "/api/trade/:id/offer"));
    },

    accept(tradeId: string, versions: [number, number]): Promise<ApiResult<TradeView>> {
      return http
        .request<unknown>({
          method: "POST",
          path: tradePath(tradeId, "/accept"),
          body: { versions },
        })
        .then((res) => tradeResult(res, "/api/trade/:id/accept"));
    },

    cancel(tradeId: string): Promise<ApiResult<TradeView>> {
      return http
        .request<unknown>({ method: "POST", path: tradePath(tradeId, "/cancel"), body: {} })
        .then((res) => tradeResult(res, "/api/trade/:id/cancel"));
    },
  };
}

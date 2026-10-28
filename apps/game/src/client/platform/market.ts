/**
 * MarketApi over /api/market/* (wave-C.md §4). OWNER: T-econ-ui. Writes take an
 * opId (generated when absent, reused on network retries); search and mine are
 * D1 reads for display only.
 */
import type {
  MarketListing,
  MarketMineResponse,
  MarketSearchQuery,
  MarketSearchResponse,
} from "@gamez/protocol";
import type { ApiResult, MarketApi } from "@gamez/ui-host";
import { badResponse, type HttpClient } from "./http.ts";
import { newOpId } from "./pending.ts";
import { retryNetwork } from "./vault.ts";

function isListing(v: unknown): v is MarketListing {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as MarketListing).id === "string" &&
    !!(v as MarketListing).item
  );
}

function listingResult(res: ApiResult<unknown>, what: string): ApiResult<MarketListing> {
  if (!res.ok) return res;
  return isListing(res.value) ? { ok: true, value: res.value } : badResponse(what);
}

export function createMarketApi(http: HttpClient): MarketApi {
  return {
    async search(q: MarketSearchQuery): Promise<ApiResult<MarketSearchResponse>> {
      const res = await http.request<unknown>({
        method: "GET",
        path: "/api/market/search",
        query: {
          scope: q.scope,
          category: q.category,
          q: q.q,
          rarity: q.rarity,
          minLevel: q.minLevel,
          maxLevel: q.maxLevel,
          sort: q.sort,
          limit: q.limit,
          offset: q.offset,
        },
      });
      if (!res.ok) return res;
      const body = res.value as Partial<MarketSearchResponse> | undefined;
      return body && Array.isArray(body.listings) && typeof body.available === "boolean"
        ? { ok: true, value: { listings: body.listings, available: body.available } }
        : badResponse("/api/market/search");
    },

    async mine(): Promise<ApiResult<MarketMineResponse>> {
      const res = await http.request<unknown>({ method: "GET", path: "/api/market/mine" });
      if (!res.ok) return res;
      const body = res.value as Partial<MarketMineResponse> | undefined;
      return body && Array.isArray(body.listings) && Array.isArray(body.bids)
        ? { ok: true, value: { listings: body.listings, bids: body.bids } }
        : badResponse("/api/market/mine");
    },

    list(req): Promise<ApiResult<MarketListing>> {
      const opId = req.opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: "/api/market/list",
          body: {
            opId,
            uid: req.uid,
            buyout: req.buyout,
            startBid: req.startBid,
            durationH: req.durationH,
          },
        }),
      ).then((res) => listingResult(res, "/api/market/list"));
    },

    bid(listingId: string, amount: number, opId?: string): Promise<ApiResult<MarketListing>> {
      const id = opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: "/api/market/bid",
          body: { opId: id, listingId, amount },
        }),
      ).then((res) => listingResult(res, "/api/market/bid"));
    },

    buy(listingId: string, opId?: string): Promise<ApiResult<MarketListing>> {
      const id = opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: "/api/market/buy",
          body: { opId: id, listingId },
        }),
      ).then((res) => listingResult(res, "/api/market/buy"));
    },

    cancel(listingId: string, opId?: string): Promise<ApiResult<MarketListing>> {
      const id = opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: "/api/market/cancel",
          body: { opId: id, listingId },
        }),
      ).then((res) => listingResult(res, "/api/market/cancel"));
    },
  };
}

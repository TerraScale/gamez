/**
 * ShopsApi over /api/shops* (wave-C.md §5). OWNER: T-econ-ui. Plot bids and
 * shop writes take an opId (generated when absent, reused on network retries).
 * configure has no opId in its contract: it sets values, so a retry is harmless.
 */
import type { PlotsResponse, PlotView, ShopConfigureRequest, ShopView } from "@gamez/protocol";
import type { ApiResult, ShopsApi } from "@gamez/ui-host";
import { badResponse, type HttpClient } from "./http.ts";
import { newOpId } from "./pending.ts";
import { retryNetwork } from "./vault.ts";

function isPlot(v: unknown): v is PlotView {
  return !!v && typeof v === "object" && typeof (v as PlotView).id === "string";
}

function isShop(v: unknown): v is ShopView {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as ShopView).plotId === "string" &&
    Array.isArray((v as ShopView).stock)
  );
}

function shopResult(res: ApiResult<unknown>, what: string): ApiResult<ShopView> {
  if (!res.ok) return res;
  return isShop(res.value) ? { ok: true, value: res.value } : badResponse(what);
}

export function createShopsApi(http: HttpClient): ShopsApi {
  const shopPath = (world: string, plotId: string, rest = "") =>
    `/api/shops/${encodeURIComponent(world)}/${encodeURIComponent(plotId)}${rest}`;

  return {
    async plots(world: string): Promise<ApiResult<PlotsResponse>> {
      const res = await http.request<unknown>({
        method: "GET",
        path: "/api/shops",
        query: { world },
      });
      if (!res.ok) return res;
      const body = res.value as Partial<PlotsResponse> | undefined;
      return body && Array.isArray(body.plots)
        ? { ok: true, value: { world: String(body.world ?? world), plots: body.plots } }
        : badResponse("/api/shops");
    },

    bidPlot(
      world: string,
      plotId: string,
      amount: number,
      opId?: string,
    ): Promise<ApiResult<PlotView>> {
      const id = opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: "/api/shops/plots/bid",
          body: { opId: id, world, plotId, amount },
        }),
      ).then((res) => {
        if (!res.ok) return res;
        return isPlot(res.value)
          ? { ok: true, value: res.value }
          : badResponse("/api/shops/plots/bid");
      });
    },

    shop(world: string, plotId: string): Promise<ApiResult<ShopView>> {
      return http
        .request<unknown>({ method: "GET", path: shopPath(world, plotId) })
        .then((res) => shopResult(res, "/api/shops/:world/:plotId"));
    },

    configure(
      world: string,
      plotId: string,
      req: ShopConfigureRequest,
    ): Promise<ApiResult<ShopView>> {
      return http
        .request<unknown>({
          method: "POST",
          path: shopPath(world, plotId, "/configure"),
          body: req,
        })
        .then((res) => shopResult(res, "/api/shops/configure"));
    },

    stock(
      world: string,
      plotId: string,
      uid: string,
      price: number,
      opId?: string,
    ): Promise<ApiResult<ShopView>> {
      const id = opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: shopPath(world, plotId, "/stock"),
          body: { opId: id, uid, price },
        }),
      ).then((res) => shopResult(res, "/api/shops/stock"));
    },

    unstock(
      world: string,
      plotId: string,
      entryId: string,
      opId?: string,
    ): Promise<ApiResult<ShopView>> {
      const id = opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: shopPath(world, plotId, "/unstock"),
          body: { opId: id, entryId },
        }),
      ).then((res) => shopResult(res, "/api/shops/unstock"));
    },

    buy(
      world: string,
      plotId: string,
      entryId: string,
      opId?: string,
    ): Promise<ApiResult<ShopView>> {
      const id = opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: shopPath(world, plotId, "/buy"),
          body: { opId: id, entryId },
        }),
      ).then((res) => shopResult(res, "/api/shops/buy"));
    },

    claim(world: string, plotId: string, opId?: string): Promise<ApiResult<ShopView>> {
      const id = opId ?? newOpId();
      return retryNetwork(() =>
        http.request<unknown>({
          method: "POST",
          path: shopPath(world, plotId, "/claim"),
          body: { opId: id },
        }),
      ).then((res) => shopResult(res, "/api/shops/claim"));
    },
  };
}

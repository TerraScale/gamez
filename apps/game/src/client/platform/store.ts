/**
 * StoreApi over /api/store* (wave-C.md §8). OWNER: T-pay. Every call resolves
 * to an ApiResult (see http.ts). Checkout carries an opId: the caller passes
 * one to make retries safe, or one is generated.
 */
import type {
  CheckoutResponse,
  FiatCurrency,
  OrdersResponse,
  PaymentProviderId,
  StoreResponse,
} from "@gamez/protocol";
import type { StoreApi } from "@gamez/ui-host";
import type { HttpClient } from "./http.ts";
import { newOpId } from "./pending.ts";

export function createStoreApi(http: HttpClient): StoreApi {
  return {
    catalog: (country) =>
      http.request<StoreResponse>({
        method: "GET",
        path: "/api/store",
        query: { country: country ?? null },
      }),
    checkout: (sku: string, provider: PaymentProviderId, currency: FiatCurrency, opId?: string) =>
      http.request<CheckoutResponse>({
        method: "POST",
        path: "/api/store/checkout",
        body: { opId: opId ?? newOpId(), sku, provider, currency },
      }),
    orders: () => http.request<OrdersResponse>({ method: "GET", path: "/api/store/orders" }),
  };
}

/**
 * AccountApi (wave-B.md §3.4): the wallet and cosmetics of the current account.
 * Read-only in wave B; mutations (equip, grants) are not exposed to modes.
 */
import type { CosmeticsView, WalletView } from "@gamez/protocol";
import type { AccountApi, ApiResult } from "@gamez/ui-host";
import { type HttpClient } from "./http.ts";

export function createAccountApi(http: HttpClient): AccountApi {
  return {
    wallet(): Promise<ApiResult<WalletView>> {
      return http.request<WalletView>({ method: "GET", path: "/api/account/wallet" });
    },
    cosmetics(): Promise<ApiResult<CosmeticsView>> {
      return http.request<CosmeticsView>({ method: "GET", path: "/api/account/cosmetics" });
    },
  };
}

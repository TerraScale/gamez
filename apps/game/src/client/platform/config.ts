/** ConfigApi over GET /api/config (wave-C.md §9.2). OWNER: T-admin. Public, cacheable 30 s. */
import type { ConfigResponse } from "@gamez/protocol";
import type { ConfigApi } from "@gamez/ui-host";
import type { HttpClient } from "./http.ts";

export function createConfigApi(http: HttpClient): ConfigApi {
  return {
    get: () => http.request<ConfigResponse>({ method: "GET", path: "/api/config" }),
  };
}

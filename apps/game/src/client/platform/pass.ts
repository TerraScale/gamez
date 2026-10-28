/** PassApi over /api/pass* (wave-C.md §7). OWNER: T-pass. */
import type { PassTrack, PassView } from "@gamez/protocol";
import type { PassApi } from "@gamez/ui-host";
import type { HttpClient } from "./http.ts";
import { newOpId } from "./pending.ts";

export function createPassApi(http: HttpClient): PassApi {
  return {
    view: () => http.request<PassView>({ method: "GET", path: "/api/pass" }),
    claim: (tier: number, track: PassTrack) =>
      http.request<PassView>({
        method: "POST",
        path: "/api/pass/claim",
        body: { tier, track },
      }),
    premium: (opId?: string) =>
      http.request<PassView>({
        method: "POST",
        path: "/api/pass/premium",
        body: { opId: opId ?? newOpId() },
      }),
  };
}

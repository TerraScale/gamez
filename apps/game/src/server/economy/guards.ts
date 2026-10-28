/**
 * Shared guards of the wave C routes (wave-C.md §1.2). CONTRACT (architect, implemented).
 *
 *   const who = await economyCaller(c, "market");   // flag + auth (+ registered for writes)
 *   if (who instanceof Response) return who;
 */
import { isOpId, type FeatureFlag } from "@gamez/protocol";
import { authenticateRequest } from "../auth/session.ts";
import { featureEnabled } from "../config/flags.ts";
import type { SessionIdentity } from "../contracts.ts";
import { apiError } from "../http.ts";
import type { RouteContext } from "../routes/types.ts";

export interface Caller {
  identity: SessionIdentity;
  /** {accountId, displayName} for DO calls. */
  party: { accountId: string; displayName: string };
}

/**
 * 503 "disabled" when the feature flag is off, 401 without a session, and —
 * when `write` — 403 "guest_forbidden" for guests (trading needs an account).
 */
export async function economyCaller(
  c: RouteContext,
  flag: FeatureFlag,
  opts: { write?: boolean } = {},
): Promise<Caller | Response> {
  if (!(await featureEnabled(c.env, flag)))
    return apiError(503, "disabled", `${flag} is switched off for now`);
  const identity = await authenticateRequest(c.request, c.env, c.url);
  if (!identity) return apiError(401, "unauthorized", "sign in first");
  if (opts.write && identity.kind !== "registered")
    return apiError(403, "guest_forbidden", "create an account first");
  return { identity, party: { accountId: identity.accountId, displayName: identity.name } };
}

/** 400 unless body.opId is a valid op id. */
export function opIdOf(body: Record<string, unknown> | null): string | Response {
  const opId = body?.opId;
  return isOpId(opId) ? opId : apiError(400, "bad_request", "opId: 8-64 chars [A-Za-z0-9_-]");
}

/** Maps an EconResult failure code to an HTTP status. */
export function statusOf(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "forbidden":
    case "guest_forbidden":
      return 403;
    case "unauthorized":
      return 401;
    case "conflict":
    case "busy":
      return 409;
    case "rate_limited":
      return 429;
    case "disabled":
    case "unavailable":
      return 503;
    case "internal":
      return 500;
    default:
      return 400;
  }
}

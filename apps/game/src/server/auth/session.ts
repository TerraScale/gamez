/**
 * Request authentication for every route (wave-B.md §3.1). OWNER: T-auth.
 *
 * CONTRACT: routes call only these two functions.
 * - Every token: HMAC + shape + 30-day max age (auth.ts verifyToken).
 * - Registered tokens: AccountDO.checkSession(sid) must still be open
 *   (logout and session pruning revoke them).
 * - Guest tokens: refused once their account was upgraded to registered, so a
 *   leftover guest token cannot outlive the upgrade (and a logout).
 * Both checks are one AccountDO RPC; they fail closed. An env without the
 * ACCOUNT binding (unit tests of unrelated routes) skips the guest check only.
 */
import { TOKEN_MAX_AGE_MS, verifyToken } from "../auth.ts";
import type { AccountApi, Env, SessionIdentity } from "../contracts.ts";
import { bearerToken } from "../http.ts";

/** The identity of a token, or null (bad, expired or revoked). */
export async function authenticateToken(
  env: Pick<Env, "AUTH_SECRET" | "ACCOUNT">,
  token: string,
): Promise<SessionIdentity | null> {
  if (!token || token.length > 4096) return null;
  const id = await verifyToken(env.AUTH_SECRET, token, TOKEN_MAX_AGE_MS);
  if (!id) return null;
  const kind = id.kind ?? "guest";
  const sid = typeof id.sid === "string" ? id.sid : null;
  if (!(await sessionStillOpen(env, { accountId: id.accountId, kind, sid }))) return null;
  return { accountId: id.accountId, name: id.name, issuedAt: id.issuedAt, kind, sid };
}

/**
 * The AccountDO half of authentication (also used when an OAuth link flow
 * returns): a registered session must still be open; a guest session dies
 * once its account became registered.
 */
export async function sessionStillOpen(
  env: Pick<Env, "ACCOUNT">,
  s: { accountId: string; kind: SessionIdentity["kind"]; sid: string | null },
): Promise<boolean> {
  const account = env.ACCOUNT as Env["ACCOUNT"] | undefined;
  try {
    if (s.kind === "registered") {
      if (!s.sid || !account) return false;
      return await account.getByName(s.accountId).checkSession(s.sid);
    }
    if (!account) return true;
    const stub = account.getByName(s.accountId) as unknown as Partial<Pick<AccountApi, "profile">>;
    // Real DO stubs expose every RPC method; partial test fakes of AccountDO
    // (economy/guild route tests) may lack profile(), so the guest check is skipped there.
    if (typeof stub.profile !== "function") return true;
    const profile = await stub.profile();
    return !(profile && profile.kind === "registered");
  } catch (err) {
    console.error("auth: session check failed", err);
    return false;
  }
}

/** True for a WebSocket upgrade request (`Upgrade: websocket`, any case). */
export function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get("upgrade") ?? "").trim().toLowerCase() === "websocket";
}

/**
 * authenticateToken of the request's bearer token. `?token=` is read only on
 * WebSocket upgrades (browsers cannot set headers there). ADR 0007 R3: on any
 * other request a URL token would let a cross-site link act as its owner.
 */
export async function authenticateRequest(
  request: Request,
  env: Pick<Env, "AUTH_SECRET" | "ACCOUNT">,
  url: URL = new URL(request.url),
): Promise<SessionIdentity | null> {
  const query = isWebSocketUpgrade(request) ? url.searchParams.get("token") : null;
  const token = bearerToken(request) || query || "";
  return token ? authenticateToken(env, token) : null;
}

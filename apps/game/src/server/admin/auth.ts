/**
 * Admin access (wave-C.md §9.3). OWNER: T-admin.
 *
 * Admins are the accounts in ADMIN_ACCOUNT_IDS plus the dev admins granted in
 * ConfigDO. Dev admins only count on dev hosts (isDevHost), so a grant made
 * locally never works on production hosts even if the row exists.
 */
import { authenticateRequest } from "../auth/session.ts";
import type { Env } from "../contracts.ts";
import { apiError, isDevHost } from "../http.ts";
import { adminIds } from "../routes/chat.ts";

export interface AdminIdentity {
  accountId: string;
  /** Where the admin right comes from. */
  via: "env" | "dev";
}

export type AdminEnv = Pick<Env, "AUTH_SECRET" | "ACCOUNT" | "ADMIN_ACCOUNT_IDS" | "CONFIG">;

/**
 * The admin identity of the request, or a ready Response: 401 without a valid
 * token, 403 for any other account.
 */
export async function requireAdmin(
  request: Request,
  env: AdminEnv & Pick<Env, "OAUTH_STUB">,
  url: URL,
): Promise<AdminIdentity | Response> {
  const identity = await authenticateRequest(request, env, url);
  if (!identity) return apiError(401, "unauthorized", "log in first");
  if (adminIds(env).has(identity.accountId)) return { accountId: identity.accountId, via: "env" };
  if (isDevHost(url, env) && env.CONFIG) {
    try {
      if (await env.CONFIG.getByName("global").isDevAdmin(identity.accountId)) {
        return { accountId: identity.accountId, via: "dev" };
      }
    } catch (err) {
      // Fail closed: an unreachable ConfigDO grants nothing beyond the env list.
      console.error("admin: dev admin lookup failed", err);
    }
  }
  return apiError(403, "forbidden", "admins only");
}

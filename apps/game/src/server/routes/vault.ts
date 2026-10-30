/**
 * /api/account/vault, /api/account/notices*, POST /api/dev/economy/grant (dev hosts only)
 * (docs/design/wave-C.md §3.1-3.2). OWNER: T-escrow. Runs before account.ts.
 *
 *   GET  /api/account/vault             -> VaultResponse
 *   GET  /api/account/notices?since=id  -> NoticesResponse
 *   POST /api/account/notices/read {upTo} -> { marked }
 *   POST /api/dev/economy/grant {opId?, coin?, gem?, items?: VaultItemInput[]}
 *        -> { balances, items: VaultItem[] (the ones put), vault: VaultResponse }
 *
 * Reads work for guests and registered accounts alike. The dev grant is
 * invisible (404) off dev hosts (http.ts isDevHost); coin/gem go in as flow
 * "faucet" with reason "dev.grant". It validates the whole body before
 * applying anything; with an opId a retried grant is a no-op (txIds derive
 * from it), without one every call grants again.
 */
import {
  VAULT_MAX_ITEMS,
  isOpId,
  type VaultItem,
  type VaultItemInput,
  type VaultResponse,
} from "@gamez/protocol";
import { isAmount } from "@gamez/economy";
import { vaultItemProblem } from "../account/vault.ts";
import { authenticateRequest } from "../auth/session.ts";
import { apiError, isDevHost, json, readJson } from "../http.ts";
import type { RouteHandler } from "./types.ts";

const MAX_GRANT_ITEMS = 20;
const MAX_NOTICE_ID = 160;

export const vaultRoutes: RouteHandler = async ({ request, env, url }) => {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/dev/economy/grant") {
    if (!isDevHost(url, env)) return apiError(404, "not_found", "no such endpoint");
    if (method !== "POST") return methodNotAllowed();
    const identity = await authenticateRequest(request, env, url);
    if (!identity) return unauthorized();
    const body = await readJson(request);
    if (!body) return apiError(400, "bad_request", "expected a JSON object");
    const coin = body.coin ?? 0;
    const gem = body.gem ?? 0;
    if (coin !== 0 && !isAmount(coin)) return apiError(400, "bad_request", "coin: 1..1e9");
    if (gem !== 0 && !isAmount(gem)) return apiError(400, "bad_request", "gem: 1..1e9");
    const rawItems = body.items ?? [];
    if (!Array.isArray(rawItems) || rawItems.length > MAX_GRANT_ITEMS)
      return apiError(400, "bad_request", `items: a list of at most ${MAX_GRANT_ITEMS}`);
    for (let i = 0; i < rawItems.length; i++) {
      const problem = vaultItemProblem(rawItems[i]);
      if (problem) return apiError(400, "bad_request", `items[${i}]: ${problem}`);
    }
    if (body.opId !== undefined && !isOpId(body.opId))
      return apiError(400, "bad_request", "opId: 8-64 chars [A-Za-z0-9_-]");
    const root = typeof body.opId === "string" ? body.opId : crypto.randomUUID();
    const account = env.ACCOUNT.getByName(identity.accountId);
    const items = rawItems as VaultItemInput[];
    for (const [currency, amount] of [
      ["coin", coin],
      ["gem", gem],
    ] as const) {
      if (amount === 0) continue;
      const r = await account.walletTx({
        txId: `dev.grant:${root}:${currency}`,
        currency,
        amount: amount as number,
        reason: "dev.grant",
        flow: "faucet",
      });
      if (!r.ok) return apiError(400, r.code, `grant failed: ${r.code}`);
    }
    const put: VaultItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const r = await account.vaultPut(`dev.grant:${root}:item:${i}`, items[i]!);
      if (!r.ok)
        return apiError(r.code === "vault_full" ? 409 : 400, r.code, `items[${i}]: ${r.code}`);
      put.push(r.item);
    }
    const vault: VaultResponse = { items: await account.vault(), max: VAULT_MAX_ITEMS };
    return json({ balances: (await account.wallet()).balances, items: put, vault });
  }

  const known =
    path === "/api/account/vault" ||
    path === "/api/account/notices" ||
    path === "/api/account/notices/read";
  if (!known) return null;

  const identity = await authenticateRequest(request, env, url);
  if (!identity) return unauthorized();
  const account = env.ACCOUNT.getByName(identity.accountId);

  if (path === "/api/account/vault") {
    if (method !== "GET") return methodNotAllowed();
    const [items, waiting] = await Promise.all([account.vault(), account.vaultWaiting()]);
    const res: VaultResponse = { items, max: VAULT_MAX_ITEMS, waiting };
    return json(res);
  }
  if (path === "/api/account/notices") {
    if (method !== "GET") return methodNotAllowed();
    const since = url.searchParams.get("since");
    const sinceId = since && since.length <= MAX_NOTICE_ID ? since : null;
    return json(await account.notices(sinceId));
  }
  // POST /api/account/notices/read {upTo}
  if (method !== "POST") return methodNotAllowed();
  const body = await readJson(request);
  const upTo = body?.upTo;
  if (typeof upTo !== "string" || upTo.length === 0 || upTo.length > MAX_NOTICE_ID)
    return apiError(400, "bad_request", "upTo: a notice id");
  return json({ marked: await account.markNoticesRead(upTo) });
};

function unauthorized(): Response {
  return apiError(401, "unauthorized", "sign in first");
}

function methodNotAllowed(): Response {
  return apiError(405, "method_not_allowed", "method not allowed");
}

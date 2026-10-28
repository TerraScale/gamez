/**
 * /api/trade* (docs/design/wave-C.md §3.3). OWNER: T-escrow.
 *
 *   POST /api/trade {opId, with}          -> TradeView (same opId -> same trade)
 *   GET  /api/trade                       -> TradeListResponse (my open trades)
 *   GET  /api/trade/:id                   -> TradeView
 *   POST /api/trade/:id/offer {coin, uids} -> TradeView
 *   POST /api/trade/:id/accept {versions} -> TradeView
 *   POST /api/trade/:id/cancel            -> TradeView
 *
 * Writes go through economyCaller(c, "trade", {write: true}) (flag, auth,
 * registered accounts only); reads need a session. tradeId = "t" + the first
 * 24 hex of SHA-256(`${accountId}:${opId}`), so a retried open lands on the
 * same EscrowDO, which answers it as a replay. Only the two parties may see or
 * act on a trade: everyone else gets 404. Offer/accept/cancel are naturally
 * idempotent (an unchanged offer, an accept of the same pair or a second
 * cancel is a no-op), so they need no opId.
 */
import type { TradeListResponse, TradeView } from "@gamez/protocol";
import type { EconResult, Env, EscrowApi } from "../contracts.ts";
import { economyCaller, opIdOf, statusOf } from "../economy/guards.ts";
import { apiError, json, readJson } from "../http.ts";
import { TRADE_ID_RE } from "../trade/escrow.ts";
import type { RouteContext, RouteHandler } from "./types.ts";

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** "t" + the first 24 hex chars of SHA-256(`${accountId}:${opId}`). */
export async function tradeIdOf(accountId: string, opId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${accountId}:${opId}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t${hex.slice(0, 24)}`;
}

/** The EscrowDO stub typed as its contract (RPC typing widens tuples like `accepted`). */
function escrowOf(env: Env, tradeId: string): EscrowApi {
  return env.ESCROW.getByName(tradeId) as unknown as EscrowApi;
}

function answer(r: EconResult<TradeView>): Response {
  return r.ok ? json(r.value) : apiError(statusOf(r.code), r.code, r.message);
}

function notFound(): Response {
  return apiError(404, "not_found", "no such trade");
}

function methodNotAllowed(): Response {
  return apiError(405, "method_not_allowed", "method not allowed");
}

export const tradeRoutes: RouteHandler = async (c) => {
  const path = c.url.pathname;
  if (path !== "/api/trade" && !path.startsWith("/api/trade/")) return null;
  const method = c.request.method;

  if (path === "/api/trade") {
    if (method === "POST") return openTrade(c);
    if (method !== "GET") return methodNotAllowed();
    const who = await economyCaller(c, "trade");
    if (who instanceof Response) return who;
    const ids = await c.env.ACCOUNT.getByName(who.party.accountId).openTrades();
    const views = await Promise.all(
      ids
        .filter((id) => TRADE_ID_RE.test(id))
        .map((id) => escrowOf(c.env, id).view(who.party.accountId)),
    );
    const res: TradeListResponse = {
      trades: views.filter((v): v is TradeView => v !== null),
    };
    return json(res);
  }

  const parts = path.slice("/api/trade/".length).split("/");
  const id = parts[0] ?? "";
  const action = parts[1];
  if (!TRADE_ID_RE.test(id) || parts.length > 2) return notFound();

  if (action === undefined) {
    if (method !== "GET") return methodNotAllowed();
    const who = await economyCaller(c, "trade");
    if (who instanceof Response) return who;
    const view = await escrowOf(c.env, id).view(who.party.accountId);
    return view ? json(view) : notFound();
  }
  if (action !== "offer" && action !== "accept" && action !== "cancel") return notFound();
  if (method !== "POST") return methodNotAllowed();
  const who = await economyCaller(c, "trade", { write: true });
  if (who instanceof Response) return who;
  const body = (await readJson(c.request)) ?? {};
  const escrow = escrowOf(c.env, id);
  const accountId = who.party.accountId;

  if (action === "offer") {
    const coin = body.coin ?? 0;
    const uids = body.uids ?? [];
    if (typeof coin !== "number" || !Array.isArray(uids))
      return apiError(400, "bad_request", "expected {coin, uids}");
    return answer(await escrow.offer({ accountId, coin, uids: uids as string[] }));
  }
  if (action === "accept") {
    const versions = body.versions;
    if (!Array.isArray(versions) || versions.length !== 2)
      return apiError(400, "bad_request", "versions: [aVersion, bVersion]");
    return answer(
      await escrow.accept({ accountId, versions: versions as unknown as [number, number] }),
    );
  }
  return answer(await escrow.cancel(accountId));
};

async function openTrade(c: RouteContext): Promise<Response> {
  const who = await economyCaller(c, "trade", { write: true });
  if (who instanceof Response) return who;
  const body = await readJson(c.request);
  const opId = opIdOf(body);
  if (opId instanceof Response) return opId;
  const target = body?.with;
  if (typeof target !== "string" || !ACCOUNT_ID_RE.test(target))
    return apiError(400, "bad_request", "with: the account id to trade with");
  if (target === who.party.accountId)
    return apiError(400, "bad_request", "you cannot trade with yourself");
  const profile = await c.env.ACCOUNT.getByName(target).profile();
  if (!profile) return apiError(404, "not_found", "no such player");
  if (profile.kind !== "registered")
    return apiError(400, "not_eligible", "that player needs an account to trade");
  const tradeId = await tradeIdOf(who.party.accountId, opId);
  return answer(
    await escrowOf(c.env, tradeId).open({
      tradeId,
      a: who.party,
      b: { accountId: target, displayName: profile.displayName },
    }),
  );
}

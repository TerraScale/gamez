/**
 * /api/market/* (docs/design/wave-C.md §4, §1.2). OWNER: T-market.
 *
 *   POST /api/market/list    {opId, uid, buyout, startBid, durationH}   registered
 *   POST /api/market/bid     {opId, listingId, amount}                  registered
 *   POST /api/market/buy     {opId, listingId}                          registered
 *   POST /api/market/cancel  {opId, listingId}                          registered
 *   GET  /api/market/search  filters (D1, display only)                 guests allowed
 *   GET  /api/market/mine    my listings and the ones I lead (D1)       signed in
 */
import { featureEnabled } from "../config/flags.ts";
import { economyCaller, opIdOf, statusOf } from "../economy/guards.ts";
import { accountGateway } from "../economy/gateway.ts";
import type { EconResult } from "../contracts.ts";
import { apiError, json, readJson } from "../http.ts";
import { myListings, parseSearch, searchListings } from "../market/search.ts";
import type { RouteHandler, RouteContext } from "./types.ts";
import {
  isAmount,
  marketEligible,
  marketShard,
  MARKET_DURATIONS_H,
  MARKET_MAX_PRICE,
  shardOfListing,
} from "@gamez/economy";

const UNAVAILABLE = "the market is busy, try again";

export const marketRoutes: RouteHandler = async (c) => {
  const { request, env, url } = c;
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/market/search") {
    if (method !== "GET") return methodNotAllowed("GET");
    return search(c);
  }
  if (path === "/api/market/mine") {
    if (method !== "GET") return methodNotAllowed("GET");
    const who = await economyCaller(c, "market");
    if (who instanceof Response) return who;
    try {
      return json(await myListings(env.DB, who.party.accountId, Date.now()));
    } catch {
      return apiError(500, "internal", "market query failed");
    }
  }

  switch (path) {
    case "/api/market/list":
      return method === "POST" ? list(c) : methodNotAllowed("POST");
    case "/api/market/bid":
      return method === "POST" ? bid(c) : methodNotAllowed("POST");
    case "/api/market/buy":
      return method === "POST" ? buy(c) : methodNotAllowed("POST");
    case "/api/market/cancel":
      return method === "POST" ? cancel(c) : methodNotAllowed("POST");
    default:
      return null;
  }
};

function methodNotAllowed(use: string): Response {
  return apiError(405, "method_not_allowed", `use ${use}`);
}

/** GET /api/market/search: guests allowed; only the flag and the read model. */
async function search(c: RouteContext): Promise<Response> {
  if (!(await featureEnabled(c.env, "market")))
    return apiError(503, "disabled", "market is switched off for now");
  const parsed = parseSearch(c.url.searchParams);
  if (!parsed.ok) return apiError(400, "bad_request", parsed.message);
  try {
    return json(await searchListings(c.env.DB, parsed.value, Date.now()));
  } catch {
    return apiError(500, "internal", "market query failed");
  }
}

/** Shared shape of the POST writes: flag, registered caller, JSON body, opId. */
async function writeBody(c: RouteContext): Promise<
  | {
      party: { accountId: string; displayName: string };
      body: Record<string, unknown>;
      opId: string;
    }
  | Response
> {
  const who = await economyCaller(c, "market", { write: true });
  if (who instanceof Response) return who;
  const body = await readJson(c.request);
  if (!body) return apiError(400, "bad_request", "expected a JSON object");
  const opId = opIdOf(body);
  if (typeof opId !== "string") return opId;
  return { party: who.party, body, opId };
}

function result(res: EconResult<unknown>): Response {
  if (res.ok) return json(res.value);
  return apiError(statusOf(res.code), res.code, res.message);
}

/** Runs a DO call; a thrown RPC answers 503 (the alarm finishes any saga it started). */
async function callDo<T>(fn: () => Promise<EconResult<T>>): Promise<Response> {
  try {
    return result(await fn());
  } catch {
    return apiError(503, "unavailable", UNAVAILABLE);
  }
}

function listingIdOf(
  body: Record<string, unknown>,
): { shard: string; listingId: string } | Response {
  const listingId = body.listingId;
  const shard = typeof listingId === "string" ? shardOfListing(listingId) : null;
  if (typeof listingId !== "string" || shard === null)
    return apiError(400, "bad_request", 'listingId: "<shard>/<number>"');
  return { shard, listingId };
}

async function list(c: RouteContext): Promise<Response> {
  const w = await writeBody(c);
  if (w instanceof Response) return w;
  const { body, party, opId } = w;

  const uid = body.uid;
  if (typeof uid !== "string" || uid.length < 1 || uid.length > 128)
    return apiError(400, "bad_request", "uid: the vault item id");
  const buyout = body.buyout ?? null;
  const startBid = body.startBid ?? null;
  if (buyout !== null && !isAmount(buyout, MARKET_MAX_PRICE))
    return apiError(400, "bad_request", "buyout: a whole number of coin");
  if (startBid !== null && !isAmount(startBid, MARKET_MAX_PRICE))
    return apiError(400, "bad_request", "startBid: a whole number of coin");
  if (buyout === null && startBid === null)
    return apiError(400, "bad_request", "set a buyout or a start bid");
  const durationH = body.durationH;
  if (!(MARKET_DURATIONS_H as readonly unknown[]).includes(durationH))
    return apiError(400, "bad_request", "durationH: 12, 24 or 48");

  // Pre-checks on the vault item pick the shard; the shard DO re-checks after taking it.
  const item = await accountGateway(c.env).vaultGet(party.accountId, uid);
  if (!item) return apiError(404, "not_found", "that item is not in your vault");
  if (!item.tradable) return apiError(400, "not_tradable", "this item cannot be traded");
  if (!marketEligible(item.summary))
    return apiError(
      400,
      "not_eligible",
      "only level 10+ gear, gems, materials and cosmetics can be listed",
    );

  const stub = c.env.MARKET.getByName(marketShard(item));
  return callDo(() =>
    stub.list({
      opId,
      seller: party,
      uid,
      buyout: buyout as number | null,
      startBid: startBid as number | null,
      durationH: durationH as number,
    }),
  );
}

async function bid(c: RouteContext): Promise<Response> {
  const w = await writeBody(c);
  if (w instanceof Response) return w;
  const { body, party, opId } = w;
  const l = listingIdOf(body);
  if (l instanceof Response) return l;
  if (!isAmount(body.amount, MARKET_MAX_PRICE))
    return apiError(400, "bad_request", "amount: a whole number of coin");
  const stub = c.env.MARKET.getByName(l.shard);
  return callDo(() =>
    stub.bid({ opId, bidder: party, listingId: l.listingId, amount: body.amount as number }),
  );
}

async function buy(c: RouteContext): Promise<Response> {
  const w = await writeBody(c);
  if (w instanceof Response) return w;
  const { body, party, opId } = w;
  const l = listingIdOf(body);
  if (l instanceof Response) return l;
  const stub = c.env.MARKET.getByName(l.shard);
  return callDo(() => stub.buy({ opId, buyer: party, listingId: l.listingId }));
}

async function cancel(c: RouteContext): Promise<Response> {
  const w = await writeBody(c);
  if (w instanceof Response) return w;
  const { body, party, opId } = w;
  const l = listingIdOf(body);
  if (l instanceof Response) return l;
  const stub = c.env.MARKET.getByName(l.shard);
  return callDo(() => stub.cancel({ opId, accountId: party.accountId, listingId: l.listingId }));
}

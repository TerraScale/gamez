/**
 * /api/shops*, /api/dev/shops/advance (dev hosts only) (docs/design/wave-C.md §5). OWNER: T-shops.
 *
 *   GET  /api/shops?world=                         PlotsResponse (reads: guests too)
 *   POST /api/shops/plots/bid                      PlotView          {opId, world, plotId, amount}
 *   GET  /api/shops/:world/:plotId                 ShopView (earnings for the owner only)
 *   POST /api/shops/:world/:plotId/configure       ShopView          {name?, appearance?, open?}
 *   POST /api/shops/:world/:plotId/stock           ShopView          {opId, uid, price}
 *   POST /api/shops/:world/:plotId/unstock         ShopView          {opId, entryId}
 *   POST /api/shops/:world/:plotId/buy             ShopView          {opId, entryId}
 *   POST /api/shops/:world/:plotId/claim           ShopView          {opId}
 *   POST /api/dev/shops/advance                    {world, ms} -> PlotsResponse (dev hosts only)
 */
import { authenticateRequest } from "../auth/session.ts";
import { plotsOf } from "../../shared/plots.ts";
import { isAmount } from "@gamez/economy";
import type { PlotsResponse } from "@gamez/protocol";
import { economyCaller, opIdOf, statusOf, type Caller } from "../economy/guards.ts";
import { apiError, isDevHost, json, readJson } from "../http.ts";
import type { RouteContext, RouteHandler } from "./types.ts";

const PREFIX = "/api/shops";
const DEV_PREFIX = "/api/dev/shops/advance";
/** Dev clock jumps are capped at 30 days per call. */
const MAX_ADVANCE_MS = 30 * 24 * 3600_000;
const MAX_ITEM_LEN = 128;
const MAX_NAME_LEN = 64;
const MAX_APPEARANCE_LEN = 64;

export const shopRoutes: RouteHandler = async (c) => {
  const path = c.url.pathname;
  if (path === DEV_PREFIX) return devAdvance(c);
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return null;

  const rest = path === PREFIX ? [] : path.slice(PREFIX.length + 1).split("/");

  if (rest.length === 0) {
    if (c.request.method !== "GET") return methodNotAllowed();
    return listPlots(c);
  }
  if (rest.length === 2 && rest[0] === "plots" && rest[1] === "bid") {
    if (c.request.method !== "POST") return methodNotAllowed();
    return bidPlot(c);
  }
  if (rest.length === 2) {
    if (c.request.method !== "GET") return methodNotAllowed();
    return getShop(c, rest[0] ?? "", rest[1] ?? "");
  }
  if (rest.length === 3) {
    if (c.request.method !== "POST") return methodNotAllowed();
    return shopAction(c, rest[0] ?? "", rest[1] ?? "", rest[2] ?? "");
  }
  return apiError(404, "not_found", "no such endpoint");
};

function methodNotAllowed(): Response {
  return apiError(405, "bad_request", "method not allowed");
}

/** Known world with shops, or a 400 response. */
function worldOrError(world: string | null): string | Response {
  if (!world || plotsOf(world).length === 0) return apiError(400, "bad_request", "unknown world");
  return world;
}

/** A known plot of the world, or a 404 response. */
function plotOrError(world: string, plotId: string): Response | null {
  return plotsOf(world).some((p) => p.id === plotId)
    ? null
    : apiError(404, "not_found", "no such plot");
}

async function listPlots(c: RouteContext): Promise<Response> {
  const who = await economyCaller(c, "shops");
  if (who instanceof Response) return who;
  const world = worldOrError(c.url.searchParams.get("world"));
  if (world instanceof Response) return world;
  const plots = await c.env.PLOTS.getByName(world).plots();
  const body: PlotsResponse = { world, plots };
  return json(body);
}

async function bidPlot(c: RouteContext): Promise<Response> {
  const who = await economyCaller(c, "shops", { write: true });
  if (who instanceof Response) return who;
  const body = await readJson(c.request);
  if (!body) return apiError(400, "bad_request", "expected a JSON object");
  const opId = opIdOf(body);
  if (opId instanceof Response) return opId;
  const world = worldOrError(typeof body.world === "string" ? body.world : null);
  if (world instanceof Response) return world;
  const plotId = typeof body.plotId === "string" ? body.plotId : "";
  const missing = plotOrError(world, plotId);
  if (missing) return missing;
  if (!isAmount(body.amount))
    return apiError(400, "bad_request", "amount must be a positive whole number of coin");
  const r = await c.env.PLOTS.getByName(world).bid({
    opId,
    bidder: who.party,
    plotId,
    amount: body.amount,
  });
  return r.ok ? json(r.value) : apiError(statusOf(r.code), r.code, r.message);
}

async function getShop(c: RouteContext, world: string, plotId: string): Promise<Response> {
  const who = await economyCaller(c, "shops");
  if (who instanceof Response) return who;
  const checked = worldOrError(world);
  if (checked instanceof Response) return checked;
  const missing = plotOrError(checked, plotId);
  if (missing) return missing;
  const view = await c.env.SHOP.getByName(`${checked}/${plotId}`).view(who.identity.accountId);
  return view ? json(view) : apiError(404, "not_found", "no shop on this plot");
}

/** The write routes under /api/shops/:world/:plotId/<action>. */
async function shopAction(
  c: RouteContext,
  world: string,
  plotId: string,
  action: string,
): Promise<Response> {
  const who = await economyCaller(c, "shops", { write: true });
  if (who instanceof Response) return who;
  const checked = worldOrError(world);
  if (checked instanceof Response) return checked;
  const missing = plotOrError(checked, plotId);
  if (missing) return missing;
  const body = await readJson(c.request);
  if (!body) return apiError(400, "bad_request", "expected a JSON object");
  const shop = c.env.SHOP.getByName(`${checked}/${plotId}`);

  if (action === "configure") {
    const input = configureInput(body, who);
    if (input instanceof Response) return input;
    return reply(await shop.configure(input));
  }

  const opId = opIdOf(body);
  if (opId instanceof Response) return opId;
  if (action === "stock") {
    const uid = body.uid;
    if (typeof uid !== "string" || uid === "" || uid.length > MAX_ITEM_LEN) {
      return apiError(400, "bad_request", "uid is required");
    }
    if (!isAmount(body.price)) {
      return apiError(400, "bad_request", "price must be a positive whole number of coin");
    }
    return reply(
      await shop.stock({ opId, accountId: who.party.accountId, uid, price: body.price }),
    );
  }
  if (action === "unstock" || action === "buy") {
    const entryId = body.entryId;
    if (typeof entryId !== "string" || entryId === "" || entryId.length > MAX_ITEM_LEN) {
      return apiError(400, "bad_request", "entryId is required");
    }
    if (action === "unstock") {
      return reply(await shop.unstock({ opId, accountId: who.party.accountId, entryId }));
    }
    return reply(await shop.buy({ opId, buyer: who.party, entryId }));
  }
  if (action === "claim") {
    return reply(await shop.claim({ opId, accountId: who.party.accountId }));
  }
  return apiError(404, "not_found", "no such shop action");
}

/** Validates a configure body; a Response on bad input. */
function configureInput(
  body: Record<string, unknown>,
  who: Caller,
): { accountId: string; name?: string; appearance?: string; open?: boolean } | Response {
  const input: { accountId: string; name?: string; appearance?: string; open?: boolean } = {
    accountId: who.party.accountId,
  };
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length > MAX_NAME_LEN) {
      return apiError(400, "bad_request", "name must be text of at most 64 characters");
    }
    input.name = body.name;
  }
  if (body.appearance !== undefined) {
    if (typeof body.appearance !== "string" || body.appearance.length > MAX_APPEARANCE_LEN) {
      return apiError(400, "bad_request", "appearance must be a short look id");
    }
    input.appearance = body.appearance;
  }
  if (body.open !== undefined) {
    if (typeof body.open !== "boolean")
      return apiError(400, "bad_request", "open must be true or false");
    input.open = body.open;
  }
  return input;
}

/** An EconResult as a response: the value (200) or the economy error. */
function reply<T>(
  r: { ok: true; value: T } | { ok: false; code: string; message: string },
): Response {
  return r.ok ? json(r.value) : apiError(statusOf(r.code), r.code, r.message);
}

/** POST /api/dev/shops/advance {world, ms}: dev hosts only (404 elsewhere). */
async function devAdvance(c: RouteContext): Promise<Response> {
  if (!isDevHost(c.url, c.env)) return apiError(404, "not_found", "no such endpoint");
  if (c.request.method !== "POST") return methodNotAllowed();
  const identity = await authenticateRequest(c.request, c.env, c.url);
  if (!identity) return apiError(401, "unauthorized", "sign in first");
  const body = await readJson(c.request);
  if (!body) return apiError(400, "bad_request", "expected a JSON object");
  const world = worldOrError(typeof body.world === "string" ? body.world : null);
  if (world instanceof Response) return world;
  if (!isAmount(body.ms, MAX_ADVANCE_MS)) {
    return apiError(400, "bad_request", "ms must be 1 to 30 days in milliseconds");
  }
  const plots = await c.env.PLOTS.getByName(world).devAdvance(body.ms);
  const response: PlotsResponse = { world, plots };
  return json(response);
}

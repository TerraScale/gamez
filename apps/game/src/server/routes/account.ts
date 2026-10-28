/**
 * /api/account/* (wallet, stash, cosmetics) and /api/dev/grant (stub hosts only)
 * (wave-B.md §3.4). OWNER: T-economy.
 *
 * Every route authenticates with authenticateRequest and talks to the caller's
 * AccountDO (named by accountId). Paths owned here are answered for every
 * method; /api/account/name stays with the auth routes.
 */
import type { CosmeticSlot } from "@gamez/protocol";
import { authenticateRequest } from "../auth/session.ts";
import { COSMETIC_SLOTS } from "../account/economy.ts";
import { apiError, isDevHost, json, readJson } from "../http.ts";
import type { RouteHandler } from "./types.ts";

const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_COSMETIC_ID = 100;

export const accountRoutes: RouteHandler = async ({ request, env, url }) => {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/dev/grant") {
    // Dev-only: invisible (404) on production hosts, whatever the caller sends.
    if (!isDevHost(url, env)) return apiError(404, "not_found", "no such endpoint");
    if (method !== "POST") return methodNotAllowed();
    const identity = await authenticateRequest(request, env, url);
    if (!identity) return unauthorized();
    const body = await readJson(request);
    const sku = body?.sku;
    if (typeof sku !== "string" || !SKU_RE.test(sku))
      return apiError(400, "bad_request", "sku must be a short identifier");
    const stub = env.ACCOUNT.getByName(identity.accountId);
    const result = await stub.grantEntitlement({
      txId: `dev:${crypto.randomUUID()}`,
      sku,
      source: "dev",
    });
    return json(result);
  }

  const known =
    path === "/api/account/wallet" ||
    path === "/api/account/stash" ||
    path === "/api/account/cosmetics" ||
    path === "/api/account/cosmetics/equip";
  if (!known) return null;

  const identity = await authenticateRequest(request, env, url);
  if (!identity) return unauthorized();
  const stub = env.ACCOUNT.getByName(identity.accountId);

  if (path === "/api/account/wallet") {
    if (method !== "GET") return methodNotAllowed();
    return json(await stub.wallet());
  }
  if (path === "/api/account/stash") {
    if (method !== "GET") return methodNotAllowed();
    return json(await stub.stash());
  }
  if (path === "/api/account/cosmetics") {
    if (method !== "GET") return methodNotAllowed();
    return json(await stub.cosmetics());
  }

  // POST /api/account/cosmetics/equip {slot, id}; id null unequips.
  if (method !== "POST") return methodNotAllowed();
  const body = await readJson(request);
  if (!body) return apiError(400, "bad_request", "expected a JSON object");
  const slot = body.slot;
  if (typeof slot !== "string" || !(COSMETIC_SLOTS as readonly string[]).includes(slot))
    return apiError(400, "bad_request", "slot must be title, nameplate or chatColor");
  let id: string | null;
  if (body.id === null) {
    id = null;
  } else if (
    typeof body.id === "string" &&
    body.id.length > 0 &&
    body.id.length <= MAX_COSMETIC_ID
  ) {
    id = body.id;
    const owned = (await stub.cosmetics()).owned;
    if (!owned.includes(id)) return apiError(400, "not_owned", "cosmetic is not owned");
  } else {
    return apiError(400, "bad_request", "id must be a cosmetic id or null");
  }
  return json(await stub.equipCosmetic(slot as CosmeticSlot, id));
};

function unauthorized(): Response {
  return apiError(401, "unauthorized", "sign in first");
}

function methodNotAllowed(): Response {
  return apiError(405, "method_not_allowed", "method not allowed");
}

/**
 * /api/pass* (docs/design/wave-C.md §7). OWNER: T-pass.
 *
 *   GET  /api/pass                 PassView of the running season (guests too)
 *   POST /api/pass/claim {tier, track}   claim one reward (guests too: progress is personal)
 *   POST /api/pass/premium {opId}  registered only: pay PASS_PREMIUM_GEMS gems, then grant the premium sku
 *   POST /api/dev/pass/xp {xp}     dev hosts only (404 elsewhere): adds season xp
 *
 * Writes go through AccountDO RPCs that are idempotent by txId. Premium is the
 * first gem sink: walletTx debits gems (flow "sink") and grantEntitlement
 * unlocks the season's premium sku; both use txId "passprem:<season>:<opId>".
 */
import { PASS_PREMIUM_GEMS, SEASON_TIERS } from "@gamez/economy";
import type { EntitlementView, PassTrack, PassView } from "@gamez/protocol";
import { authenticateRequest } from "../auth/session.ts";
import type { EconResult, EntitlementGrant, WalletTxC, WalletTxResult } from "../contracts.ts";
import { economyCaller, opIdOf, statusOf } from "../economy/guards.ts";
import { apiError, isDevHost, json, readJson } from "../http.ts";
import type { RouteContext, RouteHandler } from "./types.ts";

const PASS_XP_MAX = 10_000;

/** The AccountDO calls the premium purchase needs (AccountDO satisfies this). */
export interface PremiumAccount {
  pass(): Promise<PassView>;
  walletTx(tx: WalletTxC): Promise<WalletTxResult>;
  grantEntitlement(
    grant: EntitlementGrant,
  ): Promise<{ granted: boolean; entitlement: EntitlementView }>;
}

/**
 * Buys the premium track with gems. Already premium: answers the view without
 * charging. Otherwise debits PASS_PREMIUM_GEMS (idempotent by
 * "passprem:<season>:<opId>") and grants the season's premium sku under the
 * same txId. A retry after a failure in between replays both steps safely.
 */
export async function buyPremium(
  acct: PremiumAccount,
  opId: string,
): Promise<EconResult<PassView>> {
  const before = await acct.pass();
  if (before.premium) return { ok: true, value: before, replayed: true };
  const txId = `passprem:${before.seasonId}:${opId}`;
  const charged = await acct.walletTx({
    txId,
    currency: "gem",
    amount: -PASS_PREMIUM_GEMS,
    reason: `pass.premium:${before.seasonId}`,
    flow: "sink",
  });
  if (!charged.ok) {
    if (charged.code === "insufficient_funds")
      return {
        ok: false,
        code: "insufficient_funds",
        message: `premium costs ${PASS_PREMIUM_GEMS} gems`,
      };
    return { ok: false, code: "bad_request", message: "could not charge gems" };
  }
  await acct.grantEntitlement({ txId, sku: before.premiumSku, source: "pass" });
  return { ok: true, value: await acct.pass(), replayed: charged.replayed };
}

export const passRoutes: RouteHandler = async (c) => {
  const path = c.url.pathname;
  if (path === "/api/dev/pass/xp") return devXp(c);
  if (path === "/api/pass") return getPass(c);
  if (path === "/api/pass/claim") return claim(c);
  if (path === "/api/pass/premium") return premium(c);
  return null;
};

async function getPass(c: RouteContext): Promise<Response> {
  if (c.request.method !== "GET") return methodNotAllowed();
  const who = await economyCaller(c, "pass");
  if (who instanceof Response) return who;
  return json(await c.env.ACCOUNT.getByName(who.party.accountId).pass());
}

async function claim(c: RouteContext): Promise<Response> {
  if (c.request.method !== "POST") return methodNotAllowed();
  const who = await economyCaller(c, "pass");
  if (who instanceof Response) return who;
  const body = await readJson(c.request);
  if (!body) return apiError(400, "bad_request", "expected a JSON object");
  const tier = body.tier;
  if (!Number.isSafeInteger(tier) || (tier as number) < 1 || (tier as number) > SEASON_TIERS)
    return apiError(400, "bad_request", `tier must be an integer from 1 to ${SEASON_TIERS}`);
  const track = body.track;
  if (track !== "free" && track !== "premium")
    return apiError(400, "bad_request", "track must be free or premium");
  const result = await c.env.ACCOUNT.getByName(who.party.accountId).claimPassReward(
    tier as number,
    track as PassTrack,
  );
  if (!result.ok) return apiError(statusOf(result.code), result.code, result.message);
  return json(result.value);
}

async function premium(c: RouteContext): Promise<Response> {
  if (c.request.method !== "POST") return methodNotAllowed();
  // Spending gems is a registered-only write (wave-C.md §1.2): guests get 403.
  const who = await economyCaller(c, "pass", { write: true });
  if (who instanceof Response) return who;
  const body = await readJson(c.request);
  if (!body) return apiError(400, "bad_request", "expected a JSON object");
  const opId = opIdOf(body);
  if (opId instanceof Response) return opId;
  const stub = c.env.ACCOUNT.getByName(who.party.accountId);
  const result = await buyPremium(
    {
      pass: () => stub.pass(),
      walletTx: (tx) => stub.walletTx(tx),
      grantEntitlement: (grant) => stub.grantEntitlement(grant),
    },
    opId,
  );
  if (!result.ok) return apiError(statusOf(result.code), result.code, result.message);
  return json(result.value);
}

/** POST /api/dev/pass/xp {xp}: stub hosts only (404 elsewhere). */
async function devXp(c: RouteContext): Promise<Response> {
  if (!isDevHost(c.url, c.env)) return apiError(404, "not_found", "no such endpoint");
  if (c.request.method !== "POST") return methodNotAllowed();
  const identity = await authenticateRequest(c.request, c.env, c.url);
  if (!identity) return apiError(401, "unauthorized", "sign in first");
  const body = await readJson(c.request);
  const xp = body?.xp;
  if (!Number.isSafeInteger(xp) || (xp as number) < 1 || (xp as number) > PASS_XP_MAX)
    return apiError(400, "bad_request", `xp must be an integer from 1 to ${PASS_XP_MAX}`);
  const view = await c.env.ACCOUNT.getByName(identity.accountId).addSeasonXp(
    `dev:${crypto.randomUUID()}`,
    xp as number,
    "dev",
  );
  return json(view);
}

function methodNotAllowed(): Response {
  return apiError(405, "bad_request", "method not allowed");
}

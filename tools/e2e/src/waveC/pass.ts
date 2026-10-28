/**
 * Wave C e2e: battle pass: season xp from the dev hook, free claims (cosmetic + coin), premium refused without the entitlement, premium via gems refused without gems, premium claim after the entitlement, and state after a dev-server restart (docs/design/wave-C.md §11). OWNER: T-pass.
 * Port 5407. Dev hooks only run on localhost. The gem purchase needs a gem
 * balance, which no dev hook grants yet, so the premium entitlement comes from
 * POST /api/dev/grant (the store path is covered by the payments feature).
 */
import type { CosmeticsView, PassView, WalletView } from "@gamez/protocol";
import { api, registerGuest, type Registered } from "../accounts.ts";
import { loginGuest } from "../client.ts";
import type { E2eFeature } from "../features.ts";
import { check } from "../report.ts";

interface PassState {
  token: string;
  accountId: string;
  premiumSku: string;
  freeSku: string;
}

/** Tier 1 free: the first chat colour of the season. */
const FREE_TIER_1_SKU = "cosmetic.chatColor.amber";
/** Tier 1 premium: the first nameplate of the season. */
const PREMIUM_TIER_1_SKU = "cosmetic.nameplate.gilded-plate";

export const passFeature: E2eFeature = {
  name: "pass",
  async run(ctx) {
    const suffix = Date.now().toString(36);
    const a: Registered = await registerGuest(
      ctx.url,
      await loginGuest(ctx.url),
      `Pass ${suffix.slice(-4)}`,
    );

    const anon = await api<unknown>(ctx.url, "/api/pass");
    check(anon.status === 401, "pass: the battle pass needs a session (401)");

    const start = await api<PassView>(ctx.url, "/api/pass", { token: a.token });
    check(
      start.status === 200 &&
        start.body.seasonId === "2026-s1" &&
        start.body.xp === 0 &&
        start.body.tier === 0 &&
        start.body.premium === false,
      "pass: a new account starts at 0 xp in season 2026-s1, no premium",
    );
    if (start.status !== 200) return;
    const premiumSku = start.body.premiumSku;

    // 400 xp: tier 3 (tier 2 needs 240 xp, tier 3 needs 390 xp).
    const xp = await api<PassView>(ctx.url, "/api/dev/pass/xp", {
      token: a.token,
      body: { xp: 400 },
    });
    check(
      xp.status === 200 && xp.body.xp === 400 && xp.body.tier === 3,
      `pass: 400 season xp reaches tier 3 (tier ${xp.body.tier})`,
    );

    // Free tier 1: a cosmetic lands in the account.
    const freeOne = await api<PassView>(ctx.url, "/api/pass/claim", {
      token: a.token,
      body: { tier: 1, track: "free" },
    });
    check(
      freeOne.status === 200 && freeOne.body.claimed.free.includes(1),
      "pass: the free tier 1 reward is claimed",
    );
    const cos = await api<CosmeticsView>(ctx.url, "/api/account/cosmetics", { token: a.token });
    check(
      cos.status === 200 && cos.body.owned.includes(FREE_TIER_1_SKU),
      "pass: the free tier 1 cosmetic is owned",
    );

    // Premium is refused without the entitlement, and so is paying with no gems.
    const locked = await api<{ error?: { code: string } }>(ctx.url, "/api/pass/claim", {
      token: a.token,
      body: { tier: 1, track: "premium" },
    });
    check(
      locked.status === 403 && locked.body.error?.code === "forbidden",
      "pass: a premium claim without premium -> 403",
    );
    const broke = await api<{ error?: { code: string } }>(ctx.url, "/api/pass/premium", {
      token: a.token,
      body: { opId: `pass-${suffix}-a` },
    });
    check(
      broke.status === 400 && broke.body.error?.code === "insufficient_funds",
      "pass: buying premium with no gems -> insufficient_funds",
    );

    // The premium entitlement (stub hosts): then the premium claim works.
    const grant = await api<{ granted?: boolean }>(ctx.url, "/api/dev/grant", {
      token: a.token,
      body: { sku: premiumSku },
    });
    check(grant.status === 200 && grant.body.granted === true, "pass: premium entitlement granted");
    const owned = await api<PassView>(ctx.url, "/api/pass", { token: a.token });
    check(owned.status === 200 && owned.body.premium === true, "pass: the view shows premium");
    const premiumOne = await api<PassView>(ctx.url, "/api/pass/claim", {
      token: a.token,
      body: { tier: 1, track: "premium" },
    });
    check(
      premiumOne.status === 200 && premiumOne.body.claimed.premium.includes(1),
      "pass: the premium tier 1 reward is claimed",
    );
    const cos2 = await api<CosmeticsView>(ctx.url, "/api/account/cosmetics", { token: a.token });
    check(
      cos2.status === 200 && cos2.body.owned.includes(PREMIUM_TIER_1_SKU),
      "pass: the premium tier 1 cosmetic is owned",
    );

    // Tier 5 (750 xp) gives a coin reward on the free track.
    const more = await api<PassView>(ctx.url, "/api/dev/pass/xp", {
      token: a.token,
      body: { xp: 400 },
    });
    check(more.status === 200 && more.body.tier === 5, "pass: 800 xp reaches tier 5");
    const coin = await api<PassView>(ctx.url, "/api/pass/claim", {
      token: a.token,
      body: { tier: 5, track: "free" },
    });
    check(coin.status === 200 && coin.body.claimed.free.includes(5), "pass: free tier 5 claimed");
    const wallet = await api<WalletView>(ctx.url, "/api/account/wallet", { token: a.token });
    check(
      wallet.status === 200 && wallet.body.balances.coin === 10,
      `pass: the tier 5 coin reward is credited (coin ${wallet.body.balances.coin})`,
    );
    const again = await api<PassView>(ctx.url, "/api/pass/claim", {
      token: a.token,
      body: { tier: 5, track: "free" },
    });
    const wallet2 = await api<WalletView>(ctx.url, "/api/account/wallet", { token: a.token });
    check(
      again.status === 200 && wallet2.body.balances.coin === 10,
      "pass: a repeated claim does not credit coin twice",
    );

    ctx.state.set("pass", {
      token: a.token,
      accountId: a.accountId,
      premiumSku,
      freeSku: FREE_TIER_1_SKU,
    } satisfies PassState);
  },

  async afterRestart(ctx) {
    const st = ctx.state.get("pass") as PassState | undefined;
    if (!st) return;
    const view = await api<PassView>(ctx.url, "/api/pass", { token: st.token });
    check(
      view.status === 200 &&
        view.body.xp === 800 &&
        view.body.tier === 5 &&
        view.body.premium === true &&
        view.body.claimed.free.includes(1) &&
        view.body.claimed.free.includes(5) &&
        view.body.claimed.premium.includes(1),
      "pass after restart: xp, tiers, premium and claims persisted",
    );
    const cos = await api<CosmeticsView>(ctx.url, "/api/account/cosmetics", { token: st.token });
    check(
      cos.status === 200 &&
        cos.body.owned.includes(st.freeSku) &&
        cos.body.owned.includes(PREMIUM_TIER_1_SKU),
      "pass after restart: the cosmetics persisted",
    );
    const wallet = await api<WalletView>(ctx.url, "/api/account/wallet", { token: st.token });
    check(
      wallet.status === 200 && wallet.body.balances.coin === 10,
      "pass after restart: the coin reward persisted",
    );
  },
};

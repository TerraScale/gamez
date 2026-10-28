/**
 * BattlePassView (wave-C.md §7, §10.3): the pure helpers, the body states
 * (loading, error, empty, data, locked premium) and the loader with a fake PassApi.
 */
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PassTierView, PassView } from "@gamez/protocol";
import type { AccountApi, PassApi } from "../src/platform.ts";
import {
  BattlePassBody,
  BattlePassView,
  gemOfferState,
  loadPass,
  passProgress,
  rewardLabel,
  tierCellState,
  timeLeftLabel,
  type PassLoad,
} from "../src/play/BattlePassView.tsx";

const tiers: PassTierView[] = [
  {
    tier: 1,
    xp: 110,
    free: { kind: "cosmetic", sku: "cosmetic.chatColor.amber", name: "Amber", slot: "chatColor" },
    premium: {
      kind: "cosmetic",
      sku: "cosmetic.nameplate.gilded-plate",
      name: "Gilded Plate",
      slot: "nameplate",
    },
  },
  {
    tier: 2,
    xp: 240,
    free: {
      kind: "cosmetic",
      sku: "cosmetic.title.ember-initiate",
      name: "Ember Initiate",
      slot: "title",
    },
    premium: {
      kind: "cosmetic",
      sku: "cosmetic.title.ember-sovereign",
      name: "Ember Sovereign",
      slot: "title",
    },
  },
  { tier: 3, xp: 390, free: { kind: "coin", amount: 30 }, premium: null },
];

function view(over: Partial<PassView> = {}): PassView {
  return {
    seasonId: "2026-s1",
    name: "Season of Embers",
    startsAt: 0,
    endsAt: 1_000_000_000_000,
    xp: 300,
    tier: 2,
    premium: false,
    premiumSku: "pass.premium.2026-s1",
    tiers,
    claimed: { free: [], premium: [] },
    ...over,
  };
}

const NOW = 1_000_000_000_000 - 3 * 86_400_000;

function body(
  state: PassLoad | undefined,
  extra: Partial<Parameters<typeof BattlePassBody>[0]> = {},
) {
  return renderToStaticMarkup(
    <BattlePassBody
      state={state}
      busyKey={null}
      error={null}
      now={NOW}
      onClaim={() => {}}
      onRetry={() => {}}
      {...extra}
    />,
  );
}

/** BattlePassView takes an AccountApi it does not call (the premium purchase goes to the store). */
function fakeAccount(): AccountApi {
  const failed = async () => ({ ok: false as const, code: "unavailable", message: "unused" });
  return { wallet: failed, cosmetics: failed };
}

function fakePass(result: () => unknown): PassApi {
  return {
    view: async () => result() as Awaited<ReturnType<PassApi["view"]>>,
    claim: async () => ({ ok: false, code: "unavailable", message: "not here" }),
  };
}

describe("pass helpers", () => {
  it("labels the time left", () => {
    expect(timeLeftLabel(NOW + 3 * 86_400_000, NOW)).toBe("3 days left");
    expect(timeLeftLabel(NOW + 86_400_000, NOW)).toBe("1 day left");
    expect(timeLeftLabel(NOW + 5 * 3_600_000, NOW)).toBe("5 h left");
    expect(timeLeftLabel(NOW + 40 * 60_000, NOW)).toBe("40 min left");
    expect(timeLeftLabel(NOW - 1, NOW)).toBe("Season ended");
    expect(timeLeftLabel(Number.NaN, NOW)).toBe("Season ended");
  });

  it("names rewards", () => {
    expect(rewardLabel({ kind: "coin", amount: 30 })).toBe("30 coin");
    expect(rewardLabel(tiers[0]!.free)).toBe("Amber");
    expect(rewardLabel(null)).toBe("Nothing");
  });

  it("computes progress toward the next tier", () => {
    // Tier 2 reached at 240 xp; tier 3 at 390; 300 xp is 60 of 150.
    const p = passProgress(view({ xp: 300, tier: 2 }));
    expect(p.tier).toBe(2);
    expect(p.nextXp).toBe(390);
    expect(p.fraction).toBeCloseTo(60 / 150, 5);
  });

  it("reports the top tier as complete", () => {
    const p = passProgress(view({ xp: 9999, tier: 3 }));
    expect(p).toEqual({ tier: 3, maxTier: 3, nextXp: null, fraction: 1 });
  });

  it("classifies tier cells", () => {
    const v = view({ xp: 300, tier: 2, premium: false, claimed: { free: [1], premium: [] } });
    expect(tierCellState(v, "free", 1)).toBe("claimed");
    expect(tierCellState(v, "free", 2)).toBe("claimable");
    expect(tierCellState(v, "free", 3)).toBe("locked");
    expect(tierCellState(v, "premium", 2)).toBe("premium-locked");
    expect(tierCellState(v, "premium", 3)).toBe("empty");
    expect(tierCellState(view({ premium: true }), "premium", 2)).toBe("claimable");
  });
});

describe("BattlePassBody states", () => {
  it("shows a loading status before the view arrives", () => {
    const html = body(undefined);
    expect(html).toContain("Loading the battle pass");
    expect(html).toContain('role="status"');
  });

  it("shows the error with a retry button", () => {
    const html = body({ status: "error", message: "Network error, try again" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Network error, try again");
    expect(html).toContain("Try again");
  });

  it("shows an empty season without tracks", () => {
    const html = body({ status: "ok", view: view({ tiers: [] }) });
    expect(html).toContain("not ready yet");
    expect(html).not.toContain("Tier track");
  });

  it("renders the tier track with the season, xp and time left", () => {
    const html = body({ status: "ok", view: view() });
    expect(html).toContain("Season of Embers");
    expect(html).toContain("3 days left");
    expect(html).toContain("Tier 2");
    expect(html).toContain("300 / 390 xp to tier 3");
    expect(html).toContain('aria-label="Tier track"');
    expect(html).toContain("overflow-x:auto");
  });

  it("offers claim buttons for reached rewards and hides claimed ones", () => {
    const html = body({ status: "ok", view: view({ claimed: { free: [1], premium: [] } }) });
    expect(html).toContain('aria-label="Claim tier 2 free: Ember Initiate"');
    expect(html).not.toContain('aria-label="Claim tier 1 free: Amber"');
    expect(html).toContain("Claimed");
  });

  it("does not offer a claim for a tier not reached", () => {
    const html = body({ status: "ok", view: view() });
    expect(html).not.toContain("Claim tier 3 free");
    expect(html).toContain("Locked");
  });

  it("shows Get premium while the premium track is locked", () => {
    const html = body({ status: "ok", view: view({ premium: false }) }, { onBuyPremium: () => {} });
    expect(html).toContain("Get premium");
    expect(html).toContain('data-state="premium-locked"');
    expect(html).not.toContain("disabled");
  });

  it("disables Get premium when there is no handler, and hides it once premium", () => {
    const locked = body({ status: "ok", view: view({ premium: false }) });
    expect(locked).toContain("Get premium");
    expect(locked).toContain("disabled");
    const owned = body({ status: "ok", view: view({ premium: true }) });
    expect(owned).not.toContain("Get premium");
    expect(owned).toContain("Premium track unlocked");
  });

  it("keeps claim buttons at 44 px", () => {
    const html = body({ status: "ok", view: view() });
    expect(html).toContain("min-height:44px");
  });

  it("shows an error from a failed claim", () => {
    const html = body({ status: "ok", view: view() }, { error: "reach tier 3 first" });
    expect(html).toContain("reach tier 3 first");
  });

  it("marks the claim in flight", () => {
    const html = body({ status: "ok", view: view() }, { busyKey: "free:2" });
    expect(html).toContain("Claiming...");
  });
});

describe("premium for gems", () => {
  it("offers the gem unlock only with enough gems", () => {
    expect(gemOfferState({ price: 500, gems: 700, busy: false })).toEqual({
      label: "Unlock for 500 gems",
      hint: "You have 700 gems.",
      disabled: false,
    });
    expect(gemOfferState({ price: 500, gems: 100, busy: false })).toMatchObject({
      disabled: true,
      hint: "You have 100 gems. Not enough yet.",
    });
    expect(gemOfferState({ price: 500, gems: null, busy: false }).disabled).toBe(true);
    expect(gemOfferState({ price: 500, gems: 900, busy: true })).toMatchObject({
      label: "Unlocking...",
      disabled: true,
    });
  });

  it("renders the gem button beside Get premium when offered", () => {
    const html = body(
      { status: "ok", view: view() },
      { gemOffer: { price: 500, gems: 600, busy: false }, onUnlockWithGems: () => {} },
    );
    expect(html).toContain("Unlock for 500 gems");
    expect(html).toContain("Get premium");
    // Without an offer (guests, older servers) there is no gem button.
    expect(body({ status: "ok", view: view() })).not.toContain("Unlock for");
    // Never on an unlocked pass.
    const owned = body(
      { status: "ok", view: view({ premium: true }) },
      { gemOffer: { price: 500, gems: 600, busy: false }, onUnlockWithGems: () => {} },
    );
    expect(owned).not.toContain("Unlock for");
  });
});

describe("loadPass and the component", () => {
  it("answers the ok view", async () => {
    const res = await loadPass(fakePass(() => ({ ok: true, value: view() })));
    expect(res).toEqual({ status: "ok", view: view() });
  });

  it("turns an API error into an error state", async () => {
    const res = await loadPass(
      fakePass(() => ({ ok: false, code: "unauthorized", message: "sign in first" })),
    );
    expect(res).toEqual({ status: "error", message: "sign in first" });
  });

  it("turns a rejected call into an error state", async () => {
    const api: PassApi = {
      view: () => Promise.reject(new Error("boom")),
      claim: async () => ({ ok: false, code: "x", message: "x" }),
    };
    const res = await loadPass(api);
    expect(res.status).toBe("error");
  });

  it("renders the loading state first with a fake PassApi", () => {
    const html = renderToStaticMarkup(
      <BattlePassView
        pass={fakePass(() => ({ ok: true, value: view() }))}
        account={fakeAccount()}
      />,
    );
    expect(html).toContain("Loading the battle pass");
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  PASS_PREMIUM_GEMS,
  SEASON_TIERS,
  SEASONS,
  currentSeason,
  passReward,
  tierForXp,
  tierXp,
  type SeasonDef,
} from "../src/index.ts";

const S1 = SEASONS[0]!;
const SKU_RE = /^cosmetic\.(title|nameplate|chatColor)\.[a-z0-9]+(-[a-z0-9]+)*$/;

describe("season 2026-s1 definition", () => {
  it("keeps the id, name, dates and premium sku", () => {
    expect(S1.id).toBe("2026-s1");
    expect(S1.name).toBe("Season of Embers");
    expect(S1.startsAt).toBe(1_790_812_800_000);
    expect(S1.endsAt).toBe(1_798_761_600_000);
    expect(S1.premiumSku).toBe("pass.premium.2026-s1");
    expect(PASS_PREMIUM_GEMS).toBe(500);
    expect(SEASON_TIERS).toBe(30);
  });

  it("picks the running season, the latest started one, else the first", () => {
    expect(currentSeason(S1.startsAt + 1).id).toBe("2026-s1");
    expect(currentSeason(0).id).toBe("2026-s1");
    expect(currentSeason(S1.endsAt + 10).id).toBe("2026-s1");
  });
});

describe("cumulative xp curve", () => {
  it("is 100·t + 10·t² for every tier", () => {
    expect(tierXp(1)).toBe(110);
    expect(tierXp(2)).toBe(240);
    expect(tierXp(3)).toBe(390);
    expect(tierXp(5)).toBe(750);
    expect(tierXp(30)).toBe(12_000);
    expect(S1.tiers.map((t) => t.xp)).toEqual(
      Array.from({ length: 30 }, (_, i) => 100 * (i + 1) + 10 * (i + 1) * (i + 1)),
    );
  });

  it("has 30 consecutive tiers with strictly rising xp", () => {
    expect(S1.tiers.map((t) => t.tier)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    for (let i = 1; i < S1.tiers.length; i++) {
      expect(S1.tiers[i]!.xp).toBeGreaterThan(S1.tiers[i - 1]!.xp);
    }
  });
});

describe("tierForXp", () => {
  it("returns the highest tier whose cumulative xp is reached", () => {
    expect(tierForXp(S1, 0)).toBe(0);
    expect(tierForXp(S1, 109)).toBe(0);
    expect(tierForXp(S1, 110)).toBe(1);
    expect(tierForXp(S1, 239)).toBe(1);
    expect(tierForXp(S1, 240)).toBe(2);
    expect(tierForXp(S1, 400)).toBe(3);
    expect(tierForXp(S1, 750)).toBe(5);
    expect(tierForXp(S1, 12_000)).toBe(30);
    expect(tierForXp(S1, 10_000_000)).toBe(30);
  });

  it("treats negative, NaN and infinite xp safely", () => {
    expect(tierForXp(S1, -5)).toBe(0);
    expect(tierForXp(S1, Number.NaN)).toBe(0);
    expect(tierForXp(S1, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("works for a season with no tiers", () => {
    const empty: SeasonDef = { ...S1, tiers: [] };
    expect(tierForXp(empty, 1000)).toBe(0);
    expect(passReward(empty, 1, "free")).toBeNull();
  });
});

describe("rewards", () => {
  it("pins the first rewards of each track", () => {
    expect(passReward(S1, 1, "free")).toEqual({
      kind: "cosmetic",
      sku: "cosmetic.chatColor.amber",
      name: "Amber",
      slot: "chatColor",
    });
    expect(passReward(S1, 2, "free")).toEqual({
      kind: "cosmetic",
      sku: "cosmetic.title.ember-initiate",
      name: "Ember Initiate",
      slot: "title",
    });
    expect(passReward(S1, 5, "free")).toEqual({ kind: "coin", amount: 10 });
    expect(passReward(S1, 1, "premium")).toEqual({
      kind: "cosmetic",
      sku: "cosmetic.nameplate.gilded-plate",
      name: "Gilded Plate",
      slot: "nameplate",
    });
    expect(passReward(S1, 31, "free")).toBeNull();
    expect(passReward(S1, 0, "premium")).toBeNull();
  });

  it("gives coin on every 5th free tier, capped at 50, and nothing else in coin", () => {
    for (const t of S1.tiers) {
      const r = t.free;
      if (t.tier % 5 === 0) {
        expect(r?.kind).toBe("coin");
        if (r?.kind === "coin") {
          expect(r.amount).toBeGreaterThan(0);
          expect(r.amount).toBeLessThanOrEqual(50);
          expect(Number.isSafeInteger(r.amount)).toBe(true);
        }
      } else {
        expect(r?.kind).toBe("cosmetic");
      }
    }
  });

  it("gives a premium cosmetic on every tier", () => {
    for (const t of S1.tiers) {
      expect(t.premium?.kind).toBe("cosmetic");
    }
  });

  it("uses only title, nameplate and chatColor slots, matching the sku", () => {
    for (const t of S1.tiers) {
      for (const r of [t.free, t.premium]) {
        if (!r || r.kind !== "cosmetic") continue;
        expect(r.sku).toMatch(SKU_RE);
        expect(r.sku.startsWith(`cosmetic.${r.slot}.`)).toBe(true);
        expect(r.name.length).toBeGreaterThan(0);
        expect(r.name.length).toBeLessThanOrEqual(40);
      }
    }
  });

  it("gives every reward sku once across the whole season", () => {
    const skus: string[] = [];
    for (const t of S1.tiers) {
      for (const r of [t.free, t.premium]) {
        if (r && r.kind === "cosmetic") skus.push(r.sku);
      }
    }
    expect(new Set(skus).size).toBe(skus.length);
    // 12 free titles + 12 free chat colours + 30 premium cosmetics.
    expect(skus.length).toBe(54);
  });

  it("keeps season skus clear of the premium entitlement sku", () => {
    for (const t of S1.tiers) {
      for (const r of [t.free, t.premium]) {
        if (r && r.kind === "cosmetic") expect(r.sku).not.toBe(S1.premiumSku);
      }
    }
  });
});

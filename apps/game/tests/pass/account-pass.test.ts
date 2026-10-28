/**
 * AccountPass (wave-C.md §7): monotonic season progress per source, idempotent
 * xp, tier notices, claim rules (tier reached, premium gate, replays), and
 * persistence across a reopened store.
 */
import { describe, expect, it } from "vite-plus/test";
import { PASS_PREMIUM_GEMS, SEASON_TIERS } from "@gamez/economy";
import { AccountPass } from "../../src/server/account/pass.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";
import { RecordingNotices, S1_START, fakeAccount } from "./support.ts";

const SKU_PREMIUM = "pass.premium.2026-s1";

describe("seasonProgress", () => {
  it("adds only the positive delta of a source total", () => {
    const a = fakeAccount();
    expect(a.pass.view().xp).toBe(0);
    expect(a.pass.seasonProgress("classic:1", 40).xp).toBe(40);
    expect(a.pass.seasonProgress("classic:1", 40).xp).toBe(40); // replay adds nothing
    expect(a.pass.seasonProgress("classic:1", 55).xp).toBe(55);
  });

  it("resets the baseline without adding xp when the total goes down", () => {
    const a = fakeAccount();
    a.pass.seasonProgress("classic:1", 100);
    expect(a.pass.seasonProgress("classic:1", 30).xp).toBe(100);
    // The new baseline is 30, so the next rise counts from there.
    expect(a.pass.seasonProgress("classic:1", 45).xp).toBe(115);
  });

  it("keeps a baseline per source", () => {
    const a = fakeAccount();
    a.pass.seasonProgress("classic:1", 20);
    a.pass.seasonProgress("classic:2", 20);
    expect(a.pass.view().xp).toBe(40);
  });

  it("ignores invalid totals", () => {
    const a = fakeAccount();
    expect(a.pass.seasonProgress("classic:1", -5).xp).toBe(0);
    expect(a.pass.seasonProgress("classic:1", 1.5).xp).toBe(0);
    expect(a.pass.seasonProgress("classic:1", Number.NaN).xp).toBe(0);
    expect(a.pass.seasonProgress("", 10).xp).toBe(0);
    expect(a.pass.seasonProgress("classic:1", 10).xp).toBe(10);
  });
});

describe("addXp", () => {
  it("is idempotent by txId", () => {
    const a = fakeAccount();
    expect(a.pass.addXp("arena:m1:xp", 25, "arena").xp).toBe(25);
    expect(a.pass.addXp("arena:m1:xp", 25, "arena").xp).toBe(25);
    expect(a.pass.addXp("arena:m2:xp", 25, "arena").xp).toBe(50);
  });

  it("refuses xp outside 1..10000 and bad txIds", () => {
    const a = fakeAccount();
    expect(a.pass.addXp("t1", 0, "x").xp).toBe(0);
    expect(a.pass.addXp("t1", 10_001, "x").xp).toBe(0);
    expect(a.pass.addXp("t1", -3, "x").xp).toBe(0);
    expect(a.pass.addXp("t1", 2.5, "x").xp).toBe(0);
    expect(a.pass.addXp("", 5, "x").xp).toBe(0);
    expect(a.pass.addXp("t1", 10_000, "x").xp).toBe(10_000);
  });
});

describe("tiers and notices", () => {
  it("reports the tier from the xp curve", () => {
    const a = fakeAccount();
    expect(a.pass.addXp("t1", 110, "x").tier).toBe(1);
    expect(a.pass.addXp("t2", 129, "x").tier).toBe(1); // 239
    expect(a.pass.addXp("t3", 1, "x").tier).toBe(2); // 240
  });

  it("sends one pass.tier notice per crossed tier, idempotent by id", () => {
    const a = fakeAccount();
    a.pass.addXp("t1", 110, "x");
    expect(a.notices.tierIds()).toEqual([`pass:2026-s1:1`]);
    a.pass.addXp("t2", 280, "x"); // 390 total: tiers 2 and 3
    expect(a.notices.tierIds()).toEqual(["pass:2026-s1:1", "pass:2026-s1:2", "pass:2026-s1:3"]);
    a.pass.addXp("t3", 5, "x"); // no new tier
    expect(a.notices.tierIds()).toHaveLength(3);
    const notice = a.notices.all[0]!;
    expect(notice.kind).toBe("pass.tier");
    expect(notice.text.length).toBeLessThanOrEqual(140);
    expect(notice.data).toMatchObject({ season: "2026-s1", tier: 1 });
  });

  it("notifies from season progress too", () => {
    const a = fakeAccount();
    a.pass.seasonProgress("classic:9", 240);
    expect(a.notices.tierIds()).toEqual(["pass:2026-s1:1", "pass:2026-s1:2"]);
  });

  it("does not notify on a replayed or invalid call", () => {
    const a = fakeAccount();
    a.pass.addXp("t1", 500, "x");
    const before = a.notices.all.length;
    a.pass.addXp("t1", 500, "x");
    a.pass.addXp("t2", 0, "x");
    a.pass.seasonProgress("s", -1);
    expect(a.notices.all.length).toBe(before);
  });
});

describe("claim", () => {
  it("refuses a tier that is not reached yet", () => {
    const a = fakeAccount();
    const r = a.pass.claim(1, "free");
    expect(r).toMatchObject({ ok: false, code: "too_low" });
  });

  it("refuses unknown tiers and tracks", () => {
    const a = fakeAccount();
    a.pass.addXp("t", 10_000, "x");
    expect(a.pass.claim(0, "free")).toMatchObject({ ok: false, code: "not_found" });
    expect(a.pass.claim(SEASON_TIERS + 1, "free")).toMatchObject({ ok: false, code: "not_found" });
    expect(a.pass.claim(1.5, "free")).toMatchObject({ ok: false, code: "not_found" });
    expect(a.pass.claim(1, "gold" as "free")).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("grants a free cosmetic as an entitlement, once", () => {
    const a = fakeAccount();
    a.pass.addXp("t", 400, "x"); // tier 3
    const first = a.pass.claim(1, "free");
    expect(first.ok).toBe(true);
    expect(a.economy.cosmetics().owned).toEqual(["cosmetic.chatColor.amber"]);
    expect(a.pass.view().claimed).toEqual({ free: [1], premium: [] });

    const again = a.pass.claim(1, "free");
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(a.economy.entitlements()).toHaveLength(1);
  });

  it("credits coin for a coin tier, once", () => {
    const a = fakeAccount();
    a.pass.addXp("t", 750, "x"); // tier 5 reached (750 xp)
    expect(a.pass.claim(5, "free").ok).toBe(true);
    expect(a.economy.wallet().balances.coin).toBe(10);
    expect(a.pass.claim(5, "free")).toMatchObject({ ok: true, replayed: true });
    expect(a.economy.wallet().balances.coin).toBe(10);
  });

  it("refuses the premium track without the premium entitlement", () => {
    const a = fakeAccount();
    a.pass.addXp("t", 400, "x");
    expect(a.pass.claim(1, "premium")).toMatchObject({ ok: false, code: "forbidden" });
    expect(a.pass.view().premium).toBe(false);
  });

  it("unlocks the premium track with the premium entitlement", () => {
    const a = fakeAccount();
    a.pass.addXp("t", 400, "x");
    a.economy.grantEntitlement({ txId: "buy-1", sku: SKU_PREMIUM, source: "store" });
    expect(a.pass.view().premium).toBe(true);
    expect(a.pass.claim(1, "premium").ok).toBe(true);
    expect(a.economy.cosmetics().owned).toContain("cosmetic.nameplate.gilded-plate");
    expect(a.pass.view().claimed).toEqual({ free: [], premium: [1] });
  });

  it("keeps the claimed lists sorted per track", () => {
    const a = fakeAccount();
    a.pass.addXp("t", 2000, "x");
    a.pass.claim(3, "free");
    a.pass.claim(1, "free");
    expect(a.pass.view().claimed.free).toEqual([1, 3]);
  });
});

describe("persistence and seasons", () => {
  it("keeps xp and claims after reopening the same store", () => {
    const store = fakeSqlStore();
    const first = fakeAccount(store);
    first.pass.addXp("t", 400, "x");
    first.pass.seasonProgress("classic:5", 12);
    first.pass.claim(1, "free");

    // A restart: new classes over the same storage.
    const again = fakeAccount(store, new RecordingNotices());
    expect(again.pass.view()).toMatchObject({ xp: 412, tier: 3, claimed: { free: [1] } });
    // The source baseline survived too: the same total adds nothing.
    expect(again.pass.seasonProgress("classic:5", 12).xp).toBe(412);
  });

  it("keeps reading the same season rows from a fresh object", () => {
    const a = fakeAccount();
    a.pass.addXp("t", 400, "x");
    a.now.value = S1_START + 1_000 + 3_000_000_000_000; // far in the future: still the only season
    expect(a.pass.view().seasonId).toBe("2026-s1");
    expect(a.pass.view().xp).toBe(400);
    // A fresh pass object over the same store reads the same rows for the same season.
    expect(
      new AccountPass(a.store, a.economy, a.vault, a.notices as never, () => S1_START).view().xp,
    ).toBe(400);
  });

  it("uses the season tiers and premium sku of the definition", () => {
    const a = fakeAccount();
    const v = a.pass.view();
    expect(v).toMatchObject({
      seasonId: "2026-s1",
      name: "Season of Embers",
      premiumSku: SKU_PREMIUM,
      premium: false,
      tier: 0,
    });
    expect(v.tiers).toHaveLength(30);
    expect(PASS_PREMIUM_GEMS).toBe(500);
  });
});

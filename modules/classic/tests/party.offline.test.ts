/**
 * Party offline progress (docs/design/party.md §6.8 with the offline/idle
 * grant of docs/design/offline-idle.md §4.2), real content with every classic
 * module. classic.offlineProgress for a party of three:
 * - computes kills, gold and items for the party (the measured rate, else the
 *   party model scaled by the party's loot %), gold into the purse (the
 *   founder's Wallet; followers have none);
 * - splits the XP per standing member, each with its own share, and the
 *   offline XP factor (BalanceProto.offlineXpPct, or the admin tunable passed
 *   as xpPct) applies to every member;
 * - keeps the solo classic.offline.summary shape (party totals);
 * - a downed follower gets no share; a dead controlled hero (a wipe) is
 *   respawned with the whole party first (§4.4), like a solo hero.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { computePartyOffline, offlineGrant, partyOfflineGrant } from "../src/auto/offline.ts";
import { AUTO_RATE_MIN_TICKS } from "../src/auto/rate.ts";
import { Dead, Level, Life, Wallet } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { partyGold, partyMembers, purseOf } from "../src/party/shared.ts";
import { heroOf, RES, type AutoRate, type GameState } from "../src/resources.ts";
import { xpAtLevel } from "../src/rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../src/types.ts";

const loaded = loadMode(mode, modules);
const bal = loaded.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
const NAMES = ["Brannoc", "Ysolde", "Corvin"];
const HOUR = 3_600_000;
const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer"];

function setPurse(sim: Sim, gold: number): void {
  sim.world.update(purseOf(sim.world), Wallet, { gold });
}

function recruitParty(seed: number, classes: readonly string[] = CLASSES): Sim {
  const sim = createSim(loaded, { seed });
  expect(sim.dispatch("classic.newHero", { classId: classes[0], name: NAMES[0] }, null).ok).toBe(
    true,
  );
  sim.step(2);
  for (let i = 1; i < classes.length; i++) {
    setPurse(sim, 1_000_000);
    expect(sim.dispatch("classic.party.buySlot", {}, null).ok).toBe(true);
    expect(
      sim.dispatch("classic.party.recruit", { classId: classes[i], name: NAMES[i] }, null).ok,
    ).toBe(true);
    sim.step(2);
  }
  setPurse(sim, 100);
  sim.step(2);
  return sim;
}

function kill(sim: Sim, e: number): void {
  sim.world.update(e, Life, { hp: 0 });
  sim.world.add(e, Dead, { at: sim.tick, killer: 0 });
}

type Summary = Record<string, unknown> & { kills: number; xp: number; gold: number };

function summary(events: readonly GameEvent[]): Summary {
  const e = events.find((x) => x.type === "classic.offline.summary");
  expect(e, "summary event").toBeDefined();
  return e as unknown as Summary;
}

const xpOf = (sim: Sim, e: number): number => sim.world.read(e, Level).xp;

describe("party offline progress", () => {
  it("splits XP per member with the offline factor, gold in the purse, the solo summary shape", () => {
    const sim = recruitParty(4);
    const members = partyMembers(sim.world);
    expect(members).toHaveLength(3);
    const xp0 = members.map((e) => xpOf(sim, e));
    const gold0 = partyGold(sim.world);
    const plan = partyOfflineGrant(sim.world, sim.loaded.registry, HOUR);
    expect(plan.grant.source).toBe("model");
    expect(plan.grant.xpPct).toBe(bal.offlineXpPct);
    expect(plan.shares.map((s) => s.hero)).toEqual(members);
    // The solo grant for the same (controlled) hero, before anything is granted.
    const solo = offlineGrant(sim.world, sim.loaded.registry, heroOf(sim.world), HOUR);

    const r = sim.dispatch("classic.offlineProgress", { elapsedMs: HOUR }, null);
    expect(r.ok).toBe(true);
    const events = [...r.events, ...sim.step(2)];
    const sum = summary(events);
    // Same keys as a solo grant's summary (the away card reads one shape).
    const soloSim = createSim(loaded, { seed: 4 });
    soloSim.dispatch("classic.newHero", { classId: CLASSES[0], name: "Solo" }, null);
    soloSim.step(2);
    const soloSum = summary(
      soloSim.dispatch("classic.offlineProgress", { elapsedMs: HOUR }, null).events,
    );
    expect(Object.keys(sum).sort()).toEqual(Object.keys(soloSum).sort());
    expect(sum.kills).toBe(plan.grant.kills);
    expect(sum.xp).toBe(plan.shares.reduce((a, s) => a + s.xp, 0));
    expect(sum.xpPct).toBe(bal.offlineXpPct);

    // Every member got its own share (no XP pooled on the founder).
    members.forEach((e, i) => {
      const got = xpOf(sim, e) - xp0[i]!;
      expect(got, `member ${i} xp`).toBe(plan.shares[i]!.xp);
      expect(got).toBeGreaterThan(0);
    });
    // Gold went to the purse; followers still have no Wallet.
    expect(purseOf(sim.world)).toBe(members[0]);
    expect(partyGold(sim.world)).toBe(gold0 + sum.gold);
    for (const e of members.slice(1)) expect(sim.world.has(e, Wallet)).toBe(false);

    console.log(
      `PARTYOFFLINE kills=${plan.grant.kills} (solo ${solo.kills}) xp=${plan.shares
        .map((s) => s.xp)
        .join("/")} (solo ${solo.xp}) gold=${plan.grant.gold} (solo ${solo.gold}) items=${
        plan.grant.items
      } (solo ${solo.items})`,
    );
    // The party kills at least as fast as its leader alone; each member's share
    // of a kill is xpPct x xpSharePct (about 0.95 for three), so a member earns
    // about the solo rate, never the party's pooled XP.
    expect(plan.grant.kills).toBeGreaterThanOrEqual(solo.kills);
    const ratio = plan.shares[0]!.xp / solo.xp;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(2);
    // Gold scales with lootPct: more in total than solo, less than 3x.
    expect(plan.grant.gold).toBeGreaterThan(solo.gold);
    expect(plan.grant.gold).toBeLessThan(3 * solo.gold);
  }, 120_000);

  it("the offline XP factor (admin tunable xpPct) applies to every member", () => {
    const sim = recruitParty(5);
    const full = partyOfflineGrant(sim.world, sim.loaded.registry, HOUR, 100);
    const twenty = partyOfflineGrant(sim.world, sim.loaded.registry, HOUR, 20);
    const none = partyOfflineGrant(sim.world, sim.loaded.registry, HOUR, 0);
    expect(full.shares).toHaveLength(3);
    full.shares.forEach((s, i) => {
      expect(s.xp).toBeGreaterThan(0);
      expect(twenty.shares[i]!.xp).toBe(Math.floor((s.xp * 20) / 100));
      expect(none.shares[i]!.xp).toBe(0);
    });
    // Gold, items and kills are not scaled by the XP factor.
    expect(none.grant.gold).toBe(full.grant.gold);
    expect(none.grant.kills).toBe(full.grant.kills);
    expect(none.grant.items).toBe(full.grant.items);

    const members = partyMembers(sim.world);
    const xp0 = members.map((e) => xpOf(sim, e));
    const r = sim.dispatch("classic.offlineProgress", { elapsedMs: HOUR, xpPct: 0 }, "server");
    expect(r.ok).toBe(true);
    sim.step(2);
    members.forEach((e, i) => expect(xpOf(sim, e)).toBe(xp0[i]));
  }, 120_000);

  it("with a measured rate, each member gets the measured pool times its own share of a kill", () => {
    const sim = recruitParty(7);
    const model = computePartyOffline(sim.world, sim.loaded.registry, HOUR);
    const plain = partyOfflineGrant(sim.world, sim.loaded.registry, HOUR, 100);
    // A measured online rate: the party's kills and their raw XP pool.
    const rate: AutoRate = {
      ticks: AUTO_RATE_MIN_TICKS * 2,
      kills: 200,
      xp: 2_000,
      pool: 2_400,
      gold: 3_000,
      loot: 0,
      upkeep: 600,
      spent: 0,
    };
    sim.world.setResource(RES.autoRate, rate);
    const plan = partyOfflineGrant(sim.world, sim.loaded.registry, HOUR, 100);
    expect(plan.grant.source).toBe("rate");
    const T = 60 * 1200;
    expect(plan.grant.kills).toBe(
      Math.min(Math.floor((rate.kills * T) / rate.ticks), plain.grant.kills * 3),
    );
    const poolXp = Math.floor((rate.pool! * T) / rate.ticks);
    expect(model.poolPerKill).toBeGreaterThan(0);
    plan.shares.forEach((s, i) => {
      const cap = Math.floor((model.shares[i]!.xp * bal.offlineModelXpPct) / 100) * 3;
      expect(s.xp).toBe(
        Math.min(Math.floor((poolXp * model.perKill[i]!) / model.poolPerKill), cap),
      );
      expect(s.xp).toBeGreaterThan(0);
    });
    // Same-level members get the same share.
    const level = (e: number) => sim.world.read(e, Level).level;
    for (const a of plan.shares)
      for (const b of plan.shares) if (level(a.hero) === level(b.hero)) expect(a.xp).toBe(b.xp);
    expect(plan.grant.upkeep).toBe(Math.floor((600 * T) / rate.ticks));
    // A rate measured before the pool existed pays the model.
    const { pool: _pool, ...old } = rate;
    sim.world.setResource(RES.autoRate, old);
    const legacy = partyOfflineGrant(sim.world, sim.loaded.registry, HOUR, 100);
    legacy.shares.forEach((s, i) =>
      expect(s.xp).toBe(Math.floor((model.shares[i]!.xp * bal.offlineModelXpPct) / 100)),
    );
  }, 120_000);

  it("the same measured rate pays every member the same whichever member is controlled", () => {
    // Founder L12 and two L9 recruits (finding: switching control to the
    // founder before the grant multiplied every member's offline XP).
    const sim = recruitParty(9);
    const members = partyMembers(sim.world);
    const levels = [12, 9, 9];
    members.forEach((e, i) =>
      sim.world.update(e, Level, { level: levels[i]!, xp: xpAtLevel(bal, levels[i]!) }),
    );
    sim.world.setResource(RES.autoRate, {
      ticks: 12_000,
      kills: 300,
      xp: 300 * 4,
      pool: 300 * 6,
      gold: 0,
      loot: 0,
      upkeep: 0,
      spent: 0,
    } satisfies AutoRate);
    const grantWith = (controlled: number): number[] => {
      const game = sim.world.getResource<GameState>(RES.game)!;
      sim.world.setResource(RES.game, { ...game, hero: controlled });
      return partyOfflineGrant(sim.world, sim.loaded.registry, HOUR, 20).shares.map((s) => s.xp);
    };
    const onRecruit = grantWith(members[1]!);
    const onFounder = grantWith(members[0]!);
    expect(onRecruit.every((x) => x > 0)).toBe(true);
    expect(onFounder).toEqual(onRecruit);
  }, 120_000);

  it("a downed follower gets no share; a wiped party respawns and every member gets one", () => {
    const sim = recruitParty(6);
    const [a, b, c] = partyMembers(sim.world) as [number, number, number];
    kill(sim, c);
    const plan = partyOfflineGrant(sim.world, sim.loaded.registry, HOUR);
    expect(plan.shares.map((s) => s.hero)).toEqual([a, b]);
    kill(sim, a);
    kill(sim, b);
    sim.step(1);
    const xp0 = [a, b, c].map((e) => xpOf(sim, e));
    const r = sim.dispatch("classic.offlineProgress", { elapsedMs: HOUR }, null);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.events.some((e) => e.type === "classic.hero.respawned")).toBe(true);
    sim.step(2);
    for (const e of [a, b, c]) expect(sim.world.has(e, Dead)).toBe(false);
    [a, b, c].forEach((e, i) => expect(xpOf(sim, e)).toBeGreaterThan(xp0[i]!));
  }, 120_000);
});

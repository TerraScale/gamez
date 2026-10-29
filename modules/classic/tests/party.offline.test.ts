/**
 * Party offline progress (T-auto, docs/design/party.md §6.8), real content
 * with every classic module: classic.offlineProgress for a party of three
 * splits the XP per standing member (partyKillXp for each member's own
 * level), puts the gold in the purse (the founder's Wallet; followers have
 * none) and keeps the classic.offline.summary shape with party totals.
 * The solo game keeps its own model (computeOffline) unchanged. Measured
 * (seed 4, level 1, one hour): party kills 2280 vs solo 1620, 20 520 XP
 * per member vs 14 580 solo, gold 13 484 vs 5 451.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { computeOffline, computePartyOffline } from "../src/auto/offline.ts";
import { Dead, Level, Life, Wallet } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { partyGold, partyMembers, purseOf } from "../src/party/shared.ts";
import { heroOf } from "../src/resources.ts";

const loaded = loadMode(mode, modules);
const NAMES = ["Brannoc", "Ysolde", "Corvin"];
const HOUR = 3_600_000;

function setPurse(sim: Sim, gold: number): void {
  sim.world.update(purseOf(sim.world), Wallet, { gold });
}

function recruitParty(seed: number, classes: readonly string[]): Sim {
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

interface Summary {
  type: string;
  ms: number;
  depth: number;
  kills: number;
  xp: number;
  gold: number;
  items: number;
  levels: number;
}

function summary(events: readonly GameEvent[]): Summary {
  const e = events.find((x) => x.type === "classic.offline.summary");
  expect(e, "summary event").toBeDefined();
  return e as unknown as Summary;
}

const xpOf = (sim: Sim, e: number): number => sim.world.read(e, Level).xp;

describe("party offline progress", () => {
  it("splits XP per member, puts gold in the purse, summary of party totals", () => {
    const sim = recruitParty(4, ["classic.warrior", "classic.rogue", "classic.sorcerer"]);
    const members = partyMembers(sim.world);
    expect(members).toHaveLength(3);
    const xp0 = members.map((e) => xpOf(sim, e));
    const gold0 = partyGold(sim.world);
    const plan = computePartyOffline(sim.world, sim.loaded.registry, HOUR);
    expect(plan.shares.map((s) => s.hero)).toEqual(members);
    // The solo model for the same (controlled) hero, before anything is granted.
    const solo = computeOffline(sim.world, sim.loaded.registry, heroOf(sim.world), HOUR);

    const r = sim.dispatch("classic.offlineProgress", { elapsedMs: HOUR }, null);
    expect(r.ok).toBe(true);
    const events = [...r.events, ...sim.step(2)];
    const sum = summary(events);
    expect(Object.keys(sum).sort()).toEqual(
      ["depth", "gold", "items", "kills", "levels", "ms", "type", "xp"].sort(),
    );
    expect(sum.kills).toBe(plan.result.kills);
    expect(sum.xp).toBe(plan.shares.reduce((a, s) => a + s.xp, 0));

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

    // The party kills more than its leader would alone, but each member earns less per kill.
    console.log(
      `PARTYOFFLINE kills=${plan.result.kills} (solo ${solo.kills}) xp=${plan.shares
        .map((s) => s.xp)
        .join("/")} (solo ${solo.xp}) gold=${plan.result.gold} (solo ${solo.gold}) items=${
        plan.result.items
      } (solo ${solo.items})`,
    );
    expect(plan.result.kills).toBeGreaterThan(solo.kills);
    // §8: a member's share of a kill is xpPct x xpSharePct (1.75 x 0.62 for three), and the
    // party kills faster, so each member earns 1x..2x the solo rate, never 3x (no XP pooling).
    const ratio = plan.shares[0]!.xp / solo.xp;
    expect(ratio).toBeGreaterThanOrEqual(1);
    expect(ratio).toBeLessThan(2);
    // Gold scales with lootPct and the kill rate: more in total, less per member than solo.
    expect(plan.result.gold).toBeGreaterThan(solo.gold);
    expect(plan.result.gold).toBeLessThan(3 * solo.gold);
  }, 120_000);

  it("a downed member gets no share; a wiped party is refused", () => {
    const sim = recruitParty(6, ["classic.warrior", "classic.rogue", "classic.sorcerer"]);
    const [a, b, c] = partyMembers(sim.world) as [number, number, number];
    sim.world.update(c, Life, { hp: 0 });
    sim.world.add(c, Dead, { at: sim.tick, killer: 0 });
    const plan = computePartyOffline(sim.world, sim.loaded.registry, HOUR);
    expect(plan.shares.map((s) => s.hero)).toEqual([a, b]);
    for (const e of [a, b]) {
      sim.world.update(e, Life, { hp: 0 });
      sim.world.add(e, Dead, { at: sim.tick, killer: 0 });
    }
    const before = sim.hash();
    const r = sim.dispatch("classic.offlineProgress", { elapsedMs: HOUR }, null);
    expect(r.ok).toBe(false);
    expect(sim.hash()).toBe(before);
  }, 120_000);
});

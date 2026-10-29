/**
 * Party-aware platform reads and the bank (docs/design/party.md §7.4, §9):
 * - classicReports: one classic_hero row per member, keyed "hero" for the
 *   founder and "hero:<uid>" for the others; kills/deaths per member;
 *   depth, rifts and play time party-wide; the solo row unchanged.
 * - classicSeasonTotal: the founder's level, so the total never depends on
 *   who is controlled and never drops when a member is dismissed.
 * - classicArenaBuild: the controlled hero, for every control choice.
 * - classic.bank: gold moves to and from the founder's purse whichever member
 *   is controlled; a party without gold still refuses the deposit.
 *
 * Parties are built with the harness (spawnTestParty), so these tests do not
 * depend on the party actions.
 */
import { createSim, loadMode, type GameEvent, type Sim, type World } from "@gamez/kernel";
import { BANK_ACTOR } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { ACTION, ERR } from "../src/actions.ts";
import { Hero, Level, PartyMember, Wallet } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { partyMembers, purseOf } from "../src/party/shared.ts";
import { BANK_ACTION, BANK_EVENT, bankFee, type ClassicBankEvent } from "../src/platform/bank.ts";
import { classicArenaBuild } from "../src/platform/build.ts";
import {
  classicClientDriven,
  classicOfflineEligible,
  classicSpeedOf,
  MAX_INPUTS_PER_SEGMENT,
} from "../src/platform/policy.ts";
import { classicReports, heroKey, type ClassicHeroReport } from "../src/platform/reports.ts";
import { classicSeasonTotal, SEASON_WEIGHTS } from "../src/platform/season.ts";
import { RES, type ControlState, type DungeonState, type RunStats } from "../src/resources.ts";
import { spawnTestHero, spawnTestParty, type TestHeroOptions } from "./support/harness.ts";

const SEED = 2027;
const loaded = loadMode(mode, modules);
const registry = loaded.registry;

/** A fresh classic sim with a party of `heroes` built by the harness (controlled = index). */
function partySim(
  heroes: TestHeroOptions[],
  controlled = 0,
  names: string[] = [],
): { sim: Sim; ents: number[] } {
  const sim = createSim(loaded, { seed: SEED });
  const ents = spawnTestParty(sim.world, heroes, { controlled });
  names.forEach((n, i) => {
    if (n) sim.world.update(ents[i]!, Hero, { name: n });
  });
  return { sim, ents };
}

const TRIO: TestHeroOptions[] = [
  { classId: "classic.warrior", level: 5, gold: 5000 },
  { classId: "classic.rogue", level: 4 },
  { classId: "classic.sorcerer", level: 3 },
];

function reportsOf(world: World) {
  return classicReports(world, registry);
}

function heroRows(world: World) {
  return reportsOf(world).filter((r) => r.table === "classic_hero");
}

describe("party classic_hero reports", () => {
  it("heroKey: the founder keeps the key 'hero', members use their uid", () => {
    expect(heroKey(7, 7, { uid: 0 }, 0)).toBe("hero");
    expect(heroKey(7, 9, { uid: 2 }, 1)).toBe("hero:2");
    expect(heroKey(7, 9, undefined, 3)).toBe("hero:s3");
  });

  it("emits one hero row per member in slot order, keyed hero and hero:<uid>", () => {
    const { sim, ents } = partySim(TRIO, 0, ["Ardane", "Brannoc", "Sela"]);
    const rows = heroRows(sim.world);
    expect(rows.map((r) => r.key)).toEqual(["hero", "hero:1", "hero:2"]);
    expect(rows.map((r) => (r.data as unknown as ClassicHeroReport).heroName)).toEqual([
      "Ardane",
      "Brannoc",
      "Sela",
    ]);
    expect(rows.map((r) => (r.data as unknown as ClassicHeroReport).level)).toEqual([5, 4, 3]);
    expect(ents).toHaveLength(3);
  });

  it("the row keys do not depend on which hero is controlled", () => {
    const a = heroRows(partySim(TRIO, 0).sim.world).map((r) => r.key);
    const b = heroRows(partySim(TRIO, 2).sim.world).map((r) => r.key);
    expect(a).toEqual(["hero", "hero:1", "hero:2"]);
    expect(b).toEqual(a);
  });

  it("kills and deaths come from each member's PartyMember", () => {
    const { sim, ents } = partySim(TRIO, 0);
    sim.world.update(ents[1]!, PartyMember, { kills: 11, deaths: 2 });
    sim.world.update(ents[2]!, PartyMember, { kills: 4, deaths: 0 });
    const data = heroRows(sim.world).map((r) => r.data as unknown as ClassicHeroReport);
    expect(data.map((d) => [d.kills, d.deaths])).toEqual([
      [0, 0],
      [11, 2],
      [4, 0],
    ]);
  });

  it("depth, rifts and play time are party-wide and identical on every row", () => {
    const { sim } = partySim(TRIO, 1);
    sim.world.getResource<DungeonState>(RES.dungeon)!.deepest = 6;
    sim.world.getResource<RunStats>(RES.stats)!.ticksPlayed = 900;
    const data = heroRows(sim.world).map((r) => r.data as unknown as ClassicHeroReport);
    expect(data.every((d) => d.deepestDepth === 6)).toBe(true);
    expect(data.every((d) => d.playTicks === 900)).toBe(true);
  });

  it("a solo hero keeps its single 'hero' row with the run-stat kills and deaths", () => {
    // No party resource and no PartyMember: the solo save shape.
    const sim = createSim(loaded, { seed: SEED });
    spawnTestHero(sim.world, { classId: "classic.warrior", level: 2 });
    sim.world.getResource<RunStats>(RES.stats)!.kills = 9;
    sim.world.getResource<RunStats>(RES.stats)!.deaths = 1;
    const rows = heroRows(sim.world);
    expect(rows.map((r) => r.key)).toEqual(["hero"]);
    const d = rows[0]!.data as unknown as ClassicHeroReport;
    expect([d.kills, d.deaths, d.level]).toEqual([9, 1, 2]);
  });

  it("a member with no PartyMember falls back to the run stats", () => {
    const { sim, ents } = partySim(TRIO, 0);
    sim.world.remove(ents[1]!, PartyMember);
    sim.world.getResource<RunStats>(RES.stats)!.kills = 3;
    const row = heroRows(sim.world).find((r) => r.key === "hero:s1");
    expect((row!.data as unknown as ClassicHeroReport).kills).toBe(3);
  });

  it("rift rows are unchanged by the party (one per history record)", () => {
    const { sim } = partySim(TRIO, 0);
    const rift = {
      unlocked: true,
      maxCompleted: 1,
      best: null,
      history: [],
      active: null,
      nextRun: 1,
    };
    sim.world.setResource(RES.rift, rift);
    expect(reportsOf(sim.world).filter((r) => r.table === "leaderboard_rift")).toEqual([]);
  });
});

describe("party season total", () => {
  it("uses the founder's level, not the controlled hero's", () => {
    const a = partySim(TRIO, 0).sim;
    const b = partySim(TRIO, 2).sim;
    const ta = classicSeasonTotal(a.world, registry)!;
    const tb = classicSeasonTotal(b.world, registry)!;
    expect(tb).toEqual(ta);
    // Founder level 5: four levels above 1, weighted.
    expect(ta.total).toBe(SEASON_WEIGHTS.level * 4);
    expect(ta.key.startsWith("classic:")).toBe(true);
  });

  it("does not drop when the party grows or a member is dismissed (founder unchanged)", () => {
    const solo = partySim([TRIO[0]!]).sim;
    const party = partySim(TRIO, 0).sim;
    expect(classicSeasonTotal(party.world, registry)!.total).toBe(
      classicSeasonTotal(solo.world, registry)!.total,
    );
  });

  it("adds the party's kills and rifts to the total (party-wide counters)", () => {
    const { sim } = partySim(TRIO, 0);
    const stats = sim.world.getResource<RunStats>(RES.stats)!;
    stats.kills = 10;
    stats.riftsCompleted = 2;
    const base = SEASON_WEIGHTS.level * 4;
    expect(classicSeasonTotal(sim.world, registry)!.total).toBe(
      10 * SEASON_WEIGHTS.kill + base + 2 * SEASON_WEIGHTS.rift,
    );
  });

  it("returns null before a hero exists", () => {
    const sim = createSim(loaded, { seed: SEED });
    expect(classicSeasonTotal(sim.world, registry)).toBeNull();
  });
});

describe("party arena build", () => {
  it("builds the controlled hero, whichever member it is", () => {
    for (const controlled of [0, 1, 2]) {
      const { sim } = partySim(TRIO, controlled, ["Ardane", "Brannoc", "Sela"]);
      const build = classicArenaBuild(sim.world, registry);
      expect(build).not.toBeNull();
      const expected = ["classic.warrior", "classic.rogue", "classic.sorcerer"][controlled];
      expect(build!.classId).toBe(expected);
      expect(build!.name).toBe(["Ardane", "Brannoc", "Sela"][controlled]);
    }
  });

  it("returns null without a hero", () => {
    const sim = createSim(loaded, { seed: SEED });
    expect(classicArenaBuild(sim.world, registry)).toBeNull();
  });
});

describe("party bank (gold on the purse)", () => {
  const opId = (n: number) => `party_bank_${String(n).padStart(4, "0")}`;

  function bank(sim: Sim, payload: unknown) {
    return sim.dispatch(BANK_ACTION, payload, BANK_ACTOR);
  }

  function bankEvent(events: readonly GameEvent[]): ClassicBankEvent {
    const evs = events.filter((e) => e.type === BANK_EVENT);
    expect(evs).toHaveLength(1);
    return evs[0] as unknown as ClassicBankEvent;
  }

  it("the purse is the founder for every control choice", () => {
    for (const controlled of [0, 1, 2]) {
      const { sim, ents } = partySim(TRIO, controlled);
      expect(purseOf(sim.world)).toBe(ents[0]);
      expect(sim.world.has(ents[1]!, Wallet)).toBe(false);
    }
  });

  it("deposits gold from the founder's purse while a member is controlled", () => {
    const { sim, ents } = partySim(TRIO, 2);
    const r = bank(sim, { opId: opId(1), op: { kind: "depositGold", gold: 1000 } });
    expect(r.ok).toBe(true);
    expect(sim.world.get(ents[0]!, Wallet)!.gold).toBe(5000 - 1000);
    const ev = bankEvent(r.events);
    expect(ev.gold).toBe(1000);
    expect(ev.credit).toEqual({ coin: 1000 - bankFee(1000) });
  });

  it("withdraws coin into the founder's purse while a member is controlled", () => {
    const { sim, ents } = partySim(TRIO, 1);
    const r = bank(sim, { opId: opId(2), op: { kind: "withdrawCoin", coin: 300 } });
    expect(r.ok).toBe(true);
    expect(sim.world.get(ents[0]!, Wallet)!.gold).toBe(5300);
    expect(sim.world.has(ents[1]!, Wallet)).toBe(false);
    expect(bankEvent(r.events).gold).toBe(-300);
  });

  it("refuses a deposit larger than the purse, with no change", () => {
    const { sim, ents } = partySim(
      [
        { classId: "classic.warrior", level: 5, gold: 100 },
        { classId: "classic.rogue", level: 4 },
      ],
      1,
    );
    const before = sim.hash();
    const r = bank(sim, { opId: opId(3), op: { kind: "depositGold", gold: 500 } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(ERR.noGold);
    expect(sim.world.get(ents[0]!, Wallet)!.gold).toBe(100);
    expect(sim.hash()).toBe(before);
  });
});

describe("party sanity", () => {
  it("partyMembers and the founder agree with the harness", () => {
    const { sim, ents } = partySim(TRIO, 1);
    expect(partyMembers(sim.world)).toEqual(ents);
    expect(sim.world.get(ents[2]!, Level)!.level).toBe(3);
    expect(sim.world.get(ents[2]!, PartyMember)!.uid).toBe(2);
  });
});

describe("party verification policy", () => {
  it("party actions are client-driven (replayed), not server-only", () => {
    const serverOnly = new Set(classicClientDriven.serverOnlyActions);
    for (const name of [
      ACTION.partyRecruit,
      ACTION.partyDismiss,
      ACTION.partyRename,
      ACTION.partyReorder,
      ACTION.partyControl,
      ACTION.partyConfig,
      ACTION.partyBuySlot,
      ACTION.partyGive,
    ]) {
      expect(serverOnly.has(name)).toBe(false);
    }
  });

  it("a segment with a party's inputs fits the input cap", () => {
    // A party session makes a handful of inputs per minute; the cap is far above that.
    expect(MAX_INPUTS_PER_SEGMENT).toBeGreaterThanOrEqual(32);
    expect(classicClientDriven.maxInputsPerSegment).toBe(MAX_INPUTS_PER_SEGMENT);
  });

  it("offline eligibility and speed read the controlled hero's mode, party or not", () => {
    const { sim } = partySim(TRIO, 1);
    const control = sim.world.getResource<ControlState>(RES.control)!;
    control.mode = "auto";
    expect(classicOfflineEligible(sim.world)).toBe(true);
    control.mode = "manual";
    expect(classicOfflineEligible(sim.world)).toBe(false);
    control.mode = "idle";
    control.speed = 8;
    expect(classicSpeedOf(sim.world)).toBe(8);
  });
});

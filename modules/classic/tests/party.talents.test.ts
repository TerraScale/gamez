/**
 * classic.talents with a party (docs/design/party.md §6.8, §7.4; T-progress):
 * followers always auto-spend their talent points (they are always on the
 * party AI) while the controlled hero keeps the manual rule, a recruit
 * created at level L through the real recruit flow (spawnHeroEntity + addXp)
 * gets every level-up and talent point, and a follower's talent reset is paid
 * from the purse.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type ActionDef,
  type Entity,
  type GameEvent,
  type LoadedMode,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushCommand } from "../src/bus.ts";
import { AreaTag, Level, PartyMember, Pos, Talents, Wallet } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { ensureParty } from "../src/party/shared.ts";
import { addXp } from "../src/progression/index.ts";
import { spawnHeroEntity } from "../src/progression/hero.ts";
import { RES, type PartyState } from "../src/resources.ts";
import { talentPointsPerLevel, talentResetCost, xpAtLevel } from "../src/rules.ts";
import {
  BALANCE_ID,
  ECONOMY_ID,
  KIND,
  type BalanceProto,
  type ClassProto,
  type EconomyProto,
} from "../src/types.ts";
import { ensureResources, spawnTestParty, useOpenMap } from "./support/harness.ts";

/** The recruit flow of docs/design/party.md §4.1 (steps 2, 3 and 5), for tests. */
const recruitLike: ActionDef<{ classId: string; name: string; level: number }> = {
  name: "test.party.recruitLike",
  parse(_world, payload) {
    return payload as { classId: string; name: string; level: number };
  },
  apply(world, p, ctx) {
    const party = ensureParty(world, ctx)!;
    const cls = ctx.registry.require<ClassProto>(KIND.class, p.classId);
    const e = spawnHeroEntity(world, ctx, cls, p.classId, p.name);
    const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
    if (p.level > 1) addXp(world, ctx, e, xpAtLevel(bal, p.level), "recruit");
    world.add(e, Pos, { x: tileCenter(8), y: tileCenter(5) });
    world.add(e, AreaTag, { depth: 0 });
    world.add(e, PartyMember, {
      uid: party.nextUid,
      joinedTick: ctx.tick,
      role: cls.partyRole ?? "front",
      kills: 0,
      deaths: 0,
    });
    party.nextUid++;
    party.members.push(e);
    world.setResource(RES.party, party);
  },
};

const recruitModule = defineModule({
  id: "test.party.recruit",
  version: "0.0.1",
  deps: ["classic.core"],
  actions: [recruitLike],
});

let loaded: LoadedMode | null = null;
function realLoaded(): LoadedMode {
  if (loaded) return loaded;
  const mode = defineMode({
    id: "classic",
    name: "Classic (party talents test)",
    description: "test",
    world: null,
    modules: [
      "classic.core",
      "classic.items",
      "classic.progression",
      "classic.talents",
      "classic.party",
      "classic.content",
      "test.party.recruit",
    ],
    tick: { kind: "fixed", hz: 20 },
  });
  loaded = loadMode(mode, [...classicModules, recruitModule]);
  return loaded;
}

function partySim(levels: number[], gold = 5000): { sim: Sim; heroes: Entity[] } {
  const sim = createSim(realLoaded(), { seed: 3 });
  ensureResources(sim.world);
  useOpenMap(sim, 0);
  const heroes = spawnTestParty(
    sim.world,
    levels.map((level, i) => ({
      classId: i % 2 === 0 ? "classic.warrior" : "classic.rogue",
      level,
      skills: [],
      bar: [null, null, null, null, null, null],
      gold: i === 0 ? gold : 0,
    })),
  );
  for (const [i, h] of heroes.entries()) {
    sim.world.update(h, Level, { level: levels[i]!, xp: xpAtLevel(balOf(sim), levels[i]!) });
  }
  return { sim, heroes };
}

const balOf = (sim: Sim) => sim.loaded.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);

function eventsOf<T = Record<string, unknown>>(events: GameEvent[], type: string): T[] {
  return events.filter((e) => e.type === type) as unknown as T[];
}

describe("party talents", () => {
  it("a follower auto-spends its points in manual mode; the controlled hero keeps them", () => {
    const { sim, heroes } = partySim([5, 5]);
    const [a, f] = heroes as [Entity, Entity];
    const per = talentPointsPerLevel(balOf(sim));
    const events = sim.step(1);
    const ta = sim.world.read(a, Talents);
    const tf = sim.world.read(f, Talents);
    expect(ta.points).toBe(4 * per);
    expect(ta.spent).toBe(0);
    expect(tf.spent).toBeGreaterThan(0);
    expect(tf.points + tf.spent).toBe(4 * per);
    expect(
      eventsOf<{ hero?: Entity; gained: number }>(events, "classic.talent.points").map((e) => [
        e.hero,
        e.gained,
      ]),
    ).toEqual([
      [a, 4 * per],
      [f, 4 * per],
    ]);
    expect(
      eventsOf<{ hero?: Entity }>(events, "classic.talent.learned").every((e) => e.hero === f),
    ).toBe(true);

    // Still manual many ticks later: the controlled hero never spends on its own.
    sim.step(40);
    expect(sim.world.read(a, Talents).spent).toBe(0);
  });

  it("a level-10 recruit made with spawnHeroEntity + addXp gets every level and talent point", () => {
    const { sim, heroes } = partySim([13]);
    const bal = balOf(sim);
    const res = sim.dispatch(
      "test.party.recruitLike",
      { classId: "classic.sorcerer", name: "Ilsa", level: 10 },
      "p1",
    );
    expect(res.ok).toBe(true);
    const party = sim.world.getResource<PartyState>(RES.party)!;
    const recruit = party.members[1]!;
    expect(party.members[0]).toBe(heroes[0]);
    const lvl = sim.world.read(recruit, Level);
    expect(lvl.level).toBe(10);
    expect(lvl.statPoints).toBe(9 * bal.statPointsPerLevel);
    expect(lvl.skillPoints).toBe(9 * bal.skillPointsPerLevel);
    expect(eventsOf<{ hero?: Entity }>(res.events, "classic.levelUp").length).toBe(9);
    expect(
      eventsOf<{ hero?: Entity }>(res.events, "classic.levelUp").every((e) => e.hero === recruit),
    ).toBe(true);

    const events = sim.step(1);
    const t = sim.world.read(recruit, Talents);
    expect(t.levelSeen).toBe(10);
    expect(t.points + t.spent).toBe(9 * talentPointsPerLevel(bal));
    expect(t.spent).toBeGreaterThan(0); // a follower: spent at once
    expect(eventsOf(events, "classic.talent.points")).toContainEqual({
      type: "classic.talent.points",
      points: 9 * talentPointsPerLevel(bal),
      gained: 9 * talentPointsPerLevel(bal),
      hero: recruit,
    });
    // heroInit gave it a kit but no purse.
    expect(sim.world.has(recruit, Wallet)).toBe(false);
  });

  it("a follower's talent reset (command) refunds its points and charges the purse", () => {
    const { sim, heroes } = partySim([8, 8]);
    const [a, f] = heroes as [Entity, Entity];
    sim.step(1);
    const spent = sim.world.read(f, Talents).spent;
    expect(spent).toBeGreaterThan(0);
    const econ = sim.loaded.registry.require<EconomyProto>(KIND.economy, ECONOMY_ID);
    const cost = talentResetCost(econ, 8);
    const gold = sim.world.read(a, Wallet).gold;
    // Manual mode: auto-spend of a follower would re-spend on its next replan; read right after.
    pushCommand(sim.world, { op: "resetTalents", hero: f });
    const events = sim.step(1);
    expect(sim.world.read(a, Wallet).gold).toBe(gold - cost);
    expect(eventsOf(events, "classic.talents.reset")).toEqual([
      { type: "classic.talents.reset", refunded: spent, cost, hero: f },
    ]);
    expect(sim.world.read(a, Talents).spent).toBe(0);
  });
});

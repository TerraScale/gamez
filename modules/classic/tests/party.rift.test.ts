/**
 * The Rift with a party (docs/design/party.md §7.4):
 * - the fee and the purse check come from the founder's purse, whichever
 *   member is controlled (and the controlled member may be downed while a
 *   standing member stands at the obelisk);
 * - a member's death counts in RiftRun.deaths and the run stays open; the run
 *   fails with reason "death" only when the whole party is down (wipe);
 * - RiftRecord hero fields describe the acting leader at the end, and
 *   record.party lists every member in slot order (absent when solo).
 * Uses the same small test RiftProto as rift.test.ts.
 */
import {
  createSim,
  defineModule,
  defineMode,
  loadMode,
  type Entity,
  type LoadedMode,
  type ModuleSpec,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { modules as classicModules } from "../src/index.ts";
import { ACTION, ERR } from "../src/actions.ts";
import { busOf, type DeathRecord } from "../src/bus.ts";
import { AreaTag, Dead, Hero, Interactable, PartyMember, Pos, Wallet } from "../src/components.ts";
import { partyMembers } from "../src/party/shared.ts";
import { tileCenter } from "../src/fixed.ts";
import { riftFee } from "../src/rules.ts";
import { RES, type DungeonState, type RiftRecord, type RiftState } from "../src/resources.ts";
import { riftStateOf } from "../src/rift/state.ts";
import { KIND, RIFT_ID, type MonsterProto, type RiftProto } from "../src/types.ts";
import { getMap } from "../src/world/maps.ts";
import { ensureResources, spawnTestHero, spawnTestParty } from "./support/harness.ts";
import { testContent } from "./support/content.ts";

// ---------------------------------------------------------------------------
// Test catalog (the same small rift as rift.test.ts)
// ---------------------------------------------------------------------------

const UNLOCK_DEPTH = 4;
const GUARDIAN = "test.monster.guardian";
const GOAL = 20;
const TIME_LIMIT = 2400;

const RIFT: RiftProto = {
  unlockBossDepth: UNLOCK_DEPTH,
  size: 48,
  rooms: [4, 6],
  roomSize: [5, 8],
  packs: [3, 4],
  progress: { normal: 1, minion: 1, champion: 4, unique: 10, boss: 0, summon: 0 },
  goal: GOAL,
  timeLimit: TIME_LIMIT,
  guardians: [GUARDIAN],
  feeBase: 100,
  feePerLevel: 50,
  reward: { goldPerLevel: 10, items: 1, bonusEvery: 2, minRarity: "normal" },
  themes: ["test.theme"],
};

const GUARDIAN_PROTO: MonsterProto = {
  name: "Test Guardian",
  family: "test",
  description: "Rift guardian for tests",
  appearance: "unit.monster.test",
  fallbackAppearance: "unit.hero",
  tint: 0xffcc00,
  scale: 140,
  behaviour: "rusher",
  life: 60,
  armor: 5,
  toHit: 20,
  dmgMin: 1,
  dmgMax: 3,
  element: "phys",
  resist: { fire: 0, cold: 0, lightning: 0, poison: 0 },
  xp: 50,
  moveSpeed: 40,
  radius: 100,
  skills: ["test.mskill.bite"],
  aggroRange: 8 * 256,
  keepDistance: 0,
  packSize: [1, 1],
  themes: [],
  minDepth: 1,
  weight: 0,
};

const testRiftContent = defineModule({
  id: "test.rift.party",
  version: "0.0.1",
  data(reg) {
    reg.define(KIND.rift, RIFT_ID, RIFT);
    reg.define(KIND.monster, GUARDIAN, GUARDIAN_PROTO);
  },
});

const IDS = [
  "classic.core",
  "classic.world",
  "classic.rift",
  "classic.monsters",
  "classic.combat",
  "classic.progression",
];

let loadedCache: LoadedMode | null = null;

function riftLoaded(): LoadedMode {
  if (loadedCache) return loadedCache;
  const catalog: ModuleSpec[] = [...classicModules, testContent, testRiftContent];
  const mode = defineMode({
    id: "classic",
    name: "Classic (party rift test)",
    description: "test",
    world: null,
    modules: [...IDS, "test.content", "test.rift.party"],
    tick: { kind: "fixed", hz: 20 },
  });
  loadedCache = loadMode(mode, catalog);
  return loadedCache;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A party (harness heroes) on the town spawn, purse on the founder. */
function partySim(
  heroes: { classId: string; level: number; gold?: number }[],
  controlled = 0,
  seed = 7,
): { sim: Sim; ents: Entity[] } {
  const sim = createSim(riftLoaded(), { seed });
  ensureResources(sim.world);
  const ents = spawnTestParty(sim.world, heroes, { controlled });
  const spawn = getMap(sim.world, sim.loaded.registry, 0).spawn;
  ents.forEach((e, i) => {
    sim.world.update(e, Pos, { x: tileCenter(spawn.x), y: tileCenter(spawn.y) });
    sim.world.update(e, Hero, { name: `Hero${i}`, classId: heroes[i]!.classId, createdTick: 0 });
  });
  return { sim, ents };
}

/** A solo hero (no party resource, no PartyMember): the solo save shape. */
function soloSim(gold: number, seed = 9): { sim: Sim; hero: Entity } {
  const sim = createSim(riftLoaded(), { seed });
  ensureResources(sim.world);
  const spawn = getMap(sim.world, sim.loaded.registry, 0).spawn;
  const hero = spawnTestHero(sim.world, { x: spawn.x, y: spawn.y, depth: 0, gold });
  return { sim, hero };
}

function obeliskOf(sim: Sim): Entity {
  for (const e of sim.world.query(Interactable, AreaTag)) {
    if (sim.world.read(e, Interactable).kind === "riftObelisk") return e;
  }
  return 0;
}

/** Puts `who` on the obelisk tile (in reach of the rift ops). */
function standAtObelisk(sim: Sim, who: Entity): Entity {
  const obelisk = obeliskOf(sim);
  const p = sim.world.read(obelisk, Pos);
  sim.world.update(who, Pos, { x: p.x, y: p.y });
  return obelisk;
}

function unlock(sim: Sim): void {
  sim.world.getResource<DungeonState>(RES.dungeon)!.bossesKilled = [UNLOCK_DEPTH];
  sim.step(1);
}

function stateOf(sim: Sim): RiftState {
  return riftStateOf(sim.world);
}

function deathOf(over: Partial<DeathRecord>): DeathRecord {
  return {
    entity: 0,
    killer: 0,
    creditTeam: "monster",
    team: "hero",
    isHero: true,
    x: 0,
    y: 0,
    depth: 1,
    monster: "",
    rarity: "hero",
    level: 1,
    xp: 0,
    pack: 0,
    ...over,
  };
}

/** Marks every member downed (a wipe) and reports each death for `depth`. */
function wipe(sim: Sim, members: Entity[], depth: number): void {
  for (const e of members) {
    sim.world.add(e, Dead, { at: sim.tick, killer: 0 });
    busOf(sim.world).deaths.push(deathOf({ depth, entity: e }));
  }
}

/** One member downed with its death reported (the run goes on while others stand). */
function downOne(sim: Sim, who: Entity, depth: number): void {
  sim.world.add(who, Dead, { at: sim.tick, killer: 0 });
  busOf(sim.world).deaths.push(deathOf({ depth, entity: who }));
}

// ---------------------------------------------------------------------------
// Fee and purse
// ---------------------------------------------------------------------------

describe("party rift: fee and purse", () => {
  it("the fee is paid from the founder's purse while a member is controlled", () => {
    const { sim, ents } = partySim(
      [
        { classId: "test.class.fighter", level: 5, gold: 1000 },
        { classId: "test.class.fighter", level: 4 },
      ],
      1,
    );
    unlock(sim);
    const obelisk = standAtObelisk(sim, ents[1]!);
    const fee = riftFee(RIFT, 1);
    const r = sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null);
    expect(r.ok).toBe(true);
    expect(sim.world.get(ents[0]!, Wallet)!.gold).toBe(1000 - fee);
    expect(sim.world.has(ents[1]!, Wallet)).toBe(false);
    expect(stateOf(sim).active?.feePaid).toBe(fee);
  });

  it("refuses the rift when the purse cannot pay, with no change", () => {
    const { sim, ents } = partySim(
      [
        { classId: "test.class.fighter", level: 5, gold: 10 },
        { classId: "test.class.fighter", level: 4 },
      ],
      1,
    );
    unlock(sim);
    const obelisk = standAtObelisk(sim, ents[1]!);
    const before = sim.hash();
    const r = sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(ERR.noGold);
    expect(stateOf(sim).active).toBeNull();
    expect(sim.hash()).toBe(before);
  });

  it("a downed controlled member does not block the open: a standing member at the obelisk does", () => {
    const { sim, ents } = partySim(
      [
        { classId: "test.class.fighter", level: 5, gold: 1000 },
        { classId: "test.class.fighter", level: 4 },
      ],
      1,
    );
    unlock(sim);
    sim.world.add(ents[1]!, Dead, { at: sim.tick, killer: 0 });
    const obelisk = standAtObelisk(sim, ents[0]!);
    const r = sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure: a member's death counts, only a wipe fails the run
// ---------------------------------------------------------------------------

describe("party rift: failure on a wipe only", () => {
  function openedParty(seed = 11) {
    const { sim, ents } = partySim(
      [
        { classId: "test.class.fighter", level: 5, gold: 2000 },
        { classId: "test.class.fighter", level: 4 },
        { classId: "test.class.fighter", level: 3 },
      ],
      0,
      seed,
    );
    unlock(sim);
    const obelisk = standAtObelisk(sim, ents[0]!);
    expect(sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null).ok).toBe(true);
    sim.step(1);
    const depth = sim.world.getResource<{ depth: number }>(RES.area)!.depth;
    return { sim, ents, depth };
  }

  it("a member's death adds to RiftRun.deaths and the run stays open", () => {
    const { sim, ents, depth } = openedParty();
    downOne(sim, ents[1]!, depth);
    sim.step(1);
    const run = stateOf(sim).active;
    expect(run).not.toBeNull();
    expect(run!.deaths).toBe(1);
    expect(stateOf(sim).history).toEqual([]);
  });

  it("the run fails with reason death when the whole party is down", () => {
    const { sim, ents, depth } = openedParty();
    downOne(sim, ents[1]!, depth);
    sim.step(1);
    wipe(sim, [ents[0]!, ents[2]!], depth);
    sim.step(1);
    expect(stateOf(sim).active).toBeNull();
    expect(stateOf(sim).history[0]).toMatchObject({
      completed: false,
      reason: "death",
      score: 0,
    });
    // The first member death (step 1) and the first wipe record (step 2) end the run; the
    // second wipe record finds no run and is not counted.
    expect(stateOf(sim).history[0]!.deaths).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The record: acting leader fields and the party list
// ---------------------------------------------------------------------------

describe("party rift: the run record", () => {
  it("record.party lists every member in slot order, hero fields = the acting leader", () => {
    const { sim, ents } = partySim(
      [
        { classId: "test.class.fighter", level: 5, gold: 2000 },
        { classId: "test.class.fighter", level: 4 },
        { classId: "test.class.fighter", level: 3 },
      ],
      1,
    );
    unlock(sim);
    const obelisk = standAtObelisk(sim, ents[1]!);
    expect(sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null).ok).toBe(true);
    sim.step(1);
    const depth = sim.world.getResource<{ depth: number }>(RES.area)!.depth;
    // The controlled member goes down with the others: a wipe, the acting leader is the controlled hero.
    wipe(sim, ents, depth);
    sim.step(1);
    const record = stateOf(sim).history[0] as RiftRecord;
    expect(record.party).toEqual([
      { name: "Hero0", classId: "test.class.fighter", level: 5 },
      { name: "Hero1", classId: "test.class.fighter", level: 4 },
      { name: "Hero2", classId: "test.class.fighter", level: 3 },
    ]);
    expect(record.heroName).toBe("Hero1");
    expect(record.classId).toBe("test.class.fighter");
    expect(record.heroLevel).toBe(4);
    expect(partyMembers(sim.world)).toEqual(ents);
  });

  it("a solo run has no party field", () => {
    const { sim, hero } = soloSim(2000);
    unlock(sim);
    const obelisk = standAtObelisk(sim, hero);
    expect(sim.dispatch(ACTION.openRift, { target: obelisk, level: 1 }, null).ok).toBe(true);
    sim.step(1);
    const depth = sim.world.getResource<{ depth: number }>(RES.area)!.depth;
    busOf(sim.world).deaths.push(deathOf({ depth, entity: hero, isHero: true }));
    sim.step(1);
    const record = stateOf(sim).history[0]!;
    expect(record.reason).toBe("death");
    expect("party" in record).toBe(false);
    expect(sim.world.has(hero, PartyMember)).toBe(false);
  });
});

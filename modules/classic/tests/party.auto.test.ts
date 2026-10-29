/**
 * The party AI (T-auto, docs/design/party.md §6): the follower brain
 * (classic.auto.party) and the party rules of the leader brain.
 *
 * Unit level (harness: open test maps, spawnTestParty, test monsters that
 * stand still because classic.monsters is not loaded):
 * formation behind a walking manual leader, focus fire, protect, ally heals
 * (real Mend with allyRadius), revives, loot, gear distribution.
 *
 * Full mode (real content, every classic module, followers recruited with
 * classic.party.recruit): a follower's own town routine with the purse, the
 * party travelling together, a wipe in Auto respawning everyone in town,
 * determinism with a pinned hash.
 */
import { createSim, loadMode, type Entity, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import {
  Ai,
  AreaTag,
  AutoState,
  Belt,
  Casting,
  Dead,
  Equipment,
  Intent,
  Inventory,
  Life,
  Loot,
  Mana,
  Pos,
  Reviving,
} from "../src/components.ts";
import { Wallet } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { mode, modules } from "../src/index.ts";
import { partyGold, partyMembers, purseOf } from "../src/party/shared.ts";
import { controlOf, currentDepth, heroOf, RES, type AreaState } from "../src/resources.ts";
import { itemValue } from "../src/rules.ts";
import { KIND, type ItemBaseProto, type ItemInstance } from "../src/types.ts";
import { getAreaMap, type ClassicMap } from "../src/world/maps.ts";
import { spawnTestMonster, spawnTestParty, testSim, useOpenMap } from "./support/harness.ts";

const TILE = 256;
const BASE = ["classic.core", "classic.combat", "classic.auto", "classic.party"];

function tile(sim: Sim, e: Entity): { x: number; y: number } {
  const p = sim.world.read(e, Pos);
  return { x: p.x >> 8, y: p.y >> 8 };
}

function gap(sim: Sim, a: Entity, b: Entity): number {
  const pa = tile(sim, a);
  const pb = tile(sim, b);
  return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
}

function down(sim: Sim, e: Entity): void {
  sim.world.update(e, Life, { hp: 0 });
  sim.world.add(e, Dead, { at: sim.tick, killer: 0 });
}

/** A harness party on a 32x32 open map at depth 1, the founder controlled in Manual. */
function harnessParty(
  n: number,
  o: {
    modules?: string[];
    content?: "test" | "real";
    seed?: number;
    hero?: Parameters<typeof spawnTestParty>[1][number];
    roles?: ("front" | "back")[];
  } = {},
): { sim: Sim; heroes: Entity[] } {
  const sim = testSim(o.modules ?? BASE, { seed: o.seed ?? 3, content: o.content });
  useOpenMap(sim, 1, 32);
  const heroes = spawnTestParty(
    sim.world,
    Array.from({ length: n }, (_, i) => ({ life: 400, x: 5 + i, y: 5, ...o.hero })),
    { roles: o.roles },
  );
  // The controlled founder is the player's (Manual): only the follower brain runs.
  controlOf(sim.world).mode = "manual";
  return { sim, heroes };
}

function getAreaMapOf(sim: Sim): ClassicMap {
  return getAreaMap(sim.world, sim.loaded.registry);
}

function focusOf(sim: Sim, e: Entity): Entity {
  return sim.world.get(e, AutoState)?.focus ?? 0;
}

describe("followers keep the formation", () => {
  it("follow a walking manual leader and stand within spread x 2 + 1 tiles when it stops", () => {
    const { sim, heroes } = harnessParty(3);
    const [leader, b, c] = heroes as [Entity, Entity, Entity];
    expect(controlOf(sim.world).mode).toBe("manual");
    sim.world.add(leader, Intent, {
      kind: "move",
      source: "manual",
      at: sim.tick + 1,
      x: 22,
      y: 20,
    });
    // Halfway there the followers are on their way, not standing at the start.
    sim.step(120);
    expect(tile(sim, b).x + tile(sim, b).y).toBeGreaterThan(20);
    sim.step(280);
    expect(tile(sim, leader)).toEqual({ x: 22, y: 20 });
    const spread = 2;
    expect(gap(sim, b, leader)).toBeLessThanOrEqual(spread * 2 + 1);
    expect(gap(sim, c, leader)).toBeLessThanOrEqual(spread * 2 + 1);
    // Followers do not stack on one tile.
    expect(tile(sim, b)).not.toEqual(tile(sim, c));
  });
});

describe("targeting", () => {
  it("focus fire: followers attack the leader's target, not the nearer foe", () => {
    const { sim, heroes } = harnessParty(3);
    const [leader, b, c] = heroes as [Entity, Entity, Entity];
    const far = spawnTestMonster(sim.world, { x: 12, y: 5, life: 5000 });
    // The nearer foe stands next to the followers.
    spawnTestMonster(sim.world, { x: 7, y: 7, life: 5000 });
    sim.world.add(leader, Intent, {
      kind: "skill",
      skill: "test.skill.strike",
      target: far,
      x: tileCenter(12),
      y: tileCenter(5),
      repeat: true,
      source: "manual",
      at: sim.tick + 1,
    });
    sim.step(16);
    expect(focusOf(sim, b)).toBe(far);
    expect(focusOf(sim, c)).toBe(far);
  });

  it("protect: the foe attacking the weakest member is attacked first", () => {
    const { sim, heroes } = harnessParty(3);
    const [, b, c] = heroes as [Entity, Entity, Entity];
    sim.world.update(c, Life, { hp: 120 });
    const biter = spawnTestMonster(sim.world, { x: 13, y: 8, life: 5000 });
    sim.world.update(biter, Ai, { state: "attack", target: c });
    const near = spawnTestMonster(sim.world, { x: 7, y: 7, life: 5000 });
    sim.step(16);
    expect(focusOf(sim, b)).toBe(biter);
    expect(focusOf(sim, b)).not.toBe(near);
  });
});

describe("ally heals", () => {
  it("a follower with Mend (allyRadius) heals an ally below half life", () => {
    const { sim, heroes } = harnessParty(3, {
      content: "real",
      hero: {
        skills: [{ skill: "classic.skill.mend", rank: 1 }],
        bar: ["classic.skill.mend", null, null, null, null, null],
        mana: 200,
      },
    });
    const [, b, c] = heroes as [Entity, Entity, Entity];
    sim.world.update(c, Life, { hp: 80 });
    sim.world.update(b, Mana, { mp: 200 });
    let cast = false;
    for (let i = 0; i < 60 && !cast; i++) {
      sim.step(1);
      // The skill intent turns into a Casting at once.
      if (sim.world.get(b, Casting)?.skill === "classic.skill.mend") cast = true;
    }
    expect(cast, "b casts Mend").toBe(true);
    sim.step(40);
    expect(sim.world.read(c, Life).hp, "c healed by b's Mend").toBeGreaterThan(80);
  });
});

describe("revives", () => {
  it("the nearest follower revives a downed member when no foe is near", () => {
    const { sim, heroes } = harnessParty(3);
    const [, b, c] = heroes as [Entity, Entity, Entity];
    // c lies 6 tiles away; b is its nearest standing AI-driven member.
    sim.world.update(c, Pos, { x: tileCenter(13), y: tileCenter(5) });
    down(sim, c);
    let revivedAt = -1;
    for (let i = 0; i < 400 && revivedAt < 0; i++) {
      sim.step(1);
      if (!sim.world.has(c, Dead)) revivedAt = sim.tick;
    }
    expect(revivedAt, "c revived").toBeGreaterThan(0);
    expect(sim.world.read(c, Life).hp).toBeGreaterThan(0);
    expect(gap(sim, b, c)).toBeLessThanOrEqual(2);
  });

  it("does not start a revive next to an awake foe", () => {
    const { sim, heroes } = harnessParty(2);
    const [, b] = heroes as [Entity, Entity];
    // The controlled founder (manual) is down: b is the acting leader in "defend".
    const leader = heroes[0]!;
    sim.world.update(leader, Pos, { x: tileCenter(14), y: tileCenter(5) });
    down(sim, leader);
    spawnTestMonster(sim.world, { x: 16, y: 5, life: 5000 });
    for (let i = 0; i < 120; i++) {
      sim.step(1);
      expect(sim.world.has(b, Reviving), "no revive next to a foe").toBe(false);
    }
    expect(sim.world.has(leader, Dead)).toBe(true);
  });
});

describe("the leader with a downed member", () => {
  it("never moves on; after 400 ticks without a revive it takes the party to town, which revives", () => {
    const { sim, heroes } = harnessParty(2, { modules: [...BASE, "classic.world"] });
    const [, b] = heroes as [Entity, Entity];
    controlOf(sim.world).mode = "auto";
    // b lies in a walled pocket nobody can reach.
    const map = getAreaMapOf(sim);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) map.walkable[(20 + dy) * 32 + 20 + dx] = 0;
    sim.world.update(b, Pos, { x: tileCenter(20), y: tileCenter(20) });
    down(sim, b);
    const downedAt = sim.tick;
    let townAt = -1;
    for (let i = 0; i < 700 && townAt < 0; i++) {
      sim.step(1);
      if (currentDepth(sim.world) === 0) townAt = sim.tick;
    }
    expect(townAt - downedAt, "town trip after the give-up delay").toBeGreaterThanOrEqual(400);
    expect(townAt).toBeGreaterThan(0);
    sim.step(5);
    expect(sim.world.has(b, Dead), "revived in town").toBe(false);
  });
});

describe("loot", () => {
  it("a follower picks up gold lying next to it (into the purse)", () => {
    const { sim, heroes } = harnessParty(3, { modules: [...BASE, "classic.items"] });
    const [founder, b] = heroes as [Entity, Entity];
    const before = partyGold(sim.world);
    expect(purseOf(sim.world)).toBe(founder);
    const bt = tile(sim, b);
    const e = sim.world.create();
    sim.world.add(e, Loot, { kind: "gold", item: null, gold: 37, potion: "", droppedAt: 0 });
    sim.world.add(e, Pos, { x: tileCenter(bt.x), y: tileCenter(bt.y + 2) });
    sim.world.add(e, AreaTag, { depth: 1 });
    sim.step(60);
    expect(sim.world.exists(e) && sim.world.has(e, Loot)).toBe(false);
    expect(partyGold(sim.world)).toBe(before + 37);
  });
});

function sword(sim: Sim, uid: number, dmgMax = 0): ItemInstance {
  const b = sim.loaded.registry.require<ItemBaseProto>(KIND.itemBase, "test.item.sword");
  return {
    uid,
    base: "test.item.sword",
    rarity: dmgMax > 0 ? "magic" : "normal",
    ilvl: 1,
    name: b.name,
    mods: dmgMax > 0 ? [{ stat: "dmgMax", value: dmgMax }] : [],
    affixes: [],
    value: itemValue(b, "normal", 1),
  };
}

describe("gear distribution", () => {
  it("a bag item that upgrades another member more goes to that member, who equips it", () => {
    const { sim, heroes } = harnessParty(3, { modules: [...BASE, "classic.items"] });
    const [, b, c] = heroes as [Entity, Entity, Entity];
    // b already wields a better sword; c has no weapon at all.
    sim.world.update(b, Equipment, {
      ...sim.world.read(b, Equipment),
      weapon: sword(sim, 9001, 30),
    });
    sim.world.update(c, Equipment, { ...sim.world.read(c, Equipment), weapon: null });
    sim.world.update(b, Inventory, {
      ...sim.world.read(b, Inventory),
      items: [{ item: sword(sim, 9002), x: 0, y: 0 }],
    });
    sim.step(80);
    expect(sim.world.read(c, Equipment).weapon?.uid, "c equips the sword").toBe(9002);
    expect(sim.world.read(b, Equipment).weapon?.uid).toBe(9001);
    expect(sim.world.read(b, Inventory).items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full mode (real content, every module)
// ---------------------------------------------------------------------------

const loaded = loadMode(mode, modules);
const NAMES = ["Brannoc", "Ysolde", "Corvin", "Maelis"];

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
    expect(sim.dispatch("classic.party.buySlot", {}, null).ok, `buySlot ${i}`).toBe(true);
    const r = sim.dispatch("classic.party.recruit", { classId: classes[i], name: NAMES[i] }, null);
    expect(r.ok, `recruit ${classes[i]}`).toBe(true);
    sim.step(2);
  }
  setPurse(sim, 200);
  return sim;
}

function lifePotions(sim: Sim, e: Entity): number {
  let n = 0;
  for (const s of sim.world.read(e, Belt).slots) {
    if (s.count <= 0 || s.base === null) continue;
    const p = sim.loaded.registry.get<ItemBaseProto>(KIND.itemBase, s.base)?.potion;
    if (p && p.kind === "life") n += s.count;
  }
  return n;
}

describe("a follower's own town routine (full mode)", () => {
  it("sells its junk and buys potions with the purse before the party leaves town", () => {
    const sim = recruitParty(11, ["classic.warrior", "classic.rogue"]);
    const [, rogue] = partyMembers(sim.world) as [Entity, Entity];
    // Two more copies of the rogue's own starter bow: no upgrade for anyone, below keepRarity.
    const junk: ItemInstance[] = [];
    const bow = sim.loaded.registry.require<ItemBaseProto>(
      KIND.itemBase,
      "classic.item.hunting_bow",
    );
    for (let i = 0; i < 2; i++) {
      junk.push({
        uid: 8000 + i,
        base: "classic.item.hunting_bow",
        rarity: "normal",
        ilvl: 1,
        name: bow.name,
        mods: [],
        affixes: [],
        value: itemValue(bow, "normal", 1),
      });
    }
    const inv = sim.world.read(rogue, Inventory);
    sim.world.update(rogue, Inventory, {
      ...inv,
      items: junk.map((item, i) => ({ item, x: i * 2, y: 0 })),
    });
    const belt = sim.world.read(rogue, Belt);
    sim.world.update(rogue, Belt, {
      ...belt,
      slots: belt.slots.map(() => ({ base: null, count: 0 })),
    });
    setPurse(sim, 3000);
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
    const gold0 = partyGold(sim.world);
    let leftAt = -1;
    for (let i = 0; i < 1500 && leftAt < 0; i++) {
      sim.step(1);
      if (currentDepth(sim.world) !== 0) leftAt = sim.tick;
    }
    const bag = sim.world.read(rogue, Inventory).items.map((en) => en.item.uid);
    expect(
      bag.some((u) => u >= 8000 && u < 8003),
      "junk sold",
    ).toBe(false);
    expect(lifePotions(sim, rogue), "potions bought into the rogue's belt").toBeGreaterThan(0);
    expect(partyGold(sim.world)).not.toBe(gold0);
    expect(leftAt, "the party left town").toBeGreaterThan(0);
  }, 120_000);
});

describe("the party travels together (full mode)", () => {
  it("every member is always in the current area, through several transitions", () => {
    const sim = recruitParty(5, ["classic.sorcerer", "classic.warrior", "classic.rogue"]);
    const members = partyMembers(sim.world);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    let changes = 0;
    let last = currentDepth(sim.world);
    for (let i = 0; i < 9000; i++) {
      sim.step(1);
      const d = currentDepth(sim.world);
      if (d !== last) {
        changes++;
        last = d;
      }
      for (const e of members) expect(sim.world.read(e, AreaTag).depth).toBe(d);
    }
    expect(changes).toBeGreaterThanOrEqual(2);
  }, 300_000);
});

describe("a wipe in Auto (full mode)", () => {
  it("respawns the whole party in town, everyone alive", () => {
    const sim = recruitParty(9, ["classic.warrior", "classic.rogue", "classic.sorcerer"]);
    const members = partyMembers(sim.world);
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
    for (let i = 0; i < 6000 && currentDepth(sim.world) === 0; i++) sim.step(1);
    expect(currentDepth(sim.world)).toBeGreaterThan(0);
    sim.step(20);
    for (const e of members) down(sim, e);
    let back = -1;
    for (let i = 0; i < 600 && back < 0; i++) {
      sim.step(1);
      if (currentDepth(sim.world) === 0 && members.every((e) => !sim.world.has(e, Dead)))
        back = sim.tick;
    }
    expect(back, "respawned in town").toBeGreaterThan(0);
    for (const e of members) expect(sim.world.read(e, Life).hp).toBeGreaterThan(0);
    expect(sim.world.getResource<AreaState>(RES.area)!.depth).toBe(0);
    expect(members).toContain(heroOf(sim.world));
  }, 120_000);
});

describe("determinism", () => {
  const script = (): Sim => {
    const sim = recruitParty(77, ["classic.warrior", "classic.sorcerer", "classic.rogue"]);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    sim.step(1500);
    // Take control of the second member for a while, then back.
    const [a, b] = partyMembers(sim.world) as [Entity, Entity];
    expect(sim.dispatch("classic.party.control", { hero: b }, null).ok).toBe(true);
    sim.step(500);
    expect(sim.dispatch("classic.party.control", { hero: a }, null).ok).toBe(true);
    sim.step(500);
    return sim;
  };

  it("two identical party scripts give the same hash (pinned)", () => {
    const a = script();
    const b = script();
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).toBe("13eb8ae48602c00c");
  }, 300_000);
});

void TILE;

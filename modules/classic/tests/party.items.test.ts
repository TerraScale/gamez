/**
 * classic.items with a party (docs/design/party.md §2.3 I4, §7.4, §8;
 * T-progress): the purse (founder's Wallet + Supplies) pays for every member,
 * purchases and pickups land in the acting member's belt / bag, heroInit
 * gives a post-party recruit its kit but no purse, and drops scale with
 * PartyScale.lootPct while a party of one draws exactly the solo loot.
 */
import type { Entity, GameEvent, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf, pushCommand, type DeathRecord } from "../src/bus.ts";
import {
  AreaTag,
  Belt,
  Body,
  Equipment,
  Hero,
  Inventory,
  Loot,
  Npc,
  PartyMember,
  Pos,
  Supplies,
  Wallet,
} from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { extraItemRolls } from "../src/items/index.ts";
import { nextUid, RES, type GameState, type PartyState } from "../src/resources.ts";
import { itemValue } from "../src/rules.ts";
import { KIND, type ItemBaseProto, type ItemInstance } from "../src/types.ts";
import { spawnTestHero, spawnTestParty, testSim, useOpenMap } from "./support/harness.ts";

const MODULES = ["classic.core", "classic.items", "classic.party"];

function partySim(
  n: number,
  o: { seed?: number; depth?: number; controlled?: number; gold?: number } = {},
): { sim: Sim; heroes: Entity[] } {
  const sim = testSim(MODULES, { seed: o.seed ?? 1 });
  useOpenMap(sim, o.depth ?? 0);
  const heroes = spawnTestParty(
    sim.world,
    Array.from({ length: n }, (_, i) => ({
      depth: o.depth ?? 0,
      gold: i === 0 ? (o.gold ?? 1000) : 0,
    })),
    { controlled: o.controlled ?? 0 },
  );
  return { sim, heroes };
}

function spawnNpc(sim: Sim, proto: string, x: number, y: number): Entity {
  const e = sim.world.create();
  sim.world.add(e, Npc, { proto });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth: 0 });
  sim.world.add(e, Body, { radius: 80, solid: true });
  return e;
}

function makeItem(sim: Sim, baseId: string): ItemInstance {
  const b = sim.loaded.registry.require<ItemBaseProto>(KIND.itemBase, baseId);
  return {
    uid: nextUid(sim.world),
    base: baseId,
    rarity: "normal",
    ilvl: 1,
    name: b.name,
    mods: [],
    affixes: [],
    value: itemValue(b, "normal", 1),
  };
}

function spawnLoot(
  sim: Sim,
  x: number,
  y: number,
  loot: { kind: "item" | "gold"; item?: ItemInstance; gold?: number },
  depth: number,
): Entity {
  const e = sim.world.create();
  sim.world.add(e, Loot, {
    kind: loot.kind,
    item: loot.item ?? null,
    gold: loot.gold ?? 0,
    potion: "",
    droppedAt: 0,
  });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth });
  return e;
}

function eventsOf<T = Record<string, unknown>>(events: GameEvent[], type: string): T[] {
  return events.filter((e) => e.type === type) as unknown as T[];
}

const gold = (sim: Sim, e: Entity) => sim.world.read(e, Wallet).gold;
const potionValue = (sim: Sim, id: string) =>
  sim.loaded.registry.require<ItemBaseProto>(KIND.itemBase, id).value;

describe("the purse pays for every member", () => {
  it("a controlled recruit (no Wallet) buys potions with purse gold into ITS belt", () => {
    const { sim, heroes } = partySim(2, { controlled: 1 });
    const [founder, recruit] = heroes as [Entity, Entity];
    expect(sim.world.has(recruit, Wallet)).toBe(false);
    const npc = spawnNpc(sim, "test.npc.alchemist", 6, 6);
    const res = sim.dispatch(
      "classic.buy",
      { npc, potion: "test.item.potion.mana", count: 2 },
      "p1",
    );
    expect(res.ok).toBe(true);
    const price = 2 * potionValue(sim, "test.item.potion.mana");
    expect(gold(sim, founder)).toBe(1000 - price);
    expect(
      sim.world.read(recruit, Belt).slots.find((s) => s.base === "test.item.potion.mana"),
    ).toEqual({ base: "test.item.potion.mana", count: 2 });
    expect(
      sim.world.read(founder, Belt).slots.some((s) => s.base === "test.item.potion.mana"),
    ).toBe(false);
    expect(sim.world.has(recruit, Wallet)).toBe(false);
    expect(eventsOf(res.events, "classic.vendor.bought")).toEqual([
      {
        type: "classic.vendor.bought",
        npc: "test.npc.alchemist",
        name: "Test Mana Potion",
        price,
        hero: recruit,
      },
    ]);

    // Town portal scrolls go to the purse's Supplies.
    const scrolls = sim.world.read(founder, Supplies).tpScrolls;
    expect(sim.dispatch("classic.buy", { npc, potion: "tp", count: 1 }, "p1").ok).toBe(true);
    expect(sim.world.read(founder, Supplies).tpScrolls).toBe(scrolls + 1);
    expect(sim.world.has(recruit, Supplies)).toBe(false);
  });

  it("a follower buys through a command (hero set); no gold means no_gold for anyone", () => {
    const { sim, heroes } = partySim(2, { gold: 30 });
    const [founder, f] = heroes as [Entity, Entity];
    const npc = spawnNpc(sim, "test.npc.alchemist", 6, 6);
    const value = potionValue(sim, "test.item.potion.life");
    const mana = potionValue(sim, "test.item.potion.mana");
    expect(30 - value).toBeLessThan(3 * mana);
    pushCommand(sim.world, {
      op: "buy",
      npc,
      index: 0,
      potion: "test.item.potion.life",
      count: 1,
      hero: f,
    });
    pushCommand(sim.world, {
      op: "buy",
      npc,
      index: 0,
      potion: "test.item.potion.mana",
      count: 3,
      hero: f,
    });
    const events = sim.step(1);
    expect(gold(sim, founder)).toBe(30 - value);
    expect(sim.world.read(f, Belt).slots[0]).toEqual({ base: "test.item.potion.life", count: 4 });
    expect(
      eventsOf<{ op: string; code: string; hero?: Entity }>(events, "classic.command.failed"),
    ).toEqual([
      {
        type: "classic.command.failed",
        op: "buy",
        code: "no_gold",
        message: `need ${3 * mana} gold`,
        hero: f,
      },
    ]);
  });

  it("follower pickup: the item goes to the follower's bag, the gold to the purse", () => {
    const { sim, heroes } = partySim(2, { depth: 1 });
    const [founder, f] = heroes as [Entity, Entity];
    const fp = sim.world.read(f, Pos);
    const tx = Math.floor(fp.x / 256);
    const ty = Math.floor(fp.y / 256);
    const item = makeItem(sim, "test.item.cap");
    const itemLoot = spawnLoot(sim, tx, ty, { kind: "item", item }, 1);
    const goldLoot = spawnLoot(sim, tx, ty, { kind: "gold", gold: 37 }, 1);
    pushCommand(sim.world, { op: "pickup", target: itemLoot, hero: f });
    pushCommand(sim.world, { op: "pickup", target: goldLoot, hero: f });
    const events = sim.step(1);
    expect(sim.world.read(f, Inventory).items.map((e) => e.item.uid)).toEqual([item.uid]);
    expect(sim.world.read(founder, Inventory).items).toEqual([]);
    expect(gold(sim, founder)).toBe(1037);
    expect(sim.world.has(f, Wallet)).toBe(false);
    expect(sim.world.exists(itemLoot)).toBe(false);
    expect(sim.world.exists(goldLoot)).toBe(false);
    expect(eventsOf<{ hero?: Entity }>(events, "classic.loot.picked").map((e) => e.hero)).toEqual([
      f,
      f,
    ]);
    expect(eventsOf(events, "classic.gold")).toEqual([
      { type: "classic.gold", amount: 37, total: 1037, reason: "pickup", hero: f },
    ]);
  });

  it("grantGold credits the purse whoever the command names", () => {
    const { sim, heroes } = partySim(3);
    pushCommand(sim.world, { op: "grantGold", amount: 50, reason: "test", hero: heroes[2]! });
    sim.step(1);
    expect(gold(sim, heroes[0]!)).toBe(1050);
  });
});

describe("heroInit and the purse invariant (I4)", () => {
  it("gives a post-party recruit its kit but no Wallet or Supplies", () => {
    const { sim, heroes } = partySim(1);
    const founder = heroes[0]!;
    const recruit = spawnTestHero(sim.world, { x: 7, y: 5 });
    sim.world.remove(recruit, Inventory);
    sim.world.remove(recruit, Equipment);
    sim.world.remove(recruit, Belt);
    sim.world.remove(recruit, Wallet);
    sim.world.remove(recruit, Supplies);
    sim.world.add(recruit, PartyMember, {
      uid: 1,
      joinedTick: 0,
      role: "front",
      kills: 0,
      deaths: 0,
    });
    sim.world.getResource<PartyState>(RES.party)!.members.push(recruit);
    sim.world.getResource<GameState>(RES.game)!.hero = founder;
    const founderGold = gold(sim, founder);

    sim.step(1);
    expect(sim.world.has(recruit, Inventory)).toBe(true);
    expect(sim.world.read(recruit, Equipment).weapon?.base).toBe("test.item.sword");
    expect(sim.world.read(recruit, Belt).slots[0]).toEqual({
      base: "test.item.potion.life",
      count: 3,
    });
    expect(sim.world.has(recruit, Wallet)).toBe(false);
    expect(sim.world.has(recruit, Supplies)).toBe(false);
    expect(gold(sim, founder)).toBe(founderGold);
    expect(sim.world.read(recruit, Hero).classId).toBe("test.class.fighter");
  });
});

describe("party drops", () => {
  function deaths(n: number): DeathRecord[] {
    return Array.from({ length: n }, (_, i) => ({
      entity: 0,
      killer: 0,
      creditTeam: "hero" as const,
      team: "monster" as const,
      isHero: false,
      x: tileCenter(4 + (i % 6) * 4),
      y: tileCenter(4 + Math.floor(i / 6) * 4),
      depth: 1,
      monster: "test.monster.dummy",
      rarity: "champion" as const,
      level: 3,
      xp: 10,
      pack: 0,
    }));
  }

  /** Loot of 24 champion deaths with a party of `size` (0 = solo without a party resource). */
  function lootRun(seed: number, size: number) {
    const sim = testSim(MODULES, { seed });
    useOpenMap(sim, 1);
    if (size === 0) spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
    else
      spawnTestParty(
        sim.world,
        Array.from({ length: size }, () => ({ depth: 1 })),
      );
    busOf(sim.world).deaths.push(...deaths(24));
    sim.step(1);
    const loots = sim.world
      .query(Loot, Pos)
      .map((e) => ({ loot: sim.world.read(e, Loot), pos: sim.world.read(e, Pos) }));
    return {
      loots,
      items: loots.filter((l) => l.loot.kind === "item").length,
      gold: loots.reduce((n, l) => n + l.loot.gold, 0),
      rng: sim.snapshot().rng,
    };
  }

  it("a party of 4 gets more items and gold than a solo hero on average", () => {
    let soloItems = 0;
    let partyItems = 0;
    let soloGold = 0;
    let partyGold = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const solo = lootRun(seed, 0);
      const four = lootRun(seed, 4);
      soloItems += solo.items;
      partyItems += four.items;
      soloGold += solo.gold;
      partyGold += four.gold;
    }
    expect(partyItems).toBeGreaterThan(soloItems * 1.4);
    expect(partyGold).toBeGreaterThan(soloGold * 1.6);
  });

  it("a party of one drops exactly what a world without a party resource drops", () => {
    for (const seed of [1, 2, 3]) {
      const solo = lootRun(seed, 0);
      const one = lootRun(seed, 1);
      expect(one.loots).toEqual(solo.loots);
      expect(one.rng).toEqual(solo.rng);
    }
  });

  it("extraItemRolls: whole hundreds beyond the first plus one chance roll", () => {
    const sim = testSim(MODULES, { seed: 5 });
    const draws: number[] = [];
    const rng = {
      int(min: number, max: number) {
        draws.push(max);
        return min;
      },
    } as unknown as Parameters<typeof extraItemRolls>[0];
    expect(extraItemRolls(rng, 100)).toBe(0);
    expect(draws).toEqual([]);
    expect(extraItemRolls(rng, 200)).toBe(1);
    expect(draws).toEqual([]);
    expect(extraItemRolls(rng, 210)).toBe(2); // the fake roll always succeeds
    expect(extraItemRolls(rng, 140)).toBe(1);
    expect(draws).toEqual([100, 100]);
    expect(sim.tick).toBe(0);
  });
});

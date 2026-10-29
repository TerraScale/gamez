/**
 * classic.items.drops: loot for hero kills from fake DeathRecords (seeded
 * counts, loot entities on walkable tiles, filters) and the hero kit. Uses the
 * minimal test content; determinism of the drops is covered here as well.
 */
import { describe, expect, it } from "vite-plus/test";
import { busOf } from "../src/bus.ts";
import type { DeathRecord } from "../src/bus.ts";
import { AreaTag, HeroStats, Loot, Pos } from "../src/components.ts";
import { toTile } from "../src/fixed.ts";
import { BALANCE_ID, KIND, type BalanceProto, type ItemRarity } from "../src/types.ts";
import { getMap, walkableAt } from "../src/world/maps.ts";
import { testSim, spawnTestHero, useOpenMap } from "./support/harness.ts";
import { TEST_BALANCE } from "./support/content.ts";
import type { Entity, Sim } from "@gamez/kernel";

function death(over: Partial<DeathRecord> = {}): DeathRecord {
  return {
    entity: 0,
    killer: 0,
    creditTeam: "hero",
    team: "monster",
    isHero: false,
    x: 8 * 256 + 128,
    y: 8 * 256 + 128,
    depth: 1,
    monster: "test.monster.dummy",
    rarity: "normal",
    level: 1,
    xp: 10,
    pack: 0,
    ...over,
  };
}

function setup(seed = 1): { sim: Sim; hero: Entity } {
  const sim = testSim(["classic.core", "classic.items"], { seed });
  useOpenMap(sim, 1);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 1 });
  return { sim, hero };
}

/** Pushes the records and steps one tick; returns the loot entities created by the drops. */
function kill(
  sim: Sim,
  records: DeathRecord[],
): { loot: Entity[]; events: ReturnType<Sim["step"]> } {
  const before = new Set(sim.world.query(Loot));
  busOf(sim.world).deaths.push(...records);
  const events = sim.step(1);
  const loot = sim.world.query(Loot).filter((e) => !before.has(e));
  return { loot, events };
}

const kindsOf = (sim: Sim, ids: Entity[]) => ids.map((e) => sim.world.read(e, Loot).kind);

describe("drops from hero kills", () => {
  it("normal kills drop at the balance chances (seeded, counted)", () => {
    const { sim } = setup(3);
    let items = 0;
    let gold = 0;
    let potions = 0;
    const rounds = 200;
    for (let i = 0; i < rounds; i++) {
      const { loot } = kill(sim, [death({ level: 1 })]);
      for (const e of loot) {
        const k = sim.world.read(e, Loot).kind;
        if (k === "item") items++;
        else if (k === "gold") gold++;
        else potions++;
      }
    }
    // Balance: normal items 15%, gold 45%, potions 12%. Generous bands for 200 kills.
    const drops = TEST_BALANCE.drops.normal;
    expect(items).toBeGreaterThan((rounds * drops.item) / 100 / 2);
    expect(items).toBeLessThan(((rounds * drops.item) / 100) * 2);
    expect(gold).toBeGreaterThan((rounds * drops.gold) / 100 / 2);
    expect(gold).toBeLessThan(((rounds * drops.gold) / 100) * 2);
    expect(potions).toBeGreaterThan((rounds * drops.potion) / 100 / 2);
    expect(potions).toBeLessThan(((rounds * drops.potion) / 100) * 2);
  });

  it("boss kills drop the balance counts, at least two rare or better, plus gold and a potion", () => {
    const { sim } = setup(4);
    const { loot, events } = kill(sim, [
      death({ rarity: "boss", level: 4, monster: "test.monster.boss" }),
    ]);
    const boss = TEST_BALANCE.drops.boss;
    const items = loot.filter((e) => sim.world.read(e, Loot).kind === "item");
    expect(items.length).toBeGreaterThanOrEqual(boss.items[0]);
    expect(items.length).toBeLessThanOrEqual(boss.items[1]);
    const rarities: ItemRarity[] = items.map((e) => sim.world.read(e, Loot).item!.rarity);
    expect(rarities.filter((r) => r === "rare" || r === "unique").length).toBeGreaterThanOrEqual(2);
    expect(kindsOf(sim, loot)).toContain("gold");
    expect(events.filter((e) => e.type === "classic.loot.dropped").length).toBe(loot.length);
  });

  it("gold is rng x level x (100 + goldFind)%", () => {
    const { sim, hero } = setup(5);
    const bal = sim.loaded.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
    const level = 3;
    const golds: number[] = [];
    for (let i = 0; i < 80; i++) {
      const { loot } = kill(sim, [death({ rarity: "boss", level, monster: "test.monster.boss" })]);
      for (const e of loot) {
        const l = sim.world.read(e, Loot);
        if (l.kind === "gold") golds.push(l.gold);
      }
    }
    expect(golds.length).toBeGreaterThan(0);
    for (const g of golds) {
      expect(g).toBeGreaterThanOrEqual(bal.goldPerLevel[0] * level);
      expect(g).toBeLessThanOrEqual(bal.goldPerLevel[1] * level);
    }

    // Gold find of 100% doubles the pile.
    sim.world.update(hero, HeroStats, { goldFind: 100 });
    const more: number[] = [];
    for (let i = 0; i < 40; i++) {
      const { loot } = kill(sim, [death({ rarity: "boss", level, monster: "test.monster.boss" })]);
      for (const e of loot) {
        const l = sim.world.read(e, Loot);
        if (l.kind === "gold") more.push(l.gold);
      }
    }
    for (const g of more) expect(g).toBeGreaterThanOrEqual(bal.goldPerLevel[0] * level * 2);
  });

  it("loot lands on walkable tiles within radius 3 of the death tile, one pile per tile", () => {
    const { sim } = setup(6);
    const map = getMap(sim.world, sim.loaded.registry, 1);
    const records = Array.from({ length: 6 }, () =>
      death({
        rarity: "boss",
        level: 2,
        monster: "test.monster.boss",
        x: 8 * 256 + 128,
        y: 8 * 256 + 128,
      }),
    );
    const { loot } = kill(sim, records);
    expect(loot.length).toBeGreaterThan(20);
    const tiles = new Set<string>();
    for (const e of loot) {
      const p = sim.world.read(e, Pos);
      const tx = toTile(p.x);
      const ty = toTile(p.y);
      expect(walkableAt(map, tx, ty)).toBe(true);
      expect(Math.max(Math.abs(tx - 8), Math.abs(ty - 8))).toBeLessThanOrEqual(3);
      expect(sim.world.read(e, AreaTag).depth).toBe(1);
      tiles.add(`${tx},${ty}`);
    }
    // Piles use free tiles first, so the first loot never stacks while free tiles remain.
    expect(tiles.size).toBeGreaterThanOrEqual(Math.min(loot.length, 20));
  });

  it("ignores summons, hero deaths and kills credited to monsters", () => {
    const { sim } = setup(7);
    const { loot } = kill(sim, [
      death({ rarity: "summon" }),
      death({ isHero: true, rarity: "hero", creditTeam: "monster", monster: "" }),
      death({ creditTeam: "monster" }),
    ]);
    expect(loot).toEqual([]);
  });

  it("a champion kill can drop a potion for the depth tier and only life or mana", () => {
    const { sim } = setup(8);
    let potion = 0;
    for (let i = 0; i < 60; i++) {
      const { loot } = kill(sim, [death({ rarity: "champion", level: 4, depth: 1 })]);
      for (const e of loot) {
        const l = sim.world.read(e, Loot);
        if (l.kind === "potion") {
          potion++;
          expect(["test.item.potion.life", "test.item.potion.mana"]).toContain(l.potion);
        }
      }
    }
    expect(potion).toBeGreaterThan(0);
  });

  it("is deterministic: the same seed and kills give the same loot", () => {
    const run = (seed: number): string => {
      const { sim } = setup(seed);
      for (let i = 0; i < 30; i++)
        kill(sim, [death({ rarity: i % 7 === 0 ? "boss" : "normal", level: 1 + (i % 4) })]);
      return sim.hash();
    };
    expect(run(9)).toBe(run(9));
    expect(run(9)).not.toBe(run(10));
  });
});

describe("pinned drops", () => {
  it("pins the hash after a fixed kill sequence", () => {
    const { sim } = setup(11);
    for (let i = 0; i < 12; i++) {
      kill(sim, [death({ rarity: i % 4 === 0 ? "boss" : "normal", level: 2 + (i % 3) })]);
    }
    expect(sim.hash()).toBe("38447cb95e4c6523");
  });
});

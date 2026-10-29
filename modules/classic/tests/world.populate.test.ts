/**
 * classic.world population planning (design §8.3): boss and minions on boss
 * depths, champion and unique packs, spawn distance, the arrival room, the
 * level cap and volley mods. Called directly with a seeded rng.
 */
import { createRng, createRegistry, type FrozenRegistry, type SimContext } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import type { SpawnRequest } from "../src/bus.ts";
import type { GameState } from "../src/resources.ts";
import { monsterLevel } from "../src/rules.ts";
import {
  BALANCE_ID,
  KIND,
  NAMES_UNIQUE_MONSTER,
  type BalanceProto,
  type MonsterModProto,
  type MonsterProto,
  type ThemeProto,
} from "../src/types.ts";
import { generateArea } from "../src/world/generate.ts";
import type { ClassicMap } from "../src/world/maps.ts";
import { planPopulation } from "../src/world/populate.ts";
import { TEST_BALANCE } from "./support/content.ts";

const BALANCE: BalanceProto = {
  ...TEST_BALANCE,
  levelWidth: 96,
  levelHeight: 96,
  rooms: [12, 16],
  roomSize: [6, 12],
  packs: [8, 10],
  maxMonstersPerLevel: 300,
  championPackChancePct: 50,
  uniquePacksPerLevel: [1, 2],
};

function monster(
  over: Partial<MonsterProto> & Pick<MonsterProto, "name" | "behaviour">,
): MonsterProto {
  return {
    family: "test",
    description: over.name,
    appearance: "unit.monster.test",
    fallbackAppearance: "unit.hero",
    tint: 0,
    scale: 100,
    life: 20,
    armor: 5,
    toHit: 20,
    dmgMin: 1,
    dmgMax: 3,
    element: "phys",
    resist: { fire: 0, cold: 0, lightning: 0, poison: 0 },
    xp: 10,
    moveSpeed: 40,
    radius: 80,
    skills: ["test.mskill.bite"],
    aggroRange: 2048,
    keepDistance: 0,
    packSize: [2, 4],
    themes: ["classic.theme.crypt"],
    minDepth: 1,
    weight: 10,
    ...over,
  };
}

function mod(name: string, extraProjectiles: number, minDepth = 1): MonsterModProto {
  return {
    name,
    lifePct: 50,
    dmgPct: 20,
    speedPct: 0,
    armorPct: 0,
    lifeStealPct: 0,
    blinkEvery: 0,
    extraProjectiles,
    resistAll: 0,
    tint: 0,
    minDepth,
  };
}

function registry(): FrozenRegistry {
  const reg = createRegistry();
  reg.define(KIND.balance, BALANCE_ID, BALANCE);
  const theme: ThemeProto = {
    name: "Crypt",
    tier: 0,
    floor: ["tile.crypt.floor"],
    wall: "wall.crypt",
    door: "prop.door",
    stairsDown: "prop.stairs.down",
    stairsUp: "prop.stairs.up",
    waypoint: "prop.waypoint",
    decor: ["prop.barrel"],
    monsters: ["classic.monster.archer", "classic.monster.husk"],
    darkness: 50,
  };
  reg.define(KIND.theme, "classic.theme.crypt", theme);
  reg.define(KIND.monster, "classic.monster.husk", monster({ name: "Husk", behaviour: "rusher" }));
  reg.define(
    KIND.monster,
    "classic.monster.archer",
    monster({
      name: "Archer",
      behaviour: "archer",
      skills: ["test.mskill.arrow"],
      keepDistance: 5 * 256,
      weight: 6,
    }),
  );
  reg.define(
    KIND.monster,
    "classic.monster.minion",
    monster({ name: "Escort", behaviour: "rusher", themes: [] }),
  );
  reg.define(
    KIND.monster,
    "classic.monster.boss4",
    monster({
      name: "Big Husk",
      behaviour: "boss",
      life: 300,
      themes: [],
      boss: { depth: 4, title: "the Test", minions: "classic.monster.minion", minionCount: 3 },
    }),
  );
  reg.define(KIND.monsterMod, "classic.mod.mighty", mod("Mighty", 0));
  reg.define(KIND.monsterMod, "classic.mod.volley", mod("Volleying", 2));
  reg.define(KIND.monsterMod, "classic.mod.swift", mod("Swift", 0));
  reg.define(KIND.names, NAMES_UNIQUE_MONSTER, { first: ["Grim"], second: ["Fang"] });
  return reg.freeze();
}

const REG = registry();

function ctxFor(seed: number): SimContext {
  return { rng: createRng(seed), registry: REG, tick: 0 } as unknown as SimContext;
}

function gameState(): GameState {
  return { phase: "play", worldSeed: 1, nextUid: 1, hero: 0, nextPack: 1 };
}

function plan(
  seed: number,
  depth: number,
  map?: ClassicMap,
): { reqs: SpawnRequest[]; game: GameState; map: ClassicMap } {
  const m = map ?? generateArea(REG, 4242, depth);
  const game = gameState();
  const reqs = planPopulation(ctxFor(seed), REG, m, depth, game);
  return { reqs, game, map: m };
}

function tileOf(r: SpawnRequest): { x: number; y: number } {
  return { x: r.x >> 8, y: r.y >> 8 };
}

describe("population planning", () => {
  it("is deterministic for the same rng seed", () => {
    expect(plan(11, 2).reqs).toEqual(plan(11, 2).reqs);
    expect(plan(11, 2).reqs).not.toEqual(plan(12, 2).reqs);
  });

  it("places a boss with minions at the boss spot on boss depths", () => {
    const { reqs, map } = plan(5, 4);
    const boss = reqs.filter((r) => r.rarity === "boss");
    expect(boss).toHaveLength(1);
    const b = boss[0]!;
    expect(b.monster).toBe("classic.monster.boss4");
    expect(b.name).toBe("Big Husk, the Test");
    expect(b.level).toBe(monsterLevel(4) + 3);
    expect(tileOf(b)).toEqual(map.bossSpot);
    expect(b.awake).toBe(false);
    const minions = reqs.filter((r) => r.pack === b.pack && r.rarity === "minion");
    expect(minions.length).toBe(3);
    for (const m of minions) {
      const t = tileOf(m);
      expect(
        Math.max(Math.abs(t.x - map.bossSpot!.x), Math.abs(t.y - map.bossSpot!.y)),
      ).toBeLessThanOrEqual(3);
    }
  });

  it("does not place a boss on depths without one", () => {
    expect(plan(5, 3).reqs.some((r) => r.rarity === "boss")).toBe(false);
  });

  it("keeps every pack out of the arrival room and 12 tiles from the spawn", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { reqs, map } = plan(seed, 5);
      const arrival = map.rooms[0]!;
      for (const r of reqs) {
        if (r.rarity === "boss") continue;
        const t = tileOf(r);
        const dx = t.x - map.spawn.x;
        const dy = t.y - map.spawn.y;
        expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(144);
        const inArrival =
          t.x >= arrival.x &&
          t.y >= arrival.y &&
          t.x < arrival.x + arrival.w &&
          t.y < arrival.y + arrival.h;
        expect(inArrival).toBe(false);
        expect(map.walkable[t.y * map.width + t.x]).toBe(1);
      }
    }
  });

  it("gives every pack its own id and advances GameState.nextPack", () => {
    const { reqs, game } = plan(9, 3);
    const packs = new Set(reqs.map((r) => r.pack));
    expect(packs.size).toBeGreaterThan(1);
    expect(Math.max(...packs)).toBe(game.nextPack - 1);
    expect(reqs.every((r) => r.team === "monster" && r.owner === 0 && r.until === 0)).toBe(true);
  });

  it("builds champion packs with one shared mod and unique packs with named leaders", () => {
    let champions = 0;
    let uniques = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const { reqs } = plan(seed, 3);
      const byPack = new Map<number, SpawnRequest[]>();
      for (const r of reqs) byPack.set(r.pack, [...(byPack.get(r.pack) ?? []), r]);
      for (const members of byPack.values()) {
        const champs = members.filter((r) => r.rarity === "champion");
        if (champs.length > 0) {
          champions++;
          expect(champs.length).toBe(members.length);
          const mods = champs[0]!.mods;
          expect(mods).toHaveLength(1);
          expect(champs.every((c) => JSON.stringify(c.mods) === JSON.stringify(mods))).toBe(true);
          expect(champs.every((c) => c.level === monsterLevel(3) + 1)).toBe(true);
        }
        const leader = members.find((r) => r.rarity === "unique");
        if (leader) {
          uniques++;
          expect(leader.name).toBe("Grim Fang");
          expect(leader.mods).toHaveLength(2);
          const escorts = members.filter((r) => r.rarity === "minion");
          expect(escorts.length).toBeGreaterThanOrEqual(3);
          expect(escorts.length).toBeLessThanOrEqual(6);
          expect(leader.level).toBe(monsterLevel(3) + 2);
        }
      }
    }
    expect(champions).toBeGreaterThan(0);
    expect(uniques).toBeGreaterThan(0);
  });

  it("only gives volley mods to ranged monsters", () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const r of plan(seed, 3).reqs) {
        if (r.mods.includes("classic.mod.volley")) {
          expect(r.monster).toBe("classic.monster.archer");
        }
      }
    }
  });

  it("never exceeds the level cap", () => {
    const small = { ...BALANCE, maxMonstersPerLevel: 7 };
    const reg = createRegistry();
    reg.define(KIND.balance, BALANCE_ID, small);
    reg.define(
      KIND.theme,
      "classic.theme.crypt",
      REG.require<ThemeProto>(KIND.theme, "classic.theme.crypt"),
    );
    for (const [id, p] of REG.all<MonsterProto>(KIND.monster)) reg.define(KIND.monster, id, p);
    for (const [id, p] of REG.all<MonsterModProto>(KIND.monsterMod))
      reg.define(KIND.monsterMod, id, p);
    reg.define(KIND.names, NAMES_UNIQUE_MONSTER, { first: ["Grim"], second: ["Fang"] });
    const frozen = reg.freeze();
    const map = generateArea(frozen, 4242, 5);
    const reqs = planPopulation(
      { rng: createRng(3), registry: frozen, tick: 0 } as unknown as SimContext,
      frozen,
      map,
      5,
      gameState(),
    );
    expect(reqs.length).toBeLessThanOrEqual(7);
  });

  it("party density (densityPct) grows the packs, 100 is the solo plan", () => {
    const m = generateArea(REG, 4242, 3);
    const size = (pct: number | undefined, seed: number): number =>
      (pct === undefined
        ? planPopulation(ctxFor(seed), REG, m, 3, gameState())
        : planPopulation(ctxFor(seed), REG, m, 3, gameState(), pct)
      ).length;
    let solo = 0;
    let four = 0;
    for (let seed = 1; seed <= 24; seed++) {
      expect(size(100, seed), "100 % is the default plan").toBe(size(undefined, seed));
      solo += size(100, seed);
      // Party of 4 (PartyProto densityPct 130): every pack grows to floor(n x 1.3).
      four += size(130, seed);
    }
    console.log(`DENSITY solo=${solo} four=${four} ratio=${(four / solo).toFixed(3)}`);
    // Each pack is drawn independently (placement shifts the rng), so the
    // growth shows over many levels, not on every single one.
    expect(four / solo).toBeGreaterThan(1.08);
    expect(four / solo).toBeLessThan(1.35);
  });

  it("plans nothing in town", () => {
    const town = generateArea(REG, 4242, 0);
    expect(planPopulation(ctxFor(1), REG, town, 0, gameState())).toEqual([]);
  });
});

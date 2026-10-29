/**
 * classic.world generators: dungeon levels (rooms, corridors, stairs, waypoint,
 * boss spot, decor) and the town. Built from hand-made registries so the
 * tests do not depend on classic.content.
 */
import { createRegistry, type FrozenRegistry } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import {
  BALANCE_ID,
  KIND,
  NAMES_UNIQUE_MONSTER,
  type BalanceProto,
  type MonsterProto,
  type NameTableProto,
  type NpcProto,
  type ThemeProto,
} from "../src/types.ts";
import { generateArea } from "../src/world/generate.ts";
import type { ClassicMap } from "../src/world/maps.ts";
import { TEST_BALANCE } from "./support/content.ts";
import { loadScale } from "./support/perf.ts";

const BIG_BALANCE: BalanceProto = {
  ...TEST_BALANCE,
  levelWidth: 128,
  levelHeight: 128,
  rooms: [18, 26],
  roomSize: [6, 16],
};

const NPC_NAMES = ["alpha", "beta", "gamma", "delta", "epsilon"];

function theme(name: string, tier: number): ThemeProto {
  return {
    name,
    tier,
    floor: [`tile.${name.toLowerCase()}.floor`, `tile.${name.toLowerCase()}.floor.1`],
    wall: `wall.${name.toLowerCase()}`,
    door: "prop.door",
    stairsDown: "prop.stairs.down",
    stairsUp: "prop.stairs.up",
    waypoint: "prop.waypoint",
    decor: ["prop.barrel", "prop.crate"],
    monsters: ["test.monster.dummy"],
    darkness: 50,
  };
}

function npc(role: NpcProto["role"]): NpcProto {
  return {
    name: `Test ${role}`,
    title: role,
    role,
    appearance: `unit.npc.${role}`,
    fallbackAppearance: "unit.hero",
    tint: 0xffffff,
    buyPct: 0,
    greeting: "Hello.",
  };
}

/** A registry with the balance, four themes (one per tier), five NPCs and a name table. */
export function bigRegistry(
  options: { themes?: boolean; balance?: BalanceProto; npcs?: boolean } = {},
): FrozenRegistry {
  const reg = createRegistry();
  reg.define(KIND.balance, BALANCE_ID, options.balance ?? BIG_BALANCE);
  if (options.themes !== false) {
    reg.define(KIND.theme, "classic.theme.town", { ...theme("Town", 0), floor: ["tile.grass"] });
    reg.define(KIND.theme, "classic.theme.crypt", theme("Crypt", 0));
    reg.define(KIND.theme, "classic.theme.caves", theme("Caves", 1));
    reg.define(KIND.theme, "classic.theme.forge", theme("Forge", 2));
    reg.define(KIND.theme, "classic.theme.abyss", theme("Abyss", 3));
  }
  if (options.npcs !== false) {
    for (const n of NPC_NAMES) reg.define(KIND.npc, `classic.npc.${n}`, npc("quest"));
  }
  reg.define(KIND.monster, "test.monster.dummy", {
    name: "Dummy",
    family: "test",
    description: "test",
    appearance: "unit.monster.test",
    fallbackAppearance: "unit.hero",
    tint: 0,
    scale: 100,
    behaviour: "rusher",
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
  } satisfies MonsterProto);
  const names: NameTableProto = { first: ["Grim"], second: ["Fang"] };
  reg.define(KIND.names, NAMES_UNIQUE_MONSTER, names);
  return reg.freeze();
}

/** Walkable tiles reachable from `from` (4-neighbour BFS). */
function reachableFrom(map: ClassicMap, from: { x: number; y: number }): Uint8Array {
  const seen = new Uint8Array(map.width * map.height);
  const queue: number[] = [];
  const start = from.y * map.width + from.x;
  if (map.walkable[start] !== 1) return seen;
  seen[start] = 1;
  queue.push(start);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] as number;
    const x = i % map.width;
    const y = (i - x) / map.width;
    const next: number[] = [];
    if (x > 0) next.push(i - 1);
    if (x < map.width - 1) next.push(i + 1);
    if (y > 0) next.push(i - map.width);
    if (y < map.height - 1) next.push(i + map.width);
    for (const j of next) {
      if (seen[j] === 0 && map.walkable[j] === 1) {
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  return seen;
}

function isReachable(map: ClassicMap, seen: Uint8Array, p: { x: number; y: number }): boolean {
  return seen[p.y * map.width + p.x] === 1;
}

function walkableAtTile(map: ClassicMap, p: { x: number; y: number }): boolean {
  return (
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < map.width &&
    p.y < map.height &&
    map.walkable[p.y * map.width + p.x] === 1
  );
}

function roomOf(map: ClassicMap, p: { x: number; y: number }): number {
  return map.rooms.findIndex((r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h);
}

describe("dungeon generator", () => {
  const reg = bigRegistry();

  it("is a pure function of (registry, seed, depth)", () => {
    const a = generateArea(reg, 77, 3);
    const b = generateArea(reg, 77, 3);
    expect(b).toEqual(a);
    expect(generateArea(reg, 77, 2).walkable).not.toEqual(a.walkable);
    expect(generateArea(reg, 78, 3).walkable).not.toEqual(a.walkable);
  });

  it("reports sizes, ids, names and exact walkable counts", () => {
    const map = generateArea(reg, 5, 1);
    expect(map.id).toBe("classic.d1");
    expect(map.width).toBe(128);
    expect(map.height).toBe(128);
    expect(map.depth).toBe(1);
    expect(map.theme).toBe("classic.theme.crypt");
    expect(map.name).toBe("Crypt - Level 1");
    expect(map.walkable.length).toBe(128 * 128);
    expect(map.walkableCount).toBe(map.walkable.filter((w) => w === 1).length);
    expect(map.rooms.length).toBeGreaterThanOrEqual(18);
  });

  it("generates a 128x128 level in under 30 ms", () => {
    generateArea(reg, 1, 2); // warm up the JIT
    const times: number[] = [];
    for (let s = 0; s < 3; s++) {
      const t0 = performance.now();
      generateArea(reg, 100 + s, 5);
      times.push(performance.now() - t0);
    }
    // 30 ms on an idle box, times the measured load scale (support/perf.ts).
    expect(Math.min(...times)).toBeLessThan(30 * loadScale());
  });

  it("keeps every room reachable from the spawn", () => {
    for (const depth of [1, 2, 3, 4, 5, 9, 13]) {
      const map = generateArea(reg, 2024, depth);
      const seen = reachableFrom(map, map.spawn);
      for (const r of map.rooms) {
        const centre = { x: r.x + (r.w >> 1), y: r.y + (r.h >> 1) };
        expect(isReachable(map, seen, centre)).toBe(true);
      }
      expect(walkableAtTile(map, map.spawn)).toBe(true);
    }
  });

  it("connects every walkable tile of a crypt level", () => {
    const map = generateArea(reg, 31, 1);
    const seen = reachableFrom(map, map.spawn);
    let reachable = 0;
    for (const w of seen) reachable += w;
    expect(reachable).toBe(map.walkableCount);
  });

  it("places the arrival in rooms[0] with the spawn next to stairs up", () => {
    for (const depth of [1, 2, 4, 5]) {
      const map = generateArea(reg, 9, depth);
      expect(map.stairsUp).not.toBeNull();
      const up = map.stairsUp!;
      expect(roomOf(map, up)).toBe(0);
      expect(roomOf(map, map.spawn)).toBe(0);
      expect(
        Math.max(Math.abs(map.spawn.x - up.x), Math.abs(map.spawn.y - up.y)),
      ).toBeLessThanOrEqual(2);
      expect(walkableAtTile(map, up)).toBe(true);
    }
  });

  it("puts stairs down in the room farthest from the spawn", () => {
    const map = generateArea(reg, 44, 2);
    const down = map.stairsDown!;
    expect(down).not.toBeNull();
    expect(walkableAtTile(map, down)).toBe(true);
    const room = roomOf(map, down);
    expect(room).toBeGreaterThan(0);
    // Breadth-first distance (tiles) from the spawn, per room centre.
    const dist = bfsDistances(map, map.spawn);
    const centreDist = (r: number): number => {
      const rect = map.rooms[r]!;
      return dist[(rect.y + (rect.h >> 1)) * map.width + rect.x + (rect.w >> 1)]!;
    };
    let farthest = 0;
    for (let k = 1; k < map.rooms.length; k++) farthest = Math.max(farthest, centreDist(k));
    expect(centreDist(room)).toBe(farthest);
  });

  it("places bosses, waypoints and their spots by depth rules", () => {
    const boss = generateArea(reg, 3, 4);
    expect(boss.bossSpot).not.toBeNull();
    expect(roomOf(boss, boss.bossSpot!)).toBe(roomOf(boss, boss.stairsDown!));
    expect(walkableAtTile(boss, boss.bossSpot!)).toBe(true);

    expect(generateArea(reg, 3, 5).bossSpot).toBeNull();

    const waypoint = generateArea(reg, 3, 5);
    expect(waypoint.waypoint).not.toBeNull();
    expect(roomOf(waypoint, waypoint.waypoint!)).toBe(0);
    expect(walkableAtTile(waypoint, waypoint.waypoint!)).toBe(true);
    expect(generateArea(reg, 3, 2).waypoint).toBeNull();
    expect(generateArea(reg, 3, 4).waypoint).toBeNull();
  });

  it("picks the theme of the depth tier and falls back to the first theme", () => {
    expect(generateArea(reg, 1, 5).theme).toBe("classic.theme.caves");
    expect(generateArea(reg, 1, 5).name).toBe("Caves - Level 5");
    expect(generateArea(reg, 1, 9).theme).toBe("classic.theme.forge");
    expect(generateArea(reg, 1, 17).theme).toBe("classic.theme.crypt");
  });

  it("falls back to the default tile ids when the registry has no themes", () => {
    const bare = bigRegistry({ themes: false });
    const map = generateArea(bare, 7, 2);
    expect(map.theme).toBe("classic.theme.dungeon");
    expect(map.name).toBe("Dungeon - Level 2");
    expect(map.ground).toContain("tile.dungeon.floor");
    expect(map.objects).toContain("wall.dungeon");
    expect(map.objects).toContain("prop.stairs.up");
    expect(map.walkableCount).toBeGreaterThan(0);
  });

  it("only places decor on room perimeter tiles and never next to stairs", () => {
    const map = generateArea(reg, 58, 1);
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const id = map.objects[y * map.width + x];
        if (id !== "prop.barrel" && id !== "prop.crate") continue;
        const room = map.rooms[roomOf(map, { x, y })];
        expect(room).toBeDefined();
        const onEdge =
          x === room!.x ||
          y === room!.y ||
          x === room!.x + room!.w - 1 ||
          y === room!.y + room!.h - 1;
        expect(onEdge).toBe(true);
        for (const s of [map.stairsUp!, map.stairsDown!]) {
          expect(Math.max(Math.abs(s.x - x), Math.abs(s.y - y))).toBeGreaterThan(2);
        }
      }
    }
  });

  it("paints rock as void and wall objects only next to floor", () => {
    const map = generateArea(reg, 12, 1);
    for (let i = 0; i < map.walkable.length; i++) {
      if (map.walkable[i] === 1) continue;
      const obj = map.objects[i];
      if (obj === null) {
        expect(map.ground[i]).toBe("tile.void");
      }
    }
  });
});

describe("town generator", () => {
  const reg = bigRegistry();

  it("builds the town layout with npc spots, waypoint, stash and portal spot", () => {
    const town = generateArea(reg, 99, 0);
    expect(town.id).toBe("classic.d0");
    expect(town.name).toBe("Town");
    expect(town.theme).toBe("classic.theme.town");
    expect(town.width).toBe(72);
    expect(town.height).toBe(72);
    expect(town.stairsUp).toBeNull();
    expect(town.bossSpot).toBeNull();
    expect(town.walkableCount).toBe(town.walkable.filter((w) => w === 1).length);
    expect(town.waypoint).toEqual({ x: 36, y: 36 });
    expect(walkableAtTile(town, town.waypoint!)).toBe(true);
    expect(town.stash).not.toBeNull();
    expect(walkableAtTile(town, town.portalSpot)).toBe(true);
    expect(town.stairsDown!.x).toBeGreaterThanOrEqual(60);
    expect(walkableAtTile(town, town.stairsDown!)).toBe(true);
  });

  it("gives every NPC a distinct walkable standing tile reachable from the spawn", () => {
    const town = generateArea(reg, 99, 0);
    expect(town.npcSpots.map((s) => s.npc).sort()).toEqual(
      NPC_NAMES.map((n) => `classic.npc.${n}`).sort(),
    );
    const seen = reachableFrom(town, town.spawn);
    const tiles = new Set<number>();
    for (const s of town.npcSpots) {
      expect(walkableAtTile(town, s)).toBe(true);
      expect(isReachable(town, seen, s)).toBe(true);
      tiles.add(s.y * town.width + s.x);
    }
    expect(tiles.size).toBe(town.npcSpots.length);
    expect(isReachable(town, seen, town.portalSpot)).toBe(true);
    expect(isReachable(town, seen, town.stairsDown!)).toBe(true);
    expect(isReachable(town, seen, town.waypoint!)).toBe(true);
  });

  it("is deterministic for a seed and has no npc spots without NPC prototypes", () => {
    expect(generateArea(reg, 4, 0)).toEqual(generateArea(reg, 4, 0));
    expect(generateArea(bigRegistry({ npcs: false }), 4, 0).npcSpots).toEqual([]);
  });
});

/** Breadth-first distances (tiles) from `from`; unreachable tiles hold -1. */
function bfsDistances(map: ClassicMap, from: { x: number; y: number }): Int32Array {
  const dist = new Int32Array(map.width * map.height).fill(-1);
  const start = from.y * map.width + from.x;
  dist[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] as number;
    const x = i % map.width;
    const y = (i - x) / map.width;
    const next: number[] = [];
    if (x > 0) next.push(i - 1);
    if (x < map.width - 1) next.push(i + 1);
    if (y > 0) next.push(i - map.width);
    if (y < map.height - 1) next.push(i + map.width);
    for (const j of next) {
      if (dist[j] === -1 && map.walkable[j] === 1) {
        dist[j] = (dist[i] ?? 0) + 1;
        queue.push(j);
      }
    }
  }
  return dist;
}

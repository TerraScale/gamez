/**
 * Level population (classic.world, design §8.3). planPopulation() returns the
 * spawn requests of a freshly entered dungeon level; the transition system
 * queues them with pushSpawn and classic.monsters.spawn creates the units.
 *
 * Uses ctx.rng (sim randomness). Pack ids come from GameState.nextPack, which
 * is advanced here. Nothing is placed within 12 tiles of the arrival point,
 * and the arrival room (rooms[0]) is never populated.
 *
 * Party (docs/design/party.md §7.1, §8): `densityPct` (the party's
 * PartyScale.densityPct; 100 = solo) grows every normal/champion pack and
 * every unique pack's escort count to floor(n x densityPct / 100), never
 * below the solo count. At 100 nothing changes (same RNG calls, same plan).
 */
import type { FrozenRegistry, SimContext } from "@gamez/kernel";
import type { SpawnRequest } from "../bus.ts";
import { tileCenter, type TilePos } from "../fixed.ts";
import { bossDisplayName, isBossDepth, isRiftDepth, monsterLevel } from "../rules.ts";
import type { GameState } from "../resources.ts";
import {
  KIND,
  NAMES_UNIQUE_MONSTER,
  type MonsterModProto,
  type MonsterProto,
  type MonsterRarity,
  type NameTableProto,
  type ThemeProto,
} from "../types.ts";
import { balanceOf, tileKey } from "./common.ts";
import type { ClassicMap } from "./maps.ts";
import { riftProtoOf } from "./riftMap.ts";

/** Packs never start closer than this many tiles to the arrival point. */
const MIN_SPAWN_TILES = 12;
/** Champion packs carry two mods from this depth on; uniques carry three. */
const TWO_MODS_DEPTH = 9;
/** Boss depths cycle through the boss protos every 16 levels. */
const BOSS_CYCLE = 16;
/** Behaviours allowed to roll volley mods (extra projectiles). */
const RANGED = new Set(["archer", "caster"]);
/** Used when the balance proto is missing. */
const FALLBACK = {
  packs: [6, 10] as [number, number],
  maxMonstersPerLevel: 300,
  championPackChancePct: 15,
  uniquePacksPerLevel: [1, 2] as [number, number],
};

interface PoolEntry {
  id: string;
  proto: Readonly<MonsterProto>;
}

/** Spawn requests for every monster of the level `depth` (>= 1) on `map`. */
export function planPopulation(
  ctx: SimContext,
  registry: FrozenRegistry,
  map: ClassicMap,
  depth: number,
  game: GameState,
  densityPct = 100,
): SpawnRequest[] {
  if (depth <= 0) return [];
  const dense = (n: number): number =>
    densityPct === 100 ? n : Math.max(n, Math.floor((n * densityPct) / 100));
  const bal = balanceOf(registry);
  const packs = bal?.packs ?? FALLBACK.packs;
  const cap = bal?.maxMonstersPerLevel ?? FALLBACK.maxMonstersPerLevel;
  const ramp = bal?.packRampDepth ?? 0;
  const rampOf = (n: number): number => (depth < ramp ? Math.floor((n * depth) / ramp) : n);
  const champPct = rampOf(bal?.championPackChancePct ?? FALLBACK.championPackChancePct);
  const uniqueRange = bal?.uniquePacksPerLevel ?? FALLBACK.uniquePacksPerLevel;
  const uniques: [number, number] = [rampOf(uniqueRange[0]), rampOf(uniqueRange[1])];
  const theme = registry.get<ThemeProto>(KIND.theme, map.theme);
  const pool = monsterPool(registry, theme, depth);

  const level = monsterLevel(depth);
  const spawn = map.spawn;
  const placeable = placementTiles(map, spawn);
  const taken = new Set<number>();
  const out: SpawnRequest[] = [];
  const pick = (): PoolEntry => weightedPick(ctx, pool);
  const spotFree = (t: TilePos): boolean => placeable.has(tileKey(map.width, t.x, t.y));
  const freeLeader = (): TilePos | null => {
    const list = placeable.list;
    if (list.length === 0) return null;
    for (let attempt = 0; attempt < 16; attempt++) {
      const t = list[ctx.rng.int(0, list.length - 1)];
      if (t && !taken.has(tileKey(map.width, t.x, t.y))) return t;
    }
    return null;
  };
  const mark = (t: TilePos): void => {
    taken.add(tileKey(map.width, t.x, t.y));
  };

  // 1. Boss and its minions at the boss spot.
  const bossSpot = map.bossSpot;
  if (isBossDepth(depth) && bossSpot) {
    const bossDepth = ((depth - 1) % BOSS_CYCLE) + 1;
    const boss = registry
      .all<MonsterProto>(KIND.monster)
      .find(([, p]) => p.boss !== undefined && p.boss.depth === bossDepth);
    if (boss) {
      const [bossId, bp] = boss;
      const minionId = bp.boss?.minions ?? "";
      const minionCount = bp.boss?.minionCount ?? 0;
      const minionProto = registry.get<MonsterProto>(KIND.monster, minionId)
        ? minionId
        : pool.length > 0
          ? weightedPick(ctx, pool).id
          : "";
      const packId = game.nextPack++;
      mark(bossSpot);
      out.push(
        request(bossId, bossSpot, depth, level + 3, "boss", [], packId, bossDisplayName(bp)),
      );
      const free = nearFree(map, bossSpot, 3, (t) => walkableFree(map, t, taken));
      for (const t of ctx.rng.shuffle(free).slice(0, minionCount)) {
        if (minionProto === "" || out.length >= cap) break;
        mark(t);
        out.push(request(minionProto, t, depth, level, "minion", [], packId, ""));
      }
    }
  }

  // Packs need a monster pool; the boss above does not.
  if (pool.length === 0) return out;

  // 2. Unique packs: one leader with two (three from depth 9) mods, plus escorts.
  const uniqueCount = ctx.rng.int(
    Math.min(uniques[0], uniques[1]),
    Math.max(uniques[0], uniques[1]),
  );
  for (let u = 0; u < uniqueCount; u++) {
    if (out.length >= cap) break;
    const leader = freeLeader();
    if (!leader) break;
    const kindPick = pick();
    const escorts = dense(ctx.rng.int(3, 6));
    if (out.length + 1 + escorts > cap) break;
    const packId = game.nextPack++;
    const mods = pickMods(
      ctx,
      modIds(registry, depth, RANGED.has(kindPick.proto.behaviour)),
      depth >= TWO_MODS_DEPTH ? 3 : 2,
    );
    mark(leader);
    out.push(
      request(
        kindPick.id,
        leader,
        depth,
        level + 2,
        "unique",
        mods,
        packId,
        uniqueName(ctx, registry),
      ),
    );
    const free = nearFree(
      map,
      leader,
      3,
      (t) => spotFree(t) && !taken.has(tileKey(map.width, t.x, t.y)),
    );
    for (const t of ctx.rng.shuffle(free).slice(0, escorts)) {
      mark(t);
      out.push(request(kindPick.id, t, depth, level, "minion", [], packId, ""));
    }
  }

  // 3. Normal and champion packs.
  // Rift levels (wave A) use RiftProto.packs and no depth growth; the rest of the rules are the same.
  const riftPacks = isRiftDepth(depth) ? riftProtoOf(registry)?.packs : undefined;
  const packCount = riftPacks
    ? ctx.rng.int(Math.min(riftPacks[0], riftPacks[1]), Math.max(riftPacks[0], riftPacks[1]))
    : ctx.rng.int(Math.min(packs[0], packs[1]), Math.max(packs[0], packs[1])) +
      Math.floor(depth / 2);
  for (let p = 0; p < packCount; p++) {
    if (out.length >= cap) break;
    const leader = freeLeader();
    if (!leader) break;
    const kindPick = pick();
    const size = dense(
      Math.max(1, ctx.rng.int(kindPick.proto.packSize[0], kindPick.proto.packSize[1])),
    );
    const champion = ctx.rng.int(1, 100) <= champPct;
    if (out.length + size > cap) break;
    const packId = game.nextPack++;
    const rarity: MonsterRarity = champion ? "champion" : "normal";
    const mods = champion
      ? pickMods(
          ctx,
          modIds(registry, depth, RANGED.has(kindPick.proto.behaviour)),
          depth >= TWO_MODS_DEPTH ? 2 : 1,
        )
      : [];
    mark(leader);
    out.push(
      request(kindPick.id, leader, depth, level + (champion ? 1 : 0), rarity, mods, packId, ""),
    );
    const free = nearFree(
      map,
      leader,
      3,
      (t) => spotFree(t) && !taken.has(tileKey(map.width, t.x, t.y)),
    );
    for (const t of ctx.rng.shuffle(free).slice(0, size - 1)) {
      mark(t);
      out.push(
        request(kindPick.id, t, depth, level + (champion ? 1 : 0), rarity, mods, packId, ""),
      );
    }
  }
  return out;
}

function request(
  monster: string,
  t: TilePos,
  depth: number,
  level: number,
  rarity: MonsterRarity,
  mods: string[],
  pack: number,
  name: string,
): SpawnRequest {
  return {
    monster,
    x: tileCenter(t.x),
    y: tileCenter(t.y),
    depth,
    level,
    rarity,
    mods,
    pack,
    name,
    owner: 0,
    team: "monster",
    until: 0,
    awake: false,
  };
}

/** Monsters the theme places, sorted by id, weight > 0, not bosses and not reachable only by bosses. */
function monsterPool(
  registry: FrozenRegistry,
  theme: Readonly<ThemeProto> | undefined,
  depth: number,
): PoolEntry[] {
  if (!theme) return [];
  const ids = [...theme.monsters].sort(byText);
  const out: PoolEntry[] = [];
  for (const id of ids) {
    const proto = registry.get<MonsterProto>(KIND.monster, id);
    if (!proto) continue;
    if (proto.boss !== undefined || proto.behaviour === "totem") continue;
    if (proto.minDepth > depth || proto.weight <= 0) continue;
    out.push({ id, proto });
  }
  return out;
}

function weightedPick(ctx: SimContext, pool: readonly PoolEntry[]): PoolEntry {
  let total = 0;
  for (const e of pool) total += e.proto.weight;
  let r = ctx.rng.int(1, Math.max(1, total));
  for (const e of pool) {
    r -= e.proto.weight;
    if (r <= 0) return e;
  }
  return pool[pool.length - 1] as PoolEntry;
}

/** Mod ids usable at this depth; volley mods only for ranged behaviours. */
function modIds(registry: FrozenRegistry, depth: number, ranged: boolean): string[] {
  return registry
    .all<MonsterModProto>(KIND.monsterMod)
    .filter(([, m]) => m.minDepth <= depth && (ranged || m.extraProjectiles === 0))
    .map(([id]) => id);
}

/** `count` distinct mods, sorted by id. */
function pickMods(ctx: SimContext, list: readonly string[], count: number): string[] {
  if (count <= 0 || list.length === 0) return [];
  return ctx.rng.shuffle(list).slice(0, count).sort(byText);
}

function uniqueName(ctx: SimContext, registry: FrozenRegistry): string {
  const table = registry.get<NameTableProto>(KIND.names, NAMES_UNIQUE_MONSTER);
  if (!table || table.first.length === 0 || table.second.length === 0) return "";
  return `${ctx.rng.pick(table.first)} ${ctx.rng.pick(table.second)}`;
}

interface Placeable {
  /** Membership of candidate tiles (by tile key). */
  has(key: number): boolean;
  /** Candidate tiles in row-major order. */
  list: TilePos[];
}

/** Open floor of the non-arrival rooms, at least MIN_SPAWN_TILES from the spawn. */
function placementTiles(map: ClassicMap, spawn: TilePos): Placeable {
  const rooms = map.rooms.length > 1 ? map.rooms.slice(1) : map.rooms;
  const keys = new Set<number>();
  const list: TilePos[] = [];
  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = tileKey(map.width, x, y);
        if (map.walkable[i] !== 1 || (map.objects[i] ?? null) !== null) continue;
        const dx = x - spawn.x;
        const dy = y - spawn.y;
        if (dx * dx + dy * dy < MIN_SPAWN_TILES * MIN_SPAWN_TILES) continue;
        keys.add(i);
        list.push({ x, y });
      }
    }
  }
  return { has: (k) => keys.has(k), list };
}

/** Walkable, unobstructed and unoccupied tile (boss minions). */
function walkableFree(map: ClassicMap, t: TilePos, taken: ReadonlySet<number>): boolean {
  if (t.x < 0 || t.y < 0 || t.x >= map.width || t.y >= map.height) return false;
  const i = tileKey(map.width, t.x, t.y);
  return map.walkable[i] === 1 && (map.objects[i] ?? null) === null && !taken.has(i);
}

/** Tiles within Chebyshev `radius` of `c` (not `c` itself) passing `ok`, in row-major order. */
function nearFree(
  map: ClassicMap,
  c: TilePos,
  radius: number,
  ok: (t: TilePos) => boolean,
): TilePos[] {
  const out: TilePos[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const t = { x: c.x + dx, y: c.y + dy };
      if (t.x < 0 || t.y < 0 || t.x >= map.width || t.y >= map.height) continue;
      if (ok(t)) out.push(t);
    }
  }
  return out;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

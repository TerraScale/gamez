/**
 * Module "classic.debug" (wave A, QA only) — OWNER: T-client.
 * docs/design/wave-A.md §11.1.
 *
 * NEVER part of `modules` (the playable mode). The client loads it only with
 * `?debug=1&cheats=1` through `debugModules` and a mode variant whose module
 * list adds "classic.debug", so its contentHash differs and cheat saves never
 * mix with real ones (their own storage key). Action "classic.debug.grant"
 * takes a strictly validated payload (see parseGrant) and lets the QA harness
 * reach late-game systems (Rift, sets, crafting, talents) quickly.
 *
 * Everything here is sim code: integers, ctx registry data, plain JSON. Grants
 * that are queued (gold, levels, items, gems) run in their owners' command
 * systems on the next step(); the rest is written at once.
 */
import {
  ActionError,
  defineModule,
  type ActionDef,
  type SimContext,
  type SystemDef,
  type World,
} from "@gamez/kernel";
import { busOf, pushCommand, pushSpawn } from "../bus.ts";
import { ERR } from "../actions.ts";
import { AreaTag, Body, Dead, Level, Life, Monster, Pos, Talents } from "../components.ts";
import { tileCenter, type TilePos } from "../fixed.ts";
import {
  currentDepth,
  gameOf,
  heroOf,
  RES,
  type DungeonState,
  type RiftState,
} from "../resources.ts";
import { bossDisplayName, MAIN_DUNGEON_DEPTH, monsterLevel, xpAtLevel } from "../rules.ts";
import { MODULE } from "../ids.ts";
import {
  BALANCE_ID,
  ITEM_CATEGORIES,
  ITEM_RARITIES,
  KIND,
  RIFT_ID,
  type BalanceProto,
  type ItemCategory,
  type ItemRarity,
  type MonsterProto,
  type RiftProto,
  type SetProto,
  type SetItemProto,
} from "../types.ts";
import { tileKey } from "../world/common.ts";
import { getMap, type ClassicMap } from "../world/maps.ts";

/** Action name of the QA grant (not in ACTION: it does not exist in the playable mode). */
export const DEBUG_GRANT = "classic.debug.grant";

/** Sanitised grant payload (every field optional; at least one present). */
export interface GrantPayload {
  gold?: number;
  levels?: number;
  items?: { count: number; rarity: ItemRarity; ilvl: number; category?: ItemCategory };
  gems?: number;
  unlockRift?: boolean;
  bossesKilled?: number[];
  deepest?: number;
  talentPoints?: number;
  /** Every piece of this SetProto id, into the bag (QA: set bonuses). */
  set?: string;
  /** Fills the active rift run's progress to this percent (1..100; 100 calls the guardian). */
  riftProgress?: number;
  /**
   * Spawns this boss or rift guardian (MonsterProto id with a `boss` block or
   * `guardian: true`) awake, about 3 tiles from the hero on a tile the hero
   * can walk to (never behind a wall), in the dungeon or a rift.
   */
  spawnBoss?: string;
  /**
   * Sets every living boss of the hero's area to this percent of its max life
   * (1..99): phase changes on demand. A boss spawned by `spawnBoss` (in the
   * same grant or one not yet stepped) is queued, so it takes the wound when
   * it spawns on the next step.
   */
  woundBosses?: number;
}

const FIELDS = [
  "gold",
  "levels",
  "items",
  "gems",
  "unlockRift",
  "bossesKilled",
  "deepest",
  "talentPoints",
  "set",
  "riftProgress",
  "spawnBoss",
  "woundBosses",
] as const;

/** Content ids in payloads: namespaced, short, plain characters. */
const ID_RE = /^classic\.[a-z_]+\.[a-z0-9_]+$/;

function idOf(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > 80 || !ID_RE.test(v)) bad(`${what} must be a content id`);
  return v;
}

const MAX_DEPTH = 200;

function bad(message: string): never {
  throw new ActionError(ERR.badPayload, message);
}

function intIn(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    bad(`${what} must be an integer ${lo}..${hi}`);
  }
  return v;
}

function plain(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad(`${what} must be an object`);
  return v as Record<string, unknown>;
}

/**
 * Validates a grant payload strictly: unknown fields, wrong types, out of
 * range numbers and unknown rarities or categories all throw ActionError.
 */
export function parseGrant(payload: unknown): GrantPayload {
  const p = plain(payload, "payload");
  for (const k of Object.keys(p)) {
    if (!(FIELDS as readonly string[]).includes(k)) bad(`unexpected field "${k}"`);
  }
  const out: GrantPayload = {};
  if (p.gold !== undefined) out.gold = intIn(p.gold, 1, 1_000_000_000, "gold");
  if (p.levels !== undefined) out.levels = intIn(p.levels, 1, 200, "levels");
  if (p.gems !== undefined) out.gems = intIn(p.gems, 1, 50, "gems");
  if (p.talentPoints !== undefined)
    out.talentPoints = intIn(p.talentPoints, 1, 100, "talentPoints");
  if (p.deepest !== undefined) out.deepest = intIn(p.deepest, 0, MAX_DEPTH, "deepest");
  if (p.set !== undefined) out.set = idOf(p.set, "set");
  if (p.spawnBoss !== undefined) out.spawnBoss = idOf(p.spawnBoss, "spawnBoss");
  if (p.woundBosses !== undefined) out.woundBosses = intIn(p.woundBosses, 1, 99, "woundBosses");
  if (p.riftProgress !== undefined)
    out.riftProgress = intIn(p.riftProgress, 1, 100, "riftProgress");
  if (p.unlockRift !== undefined) {
    if (typeof p.unlockRift !== "boolean") bad("unlockRift must be a boolean");
    out.unlockRift = p.unlockRift;
  }
  if (p.bossesKilled !== undefined) {
    if (!Array.isArray(p.bossesKilled)) bad("bossesKilled must be an array of depths");
    if (p.bossesKilled.length > 32) bad("bossesKilled has too many entries");
    out.bossesKilled = p.bossesKilled.map((d) => intIn(d, 1, MAX_DEPTH, "bossesKilled depth"));
  }
  if (p.items !== undefined) {
    const it = plain(p.items, "items");
    for (const k of Object.keys(it)) {
      if (!["count", "rarity", "ilvl", "category"].includes(k)) bad(`unexpected items.${k}`);
    }
    const rarity = it.rarity;
    if (typeof rarity !== "string" || !(ITEM_RARITIES as readonly string[]).includes(rarity)) {
      bad("items.rarity must be a known rarity");
    }
    const item: NonNullable<GrantPayload["items"]> = {
      count: intIn(it.count, 1, 50, "items.count"),
      rarity: rarity as ItemRarity,
      ilvl: intIn(it.ilvl, 1, 200, "items.ilvl"),
    };
    if (it.category !== undefined) {
      const cat = it.category;
      if (typeof cat !== "string" || !(ITEM_CATEGORIES as readonly string[]).includes(cat)) {
        bad("items.category must be a known category");
      }
      item.category = cat as ItemCategory;
    }
    out.items = item;
  }
  if (Object.keys(out).length === 0) bad("nothing to grant");
  return out;
}

/** Adds the depths to DungeonState.bossesKilled (sorted, unique). */
function addBossKills(world: World, depths: readonly number[]): void {
  const dungeon = world.getResource<DungeonState>(RES.dungeon);
  if (!dungeon) return;
  const set = new Set(dungeon.bossesKilled);
  for (const d of depths) set.add(d);
  dungeon.bossesKilled = [...set].sort((a, b) => a - b);
}

/** Unlocks the rift: the boss depth counts as killed, the depth reaches it and RiftState unlocks. */
function unlockRift(world: World, ctx: SimContext): void {
  const unlockDepth =
    ctx.registry.get<RiftProto>(KIND.rift, RIFT_ID)?.unlockBossDepth ?? MAIN_DUNGEON_DEPTH;
  addBossKills(world, [unlockDepth]);
  const dungeon = world.getResource<DungeonState>(RES.dungeon);
  if (dungeon && dungeon.deepest < unlockDepth) dungeon.deepest = unlockDepth;
  const rift = world.getResource<RiftState>(RES.rift);
  if (rift) rift.unlocked = true;
}

/** Queues one grantItems per piece of the set (each at its own ilvl or the hero's level). */
function grantSet(world: World, ctx: SimContext, setId: string, heroLevel: number): void {
  const set = ctx.registry.get<SetProto>(KIND.set, setId);
  if (!set) throw new ActionError(ERR.unknownId, `unknown set ${setId}`);
  for (const pieceId of set.pieces) {
    const piece = ctx.registry.get<SetItemProto>(KIND.setItem, pieceId);
    if (!piece) continue;
    pushCommand(world, {
      op: "grantItems",
      count: 1,
      ilvl: Math.max(piece.ilvl, heroLevel),
      minRarity: "set",
      setItem: pieceId,
      toStash: false,
      reason: "debug",
    });
  }
}

/** Fills the active rift run to `pct` % of its goal (never lowers it). */
function fillRift(world: World, pct: number): void {
  const run = world.getResource<RiftState>(RES.rift)?.active ?? null;
  if (!run) throw new ActionError(ERR.notInRift, "no rift run is open");
  run.progress = Math.max(run.progress, Math.min(run.goal, Math.ceil((run.goal * pct) / 100)));
}

/** Spawn tiles are this many tiles (Chebyshev) from the hero at least. */
export const SPAWN_MIN_TILES = 3;
/** ...and at most this many steps of walking (4-neighbour) away. */
export const SPAWN_MAX_STEPS = 12;

/**
 * The spawn tile of a debug boss: the first free walkable tile, in
 * breadth-first walking order from the hero's tile (4 neighbours, fixed
 * order), that is at least SPAWN_MIN_TILES away. Reached by walking, so the
 * boss is never placed behind a wall the hero cannot get around (QA: a boss
 * across a wall kept the Auto hero in a fight/dodge loop it could not win).
 * Null when no such tile is within SPAWN_MAX_STEPS.
 */
export function reachableSpawnTile(
  map: ClassicMap,
  from: TilePos,
  occupied: ReadonlySet<number>,
): TilePos | null {
  const w = map.width;
  const h = map.height;
  if (from.x < 0 || from.y < 0 || from.x >= w || from.y >= h) return null;
  const seen = new Map<number, number>();
  const start = tileKey(w, from.x, from.y);
  seen.set(start, 0);
  const queue = [start];
  const dirs: readonly (readonly [number, number])[] = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head]!;
    const steps = seen.get(k)!;
    const x = k % w;
    const y = (k - x) / w;
    const far = Math.max(Math.abs(x - from.x), Math.abs(y - from.y)) >= SPAWN_MIN_TILES;
    if (far && !occupied.has(k)) return { x, y };
    if (steps >= SPAWN_MAX_STEPS) continue;
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nk = tileKey(w, nx, ny);
      if (seen.has(nk) || map.walkable[nk] !== 1) continue;
      seen.set(nk, steps + 1);
      queue.push(nk);
    }
  }
  return null;
}

/** Spawns a boss or guardian awake near the hero (not in town). */
function spawnBossNear(world: World, ctx: SimContext, hero: number, id: string): void {
  const proto = ctx.registry.get<MonsterProto>(KIND.monster, id);
  if (!proto || (proto.boss === undefined && proto.guardian !== true)) {
    throw new ActionError(ERR.unknownId, `${id} is not a boss or rift guardian`);
  }
  const depth = currentDepth(world);
  if (depth === 0) throw new ActionError(ERR.inTown, "bosses spawn only outside the town");
  const map = getMap(world, ctx.registry, depth);
  const occupied = new Set<number>();
  for (let i = 0; i < map.objects.length; i++)
    if ((map.objects[i] ?? null) !== null) occupied.add(i);
  for (const e of world.query(Pos, Body, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth || !world.read(e, Body).solid) continue;
    const p = world.read(e, Pos);
    occupied.add(tileKey(map.width, p.x >> 8, p.y >> 8));
  }
  const hp = world.read(hero, Pos);
  const at = reachableSpawnTile(map, { x: hp.x >> 8, y: hp.y >> 8 }, occupied);
  if (!at) throw new ActionError(ERR.badTarget, "no free tile the hero can reach");
  pushSpawn(world, {
    monster: id,
    x: tileCenter(at.x),
    y: tileCenter(at.y),
    depth,
    level: monsterLevel(depth) + 3,
    rarity: "boss",
    mods: [],
    pack: gameOf(world).nextPack++,
    name: proto.boss !== undefined ? bossDisplayName(proto) : "",
    owner: 0,
    team: "monster",
    until: 0,
    awake: true,
  });
}

/** Resource: a wound for bosses still queued in Bus.spawns (applied right after they spawn). */
export const PENDING_WOUND = "classic.debug.pendingWound";

export interface PendingWound {
  depth: number;
  pct: number;
}

/** Lowers every living boss at `depth` to `pct` % of its max life (never heals). Returns how many. */
function woundAt(world: World, depth: number, pct: number): number {
  let found = 0;
  for (const e of world.query(Monster, Life, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth || world.has(e, Dead)) continue;
    if (world.read(e, Monster).rarity !== "boss") continue;
    const life = world.read(e, Life);
    const hp = Math.max(1, Math.floor((life.max * pct) / 100));
    if (hp < life.hp) world.update(e, Life, { hp });
    found++;
  }
  return found;
}

/**
 * Lowers every living boss of the hero's area to `pct` % of its max life
 * (never heals). Bosses still queued in Bus.spawns for the area (spawnBoss
 * runs through the spawn queue) take the wound when they spawn: the grant
 * used to fail with "no living boss" and roll the spawn back with it.
 */
function woundBosses(world: World, pct: number): void {
  const depth = currentDepth(world);
  const found = woundAt(world, depth, pct);
  const queued = busOf(world).spawns.some((r) => r.rarity === "boss" && r.depth === depth);
  if (queued) world.setResource<PendingWound>(PENDING_WOUND, { depth, pct });
  if (found === 0 && !queued) throw new ActionError(ERR.badTarget, "no living boss in this area");
}

/**
 * classic.debug.pendingWound (pre -1049, right after classic.monsters.spawn):
 * applies a PendingWound to the bosses that just spawned, then clears it.
 */
export const pendingWoundSystem: SystemDef = {
  id: "classic.debug.pendingWound",
  stage: "pre",
  order: -1049,
  run(world) {
    const w = world.getResource<PendingWound>(PENDING_WOUND);
    if (w === undefined) return;
    woundAt(world, w.depth, w.pct);
    world.deleteResource(PENDING_WOUND);
  },
};

/** Applies a validated grant to the sim (queued grants run on the next step). */
export function applyGrant(world: World, ctx: SimContext, g: GrantPayload): void {
  const hero = heroOf(world);
  if (hero === 0 || !world.has(hero, Level)) throw new ActionError(ERR.noHero, "no hero");
  const level = world.read(hero, Level);
  if (g.gold !== undefined)
    pushCommand(world, { op: "grantGold", amount: g.gold, reason: "debug" });
  if (g.levels !== undefined) {
    const bal = ctx.registry.get<BalanceProto>(KIND.balance, BALANCE_ID);
    if (bal) {
      const target = Math.min(bal.maxLevel, level.level + g.levels);
      const need = xpAtLevel(bal, target) - level.xp;
      if (need > 0) pushCommand(world, { op: "grantXp", amount: need, reason: "debug" });
    }
  }
  if (g.items !== undefined) {
    pushCommand(world, {
      op: "grantItems",
      count: g.items.count,
      ilvl: g.items.ilvl,
      minRarity: g.items.rarity,
      ...(g.items.category !== undefined ? { category: g.items.category } : {}),
      toStash: false,
      reason: "debug",
    });
  }
  if (g.gems !== undefined) {
    pushCommand(world, {
      op: "grantItems",
      count: g.gems,
      ilvl: Math.max(1, level.level),
      minRarity: "normal",
      category: "gem",
      toStash: false,
      reason: "debug",
    });
  }
  if (g.bossesKilled !== undefined) addBossKills(world, g.bossesKilled);
  if (g.deepest !== undefined) {
    const dungeon = world.getResource<DungeonState>(RES.dungeon);
    if (dungeon && g.deepest > dungeon.deepest) dungeon.deepest = g.deepest;
  }
  if (g.unlockRift) unlockRift(world, ctx);
  if (g.set !== undefined) grantSet(world, ctx, g.set, level.level);
  if (g.riftProgress !== undefined) fillRift(world, g.riftProgress);
  if (g.spawnBoss !== undefined && world.has(hero, Pos))
    spawnBossNear(world, ctx, hero, g.spawnBoss);
  if (g.woundBosses !== undefined) woundBosses(world, g.woundBosses);
  if (g.talentPoints !== undefined) {
    const t = world.get(hero, Talents);
    if (t) world.update(hero, Talents, { points: t.points + g.talentPoints });
    else {
      world.add(hero, Talents, {
        points: g.talentPoints,
        spent: 0,
        ranks: [],
        levelSeen: level.level,
      });
    }
  }
}

const grant: ActionDef<GrantPayload> = {
  name: DEBUG_GRANT,
  parse(_world, payload) {
    return parseGrant(payload);
  },
  apply(world, p, ctx) {
    applyGrant(world, ctx, p);
  },
};

export const classicDebug = defineModule({
  id: MODULE.debug,
  version: "0.3.0",
  deps: [MODULE.content, MODULE.core],
  optionalDeps: [MODULE.items, MODULE.progression, MODULE.world, MODULE.rift, MODULE.talents],
  systems: [pendingWoundSystem],
  actions: [grant],
});

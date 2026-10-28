/**
 * Rift tracking (classic.rift.track, post 160; docs/design/wave-A.md §7).
 * Unlocks the rift when the unlock boss is dead, turns hero-credited kills in
 * the run's depth into progress (RiftProto.progress per rarity, cap goal,
 * classic.rift.progress every 10 %), spawns the guardian at the goal, and
 * ends the run: guardian dead = completed (record, rewards, exit), hero death
 * = failed (reason "death").
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, pushCommand, pushSpawn, type DeathRecord } from "../bus.ts";
import { AreaTag, Body, Dead, Monster, Pos } from "../components.ts";
import { emit } from "../events.ts";
import { tileCenter, type TilePos } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { monsterLevel, riftScore } from "../rules.ts";
import {
  gameOf,
  heroOf,
  RES,
  type DungeonState,
  type RiftRun,
  type RunStats,
} from "../resources.ts";
import { type RiftProto, KIND, type MonsterProto, type ThemeProto } from "../types.ts";
import { findFreeNear, tileKey } from "../world/common.ts";
import { getMap, type ClassicMap } from "../world/maps.ts";
import { riftProtoOf } from "../world/riftMap.ts";
import { spawnInteractableSub } from "../world/transition.ts";
import { failRun } from "./ops.ts";
import { pushHistory, riftStateOf, recordOf } from "./state.ts";

/** Guardian ring: Chebyshev distance range (tiles) from the hero. */
const GUARDIAN_MIN_TILES = 6;
const GUARDIAN_MAX_TILES = 10;
/** Progress thresholds reported as classic.rift.progress (percent). */
const PROGRESS_STEP_PCT = 10;

export const riftTrackSystem: SystemDef = {
  ...SYSTEM.riftTrack,
  run(world, ctx) {
    const rift = riftProtoOf(ctx.registry);
    if (!rift) return;
    const state = riftStateOf(world);
    const dungeon = world.getResource<DungeonState>(RES.dungeon);
    if (!state.unlocked && dungeon?.bossesKilled.includes(rift.unlockBossDepth)) {
      state.unlocked = true;
      emit(ctx, { type: "classic.rift.unlocked" });
    }
    const run = state.active;
    if (!run) return;

    for (const d of busOf(world).deaths) {
      if (state.active !== run || d.depth !== run.depth) continue;
      if (d.isHero) {
        run.deaths += 1;
        failRun(world, ctx, run, "death");
        return;
      }
      if (d.team !== "monster" || d.rarity === "summon") continue;
      if (d.rarity === "boss") {
        // The guardian: only the guardian is a boss in a rift.
        if (run.guardianSpawned) completeRun(world, ctx, run, rift, d.x, d.y);
        return;
      }
      if (d.creditTeam === "hero") addProgress(ctx, run, rift, d);
    }

    if (state.active !== run) return;
    if (!run.guardianSpawned && run.progress >= run.goal) spawnGuardian(world, ctx, run, rift);
    if (run.guardianSpawned && run.guardian === 0) findGuardian(world, ctx, run);
  },
};

/** Progress points of a kill, capped at the goal; emits each 10 % crossed. */
function addProgress(
  ctx: SimContext,
  run: RiftRun,
  rift: Readonly<RiftProto>,
  d: DeathRecord,
): void {
  if (d.rarity === "hero") return;
  const points = rift.progress[d.rarity] ?? 0;
  if (points <= 0 || run.progress >= run.goal) return;
  const before = run.progress;
  const after = Math.min(run.goal, before + points);
  run.progress = after;
  for (let pct = PROGRESS_STEP_PCT; pct <= 100; pct += PROGRESS_STEP_PCT) {
    if (before * 100 < run.goal * pct && after * 100 >= run.goal * pct) {
      emit(ctx, { type: "classic.rift.progress", pct });
    }
  }
}

/** Queues the guardian spawn 6-10 tiles from the hero (awake, boss rarity, level + 2). */
function spawnGuardian(
  world: World,
  ctx: SimContext,
  run: RiftRun,
  rift: Readonly<RiftProto>,
): void {
  const map = getMap(world, ctx.registry, run.depth);
  const monster = guardianId(ctx, rift, map, run.level);
  if (monster === null) {
    // No monster content at all: the run completes where the hero stands.
    const hero = heroOf(world);
    const p = hero !== 0 ? world.read(hero, Pos) : { x: 0, y: 0 };
    completeRun(world, ctx, run, rift, p.x, p.y);
    return;
  }
  const hero = heroOf(world);
  const heroTile: TilePos =
    hero !== 0 ? { x: world.read(hero, Pos).x >> 8, y: world.read(hero, Pos).y >> 8 } : map.spawn;
  const at = guardianTile(world, ctx, map, heroTile);
  const game = gameOf(world);
  pushSpawn(world, {
    monster,
    x: tileCenter(at.x),
    y: tileCenter(at.y),
    depth: run.depth,
    level: monsterLevel(run.depth) + 2,
    rarity: "boss",
    mods: [],
    pack: game.nextPack++,
    name: "",
    owner: 0,
    team: "monster",
    until: 0,
    awake: true,
  });
  run.guardianSpawned = true;
}

/** The guardian of a level: RiftProto.guardians[level % n], else the strongest regular monster of the theme. */
function guardianId(
  ctx: SimContext,
  rift: Readonly<RiftProto>,
  map: ClassicMap,
  level: number,
): string | null {
  const list = rift.guardians;
  if (list.length > 0) {
    const id = list[level % list.length] ?? "";
    if (ctx.registry.get<MonsterProto>(KIND.monster, id)) return id;
  }
  const theme = ctx.registry.get<ThemeProto>(KIND.theme, map.theme);
  let best: { id: string; life: number } | null = null;
  for (const id of [...(theme?.monsters ?? [])].sort(byText)) {
    const p = ctx.registry.get<MonsterProto>(KIND.monster, id);
    if (!p || p.boss !== undefined || p.behaviour === "totem") continue;
    if (best === null || p.life > best.life) best = { id, life: p.life };
  }
  return best?.id ?? null;
}

/** A walkable, unobstructed tile 6-10 tiles from the hero (seeded pick), else the nearest free tile. */
function guardianTile(world: World, ctx: SimContext, map: ClassicMap, hero: TilePos): TilePos {
  const occupied = new Set<number>();
  for (const e of world.query(Pos, Body, AreaTag)) {
    if (world.read(e, AreaTag).depth !== map.depth || !world.read(e, Body).solid) continue;
    const p = world.read(e, Pos);
    occupied.add(tileKey(map.width, p.x >> 8, p.y >> 8));
  }
  const ring: TilePos[] = [];
  for (let dy = -GUARDIAN_MAX_TILES; dy <= GUARDIAN_MAX_TILES; dy++) {
    for (let dx = -GUARDIAN_MAX_TILES; dx <= GUARDIAN_MAX_TILES; dx++) {
      const r = Math.max(Math.abs(dx), Math.abs(dy));
      if (r < GUARDIAN_MIN_TILES) continue;
      const x = hero.x + dx;
      const y = hero.y + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const i = tileKey(map.width, x, y);
      if (map.walkable[i] !== 1 || (map.objects[i] ?? null) !== null || occupied.has(i)) continue;
      ring.push({ x, y });
    }
  }
  if (ring.length === 0) return findFreeNear(map, hero, 0, occupied) ?? map.spawn;
  return ring[ctx.rng.int(0, ring.length - 1)] ?? map.spawn;
}

/** Finds the guardian entity once it exists; re-queues the spawn when it was dropped. */
function findGuardian(world: World, ctx: SimContext, run: RiftRun): void {
  let found: Entity = 0;
  for (const e of world.query(Monster, AreaTag)) {
    if (world.read(e, AreaTag).depth !== run.depth || world.has(e, Dead)) continue;
    if (world.read(e, Monster).rarity !== "boss") continue;
    found = e;
    break;
  }
  if (found !== 0) {
    run.guardian = found;
    const m = world.read(found, Monster);
    emit(ctx, { type: "classic.rift.guardian", entity: found, monster: m.proto, name: m.name });
    return;
  }
  const pending = busOf(world).spawns.some((r) => r.depth === run.depth && r.rarity === "boss");
  if (!pending) run.guardianSpawned = false;
}

/** Completes the run: record, rewards (halved over time), exit at (x, y), history, best and counters. */
function completeRun(
  world: World,
  ctx: SimContext,
  run: RiftRun,
  rift: Readonly<RiftProto>,
  x: number,
  y: number,
): void {
  const state = riftStateOf(world);
  const ticks = Math.max(0, ctx.tick - run.startTick);
  const overTime = ticks > rift.timeLimit;
  const score = riftScore(run.level, ticks, rift.timeLimit, true);
  let gold = rift.reward.goldPerLevel * run.level;
  let items =
    rift.reward.items +
    (rift.reward.bonusEvery > 0 ? Math.floor(run.level / rift.reward.bonusEvery) : 0);
  if (overTime) {
    gold = Math.floor(gold / 2);
    items = Math.max(1, Math.floor(items / 2));
  }
  const record = recordOf(world, run, ctx.tick, {
    completed: true,
    score,
    reason: "",
    deaths: run.deaths,
  });
  if (gold > 0) pushCommand(world, { op: "grantGold", amount: gold, reason: "rift" });
  if (items > 0) {
    pushCommand(world, {
      op: "grantItems",
      count: items,
      ilvl: monsterLevel(run.depth),
      minRarity: rift.reward.minRarity,
      toStash: false,
      reason: "rift",
    });
  }
  spawnInteractableSub(world, "riftExit", 0, x, y, run.depth);
  state.maxCompleted = Math.max(state.maxCompleted, run.level);
  if (!state.best || record.score > state.best.score) state.best = record;
  pushHistory(state, record);
  state.active = null;
  const rs = world.getResource<RunStats>(RES.stats);
  if (rs) rs.riftsCompleted = (rs.riftsCompleted ?? 0) + 1;
  emit(ctx, { type: "classic.rift.completed", record, gold, items });
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

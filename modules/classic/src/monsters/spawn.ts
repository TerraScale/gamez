/**
 * classic.monsters.spawn (pre -1050, owner: T4 monster builder): drains
 * Bus.spawns in order and creates monster entities with every component the
 * AI, movement, combat and death systems read.
 *
 * Party (docs/design/party.md §7.1, §8): in a party of 2+, monster-team
 * spawns (not hero summons) get partyScaleOf(): Life by lifePct, CombatStats
 * dmgMin/dmgMax and the flat element adds by damagePct, Monster.xp by xpPct.
 * Solo (and a party of one) skips it entirely.
 */
import type { Entity, FrozenRegistry, SimContext, SystemDef, World } from "@gamez/kernel";
import {
  Ai,
  AreaTag,
  Body,
  CombatStats,
  type CombatStatsValue,
  Faction,
  Life,
  Monster,
  Mover,
  Pos,
  SkillBook,
  Statuses,
  Summoned,
} from "../components.ts";
import { busOf, type SpawnRequest } from "../bus.ts";
import { emit } from "../events.ts";
import { type Facing, dist2, pct, tileCenter, tiles } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth, RES, type DungeonState } from "../resources.ts";
import { bossDisplayName, bossPhase, scaleMonster, type PartyScale } from "../rules.ts";
import { partyScaleOf, partySize } from "../party/shared.ts";
import { gridOf } from "../spatial.ts";
import {
  KIND,
  type MonsterModProto,
  type MonsterProto,
  type MonsterRarity,
  type SkillProto,
} from "../types.ts";
import { getMap, walkableAt, type ClassicMap } from "../world/maps.ts";
import { skillOf } from "./util.ts";

/** Mods of a list of ids (unknown ids are skipped). */
export function modProtos(reg: FrozenRegistry, ids: readonly string[]): MonsterModProto[] {
  const out: MonsterModProto[] = [];
  for (const id of ids) {
    const m = reg.get<MonsterModProto>(KIND.monsterMod, id);
    if (m !== undefined) out.push(m);
  }
  return out;
}

/**
 * Combat stats of a monster at `level` with rarity and mods (CONTRACT: the
 * values classic.combat reads for monsters).
 */
export function monsterCombatStats(
  ctx: SimContext,
  proto: MonsterProto,
  level: number,
  rarity: MonsterRarity,
  mods: readonly MonsterModProto[],
): CombatStatsValue {
  const s = scaleMonster(proto, level, rarity, mods);
  const basic = skillOf(ctx, proto.skills[0] ?? "");
  const avg = Math.floor((s.dmgMin + s.dmgMax) / 2);
  const add = { fire: 0, cold: 0, lightning: 0, poison: 0 };
  for (const m of mods) {
    const el = m.addElement;
    if (el === undefined || el.element === "phys") continue;
    add[el.element] += pct(avg, el.pct);
  }
  const elite = rarity === "champion" || rarity === "unique" || rarity === "boss";
  return {
    level: Math.max(1, level),
    armor: s.armor,
    toHit: s.toHit,
    dmgMin: s.dmgMin,
    dmgMax: s.dmgMax,
    addFire: add.fire,
    addCold: add.cold,
    addLightning: add.lightning,
    addPoison: add.poison,
    spellPct: 0,
    critPct: elite ? 5 : 0,
    critMult: 150,
    attackSpeed: s.speedPct,
    castSpeed: s.speedPct,
    moveSpeed: s.speedPct,
    resFire: proto.resist.fire + s.resistAll,
    resCold: proto.resist.cold + s.resistAll,
    resLightning: proto.resist.lightning + s.resistAll,
    resPoison: proto.resist.poison + s.resistAll,
    lifeSteal: s.lifeStealPct,
    manaSteal: 0,
    blockPct: 0,
    thorns: 0,
    attackTicks: basic?.castTicks ?? 12,
    attackRange: basic !== undefined && basic.range > 0 ? basic.range : proto.radius + tiles(1),
    attackProjectile: basic?.projectile?.sprite ?? "",
    attackElement: proto.element,
  };
}

/**
 * Starting life: full, except a boss whose depth has a recorded wound
 * (DungeonState.bossWound, left when its level was destroyed) starts that
 * much lower (at least 10 % of max). The wound is consumed.
 */
function startLife(world: World, req: SpawnRequest, max: number): number {
  if (req.rarity !== "boss") return max;
  const dungeon = world.getResource<DungeonState>(RES.dungeon);
  const wound = dungeon?.bossWound ?? null;
  if (!dungeon || wound === null || wound.depth !== req.depth) return max;
  dungeon.bossWound = null;
  return Math.max(Math.ceil(max / 10), max - wound.lost);
}

/** Display name: the request name, else "Mighty Shambling Husk" style, else the proto name. */
export function monsterName(
  proto: MonsterProto,
  rarity: MonsterRarity,
  mods: readonly MonsterModProto[],
  requested: string,
): string {
  if (requested !== "") return requested;
  const modNames = mods.map((m) => m.name).join(" ");
  if ((rarity === "champion" || rarity === "unique") && modNames !== "") {
    return `${modNames} ${proto.name}`;
  }
  if (rarity === "boss") return bossDisplayName(proto);
  return proto.name;
}

/** Nearest walkable tile centre to (x, y) within 3 tiles (scan order breaks ties); else (x, y). */
export function placeNear(map: ClassicMap, x: number, y: number): { x: number; y: number } {
  const tx = x >> 8;
  const ty = y >> 8;
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (!walkableAt(map, nx, ny)) continue;
      const cx = tileCenter(nx);
      const cy = tileCenter(ny);
      const d = dist2(cx, cy, x, y);
      if (d < bestD) {
        bestD = d;
        best = { x: cx, y: cy };
      }
    }
  }
  return best ?? { x, y };
}

/** Applies the party multipliers to a monster's stats in place (integer maths). */
export function scaleForParty(
  scale: PartyScale,
  stats: CombatStatsValue,
  life: number,
  xp: number,
): { life: number; xp: number } {
  if (scale.damagePct !== 100) {
    const k = scale.damagePct;
    stats.dmgMin = pct(stats.dmgMin, k);
    stats.dmgMax = Math.max(stats.dmgMin, pct(stats.dmgMax, k));
    stats.addFire = pct(stats.addFire, k);
    stats.addCold = pct(stats.addCold, k);
    stats.addLightning = pct(stats.addLightning, k);
    stats.addPoison = pct(stats.addPoison, k);
  }
  return {
    life: scale.lifePct !== 100 ? Math.max(1, pct(life, scale.lifePct)) : life,
    xp: scale.xpPct !== 100 ? pct(xp, scale.xpPct) : xp,
  };
}

function spawnOne(
  world: World,
  ctx: SimContext,
  req: SpawnRequest,
  depth: number,
  party: PartyScale | null,
): void {
  const proto = ctx.registry.get<MonsterProto>(KIND.monster, req.monster);
  if (proto === undefined) return;
  const level = Math.max(1, req.level);
  const mods = modProtos(ctx.registry, req.mods);
  const map = getMap(world, ctx.registry, req.depth);
  const at = placeNear(map, req.x, req.y);
  const e: Entity = world.create();
  const stats = monsterCombatStats(ctx, proto, level, req.rarity, mods);
  const scaled = scaleMonster(proto, level, req.rarity, mods);
  let lifeMax = scaled.life;
  let xp = scaled.xp;
  if (party !== null && req.team === "monster") {
    const r = scaleForParty(party, stats, lifeMax, xp);
    lifeMax = r.life;
    xp = r.xp;
  }

  const ranks = proto.skills
    .map((id) => {
      const rank = Math.max(1, Math.floor(level / 3));
      const sk = ctx.registry.get<SkillProto>(KIND.skill, id);
      return { skill: id, rank: sk ? Math.min(rank, sk.maxRank) : rank };
    })
    .sort((a, b) => (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));

  world.add(e, Monster, {
    proto: req.monster,
    level,
    rarity: req.rarity,
    mods: [...req.mods],
    pack: req.pack,
    name: monsterName(proto, req.rarity, mods, req.name),
    xp,
  });
  const hp = startLife(world, req, lifeMax);
  world.add(e, Ai, {
    state: req.awake ? "idle" : "sleep",
    target: 0,
    homeX: at.x,
    homeY: at.y,
    thinkAt: ctx.tick,
    repathAt: 0,
    specialAt: 0,
    // A wounded boss has already called the minions of the thresholds it is past;
    // bosses with wave A phases start at 0 and enter their passed phases again.
    count:
      req.rarity === "boss" && !(proto.phases !== undefined && proto.phases.length > 0)
        ? bossPhase(hp, lifeMax)
        : 0,
  });
  world.add(e, SkillBook, { ranks, cooldowns: [] });
  world.add(e, Life, { hp, max: lifeMax, acc: 0 });
  world.add(e, CombatStats, stats);
  world.add(e, Pos, { x: at.x, y: at.y });
  world.add(e, AreaTag, { depth: req.depth });
  const facing: Facing = "s";
  world.add(e, Mover, {
    speed: proto.moveSpeed,
    path: [],
    goalX: -1,
    goalY: -1,
    moving: false,
    facing,
    blocked: 0,
  });
  world.add(e, Body, { radius: proto.radius, solid: true });
  world.add(e, Faction, { team: req.team });
  world.add(e, Statuses, { list: [] });
  if (req.owner !== 0 || req.until > 0) {
    world.add(e, Summoned, { owner: req.owner, until: req.until });
  }
  if (req.depth === depth) gridOf(world).insert(e, at.x, at.y);
  if (req.rarity === "boss") {
    emit(ctx, { type: "classic.boss.spawned", entity: e, monster: req.monster, depth: req.depth });
  }
}

export const monstersSpawnSystem: SystemDef = {
  ...SYSTEM.monstersSpawn,
  run(world, ctx) {
    const bus = busOf(world);
    if (bus.spawns.length === 0) return;
    const reqs = bus.spawns.splice(0, bus.spawns.length);
    const depth = currentDepth(world);
    const party = partySize(world) > 1 ? partyScaleOf(world, ctx.registry) : null;
    for (const req of reqs) spawnOne(world, ctx, req, depth, party);
  },
};

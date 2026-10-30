/**
 * The recruit flow (docs/design/party.md §4.1). Shared by classic.party.recruit
 * (town, fee from the purse) and the QA grant of classic.debug (`free`: any
 * place, no fee). Also the placement helper every party op uses to put a unit
 * on a free walkable tile next to another unit.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { ERR, fail, OK, type OpResult } from "../actions.ts";
import { AreaTag, Body, Level, PartyMember, Pos, Wallet } from "../components.ts";
import { emit } from "../events.ts";
import { tileCenter } from "../fixed.ts";
import { spawnHeroEntity } from "../progression/hero.ts";
import { addXp } from "../progression/level.ts";
import { currentDepth, heroOf, RES } from "../resources.ts";
import { partyProtoOf, recruitFee, recruitLevel, xpAtLevel } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto, type ClassProto } from "../types.ts";
import { getMap, walkableAt, type ClassicMap } from "../world/maps.ts";
import { ensureParty, partyMembers, purseOf, roleOf, slotsOf } from "./shared.ts";

/** Largest ring searched around a unit for a free tile. */
export const FREE_TILE_RADIUS = 6;

/**
 * The nearest free walkable tile of `depth` around tile (tx, ty), ring by
 * ring (fixed order, integer maths). A tile is taken by a solid unit of that
 * depth other than `self`, or by a map object. Null when none is found.
 */
export function freeTileNear(
  world: World,
  map: ClassicMap,
  depth: number,
  tx: number,
  ty: number,
  self: Entity,
): { x: number; y: number } | null {
  const taken = new Set<number>();
  for (const e of world.query(Pos, Body, AreaTag)) {
    if (e === self || world.read(e, AreaTag).depth !== depth || !world.read(e, Body).solid) {
      continue;
    }
    const p = world.read(e, Pos);
    taken.add((p.y >> 8) * map.width + (p.x >> 8));
  }
  for (let r = 1; r <= FREE_TILE_RADIUS; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (!walkableAt(map, x, y)) continue;
        const k = y * map.width + x;
        if (taken.has(k) || (map.objects[k] ?? null) !== null) continue;
        return { x, y };
      }
    }
  }
  return null;
}

export interface RecruitRequest {
  classId: string;
  /** Already clean (cleanHeroName). */
  name: string;
  /** QA grant: no town requirement and no fee. */
  free: boolean;
}

/**
 * Adds a recruit to the party. Checks: a hero exists, town (unless `free`),
 * the class exists, a free unlocked slot, the fee (unless `free`) is covered
 * by the purse. The recruit starts at recruitLevel(highest member level) and
 * stands next to the controlled hero.
 */
export function execRecruit(world: World, ctx: SimContext, req: RecruitRequest): OpResult {
  const party = ensureParty(world, ctx);
  if (!party) return fail(ERR.noHero, "there is no hero yet");
  if (!req.free && currentDepth(world) !== 0) {
    return fail(ERR.notInTown, "recruits join in town");
  }
  const cls = ctx.registry.get<ClassProto>(KIND.class, req.classId);
  if (!cls) return fail(ERR.unknownId, `unknown class "${req.classId}"`);
  const members = partyMembers(world);
  if (members.length >= slotsOf(world, ctx.registry)) {
    return fail(ERR.partyFull, "every party slot is taken");
  }

  const proto = partyProtoOf(ctx.registry);
  const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
  let highest = 1;
  for (const e of members) highest = Math.max(highest, world.get(e, Level)?.level ?? 1);
  const level = recruitLevel(proto, highest);
  const fee = req.free ? 0 : recruitFee(proto, level);
  const purse = purseOf(world);
  const gold = world.get(purse, Wallet)?.gold ?? 0;
  if (fee > gold) return fail(ERR.noGold, `a recruit costs ${fee} gold`);
  if (fee > 0) world.update(purse, Wallet, { gold: gold - fee });

  const e = spawnHeroEntity(world, ctx, cls, req.classId, req.name);
  if (level > 1) addXp(world, ctx, e, xpAtLevel(bal, level), "recruit");

  // Next to the controlled hero, in the party's current area (a free QA
  // recruit can join in the dungeon; a town-only recruit is in town anyway).
  // The area's spawn when the hero has no position there.
  const depth = currentDepth(world);
  const map = getMap(world, ctx.registry, depth);
  const leader = heroOf(world);
  const lp = world.get(leader, AreaTag)?.depth === depth ? world.get(leader, Pos) : undefined;
  const from = lp ?? { x: tileCenter(map.spawn.x), y: tileCenter(map.spawn.y) };
  const fx = from.x >> 8;
  const fy = from.y >> 8;
  const spot = freeTileNear(world, map, depth, fx, fy, e) ?? { x: fx, y: fy };
  world.add(e, Pos, { x: tileCenter(spot.x), y: tileCenter(spot.y) });
  world.add(e, AreaTag, { depth });

  const uid = party.nextUid;
  world.add(e, PartyMember, {
    uid,
    joinedTick: ctx.tick,
    role: roleOf(world, ctx.registry, e),
    kills: 0,
    deaths: 0,
  });
  const slot = members.length;
  world.setResource(RES.party, {
    ...party,
    members: [...party.members, e],
    nextUid: uid + 1,
  });
  emit(ctx, {
    type: "classic.party.recruited",
    hero: e,
    classId: req.classId,
    name: req.name,
    slot,
    level,
    fee,
  });
  return OK;
}

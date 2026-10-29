/**
 * Unit death (docs/design/classic.md §10 step 4, §20 exploders): Dead
 * {at, killer}, removal from the spatial grid, cast/dash/order cancelled,
 * walk cleared, a DeathRecord on the bus and a classic.death event. Never
 * kills the same unit twice.
 *
 * Party (docs/design/party.md §7.1): every member is a hero here
 * (DeathRecord.isHero); a member's body stays on the field with Dead (revive
 * and respawn belong to classic.party / classic.progression).
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { busOf, type DeathRecord } from "../bus.ts";
import {
  AreaTag,
  CastOrder,
  Casting,
  Dash,
  Dead,
  Faction,
  Hero,
  Life,
  Monster,
  Mover,
  Pos,
} from "../components.ts";
import { emit } from "../events.ts";
import { currentDepth, heroOf } from "../resources.ts";
import { isPartyHero } from "../party/shared.ts";
import { gridOf } from "../spatial.ts";
import { isHeroSide } from "./common.ts";

/** Kills `e` (credited to `killer`). Returns false when it was already dead or gone. */
export function killUnit(world: World, ctx: SimContext, e: Entity, killer: Entity): boolean {
  if (!world.exists(e) || world.has(e, Dead)) return false;
  world.add(e, Dead, { at: ctx.tick, killer });
  const life = world.get(e, Life);
  // Overkill leaves no negative life on the corpse.
  if (life && life.hp !== 0) life.hp = 0;
  gridOf(world).remove(e);
  if (world.has(e, Casting)) world.remove(e, Casting);
  if (world.has(e, Dash)) world.remove(e, Dash);
  if (world.has(e, CastOrder)) world.remove(e, CastOrder);
  const m = world.get(e, Mover);
  if (m) {
    if (m.path.length > 0) m.path = [];
    m.goalX = -1;
    m.goalY = -1;
    m.moving = false;
  }
  const p = world.get(e, Pos) ?? { x: 0, y: 0 };
  const controlled = heroOf(world);
  const isHero = e === controlled || world.has(e, Hero);
  const mon = world.get(e, Monster);
  const rec: DeathRecord = {
    entity: e,
    killer,
    creditTeam: killer !== e && isHeroSide(world, killer) ? "hero" : "monster",
    team: world.get(e, Faction)?.team ?? "monster",
    isHero,
    x: p.x,
    y: p.y,
    depth: world.get(e, AreaTag)?.depth ?? currentDepth(world),
    monster: isHero ? "" : (mon?.proto ?? ""),
    rarity: isHero ? "hero" : (mon?.rarity ?? "normal"),
    level: isHero ? 0 : (mon?.level ?? 0),
    xp: isHero ? 0 : (mon?.xp ?? 0),
    pack: isHero ? 0 : (mon?.pack ?? 0),
  };
  busOf(world).deaths.push(rec);
  emit(ctx, {
    type: "classic.death",
    entity: e,
    killer,
    isHero,
    monster: rec.monster,
    name: isHero ? (world.get(e, Hero)?.name ?? "") : (mon?.name ?? ""),
    rarity: rec.rarity,
    x: p.x,
    y: p.y,
    // Party: a follower's death names it (the controlled hero's never does: solo unchanged).
    ...(isHero && e !== controlled && isPartyHero(world, e) ? { hero: e } : {}),
  });
  return true;
}

/**
 * Control of the party (docs/design/party.md §3): classic.party.control moves
 * GameState.hero to another member, and the partyControl system (post 620)
 * switches control to the acting leader when the controlled hero goes down
 * in auto or idle mode (PartyConfig.autoSwitch). Both reset
 * ControlState.overrideUntil. Solo and party-of-one worlds are untouched.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { ERR, fail, OK, type OpResult } from "../actions.ts";
import { Dead } from "../components.ts";
import { controlMode } from "../control.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { DEFAULT_PARTY_CONFIG, gameOf, RES, type ControlState } from "../resources.ts";
import {
  actingLeaderOf,
  ensureParty,
  isPartyHero,
  partyOf,
  partySize,
  partyWiped,
} from "./shared.ts";

/** Makes `hero` the controlled hero (GameState.hero) and resets the auto override. */
function setControlled(
  world: World,
  ctx: SimContext,
  hero: Entity,
  reason: "player" | "death",
): void {
  const game = gameOf(world);
  const previous = game.hero;
  game.hero = hero;
  world.setResource(RES.game, game);
  const c = world.getResource<ControlState>(RES.control);
  if (c) {
    c.overrideUntil = 0;
    world.setResource(RES.control, c);
  }
  emit(ctx, { type: "classic.party.control", hero, previous, reason });
}

/** classic.party.control {hero}: take control of a member (alive or downed). */
export function execControl(world: World, ctx: SimContext, hero: Entity): OpResult {
  if (!ensureParty(world, ctx)) return fail(ERR.noHero, "there is no hero yet");
  if (!isPartyHero(world, hero)) return fail(ERR.notMember, "not a party member");
  if (gameOf(world).hero === hero) return fail(ERR.badTarget, "already controlled");
  setControlled(world, ctx, hero, "player");
  return OK;
}

/** Auto/Idle: a downed controlled hero hands control to the acting leader. */
export const partyControl: SystemDef = {
  ...SYSTEM.partyControl,
  run(world, ctx) {
    if (partySize(world) < 2) return;
    if (!(partyOf(world)?.config ?? DEFAULT_PARTY_CONFIG).autoSwitch) return;
    if (controlMode(world) === "manual") return;
    const hero = gameOf(world).hero;
    if (hero === 0 || !world.has(hero, Dead)) return;
    if (partyWiped(world)) return;
    const leader = actingLeaderOf(world);
    if (leader === 0 || leader === hero) return;
    setControlled(world, ctx, leader, "death");
  },
};

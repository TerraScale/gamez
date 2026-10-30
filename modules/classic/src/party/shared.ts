/**
 * Party helpers shared by EVERY module (CONTRACT, implemented by the
 * architect; docs/design/party.md §2-§4). Pure reads of the world except
 * ensureParty(). Safe on solo worlds (no RES.party): a party of one made of
 * GameState.hero, so solo code paths stay bit-identical.
 *
 * Vocabulary:
 * - member: a hero entity in PartyState.members (solo: GameState.hero).
 * - controlled hero: GameState.hero (heroOf). Manual input, HUD, camera.
 * - follower: every member but the controlled hero (always party-AI driven).
 * - acting leader: the controlled hero while it stands, else the first
 *   standing member in slot order. Formation and travel follow it.
 * - downed: a member with Dead (party mode: it waits for a revive or town).
 * - founder: the save's first hero; holds the purse (Wallet + Supplies).
 */
import type { Entity, FrozenRegistry, SimContext, World } from "@gamez/kernel";
import { Dead, Hero, PartyMember, Wallet } from "../components.ts";
import { autoActive, controlMode } from "../control.ts";
import {
  DEFAULT_PARTY_CONFIG,
  gameOf,
  heroOf,
  partyStateOf,
  RES,
  type DungeonState,
  type PartyState,
  type RunStats,
} from "../resources.ts";
import { partyProtoOf, partyScale, partySlots, type PartyScale } from "../rules.ts";
import { KIND, type ClassProto, type PartyRole } from "../types.ts";

/** The party resource or null (solo). */
export function partyOf(world: World): PartyState | null {
  return partyStateOf(world);
}

/** Read-only party resource (no rollback copy) for the pure helpers below. */
function peekParty(world: World): Readonly<PartyState> | null {
  return world.peekResource<PartyState>(RES.party) ?? null;
}

/**
 * Members in slot order (existing entities only). Solo: [GameState.hero], or
 * [] before the hero exists. Returns a fresh array (safe to keep or sort).
 */
export function partyMembers(world: World): Entity[] {
  const p = peekParty(world);
  if (p) return p.members.filter((e) => e !== 0 && world.exists(e));
  const hero = heroOf(world);
  return hero === 0 ? [] : [hero];
}

/** Number of members (0 before the first hero). */
export function partySize(world: World): number {
  const p = peekParty(world);
  if (p) {
    let n = 0;
    for (const e of p.members) if (e !== 0 && world.exists(e)) n++;
    return n;
  }
  return heroOf(world) === 0 ? 0 : 1;
}

/** True for a member of the party (solo: the hero). */
export function isPartyHero(world: World, e: Entity): boolean {
  if (e === 0 || !world.exists(e)) return false;
  const p = peekParty(world);
  if (p) return p.members.includes(e);
  return e === heroOf(world);
}

/** Slot index 0..3 of a member, -1 otherwise. */
export function memberSlot(world: World, e: Entity): number {
  return partyMembers(world).indexOf(e);
}

export function isDowned(world: World, e: Entity): boolean {
  return world.has(e, Dead);
}

/** Members that are not downed, slot order. */
export function aliveMembers(world: World): Entity[] {
  return partyMembers(world).filter((e) => !world.has(e, Dead));
}

/** Every member but the controlled hero, slot order. */
export function followersOf(world: World): Entity[] {
  const hero = heroOf(world);
  return partyMembers(world).filter((e) => e !== hero);
}

/** True when `e` is a member other than the controlled hero. */
export function isFollower(world: World, e: Entity): boolean {
  return e !== heroOf(world) && isPartyHero(world, e);
}

/**
 * The acting leader: the controlled hero while it stands, else the first
 * standing member (slot order); the controlled hero when everyone is down;
 * 0 before the first hero.
 */
export function actingLeaderOf(world: World): Entity {
  const hero = heroOf(world);
  if (hero !== 0 && !world.has(hero, Dead)) return hero;
  for (const e of partyMembers(world)) if (!world.has(e, Dead)) return e;
  return hero;
}

/** True when every member is down (and there is at least one). */
export function partyWiped(world: World): boolean {
  const all = partyMembers(world);
  return all.length > 0 && all.every((e) => world.has(e, Dead));
}

/**
 * What drives the acting leader this tick (docs/design/party.md §6.1):
 * - "off": the player leads (manual, or auto paused by a manual override),
 *   or the whole party is down (respawn flow).
 * - "full": the leader brain (explore, fight, loot, town trips, travel).
 * - "defend": manual mode while the controlled hero is down and someone
 *   still stands: fight nearby foes and revive, never explore or travel.
 */
export function leaderMode(world: World, tick: number): "off" | "full" | "defend" {
  const hero = heroOf(world);
  if (hero === 0) return "off";
  if (partyWiped(world)) return "off";
  if (!world.has(hero, Dead)) return autoActive(world, tick) ? "full" : "off";
  return controlMode(world) === "manual" ? "defend" : "full";
}

/** The save's first hero (PartyState.founder; solo: the hero). */
export function founderOf(world: World): Entity {
  const p = partyStateOf(world);
  if (p && p.founder !== 0 && world.exists(p.founder)) return p.founder;
  return heroOf(world);
}

/**
 * The entity holding the shared purse (Wallet + Supplies): the founder;
 * defensively the first member that has a Wallet, else the controlled hero.
 * Every gold / town-portal-scroll read and write goes through this.
 */
export function purseOf(world: World): Entity {
  const f = founderOf(world);
  if (f !== 0 && world.has(f, Wallet)) return f;
  for (const e of partyMembers(world)) if (world.has(e, Wallet)) return e;
  return heroOf(world);
}

/** Party gold (the purse's Wallet; 0 without one). */
export function partyGold(world: World): number {
  const purse = purseOf(world);
  return purse === 0 ? 0 : (world.get(purse, Wallet)?.gold ?? 0);
}

/**
 * The hero a HeroCommand acts for: `cmd.hero` when set (0 when it is not a
 * party member: the owner fails the command with ERR.notMember), else the
 * controlled hero.
 */
export function commandHero(world: World, cmd: { hero?: Entity }): Entity {
  if (cmd.hero === undefined) return heroOf(world);
  return isPartyHero(world, cmd.hero) ? cmd.hero : 0;
}

/** Monster / loot / XP multipliers for the current party size. */
export function partyScaleOf(world: World, registry: FrozenRegistry): PartyScale {
  return partyScale(partyProtoOf(registry), Math.max(1, partySize(world)));
}

/** Unlocked party slots (1..maxMembers) from bosses killed and slots bought. */
export function slotsOf(world: World, registry: FrozenRegistry): number {
  const bosses = world.getResource<DungeonState>(RES.dungeon)?.bossesKilled ?? [];
  return partySlots(partyProtoOf(registry), bosses, partyStateOf(world)?.slotsBought ?? 0);
}

/** Formation line of a hero: PartyMember.role, else its class's partyRole, else "front". */
export function roleOf(world: World, registry: FrozenRegistry, hero: Entity): PartyRole {
  const m = world.get(hero, PartyMember);
  if (m) return m.role;
  const classId = world.get(hero, Hero)?.classId ?? "";
  return registry.get<ClassProto>(KIND.class, classId)?.partyRole ?? "front";
}

/**
 * Creates the party resource from a solo world (THE save migration,
 * docs/design/party.md §9): founder = members[0] = GameState.hero, which
 * gets PartyMember { uid 0, kills/deaths from RunStats }. No-op when it exists or there is no hero.
 * Only party actions call this (never a system), so solo saves never change.
 * Returns the live resource or null.
 */
export function ensureParty(world: World, ctx: SimContext): PartyState | null {
  const existing = partyStateOf(world);
  if (existing) return existing;
  const game = gameOf(world);
  const hero = game.hero;
  if (game.phase !== "play" || hero === 0 || !world.exists(hero)) return null;
  if (!world.has(hero, PartyMember)) {
    // The founder keeps its solo record: its leaderboard row must not drop.
    const stats = world.getResource<RunStats>(RES.stats);
    world.add(hero, PartyMember, {
      uid: 0,
      joinedTick: world.get(hero, Hero)?.createdTick ?? 0,
      role: roleOf(world, ctx.registry, hero),
      kills: stats?.kills ?? 0,
      deaths: stats?.deaths ?? 0,
    });
  }
  const party: PartyState = {
    members: [hero],
    founder: hero,
    slotsBought: 0,
    nextUid: 1,
    config: { ...DEFAULT_PARTY_CONFIG },
  };
  world.setResource(RES.party, party);
  return partyStateOf(world);
}

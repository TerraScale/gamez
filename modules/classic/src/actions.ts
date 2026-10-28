/**
 * Player input of the classic mode (CONTRACT): every action name, its payload
 * type, the module that implements it, and the HeroCommand union the auto
 * controller (and the hero intent executor) queue on the bus for the owning
 * module to execute.
 *
 * Rules for implementers:
 * - parse() validates untrusted payloads strictly (integers, known ids,
 *   entity exists and is in the current area) and throws ActionError on bad
 *   input. Use the codes in ERR.
 * - In this fixed-tick mode dispatch() only runs the action; systems run on
 *   the next step(). Actions therefore either change state directly (buy,
 *   equip...) or write the hero's Intent for classic.core.intent.
 * - A manual action while control mode is "auto"/"idle" sets
 *   ControlState.overrideUntil = ctx.tick + MANUAL_OVERRIDE_TICKS so the
 *   controller yields (helper: noteManual in src/auto/control.ts).
 * - Shared operations live in the owner module as `execX(world, ctx, ...): OpResult`
 *   and are used by both the action (throw ActionError when !ok) and the
 *   owner's command system (emit classic.command.failed when !ok).
 */
import type { Entity } from "@gamez/kernel";
import type { Attr, EquipSlot } from "./types.ts";
import type { AutoConfig, ControlMode, SimSpeed } from "./resources.ts";

export const MANUAL_OVERRIDE_TICKS = 60;
/** Max hero distance (sub) to an NPC / Interactable for ops that need one (buy, sell, heal, stash, stairs, waypoint, portal). */
export const INTERACT_RANGE = 768;
/** classic.core.intent walks until within this distance (sub) before interacting or picking up. */
export const APPROACH_RANGE = 384;
/** Max hero distance (sub) to a Loot entity for the pickup op. */
export const PICKUP_RANGE = 512;

export const ACTION = {
  // classic.progression
  newHero: "classic.newHero",
  allocateStat: "classic.allocateStat",
  learnSkill: "classic.learnSkill",
  setSkillBar: "classic.setSkillBar",
  respawn: "classic.respawn",
  acceptQuest: "classic.acceptQuest",
  completeQuest: "classic.completeQuest",
  // classic.core (write the hero Intent)
  moveTo: "classic.moveTo",
  useSkill: "classic.useSkill",
  stop: "classic.stop",
  pickup: "classic.pickup",
  interact: "classic.interact",
  // classic.items
  equip: "classic.equip",
  unequip: "classic.unequip",
  moveItem: "classic.moveItem",
  dropItem: "classic.dropItem",
  drinkPotion: "classic.drinkPotion",
  buy: "classic.buy",
  sell: "classic.sell",
  stashPut: "classic.stashPut",
  stashTake: "classic.stashTake",
  // classic.world
  townPortal: "classic.townPortal",
  usePortal: "classic.usePortal",
  useStairs: "classic.useStairs",
  useWaypoint: "classic.useWaypoint",
  // classic.auto
  setControl: "classic.setControl",
  setSpeed: "classic.setSpeed",
  setAutoConfig: "classic.setAutoConfig",
  offlineProgress: "classic.offlineProgress",
} as const;

export type ActionName = (typeof ACTION)[keyof typeof ACTION];

/** Payload types by action name. Positions: tiles are integers; `x/y` in sub units where noted. */
export interface ActionPayloads {
  "classic.newHero": { classId: string; name: string };
  "classic.allocateStat": { attr: Attr; points: number };
  "classic.learnSkill": { skill: string };
  /** slot 0..5, skill null clears it. The skill must be known. */
  "classic.setSkillBar": { slot: number; skill: string | null };
  "classic.respawn": Record<string, never>;
  "classic.acceptQuest": { quest: string };
  "classic.completeQuest": { quest: string };
  /** Tile coordinates (integers, walkable). */
  "classic.moveTo": { x: number; y: number };
  /**
   * Cast a known skill. `target` = enemy entity (0 for point/self skills);
   * `x/y` = target point in SUB units (ignored for self skills). `repeat`:
   * keep attacking the target until it dies (click-and-hold).
   */
  "classic.useSkill": { skill: string; target: Entity; x: number; y: number; repeat: boolean };
  "classic.stop": Record<string, never>;
  /** A Loot entity in the current area. */
  "classic.pickup": { target: Entity };
  /** An Npc or Interactable entity in the current area. */
  "classic.interact": { target: Entity };
  /** Item uid from the inventory; slot optional (rings pick ring1 then ring2). */
  "classic.equip": { uid: number; slot: EquipSlot | null };
  "classic.unequip": { slot: EquipSlot };
  "classic.moveItem": { uid: number; x: number; y: number };
  "classic.dropItem": { uid: number };
  /** Belt slot 0..beltSlots-1. */
  "classic.drinkPotion": { slot: number };
  /** Town only, NPC in reach. index into that NPC's VendorStock.items, or a potion base / "tp" for the alchemist. */
  "classic.buy": { npc: Entity; index: number; potion: string | null; count: number };
  /** Town only: sell an inventory item to the junk buyer. */
  "classic.sell": { npc: Entity; uid: number };
  "classic.stashPut": { uid: number };
  "classic.stashTake": { uid: number };
  "classic.townPortal": Record<string, never>;
  "classic.usePortal": Record<string, never>;
  "classic.useStairs": Record<string, never>;
  "classic.useWaypoint": { depth: number };
  "classic.setControl": { mode: ControlMode };
  "classic.setSpeed": { speed: SimSpeed };
  "classic.setAutoConfig": { config: Partial<AutoConfig> };
  /** Elapsed wall time supplied by the host (server-verified later). 0 < elapsedMs <= 7 days. */
  "classic.offlineProgress": { elapsedMs: number };
}

/** Standard ActionError codes. */
export const ERR = {
  badPayload: "bad_payload",
  noHero: "no_hero",
  heroExists: "hero_exists",
  dead: "dead",
  notDead: "not_dead",
  unknownId: "unknown_id",
  badTarget: "bad_target",
  notInTown: "not_in_town",
  inTown: "in_town",
  tooFar: "too_far",
  blocked: "blocked",
  noMana: "no_mana",
  cooldown: "cooldown",
  busy: "busy",
  notKnown: "not_known",
  noPoints: "no_points",
  maxRank: "max_rank",
  levelTooLow: "level_too_low",
  noGold: "no_gold",
  bagFull: "bag_full",
  beltFull: "belt_full",
  stashFull: "stash_full",
  requirements: "requirements",
  noScroll: "no_scroll",
  noPortal: "no_portal",
  noWaypoint: "no_waypoint",
  notHere: "not_here",
  questState: "quest_state",
  modeNotIdle: "mode_not_idle",
  empty: "empty",
} as const;

export type OpResult = { ok: true } | { ok: false; code: string; message: string };
export const OK: OpResult = { ok: true };
export function fail(code: string, message: string): OpResult {
  return { ok: false, code, message };
}

/**
 * Operations queued on Bus.commands (by classic.auto, classic.core.intent
 * and other systems). Each owner module drains ITS ops in its command system
 * (update stage, see SYSTEM table) in queue order and emits
 * classic.command.failed for failures. Leftover commands are dropped by
 * classic.core.cleanup.
 */
export type HeroCommand =
  // owner classic.items
  | { op: "pickup"; target: Entity }
  | { op: "equip"; uid: number; slot: EquipSlot | null }
  | { op: "unequip"; slot: EquipSlot }
  | { op: "drink"; slot: number }
  | { op: "buy"; npc: Entity; index: number; potion: string | null; count: number }
  | { op: "sell"; npc: Entity; uid: number }
  | { op: "stashPut"; uid: number }
  | { op: "drop"; uid: number }
  /** Grants from other systems (quests, offline): gold to the wallet, generated items to bag/stash. */
  | { op: "grantGold"; amount: number; reason: string }
  | {
      op: "grantItems";
      count: number;
      ilvl: number;
      minRarity: "normal" | "magic" | "rare" | "unique";
      toStash: boolean;
      reason: string;
    }
  // owner classic.world
  | { op: "townPortal" }
  | { op: "usePortal" }
  | { op: "stairs"; target: Entity }
  | { op: "waypoint"; depth: number }
  // owner classic.progression
  | { op: "allocate"; attr: Attr; points: number }
  | { op: "learn"; skill: string }
  | { op: "setBar"; slot: number; skill: string | null }
  | { op: "respawn" }
  | { op: "heal"; npc: Entity }
  | { op: "acceptQuest"; quest: string }
  | { op: "completeQuest"; quest: string }
  | { op: "grantXp"; amount: number; reason: string };

export type HeroCommandOp = HeroCommand["op"];

export const COMMAND_OWNER: Record<
  HeroCommandOp,
  "classic.items" | "classic.world" | "classic.progression"
> = {
  pickup: "classic.items",
  equip: "classic.items",
  unequip: "classic.items",
  drink: "classic.items",
  buy: "classic.items",
  sell: "classic.items",
  stashPut: "classic.items",
  drop: "classic.items",
  grantGold: "classic.items",
  grantItems: "classic.items",
  townPortal: "classic.world",
  usePortal: "classic.world",
  stairs: "classic.world",
  waypoint: "classic.world",
  allocate: "classic.progression",
  learn: "classic.progression",
  setBar: "classic.progression",
  respawn: "classic.progression",
  heal: "classic.progression",
  acceptQuest: "classic.progression",
  completeQuest: "classic.progression",
  grantXp: "classic.progression",
};

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
 * - Party (docs/design/party.md §4): manual actions ALWAYS act for the
 *   controlled hero (GameState.hero / heroOf). Ops that act for a hero take
 *   that hero as a parameter; command systems resolve it with
 *   party/shared.ts commandHero(world, cmd) (HeroCommand.hero, else the
 *   controlled hero), so the party AI can command any member.
 */
import type { Entity } from "@gamez/kernel";
import type { Attr, EquipSlot, ItemCategory, ItemRarity } from "./types.ts";
import type { AutoConfig, ControlMode, LootFilter, PartyConfig, SimSpeed } from "./resources.ts";

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
  // ---- wave C: classic.platform (server-only, src/platform/bank.ts)
  bank: "classic.bank",
  // ---- wave A (docs/design/wave-A.md)
  // classic.items
  gamble: "classic.gamble",
  stashMove: "classic.stashMove",
  setLootFilter: "classic.setLootFilter",
  // classic.crafting (town, smith in reach)
  repair: "classic.repair",
  upgradeItem: "classic.upgradeItem",
  rerollItem: "classic.rerollItem",
  addSocket: "classic.addSocket",
  socketGem: "classic.socketGem",
  unsocketGems: "classic.unsocketGems",
  combineGems: "classic.combineGems",
  // classic.talents
  learnTalent: "classic.learnTalent",
  resetTalents: "classic.resetTalents",
  // classic.rift
  openRift: "classic.openRift",
  leaveRift: "classic.leaveRift",
  // ---- party (docs/design/party.md §4): classic.party
  /** Town: create a new hero (any class) in a free slot. */
  partyRecruit: "classic.party.recruit",
  /** Town: dismiss a member (not the founder); its gear goes to the shared stash. */
  partyDismiss: "classic.party.dismiss",
  partyRename: "classic.party.rename",
  /** New slot order (a permutation of the members). */
  partyReorder: "classic.party.reorder",
  /** Take control of a member (GameState.hero). */
  partyControl: "classic.party.control",
  partyConfig: "classic.party.config",
  /** Town: buy the next party slot with gold. */
  partyBuySlot: "classic.party.buySlot",
  /** Move a bag item of the controlled hero into another member's bag. */
  partyGive: "classic.party.give",
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
  /** `tab` (wave A, optional): stash tab 0..stashTabs-1; absent = the first tab with room. */
  "classic.stashPut": { uid: number; tab?: number };
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
  /** Wave C, server-only: hero <-> account bank op (src/platform/bank.ts ClassicBankPayload). */
  "classic.bank": import("./platform/bank.ts").ClassicBankPayload;
  // ---- wave A
  /** Town, gambler NPC in reach: buy a random item of `category` (EconomyProto.gamble) into the bag. */
  "classic.gamble": { npc: Entity; category: ItemCategory };
  /** Town, stash in reach: move a stash item to another tab. */
  "classic.stashMove": { uid: number; tab: number };
  /** Any time: patch the loot filter (validated; unknown keys rejected). */
  "classic.setLootFilter": { filter: Partial<LootFilter> };
  /**
   * Smith services. `npc` = the smith entity (role smith, in reach, town).
   * `uid` = an item in the bag or equipped. repair: uid 0 = everything worn
   * and carried.
   */
  "classic.repair": { npc: Entity; uid: number };
  "classic.upgradeItem": { npc: Entity; uid: number };
  "classic.rerollItem": { npc: Entity; uid: number };
  "classic.addSocket": { npc: Entity; uid: number };
  /** `gem` = uid of a gem item in the bag; it fills the first empty socket of `uid`. */
  "classic.socketGem": { npc: Entity; uid: number; gem: number };
  /** Removes every gem of `uid` back into the bag (fails when they do not fit). */
  "classic.unsocketGems": { npc: Entity; uid: number };
  /** Three bag gems of ItemBaseProto `base` -> one gem of the next tier. */
  "classic.combineGems": { npc: Entity; base: string };
  /** Spend one talent point on `node` (TalentNodeProto id of the hero's class tree). */
  "classic.learnTalent": { node: string };
  /** Town only: refund every talent point for EconomyProto.talentResetPerLevel x level gold. */
  "classic.resetTalents": Record<string, never>;
  /** Town, rift obelisk `target` in reach, rift unlocked, 1 <= level <= maxCompleted + 1, fee paid. */
  "classic.openRift": { target: Entity; level: number };
  /** In a rift: abandon it (failed, reason "left") and return to town. After completion: return to town. */
  "classic.leaveRift": Record<string, never>;
  // ---- party
  /** Same rules as classic.newHero (class id, cleanHeroName); town only; free unlocked slot; fee paid from the purse. */
  "classic.party.recruit": { classId: string; name: string };
  /** `hero` = a member other than the founder; town only. */
  "classic.party.dismiss": { hero: Entity };
  "classic.party.rename": { hero: Entity; name: string };
  /** Every member exactly once. */
  "classic.party.reorder": { order: Entity[] };
  /** A member (alive or downed). */
  "classic.party.control": { hero: Entity };
  "classic.party.config": { config: Partial<PartyConfig> };
  "classic.party.buySlot": Record<string, never>;
  /** `uid` in the controlled hero's bag; `to` another member with room. */
  "classic.party.give": { uid: number; to: Entity };
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
  potionUseless: "potion_useless",
  // ---- wave A
  notSmith: "not_smith",
  notGambler: "not_gambler",
  indestructible: "indestructible",
  noRepairNeeded: "no_repair_needed",
  maxUpgrade: "max_upgrade",
  notRerollable: "not_rerollable",
  maxSockets: "max_sockets",
  noSockets: "no_sockets",
  socketsFull: "sockets_full",
  notGem: "not_gem",
  needThree: "need_three",
  maxTier: "max_tier",
  broken: "broken",
  talentLocked: "talent_locked",
  wrongClass: "wrong_class",
  riftLocked: "rift_locked",
  riftLevel: "rift_level",
  inRift: "in_rift",
  notInRift: "not_in_rift",
  badTab: "bad_tab",
  // ---- party
  /** Not a member of the party. */
  notMember: "not_member",
  /** No free unlocked slot (recruit) / every slot already unlocked (buySlot). */
  partyFull: "party_full",
  /** The founder cannot be dismissed. */
  founder: "founder",
  /** classic.party.reorder: not a permutation of the members. */
  badOrder: "bad_order",
  /** Revive: the target is not a downed member / reviver busy or in danger. */
  notDowned: "not_downed",
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
 *
 * Party: every command may carry `hero`, the member it acts for (absent = the
 * controlled hero, which keeps solo producers unchanged). Owners resolve it
 * with party/shared.ts commandHero(); a `hero` that is not a party member
 * fails the command (code not_member). Producers acting for a follower MUST
 * set it.
 */
export type HeroCommand = HeroCommandBody & { hero?: Entity };

export type HeroCommandBody =
  // owner classic.items
  | { op: "pickup"; target: Entity }
  | { op: "equip"; uid: number; slot: EquipSlot | null }
  | { op: "unequip"; slot: EquipSlot }
  | { op: "drink"; slot: number }
  | { op: "buy"; npc: Entity; index: number; potion: string | null; count: number }
  | { op: "sell"; npc: Entity; uid: number }
  | { op: "stashPut"; uid: number; tab?: number }
  | { op: "drop"; uid: number }
  // owner classic.items (wave A)
  | { op: "gamble"; npc: Entity; category: ItemCategory }
  | { op: "stashMove"; uid: number; tab: number }
  /** Grants from other systems (quests, offline): gold to the wallet, generated items to bag/stash. */
  | { op: "grantGold"; amount: number; reason: string }
  | {
      op: "grantItems";
      count: number;
      ilvl: number;
      minRarity: ItemRarity;
      /** Wave A: only bases of this category (gambling, debug grants). Absent = any. */
      category?: ItemCategory;
      /** QA grants: every item is this exact SetItemProto piece (generate.rollItem setItem). */
      setItem?: string;
      toStash: boolean;
      reason: string;
    }
  // owner classic.world
  | { op: "townPortal" }
  | { op: "usePortal" }
  | { op: "stairs"; target: Entity }
  | { op: "waypoint"; depth: number }
  /**
   * Party leash (docs/design/party.md §6.7): place the acting hero (`hero`, a
   * follower) on a free walkable tile next to the acting leader, same area.
   * Used by the party AI when a follower is stuck or farther than
   * PartyProto.leashTeleport. Fails (not_member) for the leader itself.
   */
  | { op: "regroup" }
  // owner classic.progression
  | { op: "allocate"; attr: Attr; points: number }
  | { op: "learn"; skill: string }
  | { op: "setBar"; slot: number; skill: string | null }
  | { op: "respawn" }
  | { op: "heal"; npc: Entity }
  | { op: "acceptQuest"; quest: string }
  | { op: "completeQuest"; quest: string }
  | { op: "grantXp"; amount: number; reason: string }
  // owner classic.crafting (wave A)
  | { op: "repair"; npc: Entity; uid: number }
  | { op: "upgrade"; npc: Entity; uid: number }
  | { op: "reroll"; npc: Entity; uid: number }
  | { op: "addSocket"; npc: Entity; uid: number }
  | { op: "socketGem"; npc: Entity; uid: number; gem: number }
  | { op: "unsocket"; npc: Entity; uid: number }
  | { op: "combineGems"; npc: Entity; base: string }
  // owner classic.talents (wave A)
  | { op: "learnTalent"; node: string }
  | { op: "resetTalents" }
  // owner classic.rift (wave A)
  | { op: "openRift"; target: Entity; level: number }
  | { op: "leaveRift" }
  // owner classic.party
  /** Start channelling a revive on a downed member `target` (the acting hero must be alive and within reviveRange). */
  | { op: "revive"; target: Entity }
  /** Move bag item `uid` of the acting hero into member `to`'s bag (any distance; same party). */
  | { op: "give"; uid: number; to: Entity };

export type HeroCommandOp = HeroCommand["op"];

export type CommandOwner =
  | "classic.items"
  | "classic.world"
  | "classic.progression"
  | "classic.crafting"
  | "classic.talents"
  | "classic.rift"
  | "classic.party";

export const COMMAND_OWNER: Record<HeroCommandOp, CommandOwner> = {
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
  regroup: "classic.world",
  allocate: "classic.progression",
  learn: "classic.progression",
  setBar: "classic.progression",
  respawn: "classic.progression",
  heal: "classic.progression",
  acceptQuest: "classic.progression",
  completeQuest: "classic.progression",
  grantXp: "classic.progression",
  gamble: "classic.items",
  stashMove: "classic.items",
  repair: "classic.crafting",
  upgrade: "classic.crafting",
  reroll: "classic.crafting",
  addSocket: "classic.crafting",
  socketGem: "classic.crafting",
  unsocket: "classic.crafting",
  combineGems: "classic.crafting",
  learnTalent: "classic.talents",
  resetTalents: "classic.talents",
  openRift: "classic.rift",
  leaveRift: "classic.rift",
  revive: "classic.party",
  give: "classic.party",
};

/**
 * Every component of the classic mode (CONTRACT). Component values are plain
 * JSON (no undefined fields, no Map/Set, integers for anything accumulated).
 * Each component lists the module that OWNS it (creates it and is the main
 * writer); other modules may read it and may write only where noted.
 *
 * Entity kinds and their components:
 *   hero:        Hero, Level, Attributes, SkillBook, SkillBar, Life, Mana, CombatStats, HeroStats,
 *                Pos, AreaTag, Mover, Body, Faction, Intent, Statuses, Inventory, Equipment, Belt,
 *                Wallet, Supplies, AutoState (+ Casting, CastOrder, Dash, Dead while relevant)
 *   monster:     Monster, Ai, SkillBook, Life, CombatStats, Pos, AreaTag, Mover, Body, Faction,
 *                Statuses (+ Casting, CastOrder, Dash, Dead, Summoned)
 *   projectile:  Projectile, Pos, AreaTag
 *   effect:      GroundEffect, Pos, AreaTag
 *   loot:        Loot, Pos, AreaTag
 *   npc:         Npc, Pos, AreaTag(0), Body
 *   interactable: Interactable, Pos, AreaTag (stairs, waypoint, portal, stash)
 */
import { defineComponent, type Entity } from "@gamez/kernel";
import type { Facing, TilePos } from "./fixed.ts";
import type {
  Attr,
  AttrBlock,
  Damage,
  Element,
  EquipSlot,
  ItemInstance,
  MonsterRarity,
  SkillModifier,
  StatMod,
  Team,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Placement and movement (owner: classic.core unless noted)
// ---------------------------------------------------------------------------

/** Position in sub units (256 per tile). Owner: whoever spawns the entity; moved by classic.core.movement. */
export const Pos = defineComponent<{ x: number; y: number }>("classic.pos");

/** Which area the entity lives in: 0 = town, d >= 1 = dungeon depth d. Only entities of the current area are simulated. */
export const AreaTag = defineComponent<{ depth: number }>("classic.areaTag");

export interface MoverValue {
  /** Base speed, sub per tick (before CombatStats.moveSpeed and slows). */
  speed: number;
  /** Remaining tile waypoints (A* result), walked in order toward each tile centre. */
  path: TilePos[];
  /** Direct steering goal in sub units when `path` is empty; -1/-1 = none. */
  goalX: number;
  goalY: number;
  /** True while it moved this tick (drives the walk animation). */
  moving: boolean;
  facing: Facing;
  /** Consecutive ticks it wanted to move but could not (stuck detection). */
  blocked: number;
}
/**
 * Movement intent. Writers: classic.core.intent (hero), classic.monsters (monsters).
 * classic.core.movement advances it, sets `moving`, `facing` and `blocked`.
 */
export const Mover = defineComponent<MoverValue>("classic.mover");

/** Collision body. `solid` units block each other softly (separation); radius in sub. */
export const Body = defineComponent<{ radius: number; solid: boolean }>("classic.body");

export const Faction = defineComponent<{ team: Team }>("classic.faction");

// ---------------------------------------------------------------------------
// Vitals and combat stats
// ---------------------------------------------------------------------------

/** `acc` accumulates fractional regen in thousandths of a point. Owner: progression (hero), monsters (monsters); combat writes hp. */
export const Life = defineComponent<{ hp: number; max: number; acc: number }>("classic.life");
export const Mana = defineComponent<{ mp: number; max: number; acc: number }>("classic.mana");

/**
 * Everything combat needs, for heroes and monsters alike. Hero: recomputed
 * every tick by classic.progression.stats. Monster: set at spawn by
 * classic.monsters (scaled by level, rarity and mods).
 */
export interface CombatStatsValue {
  level: number;
  armor: number;
  toHit: number;
  /** Weapon (hero) or base (monster) damage range, physical, after flat adds and dmgPct. */
  dmgMin: number;
  dmgMax: number;
  /** Extra elemental damage added to every attack (flat, per element). */
  addFire: number;
  addCold: number;
  addLightning: number;
  addPoison: number;
  /** % more spell damage. */
  spellPct: number;
  critPct: number;
  /** Crit multiplier percent (150 = x1.5). */
  critMult: number;
  /** 100 = base speed; 125 = 25% faster. */
  attackSpeed: number;
  castSpeed: number;
  moveSpeed: number;
  resFire: number;
  resCold: number;
  resLightning: number;
  resPoison: number;
  lifeSteal: number;
  manaSteal: number;
  blockPct: number;
  thorns: number;
  /** Basic attack: base ticks at 100% speed, reach (sub), projectile sprite ("" = melee). */
  attackTicks: number;
  attackRange: number;
  attackProjectile: string;
  /** Element of the basic attack's base damage (monsters; heroes "phys"). */
  attackElement: Element;
}
export const CombatStats = defineComponent<CombatStatsValue>("classic.combatStats");

// ---------------------------------------------------------------------------
// Hero (owner: classic.progression unless noted)
// ---------------------------------------------------------------------------

export const Hero = defineComponent<{ classId: string; name: string; createdTick: number }>(
  "classic.hero",
);

export const Level = defineComponent<{
  level: number;
  /** Total XP earned (monotonic except for the death penalty). */
  xp: number;
  statPoints: number;
  skillPoints: number;
}>("classic.level");

/** Allocated base attributes (class base + points), without items or buffs. */
export const Attributes = defineComponent<AttrBlock>("classic.attributes");

/** Character sheet values derived each tick by classic.progression.stats (hero only). */
export interface HeroStatsValue {
  attrs: AttrBlock;
  lifeMax: number;
  manaMax: number;
  /** Life per second x10 (15 = 1.5/s). */
  lifeRegen: number;
  /** Mana per second x10. */
  manaRegen: number;
  magicFind: number;
  goldFind: number;
  lightRadius: number;
  lifeOnKill: number;
  manaOnKill: number;
  allSkills: number;
  potionPct: number;
  /** Two-handed weapon equipped (offhand must stay empty). */
  twoHanded: boolean;
  /** Primary attribute used for weapon damage. */
  primary: Attr;
}
export const HeroStats = defineComponent<HeroStatsValue>("classic.heroStats");

/** Known skills (hero and monsters). Owner: progression (hero), monsters (monsters); combat writes cooldowns. */
export const SkillBook = defineComponent<{
  /** Sorted by skill id. */
  ranks: { skill: string; rank: number }[];
  /** Absolute tick when each skill is ready again; sorted by skill id; missing = ready. */
  cooldowns: { skill: string; readyAt: number }[];
}>("classic.skillBook");

/** Hero skill bar: 6 slots (hotkeys 1-6), null = empty. */
export const SkillBar = defineComponent<{ slots: (string | null)[] }>("classic.skillBar");

/** Active statuses (slow, stun, dots, buffs). Owner: classic.combat. */
export interface StatusInstance {
  id: string;
  /** Absolute tick it ends at. */
  until: number;
  power: number;
  source: Entity;
  /** dots: next damage tick and damage still to deal. */
  nextAt: number;
  remaining: number;
}
export const Statuses = defineComponent<{ list: StatusInstance[] }>("classic.statuses");

// ---------------------------------------------------------------------------
// Intent, casting (owner: classic.core / classic.combat)
// ---------------------------------------------------------------------------

/**
 * What the hero wants to do. Written by manual actions (classic.moveTo,
 * classic.useSkill, ...) and by the auto controller; executed by
 * classic.core.intent which walks into range and then issues a CastOrder,
 * a pickup/interact command, or stops.
 */
export type HeroIntentValue =
  | { kind: "idle"; source: IntentSource; at: number }
  | { kind: "move"; source: IntentSource; at: number; x: number; y: number }
  | {
      kind: "skill";
      source: IntentSource;
      at: number;
      skill: string;
      /** Enemy entity (0 = point/self cast at x,y). */
      target: Entity;
      /** Target point, sub units. */
      x: number;
      y: number;
      /** Keep casting on the same target until it dies (hold / attack-move). */
      repeat: boolean;
    }
  | { kind: "pickup"; source: IntentSource; at: number; target: Entity }
  | { kind: "interact"; source: IntentSource; at: number; target: Entity };
export type IntentSource = "manual" | "auto";
export const Intent = defineComponent<HeroIntentValue>("classic.intent");

/**
 * "Cast this when you can" for any unit (hero via core.intent, monsters via
 * AI). classic.combat.orders starts the cast if the unit is not busy, has the
 * mana, the skill is off cooldown and the target is in range; otherwise it
 * emits classic.cast.failed. The order is removed either way.
 */
export const CastOrder = defineComponent<{
  skill: string;
  target: Entity;
  x: number;
  y: number;
}>("classic.castOrder");

/** A cast in progress (animation lock). Owner: classic.combat. */
export const Casting = defineComponent<{
  skill: string;
  rank: number;
  target: Entity;
  x: number;
  y: number;
  startedAt: number;
  /** Absolute tick the effect fires (once), and the tick the unit is free again. */
  hitAt: number;
  endAt: number;
  fired: boolean;
  /** pulse skills: pulses fired so far. */
  pulses: number;
}>("classic.casting");

/** A dash in flight (charge, tumble). Owner: classic.combat; classic.core.movement skips dashing units. */
export const Dash = defineComponent<{
  skill: string;
  rank: number;
  target: Entity;
  tx: number;
  ty: number;
  speed: number;
  until: number;
}>("classic.dash");

/** Marks a dying/dead unit. Monsters are destroyed after corpseTicks; the hero waits for respawn. */
export const Dead = defineComponent<{ at: number; killer: Entity }>("classic.dead");

// ---------------------------------------------------------------------------
// Monsters (owner: classic.monsters)
// ---------------------------------------------------------------------------

export const Monster = defineComponent<{
  proto: string;
  level: number;
  rarity: MonsterRarity;
  /** MonsterModProto ids (champion / unique / boss). */
  mods: string[];
  /** Pack id within the level (0 = none); minions follow the pack's champion/unique/boss. */
  pack: number;
  /** Display name ("Mighty Shambling Husk", "Grimjaw the Bitter"). */
  name: string;
  /** XP granted on death (already scaled). */
  xp: number;
}>("classic.monster");

export type AiStateName =
  | "sleep"
  | "idle"
  | "chase"
  | "attack"
  | "kite"
  | "flee"
  | "charge"
  | "return";

export const Ai = defineComponent<{
  state: AiStateName;
  target: Entity;
  homeX: number;
  homeY: number;
  /** Next tick the AI re-evaluates (throttle). */
  thinkAt: number;
  /** Next tick a new A* path may be requested. */
  repathAt: number;
  /** Behaviour-specific cooldown (summon, charge, blink), absolute tick. */
  specialAt: number;
  /** Behaviour counter: melee strikes since the last slam (tank), summon phases done (boss). */
  count: number;
}>("classic.ai");

/** Unit created by a skill; destroyed at `until` (0 = never) or when the owner leaves the area. */
export const Summoned = defineComponent<{ owner: Entity; until: number }>("classic.summoned");

// ---------------------------------------------------------------------------
// Projectiles and ground effects (owner: classic.combat)
// ---------------------------------------------------------------------------

export const Projectile = defineComponent<{
  skill: string;
  rank: number;
  owner: Entity;
  team: Team;
  /** Velocity, sub per tick. */
  vx: number;
  vy: number;
  /** Distance left before it expires (sub). */
  rangeLeft: number;
  radius: number;
  pierceLeft: number;
  /** Pre-rolled damage carried to each hit. */
  damage: Damage;
  canMiss: boolean;
  /** Entities already hit (pierce never hits the same one twice). */
  hit: Entity[];
  sprite: string;
  explodeRadius: number;
  /** Homing target (0 = flies straight): turns up to HOMING_STEPS angle steps per tick toward it. */
  home: Entity;
}>("classic.projectile");

export const GroundEffect = defineComponent<{
  skill: string;
  rank: number;
  owner: Entity;
  team: Team;
  radius: number;
  /** Absolute ticks. */
  until: number;
  nextAt: number;
  every: number;
  damage: Damage;
  effect: string;
  // ---- wave A telegraphs (SkillProto.telegraph); all optional ----
  /** True for a telegraph: hits once at `nextAt` (== until) and is destroyed. */
  once?: boolean;
  /** Danger-zone shape (default circle of `radius` around Pos). */
  shape?: "circle" | "cone" | "line";
  /** cone/line: aim angle (0..63 steps) from Pos; cone half-width in steps; line length and width (sub). */
  angle?: number;
  arc?: number;
  length?: number;
  width?: number;
  /** Tick the telegraph was placed (for the client fill animation). */
  placedAt?: number;
}>("classic.groundEffect");

// ---------------------------------------------------------------------------
// Items (owner: classic.items)
// ---------------------------------------------------------------------------

export interface InvEntry {
  item: ItemInstance;
  /** Top-left grid cell. */
  x: number;
  y: number;
}

/** Bag grid (BalanceProto.invCols x invRows); items sorted by (y, x). */
export const Inventory = defineComponent<{ cols: number; rows: number; items: InvEntry[] }>(
  "classic.inventory",
);

export const Equipment =
  defineComponent<Record<EquipSlot, ItemInstance | null>>("classic.equipment");

/** Potion belt: `beltSlots` slots, each one potion base stacked up to `beltStack`. */
export const Belt = defineComponent<{
  slots: { base: string | null; count: number }[];
  /** Potion cooldown, absolute tick. */
  readyAt: number;
}>("classic.belt");

export const Wallet = defineComponent<{ gold: number }>("classic.wallet");

/** Town portal scrolls. */
export const Supplies = defineComponent<{ tpScrolls: number }>("classic.supplies");

/** An item, gold pile or potion on the ground. */
export const Loot = defineComponent<{
  kind: "item" | "gold" | "potion";
  item: ItemInstance | null;
  gold: number;
  /** Potion base id for kind "potion". */
  potion: string;
  droppedAt: number;
}>("classic.loot");

// ---------------------------------------------------------------------------
// World (owner: classic.world)
// ---------------------------------------------------------------------------

export const Npc = defineComponent<{ proto: string }>("classic.npc");

/**
 * "riftObelisk" (wave A, town): opens the Rift panel (classic.rift.panel).
 * "riftExit" (wave A, rift levels): appears when the guardian dies; using it
 * (op leaveRift) returns to town.
 */
export type InteractableKind =
  | "stairsDown"
  | "stairsUp"
  | "waypoint"
  | "portal"
  | "stash"
  | "riftObelisk"
  | "riftExit";
export const Interactable = defineComponent<{
  kind: InteractableKind;
  /** portal: the depth it leads to (0 = town); stairs: the depth they lead to. */
  toDepth: number;
}>("classic.interactable");

// ---------------------------------------------------------------------------
// Auto controller (owner: classic.auto)
// ---------------------------------------------------------------------------

export type AutoPlan =
  | "none"
  | "explore"
  | "fight"
  | "loot"
  | "recover"
  | "toTown"
  | "town"
  | "toDungeon"
  | "descend"
  | "dead";

export const AutoState = defineComponent<{
  plan: AutoPlan;
  /** Current focus: monster, loot, npc or interactable (0 = none). */
  focus: Entity;
  /** Exploration target tile (-1 = none). */
  frontierX: number;
  frontierY: number;
  /** Town routine steps still to do, in order (e.g. ["heal","sell","buy","quests","return"]). */
  todo: string[];
  /** Next tick the controller re-plans (it also reacts every tick to danger). */
  thinkAt: number;
  /** Stuck detection: last tile and how long the hero stayed on it while moving. */
  lastTileX: number;
  lastTileY: number;
  stuck: number;
  /** Tiles the controller gave up on (unreachable frontiers), max 32, oldest first. */
  ignore: TilePos[];
  /** No voluntary town trip (bag full, restock) before this tick (set when leaving town). */
  tripAt: number;
  /** RunStats.kills last seen, and the tick it last changed (progress watchdog). */
  killsSeen: number;
  killAt: number;
  /** Area changes since the last kill (progress watchdog). */
  hops: number;
  /** Watchdog fallback: until this tick the hero stays in the dungeon and seeks a fresh level. */
  stallUntil: number;
  /** Fight hysteresis: last tick an awake foe was in range. */
  foeAt: number;
  /** Death caution: Dead.at of the last death counted, its depth, and the caution level (0-3, +1 per death, -1 per level up). */
  deathAt: number;
  deathDepth: number;
  caution: number;
  /** Hero level last seen (caution decay). */
  levelSeen: number;
}>("classic.autoState");

// ---------------------------------------------------------------------------
// Wave A (docs/design/wave-A.md)
// ---------------------------------------------------------------------------

/**
 * Talent points and ranks of the hero. Owner: classic.talents (creates it
 * lazily on the hero, grants points on level ups, spends them).
 */
export const Talents = defineComponent<{
  /** Unspent talent points. */
  points: number;
  /** Points spent (sum of ranks). */
  spent: number;
  /** Sorted by node id; rank >= 1. */
  ranks: { node: string; rank: number }[];
  /** Hero level points were last granted for (level ups grant (level - levelSeen) x talentPointsPerLevel). */
  levelSeen: number;
}>("classic.talents");

/**
 * Extra hero stats and skill modifiers by source, read by
 * classic.progression.stats (mods) and classic.combat (skills, through
 * bonus.ts skillModsOf). Each writer owns ONLY its own entry (by `source`,
 * its module id) and writes through bonus.ts setBonusSource; entries are
 * sorted by source. Writers: classic.talents ("classic.talents").
 */
export interface BonusSource {
  source: string;
  mods: StatMod[];
  skills: SkillModifier[];
}
export const BonusStats = defineComponent<{ sources: BonusSource[] }>("classic.bonusStats");

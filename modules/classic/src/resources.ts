/**
 * Resource keys, types and accessors of the classic mode (CONTRACT,
 * implemented). Resources are cloned on every sim snapshot (each step()), so
 * they must stay small: NO tile arrays here. Level maps are derived on demand
 * from (worldSeed, depth) by src/world/maps.ts and memoised outside the world.
 *
 * Owners create the resource in their module's setup() and are its main
 * writers; readers use the getters below (which throw when it is missing).
 */
import type { Entity, World } from "@gamez/kernel";
import type { ItemInstance, ItemRarity } from "./types.ts";

export const RES = {
  /** Owner classic.core. */
  game: "classic.game",
  /** Owner classic.world. */
  area: "classic.area",
  dungeon: "classic.dungeon",
  explore: "classic.explore",
  /** Owner classic.progression. */
  quests: "classic.quests",
  stats: "classic.runStats",
  /** Owner classic.auto. */
  control: "classic.control",
  /** Owner classic.items. */
  vendors: "classic.vendors",
  stash: "classic.stash",
  /** Owner classic.core (see bus.ts). */
  bus: "classic.bus",
} as const;

export interface GameState {
  /** "choose" until classic.newHero creates the hero. */
  phase: "choose" | "play";
  /** Drawn once from ctx.rng in classic.core setup; level seeds = mix(worldSeed, depth). */
  worldSeed: number;
  /** Next ItemInstance uid. */
  nextUid: number;
  /** The hero entity (0 before classic.newHero). */
  hero: Entity;
  /** Pack ids for monster population, monotonic. */
  nextPack: number;
}

export interface AreaState {
  /** 0 = town, >= 1 dungeon depth. The hero's AreaTag always equals this. */
  depth: number;
  /** ThemeProto id ("classic.theme.town" for the town). */
  theme: string;
  /** Tick the hero entered. */
  enteredAt: number;
}

export interface DungeonState {
  /** Deepest depth ever reached. */
  deepest: number;
  /** Depths with an unlocked waypoint (sorted; always contains 0 = town). */
  waypoints: number[];
  /** Dungeon depth whose entities currently exist in the world (0 = none). Kept while the hero visits town. */
  live: number;
  /** Open town portal: dungeon side position (sub) and depth; null = closed. */
  portal: { depth: number; x: number; y: number } | null;
  /** Depths whose boss has been killed (sorted). */
  bossesKilled: number[];
  /** Live level bookkeeping for "cleared enough" decisions. */
  liveSpawned: number;
  liveKilled: number;
  liveBossAlive: boolean;
  /**
   * Life a boss had lost when its level was left (destroyed) while it lived;
   * applied to the next boss spawned at that depth so attempts add up.
   * Optional: saves from before it have none.
   */
  bossWound?: { depth: number; lost: number } | null;
}

export interface ExploreArea {
  depth: number;
  width: number;
  /** 1 bit per tile, row-major, 32 tiles per number (bit i of word i>>5 is tile i). */
  bits: number[];
  /** Revealed walkable tiles and total walkable tiles. */
  revealed: number;
  total: number;
}
/** At most two areas: town (0) and the live dungeon level. */
export interface ExploreState {
  areas: ExploreArea[];
}

export interface QuestProgress {
  id: string;
  progress: number;
  done: boolean;
}
export interface QuestState {
  active: QuestProgress[];
  /** Completed (turned in) quest ids, sorted. */
  completed: string[];
}

export type ControlMode = "manual" | "auto" | "idle";
export type SimSpeed = 1 | 2 | 4 | 8;

export interface AutoConfig {
  /** Drink a life potion below this % of max life. */
  lifePotionPct: number;
  manaPotionPct: number;
  /** Go to town (town portal) below this % of life when no life potion is left. */
  retreatPct: number;
  /** Lowest item rarity the controller picks up. */
  pickupRarity: ItemRarity;
  pickupGold: boolean;
  pickupPotions: boolean;
  /** Sell items below this rarity in town; equal or above go to the stash. */
  keepRarity: ItemRarity;
  autoEquip: boolean;
  autoAllocate: boolean;
  autoDescend: boolean;
  /** Explored % of a level before descending. */
  explorePct: number;
  /** Do not descend below this depth (0 = no limit). */
  maxDepth: number;
  /** Buy potions up to this many belt slots full in town. */
  buyPotions: boolean;
  /** Keep this much mana in reserve for emergency skills (percent of max). */
  manaReservePct: number;
}

export interface ControlState {
  mode: ControlMode;
  /** Host steps `speed` ticks per 50 ms of wall time. Only "idle" may use > 1. */
  speed: SimSpeed;
  /** In auto/idle, a manual command pauses the controller until this tick. */
  overrideUntil: number;
  config: AutoConfig;
}

export interface VendorStock {
  npc: string;
  items: ItemInstance[];
  /** Tick the stock was rolled; restocked when the hero enters town after a dungeon visit. */
  rolledAt: number;
}
export interface VendorState {
  stocks: VendorStock[];
}

export interface StashState {
  items: ItemInstance[];
}

export interface RunStats {
  kills: number;
  championKills: number;
  uniqueKills: number;
  bossKills: number;
  deaths: number;
  goldEarned: number;
  itemsFound: number;
  potionsUsed: number;
  ticksPlayed: number;
  offlineMs: number;
}

export const DEFAULT_AUTO_CONFIG: AutoConfig = {
  lifePotionPct: 50,
  manaPotionPct: 25,
  retreatPct: 25,
  pickupRarity: "magic",
  pickupGold: true,
  pickupPotions: true,
  keepRarity: "rare",
  autoEquip: true,
  autoAllocate: true,
  autoDescend: true,
  explorePct: 35,
  maxDepth: 0,
  buyPotions: true,
  manaReservePct: 15,
};

function need<T>(world: World, key: string): T {
  const v = world.getResource<T>(key);
  if (v === undefined) throw new Error(`classic: resource "${key}" missing (module not loaded?)`);
  return v;
}

export const gameOf = (w: World): GameState => need<GameState>(w, RES.game);
export const areaOf = (w: World): AreaState => need<AreaState>(w, RES.area);
export const dungeonOf = (w: World): DungeonState => need<DungeonState>(w, RES.dungeon);
export const exploreOf = (w: World): ExploreState => need<ExploreState>(w, RES.explore);
export const questsOf = (w: World): QuestState => need<QuestState>(w, RES.quests);
export const runStatsOf = (w: World): RunStats => need<RunStats>(w, RES.stats);
export const controlOf = (w: World): ControlState => need<ControlState>(w, RES.control);
export const vendorsOf = (w: World): VendorState => need<VendorState>(w, RES.vendors);
export const stashOf = (w: World): StashState => need<StashState>(w, RES.stash);

/** The hero entity, or 0 when none exists yet (phase "choose") or the game resource is missing. */
export function heroOf(w: World): Entity {
  const g = w.getResource<GameState>(RES.game);
  if (!g || g.hero === 0 || !w.exists(g.hero)) return 0;
  return g.hero;
}

/** Current area depth (0 town), or 0 when the area resource is missing. */
export function currentDepth(w: World): number {
  return w.getResource<AreaState>(RES.area)?.depth ?? 0;
}

/** Takes the next item uid (mutates GameState). */
export function nextUid(w: World): number {
  const g = gameOf(w);
  const uid = g.nextUid;
  g.nextUid = uid + 1;
  return uid;
}

/** Bit test on an ExploreArea. */
export function isExplored(area: ExploreArea, x: number, y: number): boolean {
  const i = y * area.width + x;
  return ((area.bits[i >> 5] ?? 0) & (1 << (i & 31))) !== 0;
}

/** Explored fraction of an area in percent (0..100). */
export function exploredPct(area: ExploreArea): number {
  return area.total === 0 ? 100 : Math.floor((area.revealed * 100) / area.total);
}

export function exploreAreaOf(w: World, depth: number): ExploreArea | undefined {
  return w.getResource<ExploreState>(RES.explore)?.areas.find((a) => a.depth === depth);
}

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
import type { ItemCategory, ItemInstance, ItemRarity } from "./types.ts";

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
  // ---- wave A
  /** Owner classic.items (created lazily; read with lootFilterOf, which falls back to DEFAULT_LOOT_FILTER). */
  lootFilter: "classic.lootFilter",
  /** Owner classic.rift. */
  rift: "classic.riftState",
  /** Owner classic.achievements. */
  achievements: "classic.achievements",
  // ---- party (docs/design/party.md)
  /** Owner classic.party. Created lazily by the first party action (absent = a party of one: GameState.hero). */
  party: "classic.party",
} as const;

export interface GameState {
  /** "choose" until classic.newHero creates the hero. */
  phase: "choose" | "play";
  /** Drawn once from ctx.rng in classic.core setup; level seeds = mix(worldSeed, depth). */
  worldSeed: number;
  /** Next ItemInstance uid. */
  nextUid: number;
  /**
   * The CONTROLLED hero (0 before classic.newHero). Every manual action, the
   * HUD, the camera and ControlState.mode apply to this hero. With a party
   * (docs/design/party.md §2) it is always one of PartyState.members and
   * changes only through classic.party.control (or the party's auto-switch
   * on death); the other members are always driven by the party AI.
   */
  hero: Entity;
  /** Pack ids for monster population, monotonic. */
  nextPack: number;
}

export interface AreaState {
  /** 0 = town, >= 1 dungeon depth. The AreaTag of the hero (every party member) always equals this. */
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
  // ---- wave A (optional in stored configs; read with `?? DEFAULT_AUTO_CONFIG.x`) ----
  /** Repair worn gear at the smith on town visits. */
  autoRepair?: boolean;
  /** Use smith crafting (sockets + gems, upgrades, rerolls) with spare gold. */
  autoCraft?: boolean;
  /** Gamble with spare gold. */
  autoGamble?: boolean;
  /** Run Rifts once unlocked and the main dungeon is done. */
  autoRift?: boolean;
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

/**
 * Stash items of every tab in one list; ItemInstance.tab says which tab
 * (absent = 0). Capacity per tab = BalanceProto.stashSize; tabs =
 * BalanceProto.stashTabs (rules.stashTabCount). Owner classic.items.
 */
export interface StashState {
  items: ItemInstance[];
  /** Player-chosen tab names (index = tab); missing entries use "Tab n". Optional. */
  tabNames?: string[];
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
  // ---- wave A counters (optional; writers increment `(rs.x ?? 0) + n`) ----
  /** Gold paid to any sink (vendors, repair, crafting, gambling, resets, rift fees). Every spender adds. */
  goldSpent?: number;
  /** Unique / set items that entered the hero's possession (pickup, gamble, grant). classic.items. */
  uniquesFound?: number;
  setItemsFound?: number;
  /** Successful smith operations (upgrade, reroll, socket added, gems combined). classic.crafting. */
  itemsCrafted?: number;
  /** Gems put into sockets. classic.crafting. */
  gemsSocketed?: number;
  /** Items bought from the gambler. classic.items. */
  gambles?: number;
  /** Rift runs completed (guardian killed). classic.rift. */
  riftsCompleted?: number;
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
  autoRepair: true,
  autoCraft: true,
  autoGamble: true,
  autoRift: true,
};

// ---------------------------------------------------------------------------
// Wave A resources (docs/design/wave-A.md)
// ---------------------------------------------------------------------------

/**
 * Loot filter (owner classic.items, action classic.setLootFilter). Hidden
 * loot shows no ground label and the auto controller never picks it up; a
 * manual click still picks it up. Pure checks: src/loot.ts lootVisible.
 */
export interface LootFilter {
  /** Lowest rarity shown per item category; "none" hides the category. Potions and gold use the flags below. */
  minRarity: Record<ItemCategory, ItemRarity | "none">;
  showGold: boolean;
  /** Gold piles smaller than this are hidden. */
  minGold: number;
  showPotions: boolean;
}

/** A finished Rift run: everything a leaderboard needs (server verification comes with wave B). */
export interface RiftRecord {
  level: number;
  /** Run length in ticks (20 Hz). */
  ticks: number;
  /** rules.riftScore(level, ticks, timeLimit, deaths). */
  score: number;
  deaths: number;
  completed: boolean;
  /** Failure reason when !completed. */
  reason: "" | "death" | "left";
  heroLevel: number;
  classId: string;
  heroName: string;
  worldSeed: number;
  /** Sim tick the run ended. */
  endTick: number;
  /** Run id (RiftState.nextRun at open time). */
  run: number;
  /**
   * Party (docs/design/party.md §7.4): every member at the end of the run, in
   * slot order (hero fields above = the acting leader). Absent for solo runs.
   */
  party?: { name: string; classId: string; level: number }[];
}

export interface RiftRun {
  level: number;
  /** rules.riftDepth(level, run). */
  depth: number;
  run: number;
  startTick: number;
  /** Progress points (RiftProto.progress per kill), capped at goal. */
  progress: number;
  goal: number;
  /** Guardian entity once spawned (0 before). */
  guardian: Entity;
  guardianSpawned: boolean;
  deaths: number;
  feePaid: number;
}

export interface RiftState {
  unlocked: boolean;
  /** Highest level completed (levels 1..maxCompleted + 1 can be opened). */
  maxCompleted: number;
  best: RiftRecord | null;
  /** Last 10 runs, newest first. */
  history: RiftRecord[];
  active: RiftRun | null;
  /** Next run id (monotonic). */
  nextRun: number;
}

export interface AchievementState {
  /** Unlocked achievement ids with the tick, sorted by id. */
  unlocked: { id: string; at: number }[];
  /** Chosen title (an unlocked achievement's reward title) or "". */
  title: string;
}

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

/**
 * The CONTROLLED hero entity, or 0 when none exists yet (phase "choose") or
 * the game resource is missing. Party code that must act on every member
 * uses party/shared.ts partyMembers() instead.
 */
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

// ---------------------------------------------------------------------------
// Party (docs/design/party.md §2). Owner classic.party.
// ---------------------------------------------------------------------------

export type PartyFormation = "wedge" | "line" | "ring";

/** Party AI options (classic.party.config). */
export interface PartyConfig {
  /** Formation shape of the followers around the leader (§6.2). */
  formation: PartyFormation;
  /** Follow distance from the leader in tiles, 1..4. */
  spread: number;
  /** Followers prefer the leader's target (focus fire) over their own pick. */
  focusFire: boolean;
  /** Followers walk to downed allies and revive them when no foe is near. */
  revive: boolean;
  /** Auto/Idle: when the controlled hero goes down, control moves to the acting leader. */
  autoSwitch: boolean;
}

export const DEFAULT_PARTY_CONFIG: PartyConfig = {
  formation: "wedge",
  spread: 2,
  focusFire: true,
  revive: true,
  autoSwitch: true,
};

/**
 * The party (resource RES.party). ABSENT until the first party action
 * (recruit, buySlot, config...): a world without it is a party of one made
 * of GameState.hero, which keeps old saves and every solo game bit-identical.
 * Read it only through party/shared.ts helpers.
 */
export interface PartyState {
  /** Hero entities in slot order (party frames, F1..F4). 1..PartyProto.maxMembers; always contains GameState.hero and `founder`. */
  members: Entity[];
  /** The first hero of the save: never dismissed, holds the shared Wallet and Supplies (the purse), owns the "hero" leaderboard row. */
  founder: Entity;
  /** Slots bought with gold (0..3); unlocked slots = 1 + max(bosses unlocked, slotsBought). */
  slotsBought: number;
  /** Next PartyMember.uid (the founder has 0). Monotonic. */
  nextUid: number;
  config: PartyConfig;
}

/** The party resource or null (a party of one). */
export function partyStateOf(w: World): PartyState | null {
  return w.getResource<PartyState>(RES.party) ?? null;
}

export const DEFAULT_LOOT_FILTER: LootFilter = {
  minRarity: {
    weapon: "normal",
    shield: "normal",
    helm: "normal",
    armor: "normal",
    gloves: "normal",
    boots: "normal",
    ring: "normal",
    amulet: "normal",
    potion: "normal",
    gem: "normal",
  },
  showGold: true,
  minGold: 0,
  showPotions: true,
};

/** The loot filter, or the default when the resource does not exist yet. */
export function lootFilterOf(w: World): LootFilter {
  return w.getResource<LootFilter>(RES.lootFilter) ?? DEFAULT_LOOT_FILTER;
}

/** Rift state or null when classic.rift is not loaded / has not created it yet. */
export function riftOf(w: World): RiftState | null {
  return w.getResource<RiftState>(RES.rift) ?? null;
}

/** Achievement state or null when classic.achievements is not loaded / has not created it yet. */
export function achievementsOf(w: World): AchievementState | null {
  return w.getResource<AchievementState>(RES.achievements) ?? null;
}

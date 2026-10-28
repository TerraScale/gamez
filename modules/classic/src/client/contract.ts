/**
 * Client contract of the classic mode (CONTRACT). The client view (T10)
 * implements ClassicClientApi and the HudSnapshot builder; the React HUD (T9)
 * renders only from these types. Nothing here touches Pixi or the DOM.
 *
 * Data flow (docs/design/classic.md §12):
 *   local Sim (20 Hz x speed) --events--> game.ts --> renderer (Pixi, every frame, interpolated)
 *                              \--world--> buildHud() at 10 Hz --> hud store --> React (selectors)
 *   React buttons / keys / taps --> api.act(name, payload) --> sim.dispatch()
 */
import type { PlatformServices } from "@gamez/ui-host";
import type { DispatchResult, Entity } from "@gamez/kernel";
import type { AutoPlan, HeroStatsValue } from "../components.ts";
import type { AutoConfig, ControlMode, LootFilter, RiftRecord, SimSpeed } from "../resources.ts";
import type { ClassicMap } from "../world/maps.ts";
import type {
  AttrBlock,
  EquipSlot,
  ItemCategory,
  ItemRarity,
  MonsterRarity,
  NpcRole,
} from "../types.ts";

/** Minimal external store (useSyncExternalStore-compatible). getSnapshot returns the same object until it changes. */
export interface Store<T> {
  getSnapshot(): T;
  subscribe(cb: () => void): () => void;
}

export type PanelId =
  | "character"
  | "inventory"
  | "skills"
  | "quests"
  | "vendor"
  | "stash"
  | "waypoint"
  | "settings"
  | "log"
  | "map"
  // ---- wave A (docs/design/wave-A.md §HUD)
  /** Talent tree of the hero's class (key N). */
  | "talents"
  /** Smith services; opened with the smith (vendor panel shows a "Craft" button). */
  | "craft"
  /** Gambler offers; opened by the gambler NPC. */
  | "gamble"
  /** Rift levels, best runs, active run; opened by the obelisk. */
  | "rift"
  /** Achievement list (key Y). */
  | "achievements"
  /** Loot filter editor (from Settings). */
  | "lootFilter"
  // ---- wave B (docs/design/wave-B.md §8.4); need api.platform (else an offline note)
  /** Chat channels (global, mode, guild) — key Enter / C. */
  | "chat"
  /** Guild browser and roster — key G. */
  | "guild"
  /** Leaderboards (level, depth, rift; per class) — key B. */
  | "leaderboard"
  /** Sign in / register / link the guest, display name. */
  | "account";

/** Display colours (0xRRGGBB) shared by HUD and renderer. */
export const RARITY_COLOR: Record<ItemRarity, number> = {
  normal: 0xe6e6e6,
  magic: 0xa6c4ff,
  rare: 0xfff06b,
  set: 0x6fe07a,
  unique: 0xffb85c,
};
export const MONSTER_COLOR: Record<MonsterRarity, number> = {
  normal: 0xe6e6e6,
  minion: 0xe6e6e6,
  summon: 0x9fe0a8,
  champion: 0x5aa0ff,
  unique: 0xffb85c,
  boss: 0xff6a3d,
};
/**
 * World nameplate colours of monsters. Same hues as MONSTER_COLOR (HUD), but
 * the champion blue is lighter: 0x5aa0ff sank into dark and fogged floors.
 * Elite names also get a dark backing plate (ArpgRenderEntity.labelPlate).
 */
export const MONSTER_LABEL_COLOR: Record<MonsterRarity, number> = {
  ...MONSTER_COLOR,
  champion: 0x9ac7ff,
};
export const ELEMENT_COLOR = {
  phys: 0xf2f2f2,
  fire: 0xff8a3d,
  cold: 0x7fd4ff,
  lightning: 0xfff15e,
  poison: 0x8fe36b,
} as const;
export const GOLD_COLOR = 0xf0c419;

/** WCAG contrast ratio of two 0xRRGGBB colours (1..21). Used by the colour tests and any HUD-side check. */
export function contrastRatio(a: number, b: number): number {
  const lum = (c: number): number => {
    const ch = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch((c >> 16) & 255) + 0.7152 * ch((c >> 8) & 255) + 0.0722 * ch(c & 255);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;

/**
 * How an item compares with the equipped item it would replace (its best slot,
 * the same slot the upgrade score uses). Stat lines are player text, e.g.
 * "+2 to Armor" / "-3 to Dexterity"; the numeric score stays internal.
 */
export interface ItemCompare {
  slot: EquipSlot;
  /** The equipped item in that slot (null = the slot is empty). */
  equipped: { uid: number; name: string } | null;
  /** Stat differences (own minus equipped), in display order. */
  stats: { text: string; delta: number }[];
}

export interface ItemView {
  uid: number;
  /** Internal item base id (keys and actions only, never shown as text). */
  base: string;
  /** Player-facing base name ("Sandals"). Optional so older fixtures still compile; the HUD falls back to the category. */
  baseName?: string;
  name: string;
  rarity: ItemRarity;
  category: ItemCategory;
  slots: EquipSlot[];
  ilvl: number;
  reqLevel: number;
  /** "8-14 damage", "+12 to Life", ... in display order (base line first). */
  lines: string[];
  value: number;
  /** What the junk buyer pays (0 when not sellable). */
  sellPrice: number;
  icon: string;
  w: number;
  h: number;
  /** Requirements met by the hero. */
  usable: boolean;
  /** Auto-equip score delta vs the currently equipped item in its best slot (>0 = upgrade). Internal score. */
  upgrade: number;
  /** Stat comparison with the equipped item (null when the item fits no slot). Optional for older fixtures. */
  compare?: ItemCompare | null;
  // ---- wave A (optional; filled by client/model/items.ts extendItemView) ----
  /** Set piece: the set, which pieces the hero wears, and each bonus with whether it is active. */
  set?: {
    id: string;
    name: string;
    pieces: { name: string; worn: boolean }[];
    bonuses: { count: number; lines: string[]; active: boolean }[];
  } | null;
  /** One entry per socket: empty (gem null) or the gem's name and its lines for this item. */
  sockets?: { gem: string | null; name: string; lines: string[] }[];
  durability?: { cur: number; max: number } | null;
  broken?: boolean;
  /** Smith upgrade level (ItemInstance.upgrade); not to be confused with `upgrade` (auto-equip score). */
  upgradeLevel?: number;
  /** Stash tab when in the stash. */
  tab?: number;
  /** Hidden by the loot filter (ground labels / auto pickup). */
  filtered?: boolean;
}

export interface SkillBarSlot {
  slot: number;
  /** "1".."6" */
  key: string;
  skill: string | null;
  name: string;
  icon: string;
  manaCost: number;
  /** Ticks until ready and total cooldown ticks (for the sweep). */
  cooldownLeft: number;
  cooldown: number;
  /** Enough mana, known, not on cooldown. */
  usable: boolean;
}

export interface BeltSlotView {
  slot: number;
  /** "Q" "W" "E" "R" */
  key: string;
  base: string | null;
  name: string;
  kind: "life" | "mana" | "rejuv" | null;
  count: number;
}

export interface TargetView {
  entity: Entity;
  name: string;
  rarity: MonsterRarity;
  level: number;
  life: number;
  lifeMax: number;
  /** Mod display names ("Mighty", "Rimebound"). */
  mods: string[];
}

export interface SkillView {
  id: string;
  name: string;
  description: string;
  icon: string;
  rank: number;
  maxRank: number;
  reqLevel: number;
  learnable: boolean;
  manaCost: number;
  cooldown: number;
  onBar: number | null;
  tags: string[];
}

export interface QuestView {
  id: string;
  name: string;
  description: string;
  giver: string;
  state: "available" | "active" | "done" | "completed";
  progress: number;
  count: number;
  reward: string;
}

export interface VendorView {
  npc: Entity;
  proto: string;
  name: string;
  role: NpcRole;
  greeting: string;
  /** Smith: items for sale. */
  stock: (ItemView & { price: number })[];
  /** Alchemist: potions and scrolls ("tp"). */
  potions: { base: string; name: string; price: number }[];
  /** Junk buyer pays this % of item value. */
  buyPct: number;
}

export interface HeroView {
  entity: Entity;
  name: string;
  classId: string;
  className: string;
  level: number;
  xp: number;
  xpLevelStart: number;
  xpNextLevel: number;
  life: number;
  lifeMax: number;
  mana: number;
  manaMax: number;
  gold: number;
  tpScrolls: number;
  statPoints: number;
  skillPoints: number;
  attrs: AttrBlock;
  /** Allocated (base) attributes, for the + buttons. */
  baseAttrs: AttrBlock;
  sheet: HeroStatsValue;
  /** CombatStats summary for the character panel. */
  armor: number;
  dmgMin: number;
  dmgMax: number;
  toHit: number;
  critPct: number;
  attackSpeed: number;
  castSpeed: number;
  moveSpeed: number;
  res: { fire: number; cold: number; lightning: number; poison: number };
  dead: boolean;
  /** Ticks until respawn is allowed (0 when ready). */
  respawnIn: number;
  /** Fractional tile position. */
  x: number;
  y: number;
  /** Active statuses (buffs and debuffs), soonest to expire first. */
  statuses: StatusView[];
}

export interface StatusView {
  id: string;
  name: string;
  /** StatusProto.kind: "buff" is good, the rest are debuffs. */
  kind: string;
  /** Whole seconds left (rounded up). */
  secondsLeft: number;
  tint: number;
}

export interface AreaView {
  depth: number;
  name: string;
  theme: string;
  isTown: boolean;
  exploredPct: number;
  bossAlive: boolean;
  killed: number;
  spawned: number;
  waypoints: number[];
  deepest: number;
  portalOpen: boolean;
}

export interface ControlView {
  mode: ControlMode;
  speed: SimSpeed;
  config: AutoConfig;
  /** Manual override active (auto paused). */
  overridden: boolean;
  plan: AutoPlan;
}

export interface HudSnapshot {
  /** Sim tick of this snapshot. */
  tick: number;
  phase: "choose" | "play";
  /** Class choices for the new-hero screen. */
  classes: { id: string; name: string; description: string }[];
  hero: HeroView | null;
  area: AreaView | null;
  control: ControlView;
  skillBar: SkillBarSlot[];
  belt: BeltSlotView[];
  target: TargetView | null;
  inventory: { cols: number; rows: number; items: { x: number; y: number; item: ItemView }[] };
  equipment: Record<EquipSlot, ItemView | null>;
  stash: ItemView[];
  stashSize: number;
  skills: SkillView[];
  quests: QuestView[];
  /** NPC panel opened by classic.npc.opened (cleared when the hero walks away). */
  vendor: VendorView | null;
  // ---- wave A sections (optional: null/absent when the module is not loaded or nothing applies).
  // Each is built by its own file in src/client/model/ (see buildHud).
  talents?: TalentsView | null;
  craft?: CraftView | null;
  gamble?: GambleView | null;
  rift?: RiftView | null;
  achievements?: AchievementsView | null;
  lootFilter?: LootFilterView | null;
  stashTabs?: StashTabView[];
  dps?: DpsView | null;
}

// ---------------------------------------------------------------------------
// Wave A HUD views (docs/design/wave-A.md §HUD)
// ---------------------------------------------------------------------------

export interface TalentNodeView {
  id: string;
  name: string;
  /** Description with the current per-rank totals filled in. */
  description: string;
  icon: string;
  tier: number;
  col: number;
  rank: number;
  maxRank: number;
  /** A point can be spent on it now (points > 0, tier unlocked, requirement met, below max). */
  learnable: boolean;
  /** Tier not unlocked yet or requirement missing. */
  locked: boolean;
  requires: string | null;
  /** "Current: +4% life" / "Next: +6% life" lines. */
  lines: string[];
}

export interface TalentsView {
  tree: string;
  name: string;
  branches: string[];
  tierPoints: number;
  points: number;
  spent: number;
  nodes: TalentNodeView[];
  /** Gold for a reset (rules.talentResetCost) and whether it is possible now (town, gold, spent > 0). */
  resetCost: number;
  canReset: boolean;
}

export interface CraftItemView {
  item: ItemView;
  where: "bag" | "equipped";
  /** Prices (null = not possible for this item). */
  repairCost: number | null;
  upgradeCost: number | null;
  /** Success chance of the next upgrade (percent). */
  upgradeChance: number | null;
  rerollCost: number | null;
  socketCost: number | null;
  /** Bag gem uids that fit an empty socket of this item. */
  canSocket: boolean;
  unsocketCost: number | null;
}

export interface CraftView {
  npc: Entity;
  items: CraftItemView[];
  /** Bag gems grouped by base. */
  gems: {
    base: string;
    name: string;
    tier: number;
    count: number;
    uids: number[];
    combineCost: number | null;
  }[];
  repairAllCost: number;
}

export interface GambleView {
  npc: Entity;
  name: string;
  greeting: string;
  offers: { category: ItemCategory; label: string; price: number; affordable: boolean }[];
}

export interface RiftView {
  unlocked: boolean;
  /** What unlocks it, for the locked panel ("Defeat the Hollow King"). */
  unlockText: string;
  /** Levels that can be opened now (1..maxCompleted + 1) with their fee and monster level. */
  levels: { level: number; fee: number; monsterLevel: number; affordable: boolean }[];
  maxCompleted: number;
  best: RiftRecord | null;
  history: RiftRecord[];
  active: {
    level: number;
    progressPct: number;
    /** Ticks left of the time limit (0 when over). */
    ticksLeft: number;
    guardianAlive: boolean;
    done: boolean;
  } | null;
  /** The obelisk entity in reach (0 = none; the panel can still show records). */
  obelisk: Entity;
}

export interface AchievementView {
  id: string;
  name: string;
  description: string;
  icon: string;
  progress: number;
  target: number;
  unlocked: boolean;
  /** Tick it was unlocked (0 when locked). */
  at: number;
  rewardText: string;
}

export interface AchievementsView {
  unlocked: number;
  total: number;
  list: AchievementView[];
  title: string;
}

export interface LootFilterView {
  filter: LootFilter;
  /** Ground loot items currently hidden in this area (feedback in the editor). */
  hiddenOnGround: number;
}

export interface StashTabView {
  index: number;
  name: string;
  count: number;
  size: number;
}

export interface DpsSkillView {
  skill: string;
  name: string;
  /** Average damage per hit (after the hero's bonuses, before monster defences), crit included. */
  avgHit: number;
  /** Casts per second at the current attack/cast speed. */
  perSecond: number;
  dps: number;
  manaPerSecond: number;
}

export interface DpsView {
  skills: DpsSkillView[];
  /** Highest dps of the bar skills. */
  best: number;
  /** Effective life against a level-matched monster's physical hit (armor and block), for comparison. */
  effectiveLife: number;
  /** Where the hero's stats come from: "Items", "Talents", "Sets", "Buffs" with short lines. */
  sources: { source: string; lines: string[] }[];
}

export type LogKind = "combat" | "loot" | "level" | "quest" | "system" | "death";

export interface LogLine {
  id: number;
  tick: number;
  kind: LogKind;
  text: string;
  /** Colour hint (0xRRGGBB). */
  color: number;
}

export interface Toast {
  id: number;
  kind: "levelUp" | "quest" | "loot" | "area" | "death" | "info" | "offline";
  title: string;
  body: string;
  /** performance.now() based expiry (client only). */
  until: number;
}

export interface Settings {
  showDamageNumbers: boolean;
  showLootLabels: boolean;
  showMinimap: boolean;
  zoom: number;
  lighting: boolean;
  /** Developer overlay: fps, tick ms, entities. */
  showPerf: boolean;
  // ---- wave A
  /** Volumes 0..100 (master scales sfx and music). */
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  muted: boolean;
  /** Renderer quality ("auto" picks low on coarse-pointer / small screens, else high). */
  quality: GraphicsQuality;
  /** Onboarding tips on/off (dismissed tips are remembered separately). */
  tips: boolean;
}

export type GraphicsQuality = "auto" | "low" | "medium" | "high";

export interface PerfView {
  fps: number;
  /** Average sim ms per tick over the last second. */
  tickMs: number;
  ticksPerSecond: number;
  entities: number;
  monsters: number;
}

export interface UiState {
  panels: PanelId[];
  toasts: Toast[];
  settings: Settings;
  /** Item under the cursor for the tooltip (uid) and where (CSS px). */
  hover: { uid: number; x: number; y: number } | null;
  /** True below 700px width (compact layout). */
  compact: boolean;
  perf: PerfView;
  /** Last rejected action, shown briefly. */
  error: { code: string; message: string; until: number } | null;
}

export interface MinimapData {
  map: ClassicMap;
  /** ExploreArea.bits of the current area (or null = all visible, e.g. town). */
  explored: readonly number[] | null;
  heroX: number;
  heroY: number;
  /** Tile positions of notable things. */
  dots: {
    x: number;
    y: number;
    kind: "monster" | "champion" | "boss" | "npc" | "loot" | "stairs" | "waypoint" | "portal";
  }[];
}

/**
 * Wave B: server sync state of the classic client (docs/design/wave-B.md §2.5),
 * shown by the HUD's sync badge.
 */
export interface SyncView {
  /** "server": verified by the InstanceDO; "local": no server (seeded run, cheats, QA gallery, offline host). */
  mode: "server" | "local";
  /** Socket state ("local" mode: always "offline"). */
  status: "connecting" | "online" | "offline";
  /** Last server-verified sim tick (0 before the first vstate). */
  verifiedTick: number;
  /** Local ticks not yet verified (recorded and/or unacked). */
  pendingTicks: number;
  /** True when pendingTicks exceeded limits.maxPendingTicks and local progress past it will be replaced. */
  overflow: boolean;
  /** Last resync, for a toast ("Progress corrected by the server"). */
  lastResync: { code: string; message: string; at: number } | null;
  /** This character came from an imported local save (leaderboards mark it). */
  imported: boolean;
}

export const LOCAL_SYNC_VIEW: SyncView = {
  mode: "local",
  status: "offline",
  verifiedTick: 0,
  pendingTicks: 0,
  overflow: false,
  lastResync: null,
  imported: false,
};

/** Everything the HUD may call. Implemented by the client view (src/client/game.ts). */
export interface ClassicClientApi {
  /** 10 Hz snapshot store of the sim (structurally shared: unchanged sub-objects keep identity). */
  readonly hud: Store<HudSnapshot>;
  readonly log: Store<readonly LogLine[]>;
  readonly ui: Store<UiState>;
  /** Dispatches a kernel action on the local sim; failures also land in ui.error. */
  act(name: string, payload: unknown): DispatchResult;
  togglePanel(p: PanelId): void;
  openPanel(p: PanelId): void;
  closePanel(p: PanelId): void;
  closeAll(): void;
  setHover(h: UiState["hover"]): void;
  updateSettings(patch: Partial<Settings>): void;
  dismissToast(id: number): void;
  /** Minimap data, cheap to call at ~5 Hz (no copies of the map). */
  minimap(): MinimapData | null;
  /** Cast the skill in bar slot 0..5 at the current pointer/target (same as pressing 1-6). */
  castSlot(slot: number): void;
  /** Drink belt slot 0..3 (same as Q W E R). */
  drink(slot: number): void;
  /** Wipes the local save and starts a new hero (server mode: a fresh server instance). */
  newGame(): void;
  // Wave B. Optional only so older test fakes stay valid: game.ts always sets all three.
  /** Server sync state (LOCAL_SYNC_VIEW when there is no server). */
  readonly sync?: Store<SyncView>;
  /** Platform services (auth, chat, guilds, leaderboards); null without a server. */
  readonly platform?: PlatformServices | null;
  /** The signed-in account (session) or null. */
  readonly session?: { accountId: string; name: string } | null;
  /** Leaves the mode (services.exit). */
  exit(): void;
}

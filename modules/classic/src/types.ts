/**
 * Classic mode data contracts (CONTRACT): registry kinds and the prototype
 * type of every kind, plus the plain-JSON value types shared by components,
 * resources and events. Units follow src/fixed.ts: distances in sub units
 * (256 per tile), durations in ticks (20 Hz), percentages as integers.
 *
 * Content lives in modules/classic/src/content (module "classic.content").
 * Other modules only read prototypes through ctx.registry; they never import
 * content files. A mod changes content with reg.patch() in dataUpdates.
 */

// ---------------------------------------------------------------------------
// Registry kinds
// ---------------------------------------------------------------------------

export const KIND = {
  /** ClassProto. Ids: "classic.warrior", "classic.rogue", "classic.sorcerer". */
  class: "classic.class",
  /** SkillProto. Ids: "classic.skill.<name>" (hero) and "classic.mskill.<name>" (monster-only). */
  skill: "classic.skill",
  /** StatusProto. Ids: "classic.status.<name>". */
  status: "classic.status",
  /** MonsterProto. Ids: "classic.monster.<name>" (bosses too, with `boss` set). */
  monster: "classic.monster",
  /** MonsterModProto (champion/unique modifiers). Ids: "classic.mod.<name>". */
  monsterMod: "classic.monsterMod",
  /** ItemBaseProto (equipment and potions). Ids: "classic.item.<name>". */
  itemBase: "classic.itemBase",
  /** AffixProto. Ids: "classic.affix.<name>.<tier>". */
  affix: "classic.affix",
  /** UniqueProto. Ids: "classic.unique.<name>". */
  unique: "classic.unique",
  /** NpcProto. Ids: "classic.npc.<name>". */
  npc: "classic.npc",
  /** QuestProto. Ids: "classic.quest.<name>". */
  quest: "classic.quest",
  /** ThemeProto (dungeon tier look + monster pool). Ids: "classic.theme.<name>". */
  theme: "classic.theme",
  /** NameTableProto. Ids: "classic.names.uniqueMonster", "classic.names.rareItem". */
  names: "classic.names",
  /** BalanceProto, single id BALANCE_ID. */
  balance: "classic.balance",
} as const;

export const BALANCE_ID = "classic.balance";
export const NAMES_UNIQUE_MONSTER = "classic.names.uniqueMonster";
export const NAMES_RARE_ITEM = "classic.names.rareItem";

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export type Attr = "str" | "dex" | "mag" | "vit";
export const ATTRS: readonly Attr[] = ["str", "dex", "mag", "vit"];
export type AttrBlock = Record<Attr, number>;

export type Element = "phys" | "fire" | "cold" | "lightning" | "poison";
export const ELEMENTS: readonly Element[] = ["phys", "fire", "cold", "lightning", "poison"];
/** Damage amounts per element (integers). */
export type Damage = Record<Element, number>;

export type Team = "hero" | "monster";

export type ItemRarity = "normal" | "magic" | "rare" | "unique";
export const ITEM_RARITIES: readonly ItemRarity[] = ["normal", "magic", "rare", "unique"];

/** "minion" = escort of a unique/boss; "summon" = raised or placed by a skill. */
export type MonsterRarity = "normal" | "champion" | "unique" | "boss" | "minion" | "summon";

export type MonsterBehaviour =
  | "rusher"
  | "swarm"
  | "archer"
  | "caster"
  | "tank"
  | "charger"
  | "summoner"
  | "exploder"
  | "boss"
  /** Stationary hero summon (totem/sentry): never moves, casts its first skill at the nearest enemy. */
  | "totem";

export type EquipSlot =
  | "weapon"
  | "offhand"
  | "helm"
  | "armor"
  | "gloves"
  | "boots"
  | "amulet"
  | "ring1"
  | "ring2";
export const EQUIP_SLOTS: readonly EquipSlot[] = [
  "weapon",
  "offhand",
  "helm",
  "armor",
  "gloves",
  "boots",
  "amulet",
  "ring1",
  "ring2",
];

export type ItemCategory =
  | "weapon"
  | "shield"
  | "helm"
  | "armor"
  | "gloves"
  | "boots"
  | "ring"
  | "amulet"
  | "potion";

export type WeaponClass = "sword" | "axe" | "mace" | "dagger" | "bow" | "staff" | "wand";

/**
 * Every stat an item affix, unique, buff or class can change. Values are
 * integers; "Pct" stats are percent points.
 */
export type StatId =
  | "str"
  | "dex"
  | "mag"
  | "vit"
  | "allAttrs"
  | "life"
  | "mana"
  | "lifePct"
  | "manaPct"
  | "lifeRegen" // life per second (x10: 15 = 1.5/s)
  | "manaRegenPct" // % more mana regen
  | "armor"
  | "armorPct"
  | "toHit"
  | "toHitPct"
  | "dmgMin" // flat added to weapon min
  | "dmgMax" // flat added to weapon max
  | "dmgPct" // % more weapon/attack damage
  | "spellPct" // % more spell damage
  | "fireDmg" // flat fire added to attacks
  | "coldDmg"
  | "lightningDmg"
  | "poisonDmg"
  | "attackSpeed" // % increased attack speed
  | "castSpeed" // % faster cast
  | "moveSpeed" // % faster movement
  | "critPct"
  | "critDmgPct" // added to the 150% crit multiplier
  | "blockPct"
  | "resFire"
  | "resCold"
  | "resLightning"
  | "resPoison"
  | "resAll"
  | "lifeSteal" // % of damage dealt
  | "manaSteal"
  | "lifeOnKill"
  | "manaOnKill"
  | "thorns" // flat phys returned to melee attackers
  | "magicFind"
  | "goldFind"
  | "lightRadius" // tiles
  | "allSkills" // + ranks to every known skill
  | "potionPct"; // % more from potions

export interface StatMod {
  stat: StatId;
  value: number;
}

/** Plain-JSON item instance (inventory, equipment, stash, ground loot, vendor stock). */
export interface ItemInstance {
  /** Unique per sim, from GameState.nextUid. */
  uid: number;
  /** ItemBaseProto id. */
  base: string;
  rarity: ItemRarity;
  ilvl: number;
  /** Display name: base name (normal), "<prefix> <base> <suffix>" (magic), rolled name (rare), unique name. */
  name: string;
  /** Rolled explicit mods (affixes or unique mods), in roll order. Base implicits are NOT copied here. */
  mods: StatMod[];
  /** Affix ids that produced `mods` (magic/rare), for tooltips. */
  affixes: string[];
  /** UniqueProto id for uniques. */
  unique?: string;
  /** Base gold value (see rules.itemValue); vendors sell at value, the junk buyer pays NpcProto.buyPct of it. */
  value: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SkillTag =
  | "single"
  | "aoe"
  | "melee"
  | "ranged"
  | "mobility"
  | "heal"
  | "buff"
  | "summon"
  | "dot"
  | "control"
  | "basic";

// ---------------------------------------------------------------------------
// Prototypes
// ---------------------------------------------------------------------------

export interface ClassProto {
  name: string;
  description: string;
  /** Logical art id, e.g. "unit.hero.warrior" (renderer falls back to "unit.hero"). */
  appearance: string;
  tint: number;
  base: AttrBlock;
  life: { base: number; perVit: number; perLevel: number };
  mana: { base: number; perMag: number; perLevel: number };
  /** Attribute that adds 1% weapon damage per point ("str" warrior, "dex" rogue, "str" sorcerer staff). */
  primary: Attr;
  /** Auto/Idle allocation of the 5 points per level, e.g. {str:2, dex:1, mag:0, vit:2}; sums to statPointsPerLevel. */
  autoAlloc: AttrBlock;
  /** Skill ids this class can learn (including shared ones), in skill-panel order. */
  skills: string[];
  /** Skills known at level 1 with rank 1. */
  startingSkills: string[];
  /** Default skill bar, exactly 6 entries (null = empty slot). */
  defaultBar: (string | null)[];
  /** Auto-mode learn order: skill ids; the controller spends points on the first learnable one, cycling. */
  autoSkillOrder: string[];
  /** ItemBase ids equipped at creation (normal rarity, ilvl 1). */
  starterItems: string[];
  starterPotions: { base: string; count: number }[];
  /** Base move speed, sub per tick (hero default 51 = 4 tiles/s). */
  moveSpeed: number;
}

export type SkillShape =
  /** Single target in reach (basic melee, monster bites). */
  | "melee"
  /** All enemies in a cone in front of the caster within range (cleave). */
  | "arc"
  /** One or more projectiles (count, spread). */
  | "projectile"
  /** Instant circle around the caster (frost ring, slam, exploder burst). */
  | "nova"
  /** Instant hit that bounces to nearby enemies (arc chain). */
  | "chain"
  /** Instant circle at the target point (meteor-like; also on-death bursts). */
  | "aoeTarget"
  /** Moves the caster quickly to the target, hitting on arrival (charge, tumble). */
  | "dash"
  /** Instant teleport to the target point (phase step). */
  | "blink"
  /** Creates monsters on the caster's team (sentry, raise husks). */
  | "summon"
  /** Self effect: heal and/or buff (mend, war shout). */
  | "self"
  /** Repeated nova around the caster while it keeps moving (whirl). */
  | "pulse";

export interface SkillProto {
  name: string;
  description: string;
  /** Logical icon id "icon.skill.<name>". */
  icon: string;
  users: "hero" | "monster";
  reqLevel: number;
  maxRank: number;
  shape: SkillShape;
  /** What a cast order needs: an enemy entity, a point, or nothing. */
  target: "enemy" | "point" | "self";
  /** Max distance (sub) from caster to target to start the cast. "self" skills use 0. */
  range: number;
  manaCost: number;
  /** Extra mana per rank above 1. */
  manaPerRank: number;
  cooldown: number;
  /** Animation lock at 100% speed (ticks), scaled by attack or cast speed. */
  castTicks: number;
  /** Tick within the cast when the effect fires (<= castTicks), scaled the same way. */
  hitTick: number;
  speedStat: "attack" | "cast";
  /** % of the caster's weapon (or monster base) damage used; 0 = no weapon component. */
  weaponPct: number;
  weaponPctPerRank: number;
  /** Flat skill damage (spells). */
  damage: {
    element: Element;
    min: number;
    max: number;
    minPerRank: number;
    maxPerRank: number;
  } | null;
  /** Attribute adding 1% to this skill's flat damage per point (spells: "mag"); null = none. */
  scaling: Attr | null;
  /** Attack roll against armor-based hit chance (attacks); spells always hit. */
  canMiss: boolean;
  /** Arc half-width in angle steps of 64 (shape "arc"). */
  arc?: number;
  projectile?: {
    speed: number;
    count: number;
    /** Angle steps between adjacent projectiles. */
    spread: number;
    /** Extra targets a projectile passes through. */
    pierce: number;
    radius: number;
    maxRange: number;
    /** Logical sprite id, e.g. "fx.ember_bolt". */
    sprite: string;
    /** Explodes on impact or at max range with this radius (cinder orb). */
    explodeRadius?: number;
  };
  /** Radius (sub) for nova / aoeTarget / pulse. */
  radius?: number;
  chain?: { bounces: number; range: number; falloffPct: number };
  /** Status applied to every enemy hit. */
  status?: { id: string; chancePct: number; duration: number; power: number; powerPerRank: number };
  dash?: { speed: number; maxRange: number };
  summon?: { monster: string; count: number; duration: number; max: number };
  heal?: { pct: number; pctPerRank: number; flat: number };
  /** Status applied to the caster (and hero-team allies in radius when `radius` is set). */
  buff?: { status: string; duration: number; power: number; powerPerRank: number };
  pulse?: { count: number; every: number };
  /** Visual effect id for EffectSpec / renderer ("fx.frost_ring"). */
  effect: string;
  /** Hints for the auto controller and monster AI. */
  ai: { tags: SkillTag[]; priority: number; minTargets?: number };
}

export type StatusKind = "slow" | "stun" | "dot" | "buff";

export interface StatusProto {
  name: string;
  kind: StatusKind;
  /** dot: element of the damage; power = total damage over the full duration. */
  element?: Element;
  /** dot: ticks between damage ticks. */
  every?: number;
  /** slow: power = % slower movement AND attack/cast. buff: stat mods scaled by power (see `mods`). */
  mods?: { stat: StatId; perPower: number }[];
  /** Refresh rule when re-applied: keep the longer duration and the higher power. */
  stacks: false;
  icon: string;
  /** Tint applied to the affected unit by the renderer (0 = none). */
  tint: number;
}

export interface MonsterProto {
  name: string;
  family: string;
  description: string;
  /** "unit.monster.<name>", falls back to `fallbackAppearance` tinted with `tint`. */
  appearance: string;
  fallbackAppearance: string;
  tint: number;
  /** Render scale percent (100 = hero size). */
  scale: number;
  behaviour: MonsterBehaviour;
  /** Stats at monster level 1; scaled by rules.scaleMonster. */
  life: number;
  armor: number;
  toHit: number;
  dmgMin: number;
  dmgMax: number;
  element: Element;
  resist: { fire: number; cold: number; lightning: number; poison: number };
  xp: number;
  /** Sub per tick. */
  moveSpeed: number;
  /** Body radius, sub. */
  radius: number;
  /** Skill ids; [0] is the basic attack. */
  skills: string[];
  /** Wake/aggro distance, sub. */
  aggroRange: number;
  /** Ranged kiters stay at least this far (sub); 0 = melee. */
  keepDistance: number;
  packSize: [number, number];
  /** Theme ids where it spawns; [] = never placed by population (summons, bosses). */
  themes: string[];
  minDepth: number;
  weight: number;
  /** Skill cast at the death position (exploder burst). */
  onDeathSkill?: string;
  /** Bosses only. */
  boss?: { depth: number; title: string; minions: string; minionCount: number };
}

export interface MonsterModProto {
  /** Display prefix: "Mighty", "Swift"... */
  name: string;
  lifePct: number;
  dmgPct: number;
  speedPct: number;
  armorPct: number;
  /** Added to basic attacks as extra damage of this element (% of physical). */
  addElement?: { element: Element; pct: number };
  onHitStatus?: { id: string; chancePct: number; duration: number; power: number };
  onDeathSkill?: string;
  lifeStealPct: number;
  /** Blinks next to its target every N ticks (0 = never). */
  blinkEvery: number;
  extraProjectiles: number;
  resistAll: number;
  tint: number;
  /** Not rolled below this depth. */
  minDepth: number;
}

export interface ItemBaseProto {
  name: string;
  category: ItemCategory;
  /** Slots it may occupy ("ring" -> ["ring1","ring2"]). Potions: []. */
  slots: EquipSlot[];
  weaponClass?: WeaponClass;
  twoHanded?: boolean;
  /** Inventory grid footprint. */
  size: { w: number; h: number };
  icon: string;
  /** Lowest item level that can roll this base. */
  ilvl: number;
  reqLevel: number;
  reqStr: number;
  reqDex: number;
  dmgMin?: number;
  dmgMax?: number;
  /** Base attack duration at 100% speed, ticks (weapons). */
  attackTicks?: number;
  /** Basic attack reach, sub (melee ~1.6 tiles; bows/wands ranged). */
  range?: number;
  /** Ranged weapons fire a projectile for the basic attack. */
  projectile?: string;
  armor?: number;
  block?: number;
  implicit: StatMod[];
  value: number;
  dropWeight: number;
  /** Potions only: instant restore (life/mana amount; rejuvenation uses pct of max). */
  potion?: { kind: "life" | "mana" | "rejuv"; amount: number; pct: number; tier: number };
}

export interface AffixProto {
  /** "Fiery" (prefix) or "of the Bear" (suffix). */
  name: string;
  kind: "prefix" | "suffix";
  /** Only one affix per group on an item. */
  group: string;
  stat: StatId;
  min: number;
  max: number;
  ilvl: number;
  categories: ItemCategory[];
  weight: number;
}

export interface UniqueProto {
  name: string;
  base: string;
  ilvl: number;
  mods: { stat: StatId; min: number; max: number }[];
  weight: number;
  flavor: string;
}

export type NpcRole = "healer" | "smith" | "alchemist" | "junk" | "quest";

export interface NpcProto {
  name: string;
  title: string;
  role: NpcRole;
  appearance: string;
  fallbackAppearance: string;
  tint: number;
  /** Smith: item categories in stock and how many items. Alchemist: potion bases sold. */
  sells?: { categories: ItemCategory[]; count: number; potions: string[]; tpScroll: boolean };
  /** Junk buyer: % of item value paid. 0 = does not buy. */
  buyPct: number;
  greeting: string;
}

export type QuestKind = "killBoss" | "clearLevel" | "reachDepth" | "killMonsters";

export interface QuestProto {
  name: string;
  description: string;
  giver: string;
  kind: QuestKind;
  /** killBoss: monster id; killMonsters: monster id or "*"; clearLevel / reachDepth: unused (""). */
  target: string;
  /** killMonsters: count; clearLevel: depth; reachDepth: depth; killBoss: 1. */
  count: number;
  reqLevel: number;
  /** Quest id that must be completed first ("" = none). */
  after: string;
  reward: { gold: number; xp: number; item: ItemRarity | null };
}

export interface ThemeProto {
  name: string;
  /** Tier index 0..3: depths 1-4 -> 0, 5-8 -> 1, 9-12 -> 2, 13-16 -> 3, then cycles. */
  tier: number;
  /** Ground tile ids; the generator picks variants deterministically. */
  floor: string[];
  wall: string;
  door: string;
  stairsDown: string;
  stairsUp: string;
  waypoint: string;
  /** Decorative blocking props placed against room walls. */
  decor: string[];
  /** Monster ids placed by population (weights from MonsterProto.weight). */
  monsters: string[];
  /** Ambient darkness 0..100 for the renderer. */
  darkness: number;
}

export interface NameTableProto {
  first: string[];
  second: string[];
}

/** Every tunable number of the mode, one prototype (id BALANCE_ID). */
export interface BalanceProto {
  maxLevel: number;
  statPointsPerLevel: number;
  skillPointsPerLevel: number;
  /** xpToNext(level) = xpA * level^2 + xpB * level. */
  xpA: number;
  xpB: number;
  /** Hero level - monster level beyond which XP drops by xpPenaltyPct per level (min xpMinPct). */
  xpGrace: number;
  xpPenaltyPct: number;
  xpMinPct: number;
  deathGoldLossPct: number;
  deathXpLossPct: number;
  respawnDelay: number;
  corpseTicks: number;
  potionCooldown: number;
  beltSlots: number;
  beltStack: number;
  invCols: number;
  invRows: number;
  stashSize: number;
  tpScrollPrice: number;
  maxTpScrolls: number;
  levelWidth: number;
  levelHeight: number;
  /** Rooms per dungeon level. */
  rooms: [number, number];
  roomSize: [number, number];
  /** Monster packs per dungeon level and per-pack multiplier on depth. */
  packs: [number, number];
  maxMonstersPerLevel: number;
  championPackChancePct: number;
  uniquePacksPerLevel: [number, number];
  /**
   * Champion chance and unique pack count ramp up over the first depths:
   * at depth d < packRampDepth they are scaled by d / packRampDepth (unique
   * counts rounded down). Optional: 0 or absent = no ramp.
   */
  packRampDepth?: number;
  /** Monsters farther than this from the hero sleep (sub). */
  sleepRange: number;
  /** Light radius around the hero for exploration (tiles). */
  lightRadius: number;
  /** Rarity weights for item drops before magic find. */
  rarityWeights: Record<ItemRarity, number>;
  /** Drop chances by monster rarity (percent) for: item, gold, potion. */
  drops: Record<
    MonsterRarity,
    { item: number; items: [number, number]; gold: number; potion: number }
  >;
  goldPerLevel: [number, number];
  vendorItems: number;
  /** Offline progress cap, ms. */
  offlineCapMs: number;
  /** Fraction of the online kill rate used offline (percent). */
  offlineEfficiencyPct: number;
}

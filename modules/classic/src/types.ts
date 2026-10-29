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
  // ---- wave A (docs/design/wave-A.md)
  /** TalentTreeProto, one per class. Ids: "classic.talents.<class>" (e.g. "classic.talents.warrior"). Owner content: talents.ts. */
  talentTree: "classic.talentTree",
  /** TalentNodeProto. Ids: "classic.talent.<class>.<name>". Owner content: talents.ts. */
  talent: "classic.talent",
  /** SetProto (item set with bonuses). Ids: "classic.set.<name>". Owner content: sets.ts. */
  set: "classic.set",
  /** SetItemProto (one piece of a set). Ids: "classic.setItem.<name>". Owner content: sets.ts. */
  setItem: "classic.setItem",
  /** EconomyProto, single id ECONOMY_ID: every gold-sink price (repair, crafting, gambling, resets, rift fees). */
  economy: "classic.economy",
  /** RiftProto, single id RIFT_ID. */
  rift: "classic.rift",
  /** AchievementProto. Ids: "classic.achievement.<name>". */
  achievement: "classic.achievement",
  // ---- party (docs/design/party.md)
  /** PartyProto, single id PARTY_ID (defined by classic.party). Read with rules.partyProtoOf (falls back to DEFAULT_PARTY_PROTO). */
  party: "classic.party",
} as const;

export const ECONOMY_ID = "classic.economy";
export const RIFT_ID = "classic.rift";
export const PARTY_ID = "classic.party";

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

/**
 * "set" (wave A): a piece of an item set (SetItemProto); ranks between rare
 * and unique (rules.rarityRank: normal 0, magic 1, rare 2, set 3, unique 4).
 */
export type ItemRarity = "normal" | "magic" | "rare" | "set" | "unique";
export const ITEM_RARITIES: readonly ItemRarity[] = ["normal", "magic", "rare", "set", "unique"];

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
  | "potion"
  /** Socketable gem (wave A): ItemBaseProto.gem is set; never equipped. */
  | "gem";

export const ITEM_CATEGORIES: readonly ItemCategory[] = [
  "weapon",
  "shield",
  "helm",
  "armor",
  "gloves",
  "boots",
  "ring",
  "amulet",
  "potion",
  "gem",
];

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

/**
 * Per-skill modifier (wave A: talents, later sets/runes). Applied by
 * classic.combat to the matching skills of the unit that owns it (heroes
 * only, through the BonusStats component; read with bonus.ts skillModsOf).
 */
export type SkillModField =
  /** % more damage of the skill (all elements, weapon and flat parts). */
  | "damagePct"
  /** % mana cost change (negative = cheaper), floor 0. rules.effectiveManaCost. */
  | "manaCostPct"
  /** % cooldown change (negative = shorter), floor 0. rules.effectiveCooldown. */
  | "cooldownPct"
  /** % faster cast/attack of this skill (added to the speed stat it scales with). */
  | "speedPct"
  /** % larger radius (nova, aoeTarget, pulse, self radius) and arc reach. */
  | "radiusPct"
  /** + projectiles (count). */
  | "extraProjectiles"
  /** + pierce per projectile. */
  | "extraPierce"
  /** + chain bounces. */
  | "extraBounces"
  /** % longer status / buff / summon duration. */
  | "durationPct"
  /** + summons alive (max) and per cast (count). */
  | "extraSummons";

export interface SkillModifier {
  /**
   * Which skills: an exact skill id ("classic.skill.cleave"), "*" for every
   * hero skill, or "tag:<SkillTag>" (e.g. "tag:aoe") for skills whose
   * ai.tags contain that tag.
   */
  skill: string;
  field: SkillModField;
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
  // ---- wave A (all optional: items from older saves and fixtures have none) ----
  /** SetItemProto id for rarity "set". */
  set?: string;
  /**
   * Sockets: one entry per socket, the socketed gem's ItemBaseProto id or
   * null when empty. Absent = no sockets. rules.addItemStats adds gem mods.
   */
  sockets?: (string | null)[];
  /**
   * Durability (equipment only; absent = full and never wears until
   * classic.items gives it one). cur 0 = broken: rules.addItemStats and
   * progression.stats ignore the item (no stats, no base damage/armor).
   */
  dur?: { cur: number; max: number };
  /** Smith upgrade level 0..EconomyProto.upgrade.maxLevel (rules.upgradeMods adds its bonus). */
  upgrade?: number;
  /** Times the smith rerolled this item (reroll price scaling). */
  rerolls?: number;
  /** Stash tab index while the item lies in the stash (absent = 0). Removed when taken out. */
  tab?: number;
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
  /**
   * Party (docs/design/party.md §6.3): where the party AI places this class.
   * "front" = melee line next to the leader's facing, "back" = ranged/caster
   * line behind. Optional: absent = "front". Patched in by classic.party.
   */
  partyRole?: PartyRole;
}

/** Formation line of a party member (ClassProto.partyRole, PartyMember.role). */
export type PartyRole = "front" | "back";

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
  /**
   * Heals the caster. Party (docs/design/party.md §6.5): with `allyRadius`
   * (sub) the same amount also heals every living hero-team unit within that
   * radius of the caster (party members, never monsters). Optional field.
   */
  heal?: { pct: number; pctPerRank: number; flat: number; allyRadius?: number };
  /** Status applied to the caster (and hero-team allies in radius when `radius` is set). */
  buff?: { status: string; duration: number; power: number; powerPerRank: number };
  pulse?: { count: number; every: number };
  /**
   * Wave A (monster/boss skills): the area does not hit when the cast fires;
   * classic.combat places a telegraph (GroundEffect with `once`) that shows
   * the danger zone for `ticks` and then hits every enemy still inside it.
   * Shapes: circle (nova: around the caster; aoeTarget: at the target point;
   * radius = skill radius), cone (arc: caster facing, half-width `arc`,
   * length = range), line (dash: from caster to target, width `width` sub,
   * length = dash.maxRange; the caster dashes when it fires).
   * `count` (circle + aoeTarget only, default 1): that many circles, the first
   * on the target point and the others at ctx.rng points within 3 tiles of it.
   */
  telegraph?: { ticks: number; shape: "circle" | "cone" | "line"; width?: number; count?: number };
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
  /**
   * Wave A boss encounters: phases entered once each, in order, when life
   * falls to or below `atPct` of max. Entering a phase: emits
   * classic.boss.phase (with `message`), optionally summons minions, applies
   * the enrage status (StatusProto "classic.status.enrage", power = enragePct)
   * and from then on the boss may use `skills` (added to its rotation).
   */
  phases?: {
    atPct: number;
    message: string;
    skills: string[];
    summon: boolean;
    enragePct: number;
  }[];
  /** Rift guardians only (RiftProto.guardians): spawned when the rift progress bar fills. */
  guardian?: boolean;
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
  // ---- wave A ----
  /** Gems only (category "gem"): what a socketed gem adds, by the host item's group (rules.socketGroup). */
  gem?: {
    kind: GemKind;
    /** 1 (chipped) .. 5 (radiant). Three of tier t combine into one of tier t+1 (smith). */
    tier: number;
    weapon: StatMod[];
    armor: StatMod[];
    jewelry: StatMod[];
  };
  /** Max sockets; absent = rules.maxSocketsOf default by category. */
  maxSockets?: number;
  /** Max durability; absent = rules.maxDurabilityOf default by category (0 = indestructible). */
  durability?: number;
}

export type GemKind = "ruby" | "sapphire" | "topaz" | "emerald" | "amethyst" | "diamond";
export const GEM_KINDS: readonly GemKind[] = [
  "ruby",
  "sapphire",
  "topaz",
  "emerald",
  "amethyst",
  "diamond",
];

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

/** "gambler" (wave A): sells unidentified items by category (classic.gamble). */
export type NpcRole = "healer" | "smith" | "alchemist" | "junk" | "quest" | "gambler";

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
  /** Gambler only: categories offered (prices: EconomyProto.gamble). */
  gamble?: { categories: ItemCategory[] };
  /** Smith only (wave A): offers the crafting services (repair, upgrade, reroll, sockets, gems). */
  crafts?: boolean;
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
  /**
   * Fallback model only: the share (percent) of the best skill's damage that
   * lands while fighting; the model adds a fixed travel time per kill
   * (offline-idle.md §4.3).
   */
  offlineEfficiencyPct: number;
  /**
   * Offline XP as a percent of the hero's online Idle XP rate (default 20;
   * docs/design/offline-idle.md §3). An admin overrides it at runtime through
   * the tunable "classic.offlineXpPct": the server puts the effective value in
   * the offline action's payload (`xpPct`), so replay stays deterministic.
   */
  offlineXpPct: number;
  /** Offline gold (loot pickups + junk sales) as a percent of the online rate (100). */
  offlineGoldPct: number;
  /** Offline items kept to the stash as a percent of the base rule (100). */
  offlineItemPct: number;
  /**
   * Fallback model only (hero with too little measured Auto/Idle play): the
   * model's XP is scaled by this percent to approximate the online Idle rate
   * (measured: online XP is 1.9-2.4x the raw model, offline-idle.md §4).
   */
  offlineModelXpPct: number;
  /**
   * Fallback model only: the model's gold (ground piles + junk sales, no
   * upkeep) is scaled by this percent so it approximates the rate path's net
   * gold (ground + junk − upkeep), offline-idle.md §3, §4.3. Absent = 100.
   */
  offlineModelGoldPct?: number;
  // ---- wave A (optional: defaults in brackets; rules.balanceDefault reads them) ----
  /** Talent points per level gained from level 2 [1]. */
  talentPointsPerLevel?: number;
  /** Stash tabs [1]; each holds stashSize items. */
  stashTabs?: number;
  /** Gem drop chance (percent) by monster rarity [all 0]. */
  gemDrops?: Partial<Record<MonsterRarity, number>>;
  /** Chance (percent) that a dropped normal/magic weapon or armor rolls 1..maxSockets sockets [0]. */
  socketedDropPct?: number;
}

// ---------------------------------------------------------------------------
// Wave A prototypes (docs/design/wave-A.md)
// ---------------------------------------------------------------------------

/** One class's talent tree (KIND.talentTree, id "classic.talents.<class>"). */
export interface TalentTreeProto {
  name: string;
  /** ClassProto id. */
  classId: string;
  /** A node of tier t needs t x tierPoints points spent in this tree. */
  tierPoints: number;
  /** Branch names, by TalentNodeProto.col (0..branches.length-1), for the panel headers. */
  branches: string[];
  /** Every node id of the tree (panel order). */
  nodes: string[];
  /**
   * Auto/Idle allocation order (node ids, may repeat a node to give it more
   * ranks): classic.talents spends each point on the first entry that is
   * learnable now, scanning from the start.
   */
  autoOrder: string[];
}

/** A passive talent (KIND.talent). Effects are per rank: rank r gives r x perRank. */
export interface TalentNodeProto {
  name: string;
  /** Player text; "{v}" is replaced by the per-rank total of the first effect. */
  description: string;
  /** Logical icon id "icon.talent.<name>" (HUD draws an inline glyph when missing). */
  icon: string;
  /** TalentTreeProto id. */
  tree: string;
  /** Row 0..4. */
  tier: number;
  /** Column (branch index). */
  col: number;
  maxRank: number;
  /** Node that needs at least one rank first (same tree), or null. */
  requires: string | null;
  perRank: { stats: StatMod[]; skills: SkillModifier[] };
}

/** An item set (KIND.set). */
export interface SetProto {
  name: string;
  /** ClassProto id the set is themed for (drops for anyone), or null. */
  classId: string | null;
  /** SetItemProto ids, in display order. */
  pieces: string[];
  /** Bonuses by number of DIFFERENT pieces equipped (count >= 2), ascending. */
  bonuses: { count: number; mods: StatMod[] }[];
}

/** One set piece (KIND.setItem). Rolled like a unique: fixed base, ranged mods. */
export interface SetItemProto {
  name: string;
  /** SetProto id. */
  set: string;
  /** ItemBaseProto id. */
  base: string;
  ilvl: number;
  mods: { stat: StatId; min: number; max: number }[];
  weight: number;
}

/**
 * Every gold sink price (KIND.economy, id ECONOMY_ID). All prices are gold
 * integers; "Pct" prices are percent of rules.itemValue / ItemInstance.value.
 */
export interface EconomyProto {
  repair: {
    /** Full repair of an item costs value x fullPct% (pro rata of missing durability), min 1. */
    fullPct: number;
    /** Every `everyKills` hero kills the weapon and one random worn armor piece lose 1 durability. */
    everyKills: number;
    /** Hero death: every equipped item loses this % of its max durability. */
    deathLossPct: number;
  };
  upgrade: {
    maxLevel: number;
    /** Cost of upgrading level L -> L+1 = value x costPct[L]%. */
    costPct: number[];
    /** Success chance % of upgrading L -> L+1 (failure spends the gold, keeps the item). */
    chancePct: number[];
  };
  reroll: {
    /** value x basePct% x (1 + rerolls); magic and rare only. */
    basePct: number;
  };
  sockets: {
    /** Cost of adding socket n (index = current socket count). */
    addCost: number[];
    /** Removing all gems (they return to the bag): flat cost. */
    unsocketCost: number;
    /** Combining three gems of tier t: combineCost[t - 1]. */
    combineCost: number[];
  };
  gamble: {
    /** Price = base x (100 + perLevelPct x heroLevel)%, by category (missing category = not offered). */
    base: Partial<Record<ItemCategory, number>>;
    perLevelPct: number;
    /** Rarity weights of gambled items. */
    weights: Record<ItemRarity, number>;
  };
  /** Talent reset: perLevel x hero level. */
  talentResetPerLevel: number;
}

/** The endless Rift (KIND.rift, id RIFT_ID). See docs/design/wave-A.md §Rift. */
export interface RiftProto {
  /** Unlocked once this boss depth is in DungeonState.bossesKilled (16 = the Hollow King). */
  unlockBossDepth: number;
  /** Square map size in tiles. */
  size: number;
  rooms: [number, number];
  roomSize: [number, number];
  packs: [number, number];
  /** Progress points per kill by monster rarity; the guardian spawns at `goal`. */
  progress: Record<MonsterRarity, number>;
  goal: number;
  /** Time limit (ticks); a run over it can still finish but scores no time bonus and gives half rewards. */
  timeLimit: number;
  /** Guardian monster ids, cycled by rift level (level % length). */
  guardians: string[];
  /** Entry fee = feeBase + feePerLevel x level (gold sink). */
  feeBase: number;
  feePerLevel: number;
  reward: {
    goldPerLevel: number;
    /** Items granted on completion: items + floor(level / bonusEvery). */
    items: number;
    bonusEvery: number;
    minRarity: ItemRarity;
  };
  /** Theme ids cycled by rift level. */
  themes: string[];
}

/** What an achievement counts (classic.achievements reads it from the world, see wave-A.md §Achievements). */
export type AchievementMetric =
  | "kills"
  | "championKills"
  | "uniqueKills"
  | "bossKills"
  | "level"
  | "deepest"
  | "goldEarned"
  | "goldSpent"
  | "itemsFound"
  | "uniquesFound"
  | "setItemsFound"
  | "setComplete"
  | "questsCompleted"
  | "potionsUsed"
  | "itemsCrafted"
  | "gemsSocketed"
  | "gambles"
  | "talentPoints"
  | "riftLevel"
  | "riftsCompleted"
  | "playMinutes";

export interface AchievementProto {
  name: string;
  description: string;
  icon: string;
  metric: AchievementMetric;
  /** Unlocked when the metric reaches this value. */
  target: number;
  /** Gold granted on unlock (via grantGold) and an optional title shown in the character panel. */
  reward: { gold: number; title: string | null };
  /** Hidden until unlocked (name shows as "???"). */
  hidden: boolean;
  /** Panel sort order. */
  order: number;
}

// ---------------------------------------------------------------------------
// Party (docs/design/party.md)
// ---------------------------------------------------------------------------

/**
 * Party rules (KIND.party, id PARTY_ID), defined by classic.party. Every
 * "per size" table has PARTY_MAX entries indexed by party size - 1, and its
 * first entry is the identity (100 / 0) so a party of one plays exactly like
 * the solo game. Read through rules.partyProtoOf / rules.partyScale.
 */
export interface PartyProto {
  /** Hard cap of party members (4). */
  maxMembers: number;
  /** Slot k+2 (k = 0, 1, 2) unlocks for free once the boss of unlockBossDepths[k] is killed (DungeonState.bossesKilled). */
  unlockBossDepths: number[];
  /** Gold price of slot k+2 when bought before its boss (classic.party.buySlot, town). */
  slotPrices: number[];
  /** A recruit starts at max(1, highest member level - recruitLevelGap). */
  recruitLevelGap: number;
  /** Recruit fee = recruitFeePerLevel x the recruit's start level (level 1 recruits cost this much). */
  recruitFeePerLevel: number;
  /** Monster life %, by party size (applied at spawn). */
  monsterLifePct: number[];
  /** Monster damage % (CombatStats dmgMin/dmgMax and flat element adds), by party size. */
  monsterDamagePct: number[];
  /** Monster.xp % (the pool a kill is worth), by party size. */
  monsterXpPct: number[];
  /** Share of a kill's XP (after xpForKill for the member's own level) each living member gets, by party size. */
  xpSharePct: number[];
  /** Item drop count % and gold pile % (classic.items.drops), by party size. */
  lootPct: number[];
  /** Monsters per pack % (classic.world population), by party size. */
  densityPct: number[];
  /** Ticks a reviver channels next to a downed ally (60 = 3 s). */
  reviveTicks: number;
  /** Max distance (sub) between reviver and the downed ally while channelling. */
  reviveRange: number;
  /** Life and mana % a revived member comes back with. */
  reviveLifePct: number;
  /** Followers farther than this (sub) from the leader drop what they do and regroup; farther than leashTeleport they are placed next to the leader. */
  leashRange: number;
  leashTeleport: number;
}

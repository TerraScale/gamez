/**
 * Minimal test content (architect-owned, read-only for builders): one of
 * every registry kind, so module unit tests do not depend on the real
 * classic.content data. Use with harness.ts `testSim([...], { content: "test" })`.
 * Do not combine with classic.content (both define the balance + town theme).
 */
import { defineModule, type Registry } from "@gamez/kernel";
import {
  BALANCE_ID,
  KIND,
  NAMES_RARE_ITEM,
  NAMES_UNIQUE_MONSTER,
  type AffixProto,
  type BalanceProto,
  type ClassProto,
  type ItemBaseProto,
  type MonsterModProto,
  type MonsterProto,
  type NameTableProto,
  type NpcProto,
  type QuestProto,
  type SkillProto,
  type StatusProto,
  type ThemeProto,
  type UniqueProto,
} from "../../src/types.ts";

export const TEST_BALANCE: BalanceProto = {
  maxLevel: 60,
  statPointsPerLevel: 5,
  skillPointsPerLevel: 1,
  xpA: 50,
  xpB: 50,
  xpGrace: 5,
  xpPenaltyPct: 15,
  xpMinPct: 5,
  deathGoldLossPct: 10,
  deathXpLossPct: 5,
  respawnDelay: 60,
  corpseTicks: 40,
  potionCooldown: 20,
  beltSlots: 4,
  beltStack: 5,
  invCols: 10,
  invRows: 4,
  stashSize: 50,
  tpScrollPrice: 50,
  maxTpScrolls: 10,
  levelWidth: 64,
  levelHeight: 64,
  rooms: [6, 9],
  roomSize: [5, 10],
  packs: [8, 12],
  maxMonstersPerLevel: 120,
  championPackChancePct: 15,
  uniquePacksPerLevel: [1, 1],
  sleepRange: 20 * 256,
  lightRadius: 8,
  rarityWeights: { normal: 600, magic: 300, rare: 90, unique: 10 },
  drops: {
    normal: { item: 15, items: [1, 1], gold: 45, potion: 12 },
    minion: { item: 20, items: [1, 1], gold: 50, potion: 12 },
    champion: { item: 60, items: [1, 2], gold: 80, potion: 30 },
    unique: { item: 100, items: [2, 3], gold: 100, potion: 50 },
    boss: { item: 100, items: [4, 6], gold: 100, potion: 100 },
    summon: { item: 0, items: [0, 0], gold: 0, potion: 0 },
  },
  goldPerLevel: [3, 8],
  vendorItems: 8,
  offlineCapMs: 8 * 3600 * 1000,
  offlineEfficiencyPct: 35,
};

const skill = (
  p: Partial<SkillProto> & Pick<SkillProto, "name" | "shape" | "target">,
): SkillProto => ({
  description: p.name,
  icon: "icon.skill.test",
  users: "hero",
  reqLevel: 1,
  maxRank: 20,
  range: 0,
  manaCost: 0,
  manaPerRank: 0,
  cooldown: 0,
  castTicks: 10,
  hitTick: 5,
  speedStat: "attack",
  weaponPct: 0,
  weaponPctPerRank: 0,
  damage: null,
  scaling: null,
  canMiss: false,
  effect: "fx.test",
  ai: { tags: ["single"], priority: 1 },
  ...p,
});

export const TEST_SKILLS: Record<string, SkillProto> = {
  "test.skill.strike": skill({
    name: "Strike",
    shape: "melee",
    target: "enemy",
    weaponPct: 100,
    canMiss: true,
    ai: { tags: ["basic", "melee", "single"], priority: 0 },
  }),
  "test.skill.bolt": skill({
    name: "Bolt",
    shape: "projectile",
    target: "point",
    range: 10 * 256,
    manaCost: 3,
    speedStat: "cast",
    damage: { element: "fire", min: 6, max: 10, minPerRank: 2, maxPerRank: 3 },
    scaling: "mag",
    projectile: {
      speed: 64,
      count: 1,
      spread: 0,
      pierce: 0,
      radius: 64,
      maxRange: 10 * 256,
      sprite: "fx.test",
    },
    ai: { tags: ["ranged", "single"], priority: 5 },
  }),
  "test.skill.nova": skill({
    name: "Nova",
    shape: "nova",
    target: "self",
    manaCost: 8,
    cooldown: 40,
    speedStat: "cast",
    radius: 3 * 256,
    damage: { element: "cold", min: 5, max: 8, minPerRank: 2, maxPerRank: 2 },
    scaling: "mag",
    status: { id: "test.status.chill", chancePct: 100, duration: 60, power: 40, powerPerRank: 0 },
    ai: { tags: ["aoe", "control"], priority: 6, minTargets: 2 },
  }),
  "test.skill.mend": skill({
    name: "Mend",
    shape: "self",
    target: "self",
    manaCost: 10,
    cooldown: 100,
    speedStat: "cast",
    heal: { pct: 25, pctPerRank: 2, flat: 10 },
    ai: { tags: ["heal"], priority: 9 },
  }),
  "test.mskill.bite": skill({
    name: "Bite",
    users: "monster",
    shape: "melee",
    target: "enemy",
    weaponPct: 100,
    canMiss: true,
    ai: { tags: ["basic", "melee"], priority: 0 },
  }),
  "test.mskill.arrow": skill({
    name: "Arrow",
    users: "monster",
    shape: "projectile",
    target: "enemy",
    range: 8 * 256,
    weaponPct: 100,
    canMiss: true,
    projectile: {
      speed: 56,
      count: 1,
      spread: 0,
      pierce: 0,
      radius: 64,
      maxRange: 9 * 256,
      sprite: "fx.arrow",
    },
    ai: { tags: ["basic", "ranged"], priority: 0 },
  }),
};

const STATUSES: Record<string, StatusProto> = {
  "test.status.chill": {
    name: "Chilled",
    kind: "slow",
    stacks: false,
    icon: "icon.status.chill",
    tint: 0x7fd4ff,
  },
  "test.status.burn": {
    name: "Burning",
    kind: "dot",
    element: "fire",
    every: 10,
    stacks: false,
    icon: "icon.status.burn",
    tint: 0xff8a3d,
  },
  "test.status.stun": {
    name: "Stunned",
    kind: "stun",
    stacks: false,
    icon: "icon.status.stun",
    tint: 0,
  },
  "test.status.rally": {
    name: "Rallied",
    kind: "buff",
    mods: [
      { stat: "dmgPct", perPower: 1 },
      { stat: "armorPct", perPower: 1 },
    ],
    stacks: false,
    icon: "icon.status.rally",
    tint: 0,
  },
};

export const TEST_CLASS: ClassProto = {
  name: "Fighter",
  description: "Test class",
  appearance: "unit.hero.fighter",
  tint: 0xffffff,
  base: { str: 20, dex: 20, mag: 20, vit: 20 },
  life: { base: 40, perVit: 2, perLevel: 2 },
  mana: { base: 10, perMag: 1, perLevel: 1 },
  primary: "str",
  autoAlloc: { str: 2, dex: 1, mag: 0, vit: 2 },
  skills: ["test.skill.strike", "test.skill.bolt", "test.skill.nova", "test.skill.mend"],
  startingSkills: ["test.skill.strike", "test.skill.bolt"],
  defaultBar: ["test.skill.strike", "test.skill.bolt", null, null, null, null],
  autoSkillOrder: ["test.skill.nova", "test.skill.bolt", "test.skill.mend"],
  starterItems: ["test.item.sword"],
  starterPotions: [{ base: "test.item.potion.life", count: 3 }],
  moveSpeed: 51,
};

const monster = (
  p: Partial<MonsterProto> & Pick<MonsterProto, "name" | "behaviour">,
): MonsterProto => ({
  family: "test",
  description: p.name,
  appearance: "unit.monster.test",
  fallbackAppearance: "unit.hero",
  tint: 0x88ff88,
  scale: 100,
  life: 20,
  armor: 5,
  toHit: 20,
  dmgMin: 1,
  dmgMax: 3,
  element: "phys",
  resist: { fire: 0, cold: 0, lightning: 0, poison: 0 },
  xp: 10,
  moveSpeed: 40,
  radius: 80,
  skills: ["test.mskill.bite"],
  aggroRange: 8 * 256,
  keepDistance: 0,
  packSize: [2, 4],
  themes: ["test.theme"],
  minDepth: 1,
  weight: 10,
  ...p,
});

const MONSTERS: Record<string, MonsterProto> = {
  "test.monster.dummy": monster({ name: "Dummy", behaviour: "rusher" }),
  "test.monster.archer": monster({
    name: "Archer",
    behaviour: "archer",
    skills: ["test.mskill.arrow"],
    keepDistance: 5 * 256,
  }),
  "test.monster.boss": monster({
    name: "Big Dummy",
    behaviour: "boss",
    life: 300,
    themes: [],
    boss: { depth: 4, title: "the Test", minions: "test.monster.dummy", minionCount: 2 },
  }),
};

const MOD: MonsterModProto = {
  name: "Mighty",
  lifePct: 0,
  dmgPct: 100,
  speedPct: 0,
  armorPct: 0,
  lifeStealPct: 0,
  blinkEvery: 0,
  extraProjectiles: 0,
  resistAll: 0,
  tint: 0xff4444,
  minDepth: 1,
};

const base = (
  p: Partial<ItemBaseProto> & Pick<ItemBaseProto, "name" | "category" | "slots">,
): ItemBaseProto => ({
  size: { w: 1, h: 1 },
  icon: "icon.item.test",
  ilvl: 1,
  reqLevel: 1,
  reqStr: 0,
  reqDex: 0,
  implicit: [],
  value: 10,
  dropWeight: 10,
  ...p,
});

const ITEMS: Record<string, ItemBaseProto> = {
  "test.item.sword": base({
    name: "Test Sword",
    category: "weapon",
    slots: ["weapon"],
    weaponClass: "sword",
    size: { w: 1, h: 3 },
    dmgMin: 2,
    dmgMax: 6,
    attackTicks: 12,
    range: 400,
    value: 30,
  }),
  "test.item.cap": base({
    name: "Test Cap",
    category: "helm",
    slots: ["helm"],
    size: { w: 2, h: 2 },
    armor: 4,
  }),
  "test.item.ring": base({
    name: "Test Ring",
    category: "ring",
    slots: ["ring1", "ring2"],
    value: 50,
  }),
  "test.item.potion.life": base({
    name: "Test Life Potion",
    category: "potion",
    slots: [],
    value: 25,
    potion: { kind: "life", amount: 50, pct: 0, tier: 1 },
  }),
  "test.item.potion.mana": base({
    name: "Test Mana Potion",
    category: "potion",
    slots: [],
    value: 30,
    potion: { kind: "mana", amount: 30, pct: 0, tier: 1 },
  }),
};

const AFFIXES: Record<string, AffixProto> = {
  "test.affix.life.1": {
    name: "Sturdy",
    kind: "prefix",
    group: "life",
    stat: "life",
    min: 5,
    max: 10,
    ilvl: 1,
    categories: ["helm", "ring", "weapon"],
    weight: 10,
  },
  "test.affix.str.1": {
    name: "of Might",
    kind: "suffix",
    group: "str",
    stat: "str",
    min: 1,
    max: 3,
    ilvl: 1,
    categories: ["helm", "ring", "weapon"],
    weight: 10,
  },
};

const UNIQUE: UniqueProto = {
  name: "Test Band",
  base: "test.item.ring",
  ilvl: 1,
  mods: [{ stat: "allAttrs", min: 2, max: 4 }],
  weight: 1,
  flavor: "For tests.",
};

const npc = (role: NpcProto["role"], extra: Partial<NpcProto> = {}): NpcProto => ({
  name: `Test ${role}`,
  title: role,
  role,
  appearance: `unit.npc.${role}`,
  fallbackAppearance: "unit.hero",
  tint: 0xffffff,
  buyPct: 0,
  greeting: "Hello.",
  ...extra,
});

const NPCS: Record<string, NpcProto> = {
  "test.npc.healer": npc("healer"),
  "test.npc.smith": npc("smith", {
    sells: { categories: ["weapon", "helm"], count: 4, potions: [], tpScroll: false },
  }),
  "test.npc.alchemist": npc("alchemist", {
    sells: {
      categories: [],
      count: 0,
      potions: ["test.item.potion.life", "test.item.potion.mana"],
      tpScroll: true,
    },
  }),
  "test.npc.junk": npc("junk", { buyPct: 10 }),
  "test.npc.quest": npc("quest"),
};

const QUEST: QuestProto = {
  name: "Test Hunt",
  description: "Kill 3 dummies.",
  giver: "test.npc.quest",
  kind: "killMonsters",
  target: "test.monster.dummy",
  count: 3,
  reqLevel: 1,
  after: "",
  reward: { gold: 100, xp: 50, item: null },
};

const theme = (name: string, tier: number, monsters: string[]): ThemeProto => ({
  name,
  tier,
  floor: ["tile.dungeon.floor"],
  wall: "wall.dungeon",
  door: "prop.door",
  stairsDown: "prop.stairs.down",
  stairsUp: "prop.stairs.up",
  waypoint: "prop.waypoint",
  decor: ["prop.barrel"],
  monsters,
  darkness: 50,
});

const NAMES: NameTableProto = { first: ["Grim", "Pale"], second: ["Fang", "Shade"] };

function defineAll<T extends object>(reg: Registry, kind: string, table: Record<string, T>): void {
  for (const id of Object.keys(table).sort()) reg.define(kind, id, table[id]!);
}

export const testContent = defineModule({
  id: "test.content",
  version: "0.0.1",
  data(reg) {
    reg.define(KIND.balance, BALANCE_ID, TEST_BALANCE);
    reg.define(KIND.class, "test.class.fighter", TEST_CLASS);
    defineAll(reg, KIND.skill, TEST_SKILLS);
    defineAll(reg, KIND.status, STATUSES);
    defineAll(reg, KIND.monster, MONSTERS);
    reg.define(KIND.monsterMod, "test.mod.mighty", MOD);
    defineAll(reg, KIND.itemBase, ITEMS);
    defineAll(reg, KIND.affix, AFFIXES);
    reg.define(KIND.unique, "test.unique.band", UNIQUE);
    defineAll(reg, KIND.npc, NPCS);
    reg.define(KIND.quest, "test.quest.hunt", QUEST);
    reg.define(KIND.theme, "classic.theme.town", {
      ...theme("Town", 0, []),
      floor: ["tile.grass"],
    });
    reg.define(
      KIND.theme,
      "test.theme",
      theme("Test Halls", 0, ["test.monster.dummy", "test.monster.archer"]),
    );
    reg.define(KIND.names, NAMES_UNIQUE_MONSTER, NAMES);
    reg.define(KIND.names, NAMES_RARE_ITEM, NAMES);
  },
});

/**
 * Shared fixture of the wave A item HUD tests (T-items-hud): a sim with every
 * classic module, the minimal test content, and an extra content module that
 * adds the economy, two gems, a two-piece set, a smith, a gambler and four
 * stash tabs. Only the item HUD tests use it; nothing here touches src/.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type LoadedMode,
  type Sim,
  type World,
} from "@gamez/kernel";
import { modules as classicModules } from "../src/index.ts";
import { AreaTag, Equipment, Inventory, Loot, Npc, Pos } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { RES, type LootFilter, type StashState } from "../src/resources.ts";
import {
  BALANCE_ID,
  ECONOMY_ID,
  KIND,
  type BalanceProto,
  type EconomyProto,
  type EquipSlot,
  type ItemBaseProto,
  type ItemInstance,
  type NpcProto,
  type SetItemProto,
  type SetProto,
} from "../src/types.ts";
import { ensureResources, spawnTestHero } from "./support/harness.ts";
import { testContent } from "./support/content.ts";

export const ECON: EconomyProto = {
  repair: { fullPct: 100, everyKills: 10, deathLossPct: 10 },
  upgrade: { maxLevel: 3, costPct: [100, 150, 200], chancePct: [90, 60, 30] },
  reroll: { basePct: 50 },
  sockets: { addCost: [100, 200, 300], unsocketCost: 40, combineCost: [60, 120, 240, 480] },
  gamble: {
    base: { weapon: 200, ring: 100 },
    perLevelPct: 10,
    weights: { normal: 1, magic: 1, rare: 1, set: 0, unique: 0 },
  },
  talentResetPerLevel: 10,
};

const base = (
  over: Partial<ItemBaseProto> & Pick<ItemBaseProto, "name" | "category">,
): ItemBaseProto => ({
  slots: [],
  size: { w: 1, h: 1 },
  icon: "icon.item.missing",
  ilvl: 1,
  reqLevel: 1,
  reqStr: 0,
  reqDex: 0,
  implicit: [],
  value: 30,
  dropWeight: 0,
  ...over,
});

export const GEM_RUBY_1 = "test.item.gem_ruby_1";
export const GEM_RUBY_2 = "test.item.gem_ruby_2";
export const GEM_TOPAZ_1 = "test.item.gem_topaz_1";
export const GEM_RUBY_5 = "test.item.gem_ruby_5";
export const SMITH = "test.npc.forge";
export const GAMBLER = "test.npc.gambler";
export const JUNK = "test.npc.junk"; // defined by the test content
export const OAK_STAFF = "test.setItem.oak_staff";
export const OAK_CAP = "test.setItem.oak_cap";
export const OAK_SET = "test.set.oak";

const ITEMS_EXTRA: Record<string, ItemBaseProto> = {
  [GEM_RUBY_1]: base({
    name: "Chipped Ruby",
    category: "gem",
    size: { w: 1, h: 1 },
    icon: "icon.item.gem",
    value: 20,
    gem: {
      kind: "ruby",
      tier: 1,
      weapon: [{ stat: "fireDmg", value: 3 }],
      armor: [{ stat: "life", value: 10 }],
      jewelry: [{ stat: "resFire", value: 5 }],
    },
  }),
  [GEM_RUBY_2]: base({
    name: "Flawed Ruby",
    category: "gem",
    size: { w: 1, h: 1 },
    icon: "icon.item.gem",
    value: 60,
    gem: { kind: "ruby", tier: 2, weapon: [{ stat: "fireDmg", value: 6 }], armor: [], jewelry: [] },
  }),
  [GEM_TOPAZ_1]: base({
    name: "Chipped Topaz",
    category: "gem",
    size: { w: 1, h: 1 },
    icon: "icon.item.gem",
    value: 20,
    gem: {
      kind: "topaz",
      tier: 1,
      weapon: [{ stat: "lightningDmg", value: 2 }],
      armor: [],
      jewelry: [],
    },
  }),
  [GEM_RUBY_5]: base({
    name: "Radiant Ruby",
    category: "gem",
    size: { w: 1, h: 1 },
    icon: "icon.item.gem",
    value: 900,
    gem: {
      kind: "ruby",
      tier: 5,
      weapon: [{ stat: "fireDmg", value: 40 }],
      armor: [],
      jewelry: [],
    },
  }),
};

const SETS_EXTRA: Record<string, SetItemProto> = {
  [OAK_STAFF]: {
    name: "Oak Staff of Ash",
    set: OAK_SET,
    base: "test.item.sword",
    ilvl: 1,
    mods: [{ stat: "dmgPct", min: 10, max: 20 }],
    weight: 1,
  },
  [OAK_CAP]: {
    name: "Oak Cap of Ash",
    set: OAK_SET,
    base: "test.item.cap",
    ilvl: 1,
    mods: [{ stat: "armor", min: 3, max: 5 }],
    weight: 1,
  },
};

const SET_EXTRA: Record<string, SetProto> = {
  [OAK_SET]: {
    name: "Ash Circle",
    classId: null,
    pieces: [OAK_STAFF, OAK_CAP],
    bonuses: [{ count: 2, mods: [{ stat: "str", value: 5 }] }],
  },
};

const NPCS_EXTRA: Record<string, NpcProto> = {
  [SMITH]: {
    name: "Forge Master",
    title: "Smith",
    role: "smith",
    appearance: "unit.npc.smith",
    fallbackAppearance: "unit.npc.smith",
    tint: 0xffffff,
    buyPct: 0,
    greeting: "Bring me your steel.",
    crafts: true,
    sells: { categories: ["weapon"], count: 2, potions: [], tpScroll: false },
  },
  [GAMBLER]: {
    name: "Mirelle Quickhand",
    title: "Gambler",
    role: "gambler",
    appearance: "unit.npc.gambler",
    fallbackAppearance: "unit.npc.gambler",
    tint: 0xffffff,
    buyPct: 0,
    greeting: "Feeling lucky?",
    gamble: { categories: ["weapon", "ring"] },
  },
};

/** Extra content for the item HUD tests (economy, gems, a set, NPCs, four stash tabs). */
export const itemsHudContent = defineModule({
  id: "items-hud.content",
  version: "0.0.1",
  data(reg) {
    reg.define(KIND.economy, ECONOMY_ID, ECON);
    for (const id of Object.keys(ITEMS_EXTRA).sort())
      reg.define(KIND.itemBase, id, ITEMS_EXTRA[id]!);
    for (const id of Object.keys(SETS_EXTRA).sort()) reg.define(KIND.setItem, id, SETS_EXTRA[id]!);
    for (const id of Object.keys(SET_EXTRA).sort()) reg.define(KIND.set, id, SET_EXTRA[id]!);
    for (const id of Object.keys(NPCS_EXTRA).sort()) reg.define(KIND.npc, id, NPCS_EXTRA[id]!);
  },
  dataUpdates(reg) {
    reg.patch<BalanceProto>(KIND.balance, BALANCE_ID, (b) => {
      b.stashTabs = 4;
    });
  },
});

let loaded: LoadedMode | null = null;

function loadedItems(): LoadedMode {
  if (!loaded) {
    const mode = defineMode({
      id: "classic",
      name: "Classic (items test)",
      description: "test",
      world: null,
      modules: [
        ...classicModules.map((m) => m.id).filter((id) => id !== "classic.content"),
        "test.content",
        "items-hud.content",
      ],
      tick: { kind: "fixed", hz: 20 },
    });
    loaded = loadMode(mode, [...classicModules, testContent, itemsHudContent]);
  }
  return loaded;
}

/** A fresh sim of every classic module plus the item HUD content (a new world each call). */
export function itemsSim(seed = 4242): Sim {
  const sim = createSim(loadedItems(), { seed });
  ensureResources(sim.world);
  if (!sim.world.getResource(RES.stash)) {
    sim.world.setResource<StashState>(RES.stash, { items: [] });
  }
  return sim;
}

/** Hero with gold (level 10 unless told otherwise). Returns the hero entity. */
export function spawnHero(world: World, over: { gold?: number; level?: number } = {}): Entity {
  return spawnTestHero(world, { gold: over.gold ?? 1000, level: over.level ?? 10 });
}

export function spawnNpc(world: World, proto: string, x = 6, y = 5): Entity {
  const e = world.create();
  world.add(e, Npc, { proto });
  world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  world.add(e, AreaTag, { depth: 0 });
  return e;
}

export function spawnLoot(
  world: World,
  item: ItemInstance | null,
  kind: "item" | "gold" | "potion" = "item",
  gold = 0,
  depth = 0,
): Entity {
  const e = world.create();
  world.add(e, Loot, { kind, item, gold, potion: "", droppedAt: 0 });
  world.add(e, Pos, { x: tileCenter(3), y: tileCenter(3) });
  world.add(e, AreaTag, { depth });
  return e;
}

export function itemOf(
  uid: number,
  baseId: string,
  over: Partial<ItemInstance> = {},
): ItemInstance {
  return {
    uid,
    base: baseId,
    rarity: "normal",
    ilvl: 5,
    name: baseId.split(".").pop() ?? baseId,
    mods: [],
    affixes: [],
    value: 30,
    ...over,
  };
}

export function setBag(world: World, hero: Entity, items: ItemInstance[]): void {
  world.update(hero, Inventory, {
    items: items.map((item, i) => ({ item, x: i % 10, y: Math.floor(i / 10) * 2 })),
  });
}

export function setWorn(
  world: World,
  hero: Entity,
  worn: Partial<Record<EquipSlot, ItemInstance>>,
): void {
  const cur = world.read(hero, Equipment);
  const next = { ...cur } as Record<EquipSlot, ItemInstance | null>;
  for (const slot of Object.keys(next) as EquipSlot[]) next[slot] = worn[slot] ?? null;
  world.update(hero, Equipment, next);
}

export function setLootFilter(world: World, patch: Partial<LootFilter>): void {
  const base: LootFilter = {
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
  world.setResource<LootFilter>(RES.lootFilter, { ...base, ...patch });
}

/**
 * Gems (wave A, docs/design/wave-A.md §5.2): ItemBaseProto entries with
 * category "gem" and `gem` set, registered under KIND.itemBase. Ids
 * "classic.item.gem_<kind>_<tier>" (tier 1..5). OWNER: T-itemcontent.
 *
 * dropWeight is 0 on purpose: gems come from BalanceProto.gemDrops, and a
 * positive weight would let them into the generic gear pool (items/generate
 * filters bases by dropWeight only, not by category).
 */
import type { GemKind, ItemBaseProto, StatMod } from "../types.ts";
import { GEM_KINDS } from "../types.ts";

const TIER_NAMES = ["Chipped", "Flawed", "Clear", "Flawless", "Radiant"] as const;
const TIER_ILVL = [1, 10, 20, 30, 40] as const;
const TIER_VALUE = [12, 40, 130, 380, 950] as const;

const KIND_NAMES: Record<GemKind, string> = {
  ruby: "Ruby",
  sapphire: "Sapphire",
  topaz: "Topaz",
  emerald: "Emerald",
  amethyst: "Amethyst",
  diamond: "Diamond",
};

/** Mod values per tier (1..5) for each host group. Integers, rising by tier. */
interface GemTable {
  weapon: { stat: StatMod["stat"]; values: readonly number[] };
  armor: { stat: StatMod["stat"]; values: readonly number[] };
  jewelry: { stat: StatMod["stat"]; values: readonly number[] };
}

const TABLES: Record<GemKind, GemTable> = {
  ruby: {
    weapon: { stat: "fireDmg", values: [1, 2, 3, 5, 7] },
    armor: { stat: "life", values: [3, 6, 10, 16, 24] },
    jewelry: { stat: "resFire", values: [4, 7, 10, 14, 18] },
  },
  sapphire: {
    weapon: { stat: "coldDmg", values: [1, 2, 3, 5, 7] },
    armor: { stat: "mana", values: [4, 8, 13, 20, 30] },
    jewelry: { stat: "resCold", values: [4, 7, 10, 14, 18] },
  },
  topaz: {
    weapon: { stat: "lightningDmg", values: [1, 2, 3, 5, 7] },
    armor: { stat: "magicFind", values: [3, 5, 8, 12, 16] },
    jewelry: { stat: "resLightning", values: [4, 7, 10, 14, 18] },
  },
  emerald: {
    weapon: { stat: "poisonDmg", values: [1, 2, 3, 5, 7] },
    armor: { stat: "dex", values: [1, 2, 3, 4, 6] },
    jewelry: { stat: "resPoison", values: [4, 7, 10, 14, 18] },
  },
  amethyst: {
    weapon: { stat: "dmgPct", values: [2, 4, 6, 9, 12] },
    armor: { stat: "armor", values: [3, 6, 10, 16, 24] },
    jewelry: { stat: "str", values: [1, 2, 3, 4, 6] },
  },
  diamond: {
    weapon: { stat: "critPct", values: [1, 2, 3, 4, 6] },
    armor: { stat: "resAll", values: [2, 3, 4, 6, 8] },
    jewelry: { stat: "allAttrs", values: [1, 2, 3, 4, 5] },
  },
};

function gemBase(kind: GemKind, tier: number): ItemBaseProto {
  const t = TABLES[kind];
  const i = tier - 1;
  const mods = (g: GemTable[keyof GemTable]): StatMod[] => [
    { stat: g.stat, value: g.values[i] ?? 0 },
  ];
  const name = `${TIER_NAMES[i]} ${KIND_NAMES[kind]}`;
  return {
    name,
    category: "gem",
    slots: [],
    size: { w: 1, h: 1 },
    icon: "icon.item.gem",
    ilvl: TIER_ILVL[i] ?? 1,
    reqLevel: 1,
    reqStr: 0,
    reqDex: 0,
    implicit: [],
    value: TIER_VALUE[i] ?? 0,
    dropWeight: 0,
    gem: {
      kind,
      tier,
      weapon: mods(t.weapon),
      armor: mods(t.armor),
      jewelry: mods(t.jewelry),
    },
  };
}

function build(): Record<string, ItemBaseProto> {
  const out: Record<string, ItemBaseProto> = {};
  for (const kind of GEM_KINDS) {
    for (let tier = 1; tier <= 5; tier++) {
      out[`classic.item.gem_${kind}_${tier}`] = gemBase(kind, tier);
    }
  }
  return out;
}

export const GEMS: Record<string, ItemBaseProto> = build();

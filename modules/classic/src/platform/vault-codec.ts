/**
 * Classic item <-> account vault item (wave-C.md §2.3). OWNER: T-bridge.
 * Pure and deterministic (sim code rules apply: it runs inside classic.bank).
 *
 * itemToVault(item, registry):
 *   itemId  = item.base (or item.unique when set), count 1, origin "classic",
 *   universal = false (classic gear only returns to classic); gems are
 *   universal=false too in wave C (materials crossing modes come later),
 *   tradable = classicTradable(item),
 *   summary = { name, rarity, level: ilvl, category (weapon/armor/jewelry/gem),
 *              slot, icon: the HUD's logical icon id, lines: <= 8 stat lines },
 *   data = JSON.stringify(item without uid and tab), <= VAULT_ITEM_DATA_MAX.
 * vaultToItem(v, registry, uid): parses data, validates every field strictly
 *   (known base/affix/unique ids, integer ranges, mods shape) and returns the
 *   ItemInstance with `uid`; null when invalid or not of origin "classic".
 * classicTradable(item): the tradable policy hook — every generated item is
 *   tradable in wave C (plan §5 defers bind rules); broken items (dur.cur 0) too.
 *
 * The stat text and the tooltip lines come from client/describe.ts (pure
 * string formatting over prototypes, no DOM): the summary must read exactly
 * like the HUD tooltip, and STAT_TEXT is the one exhaustive list of StatIds.
 */
import type { FrozenRegistry } from "@gamez/kernel";
import {
  VAULT_ITEM_DATA_MAX,
  type ItemCategory as VaultCategory,
  type ItemSummary,
  type VaultItem,
  type VaultItemInput,
} from "@gamez/protocol";
import { itemLines, STAT_TEXT } from "../client/describe.ts";
import {
  ITEM_RARITIES,
  KIND,
  type AffixProto,
  type ItemBaseProto,
  type ItemCategory,
  type ItemInstance,
  type ItemRarity,
  type SetItemProto,
  type StatId,
  type StatMod,
  type UniqueProto,
} from "../types.ts";

/** Origin of every classic vault item. */
export const CLASSIC_ORIGIN = "classic";
/** Summary limits (protocol ItemSummary). */
export const SUMMARY_MAX_LINES = 8;
export const SUMMARY_MAX_CHARS = 60;

/** Bounds of the strict decoder (well above anything the game rolls). */
const LIMITS = {
  nameChars: 80,
  ilvl: 1000,
  mods: 24,
  modValue: 1_000_000,
  affixes: 12,
  value: 1_000_000_000,
  sockets: 8,
  dur: 100_000,
  upgrade: 50,
  rerolls: 100_000,
} as const;

/** Keys an encoded classic item may carry (ItemInstance without uid and tab). */
const DATA_KEYS: ReadonlySet<string> = new Set([
  "base",
  "rarity",
  "ilvl",
  "name",
  "mods",
  "affixes",
  "unique",
  "value",
  "set",
  "sockets",
  "dur",
  "upgrade",
  "rerolls",
]);

const CATEGORY: Record<ItemCategory, VaultCategory> = {
  weapon: "weapon",
  shield: "armor",
  helm: "armor",
  armor: "armor",
  gloves: "armor",
  boots: "armor",
  ring: "jewelry",
  amulet: "jewelry",
  gem: "gem",
  potion: "consumable",
};

const SLOT: Record<ItemCategory, string | null> = {
  weapon: "weapon",
  shield: "offhand",
  helm: "helm",
  armor: "armor",
  gloves: "gloves",
  boots: "boots",
  ring: "ring",
  amulet: "amulet",
  gem: null,
  potion: null,
};

export function classicTradable(_item: ItemInstance): boolean {
  return true;
}

function clip(text: string): string {
  return text.length <= SUMMARY_MAX_CHARS ? text : `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

/** Display data of a classic item (protocol ItemSummary). */
export function classicItemSummary(item: ItemInstance, registry: FrozenRegistry): ItemSummary {
  const base = registry.get<ItemBaseProto>(KIND.itemBase, item.base);
  const cat: ItemCategory = base?.category ?? "armor";
  return {
    name: clip(item.name),
    rarity: item.rarity,
    level: item.ilvl,
    category: CATEGORY[cat],
    slot: SLOT[cat],
    icon: base?.icon ?? "icon.item.missing",
    lines: itemLines(registry, item).slice(0, SUMMARY_MAX_LINES).map(clip),
  };
}

/** The item as stored in VaultItem.data: every field but uid and tab, in a fixed key order. */
function itemData(item: ItemInstance): Omit<ItemInstance, "uid" | "tab"> {
  const out: Omit<ItemInstance, "uid" | "tab"> = {
    base: item.base,
    rarity: item.rarity,
    ilvl: item.ilvl,
    name: item.name,
    mods: item.mods.map((m) => ({ stat: m.stat, value: m.value })),
    affixes: [...item.affixes],
    value: item.value,
  };
  if (item.unique !== undefined) out.unique = item.unique;
  if (item.set !== undefined) out.set = item.set;
  if (item.sockets !== undefined) out.sockets = [...item.sockets];
  if (item.dur !== undefined) out.dur = { cur: item.dur.cur, max: item.dur.max };
  if (item.upgrade !== undefined) out.upgrade = item.upgrade;
  if (item.rerolls !== undefined) out.rerolls = item.rerolls;
  return out;
}

export function itemToVault(item: ItemInstance, registry: FrozenRegistry): VaultItemInput {
  return {
    itemId: item.unique ?? item.base,
    count: 1,
    origin: CLASSIC_ORIGIN,
    universal: false,
    tradable: classicTradable(item),
    summary: classicItemSummary(item, registry),
    data: JSON.stringify(itemData(item)),
  };
}

// ---- strict decoding ---------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
}

function isName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= LIMITS.nameChars;
}

function decodeMods(v: unknown): StatMod[] | null {
  if (!Array.isArray(v) || v.length > LIMITS.mods) return null;
  const out: StatMod[] = [];
  for (const m of v) {
    if (!isRecord(m) || Object.keys(m).length !== 2) return null;
    if (typeof m.stat !== "string" || !Object.hasOwn(STAT_TEXT, m.stat)) return null;
    if (!isInt(m.value, -LIMITS.modValue, LIMITS.modValue)) return null;
    out.push({ stat: m.stat as StatId, value: m.value });
  }
  return out;
}

function decodeIds(v: unknown, max: number, known: (id: string) => boolean): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== "string" || !known(id)) return null;
    out.push(id);
  }
  return out;
}

/**
 * Rebuilds a classic ItemInstance from a vault item, validating every field
 * against the registry; null when anything is off (the bank then refuses).
 */
export function vaultToItem(
  v: VaultItem | VaultItemInput,
  registry: FrozenRegistry,
  uid: number,
): ItemInstance | null {
  if (!isRecord(v) || v.origin !== CLASSIC_ORIGIN || v.count !== 1) return null;
  if (typeof v.data !== "string" || v.data.length > VAULT_ITEM_DATA_MAX) return null;
  if (!Number.isSafeInteger(uid) || uid < 1) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(v.data);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  for (const key of Object.keys(raw)) if (!DATA_KEYS.has(key)) return null;

  if (typeof raw.base !== "string") return null;
  const base = registry.get<ItemBaseProto>(KIND.itemBase, raw.base);
  if (!base) return null;
  if (typeof raw.rarity !== "string" || !ITEM_RARITIES.includes(raw.rarity as ItemRarity)) {
    return null;
  }
  const rarity = raw.rarity as ItemRarity;
  if (!isInt(raw.ilvl, 1, LIMITS.ilvl) || !isName(raw.name)) return null;
  if (!isInt(raw.value, 0, LIMITS.value)) return null;
  const mods = decodeMods(raw.mods);
  if (!mods) return null;
  const affixes = decodeIds(
    raw.affixes,
    LIMITS.affixes,
    (id) => registry.get<AffixProto>(KIND.affix, id) !== undefined,
  );
  if (!affixes) return null;

  const item: ItemInstance = {
    uid,
    base: raw.base,
    rarity,
    ilvl: raw.ilvl,
    name: raw.name,
    mods,
    affixes,
    value: raw.value,
  };
  if (raw.unique !== undefined) {
    if (typeof raw.unique !== "string" || rarity !== "unique") return null;
    const u = registry.get<UniqueProto>(KIND.unique, raw.unique);
    if (!u || u.base !== raw.base) return null;
    item.unique = raw.unique;
  } else if (rarity === "unique") {
    return null;
  }
  if (raw.set !== undefined) {
    if (typeof raw.set !== "string" || rarity !== "set") return null;
    const s = registry.get<SetItemProto>(KIND.setItem, raw.set);
    if (!s || s.base !== raw.base) return null;
    item.set = raw.set;
  }
  if (raw.sockets !== undefined) {
    if (!Array.isArray(raw.sockets) || raw.sockets.length > LIMITS.sockets) return null;
    const sockets: (string | null)[] = [];
    for (const s of raw.sockets) {
      if (s === null) {
        sockets.push(null);
        continue;
      }
      if (typeof s !== "string") return null;
      if (registry.get<ItemBaseProto>(KIND.itemBase, s)?.category !== "gem") return null;
      sockets.push(s);
    }
    item.sockets = sockets;
  }
  if (raw.dur !== undefined) {
    const d = raw.dur;
    if (!isRecord(d) || Object.keys(d).length !== 2) return null;
    if (!isInt(d.max, 1, LIMITS.dur) || !isInt(d.cur, 0, d.max)) return null;
    item.dur = { cur: d.cur, max: d.max };
  }
  if (raw.upgrade !== undefined) {
    if (!isInt(raw.upgrade, 0, LIMITS.upgrade)) return null;
    item.upgrade = raw.upgrade;
  }
  if (raw.rerolls !== undefined) {
    if (!isInt(raw.rerolls, 0, LIMITS.rerolls)) return null;
    item.rerolls = raw.rerolls;
  }
  // The vault's itemId must describe this item (it is what the market indexes).
  if (v.itemId !== (item.unique ?? item.base)) return null;
  return item;
}

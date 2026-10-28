/**
 * Pure helpers of the HUD: number formatting, bar fractions, cooldown sweep,
 * inventory grid occupancy, labels. No React and no DOM, so they are unit-tested.
 */
import {
  hex,
  MONSTER_COLOR,
  RARITY_COLOR,
  type ControlView,
  type MinimapData,
} from "../contract.ts";
import type { Attr, EquipSlot, ItemCategory, ItemRarity, MonsterRarity } from "../../types.ts";
import type { ControlMode, SimSpeed } from "../../resources.ts";
import { isRiftDepth, riftLevelOf } from "../../rules.ts";

export const TICKS_PER_SECOND = 20;
export const SPEEDS: readonly SimSpeed[] = [1, 2, 4, 8];

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/**
 * Player-facing name of a depth: "Town", "Depth 7", or "Rift level 3" for the
 * synthetic rift depths (>= 100 000, rules.riftDepth), which are never shown raw.
 */
export function depthLabel(depth: number): string {
  if (depth === 0) return "Town";
  if (isRiftDepth(depth)) return `Rift level ${fmtInt(riftLevelOf(depth))}`;
  return `Depth ${fmtInt(depth)}`;
}

/** Integer with thousands separators ("12,430"); locale independent. */
export function fmtInt(n: number): string {
  const v = Math.trunc(finite(n));
  const digits = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return v < 0 ? `-${digits}` : digits;
}

/** Signed integer for deltas: "+3", "-2", "0". */
export function fmtSigned(n: number): string {
  const v = Math.trunc(finite(n));
  return v > 0 ? `+${fmtInt(v)}` : fmtInt(v);
}

/** Whole percent points: "35%". */
export function fmtPct(n: number): string {
  return `${Math.round(finite(n))}%`;
}

/** Ticks as a duration, the one format of the HUD: "0s", "0.3s", "4.5s", "12s" (rounded up from 10 s). */
export function fmtDuration(ticks: number): string {
  if (!(ticks > 0)) return "0s";
  const s = ticks / TICKS_PER_SECOND;
  return s < 10 ? `${(Math.round(s * 10) / 10).toFixed(1)}s` : `${Math.ceil(s)}s`;
}

/** Regeneration stored x10 per second: 15 -> "1.5/s". */
export function fmtRegen(x10: number): string {
  return `${(Math.round(finite(x10)) / 10).toFixed(1)}/s`;
}

/** value / max clamped to 0..1 (0 when max is not positive). */
export function fraction(value: number, max: number): number {
  if (!(max > 0)) return 0;
  return clamp(finite(value) / max, 0, 1);
}

export function fillPercent(value: number, max: number): number {
  return fraction(value, max) * 100;
}

/**
 * Degrees of a cooldown sweep still to cover, clockwise from 12 o'clock.
 * cooldownLeft = cooldown -> 360 (full dark disc), 0 -> 0 (no overlay).
 */
export function cooldownSweepDeg(cooldownLeft: number, cooldown: number): number {
  if (!(cooldown > 0) || !(cooldownLeft > 0)) return 0;
  return Math.round(clamp((cooldownLeft / cooldown) * 360, 0, 360));
}

/** Progress from the current level start to the next level, 0..1 (1 at max level). */
export function xpFraction(xp: number, levelStart: number, nextLevel: number): number {
  if (!(nextLevel > levelStart)) return 1;
  return fraction(xp - levelStart, nextLevel - levelStart);
}

/** Bit test of an ExploreArea (1 bit per tile, row-major, 32 tiles per word). */
export function isBitSet(bits: readonly number[], width: number, x: number, y: number): boolean {
  const i = y * width + x;
  return (((bits[i >> 5] ?? 0) >>> (i & 31)) & 1) === 1;
}

export interface Footprint {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bag cell size (px): always 44, the touch target of AGENTS.md §10. On compact
 * layouts the bag does not shrink: its card scrolls horizontally instead.
 */
export const BAG_CELL_PX = 44;

/** Row-major flags of the inventory cells covered by items (cols x rows). */
export function gridOccupancy(cols: number, rows: number, items: readonly Footprint[]): boolean[] {
  const cells = Array.from({ length: Math.max(0, cols * rows) }, () => false);
  for (const it of items) {
    for (let dy = 0; dy < it.h; dy++) {
      for (let dx = 0; dx < it.w; dx++) {
        const cx = it.x + dx;
        const cy = it.y + dy;
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        cells[cy * cols + cx] = true;
      }
    }
  }
  return cells;
}

/** The slot a new item goes to: the first free slot it may use, else its first slot. */
export function pickEquipSlot(
  slots: readonly EquipSlot[],
  equipment: Partial<Record<EquipSlot, unknown>>,
): EquipSlot | null {
  const free = slots.find((s) => equipment[s] === null || equipment[s] === undefined);
  return free ?? slots[0] ?? null;
}

export function controlLabel(mode: ControlMode): string {
  return mode === "manual" ? "Manual" : mode === "auto" ? "Auto" : "Idle";
}

const PLAN_TEXT: Record<ControlView["plan"], string> = {
  none: "Standing by",
  explore: "Exploring",
  fight: "Fighting",
  loot: "Collecting loot",
  recover: "Recovering",
  toTown: "Heading to town",
  town: "In town",
  toDungeon: "Heading to the dungeon",
  descend: "Descending",
  dead: "Dead",
};

export function planLabel(plan: ControlView["plan"]): string {
  return PLAN_TEXT[plan];
}

export const RARITY_LABEL: Record<ItemRarity, string> = {
  normal: "Normal",
  magic: "Magic",
  rare: "Rare",
  set: "Set",
  unique: "Unique",
};

export const ATTR_LABEL: Record<Attr, string> = {
  str: "Strength",
  dex: "Dexterity",
  mag: "Magic",
  vit: "Vitality",
};

export const EQUIP_LABEL: Record<EquipSlot, string> = {
  weapon: "Weapon",
  offhand: "Off hand",
  helm: "Helm",
  armor: "Armor",
  gloves: "Gloves",
  boots: "Boots",
  amulet: "Amulet",
  ring1: "Ring",
  ring2: "Ring",
};

/** Player-facing name of an item category (fallback when an item has no base name). */
export const CATEGORY_LABEL: Record<ItemCategory, string> = {
  weapon: "Weapon",
  shield: "Shield",
  helm: "Helm",
  armor: "Armor",
  gloves: "Gloves",
  boots: "Boots",
  ring: "Ring",
  amulet: "Amulet",
  potion: "Potion",
  gem: "Gem",
};

export function rarityHex(r: ItemRarity): string {
  return hex(RARITY_COLOR[r]);
}

export function monsterHex(r: MonsterRarity): string {
  return hex(MONSTER_COLOR[r]);
}

/**
 * "1 item", "3 items", "2 free cells" (the count is formatted with separators).
 * Use it for every count a panel shows.
 */
export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

export function clampText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export type MinimapDotKind = MinimapData["dots"][number]["kind"];

/** Dot colours of the minimap and the automap legend (0xRRGGBB). */
export const DOT_COLOR: Record<MinimapDotKind, number> = {
  monster: MONSTER_COLOR.normal,
  champion: MONSTER_COLOR.champion,
  boss: MONSTER_COLOR.boss,
  npc: 0xf0c419,
  loot: RARITY_COLOR.magic,
  stairs: 0xffffff,
  waypoint: 0x9fe0a8,
  portal: 0xb388ff,
};

export const DOT_LABEL: Record<MinimapDotKind, string> = {
  monster: "Monster",
  champion: "Champion",
  boss: "Boss",
  npc: "Townsfolk",
  loot: "Loot",
  stairs: "Stairs",
  waypoint: "Waypoint",
  portal: "Portal",
};

export function dotColor(kind: MinimapDotKind): number {
  return DOT_COLOR[kind];
}

/** Casts per second, two decimals: "1.25/s". */
export function fmtPerSecond(n: number): string {
  return `${(Math.round(finite(n) * 100) / 100).toFixed(2)}/s`;
}

/** A rate with one decimal: "4.5/s" (mana per second). */
export function fmtRate(n: number): string {
  return `${(Math.round(finite(n) * 10) / 10).toFixed(1)}/s`;
}

/** Ticks as whole seconds with one decimal: "2.4 s". */
export function fmtSeconds(ticks: number): string {
  return `${(Math.round((finite(ticks) / TICKS_PER_SECOND) * 10) / 10).toFixed(1)} s`;
}

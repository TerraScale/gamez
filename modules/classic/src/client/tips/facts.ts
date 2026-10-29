/**
 * Onboarding tips, step 1: the facts a tip can depend on, read from one HudSnapshot.
 * Pure and small: the tip widget selects this object (shallow-equal), so it re-renders only when
 * a fact changes, not at every 10 Hz snapshot.
 */
import { gridOccupancy } from "../hud/format.ts";
import type { HudSnapshot, ItemView } from "../contract.ts";

export interface TipFacts {
  /** Phase "play" with a living hero. */
  playing: boolean;
  /**
   * Hero tile (whole tiles, floored): a change means the hero walked. Whole tiles keep the facts
   * stable mid-step, so the tip card does not re-render on every snapshot while the hero walks.
   */
  heroX: number;
  heroY: number;
  /** The player took over from Auto/Idle (a click, a cast): control.overridden. */
  overridden: boolean;
  level: number;
  skillPoints: number;
  talentPoints: number;
  isTown: boolean;
  /** Deepest dungeon level reached (0 = never left town). */
  deepest: number;
  /** Some gear is worn (durability below max) or broken, equipped or in the bag. */
  wornGear: boolean;
  /** A set or unique item is equipped or in the bag. */
  setOrUnique: boolean;
  /** Every bag cell is taken. */
  bagFull: boolean;
  bossAlive: boolean;
  riftUnlocked: boolean;
  mode: string;
  speed: number;
}

function wornOf(item: ItemView): boolean {
  if (item.broken) return true;
  return (
    item.durability !== null &&
    item.durability !== undefined &&
    item.durability.cur < item.durability.max
  );
}

function rareOf(item: ItemView): boolean {
  return item.rarity === "set" || item.rarity === "unique";
}

/** The facts of one snapshot. A snapshot without a hero gives the "not playing" facts. */
export function tipFacts(hud: HudSnapshot): TipFacts {
  const hero = hud.hero;
  const bag = hud.inventory.items.map((e) => e.item);
  const worn = Object.values(hud.equipment).filter((i): i is ItemView => i !== null);
  const all = [...worn, ...bag];
  const cells = gridOccupancy(
    hud.inventory.cols,
    hud.inventory.rows,
    hud.inventory.items.map((e) => ({ x: e.x, y: e.y, w: e.item.w, h: e.item.h })),
  );
  return {
    playing: hud.phase === "play" && hero !== null && !hero.dead,
    heroX: Math.floor(hero?.x ?? 0),
    heroY: Math.floor(hero?.y ?? 0),
    overridden: hud.control.overridden,
    level: hero?.level ?? 1,
    skillPoints: hero?.skillPoints ?? 0,
    talentPoints: hud.talents?.points ?? 0,
    isTown: hud.area?.isTown ?? false,
    deepest: hud.area?.deepest ?? 0,
    wornGear: all.some(wornOf),
    setOrUnique: all.some(rareOf),
    bagFull: cells.length > 0 && cells.every(Boolean),
    bossAlive: hud.area?.bossAlive ?? false,
    riftUnlocked: hud.rift?.unlocked ?? false,
    mode: hud.control.mode,
    speed: hud.control.speed,
  };
}

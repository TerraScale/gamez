/**
 * Gear decisions of the auto controller: is a bag/vendor item an upgrade
 * (itemScore with a margin, requirements, two-handed rules, weapon style),
 * and which bag item to equip next.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import { Dead, Equipment, HeroStats, Inventory, Level, Pos } from "../components.ts";
import { controlMode } from "../control.ts";
import { partyMembers } from "../party/shared.ts";
import { heroOf } from "../resources.ts";
import {
  KIND,
  type Attr,
  type EquipSlot,
  type ItemBaseProto,
  type ItemInstance,
} from "../types.ts";
import { itemScore } from "./score.ts";
import { bagFits, configOf, itemSize, makeAutoCtx, pushCmd, type AutoCtx } from "./util.ts";

export interface Upgrade {
  slot: EquipSlot;
  /** New score minus the score it replaces. */
  gain: number;
}

export function primaryOf(c: AutoCtx): Attr {
  return c.world.get(c.hero, HeroStats)?.primary ?? c.classProto?.primary ?? "str";
}

function isRanged(base: ItemBaseProto | undefined): boolean {
  return base !== undefined && (base.projectile ?? "") !== "";
}

/** Weapon style the hero's skills are built around: bows, other ranged (wands), or melee. */
function styleOf(base: ItemBaseProto | undefined): "bow" | "ranged" | "melee" {
  if (base?.weaponClass === "bow") return "bow";
  return isRanged(base) ? "ranged" : "melee";
}

/**
 * The slot where `item` would be an upgrade by more than `marginPct`, or
 * null. `strictReq` checks level/str/dex now; otherwise items up to 3 levels
 * above the hero still count (worth keeping in the bag).
 */
export function upgradeFor(
  c: AutoCtx,
  item: ItemInstance,
  marginPct: number,
  strictReq: boolean,
): Upgrade | null {
  const base = c.reg.get<ItemBaseProto>(KIND.itemBase, item.base);
  if (!base || base.slots.length === 0 || base.category === "potion") return null;
  const eq = c.world.get(c.hero, Equipment);
  if (!eq) return null;
  const level = c.world.get(c.hero, Level)?.level ?? 1;
  const attrs = c.world.get(c.hero, HeroStats)?.attrs;
  if (strictReq) {
    if (base.reqLevel > level) return null;
    if (attrs && (base.reqStr > attrs.str || base.reqDex > attrs.dex)) return null;
  } else if (base.reqLevel > level + 3) return null;

  const primary = primaryOf(c);
  const score = itemScore(c.reg, item, primary);
  const scoreOf = (it: ItemInstance | null): number => (it ? itemScore(c.reg, it, primary) : 0);
  const weaponBase = eq.weapon
    ? c.reg.get<ItemBaseProto>(KIND.itemBase, eq.weapon.base)
    : undefined;

  let best: Upgrade | null = null;
  const consider = (slot: EquipSlot, cur: number): void => {
    if (score * 100 <= cur * (100 + marginPct)) return;
    const gain = score - cur;
    if (!best || gain > best.gain) best = { slot, gain };
  };

  if (base.slots.includes("ring1") && base.slots.includes("ring2")) {
    // Rings: an empty finger first, else replace the weaker ring.
    if (!eq.ring1) consider("ring1", 0);
    else if (!eq.ring2) consider("ring2", 0);
    else {
      const s1 = scoreOf(eq.ring1);
      const s2 = scoreOf(eq.ring2);
      if (s2 < s1) consider("ring2", s2);
      else consider("ring1", s1);
    }
    return best;
  }

  for (const slot of base.slots) {
    if (slot === "weapon") {
      // Keep the weapon style (bow, other ranged, melee) the hero's skills are built around.
      if (eq.weapon && styleOf(weaponBase) !== styleOf(base)) continue;
      const cur = scoreOf(eq.weapon) + (base.twoHanded ? scoreOf(eq.offhand) : 0);
      consider(slot, cur);
    } else if (slot === "offhand") {
      if (weaponBase?.twoHanded) continue;
      consider(slot, scoreOf(eq.offhand));
    } else {
      consider(slot, scoreOf(eq[slot]));
    }
  }
  return best;
}

/** The bag item to equip now (largest gain over 5 %), or null. */
export function pickEquip(c: AutoCtx): { uid: number; slot: EquipSlot } | null {
  const inv = c.world.get(c.hero, Inventory);
  if (!inv) return null;
  const eq = c.world.get(c.hero, Equipment);
  let best: { uid: number; slot: EquipSlot; gain: number } | null = null;
  for (const en of inv.items) {
    const up = upgradeFor(c, en.item, 5, true);
    if (!up || (best && up.gain <= best.gain)) continue;
    // Party: an item another member gains more from goes to that member (distributeGear).
    if (c.party && claimedByOther(c, en.item, up.gain)) continue;
    // What comes off must fit back into the bag (in the freed space).
    const off: ItemInstance[] = [];
    const cur = eq?.[up.slot];
    if (cur) off.push(cur);
    const base = c.reg.get<ItemBaseProto>(KIND.itemBase, en.item.base);
    if (up.slot === "weapon" && base?.twoHanded && eq?.offhand) off.push(eq.offhand);
    if (off.every((it) => fitsBack(c, it, en.item.uid)))
      best = { uid: en.item.uid, slot: up.slot, gain: up.gain };
  }
  return best ? { uid: best.uid, slot: best.slot } : null;
}

function fitsBack(c: AutoCtx, item: ItemInstance, freedUid: number): boolean {
  const s = itemSize(c.reg, item);
  return bagFits(c, s.w, s.h, [freedUid]);
}

/** True when `item` is worth keeping as a (possibly soon usable) upgrade (party: for any gear member). */
export function isKeeper(c: AutoCtx, item: ItemInstance): boolean {
  if (upgradeFor(c, item, 5, false) !== null) return true;
  if (!c.party) return false;
  for (const e of gearMembers(c.world)) {
    if (e === c.hero) continue;
    if (upgradeFor(makeAutoCtx(c.world, c.ctx, e), item, 5, false) !== null) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Party gear distribution (docs/design/party.md §6.8)
// ---------------------------------------------------------------------------

/**
 * Members taking part in gear distribution (slot order): standing members
 * with a bag; the controlled hero only outside Manual (the player manages
 * its own bag then).
 */
export function gearMembers(world: World): Entity[] {
  const manual = controlMode(world) === "manual";
  const hero = heroOf(world);
  return partyMembers(world).filter(
    (e) =>
      !world.has(e, Dead) &&
      world.has(e, Inventory) &&
      world.has(e, Pos) &&
      !(manual && e === hero),
  );
}

/** Upgrade gain of `item` for the context's hero (0 = none; strict requirements, 5 % margin). */
export function gainFor(c: AutoCtx, item: ItemInstance): number {
  return upgradeFor(c, item, 5, true)?.gain ?? 0;
}

/**
 * The member (of `ctxs`, slot order) `item` upgrades most, with its gain;
 * ties go to the lower slot. Null when it upgrades nobody.
 */
export function bestMemberFor(
  ctxs: readonly AutoCtx[],
  item: ItemInstance,
): { c: AutoCtx; gain: number } | null {
  let best: { c: AutoCtx; gain: number } | null = null;
  for (const m of ctxs) {
    const g = gainFor(m, item);
    if (g > 0 && (!best || g > best.gain)) best = { c: m, gain: g };
  }
  return best;
}

/**
 * True when another gear member with bag room gains more than `gain` from
 * `item` (or as much from a lower slot): the holder leaves it to them.
 */
function claimedByOther(c: AutoCtx, item: ItemInstance, gain: number): boolean {
  const members = gearMembers(c.world);
  const mine = members.indexOf(c.hero);
  const s = itemSize(c.reg, item);
  for (let i = 0; i < members.length; i++) {
    const e = members[i]!;
    if (e === c.hero) continue;
    const m = makeAutoCtx(c.world, c.ctx, e);
    const g = gainFor(m, item);
    if (g > gain || (g === gain && g > 0 && mine >= 0 && i < mine)) {
      if (bagFits(m, s.w, s.h)) return true;
    }
  }
  return false;
}

/**
 * Hands one bag item to the member it upgrades most (party, AutoConfig.
 * autoEquip): for every gear member's bag (slot order), every item whose
 * best member is not its holder and has room gets a `give` op from the
 * holder. One give per call; the recipient equips it on its next equip
 * check (equip runs at update 50, before classic.party's give at 56).
 */
export function distributeGear(world: World, ctx: SimContext): void {
  if (!configOf(world).autoEquip) return;
  const members = gearMembers(world);
  if (members.length < 2) return;
  const ctxs = members.map((e) => makeAutoCtx(world, ctx, e));
  for (const h of ctxs) {
    for (const en of world.get(h.hero, Inventory)?.items ?? []) {
      const best = bestMemberFor(ctxs, en.item);
      if (!best || best.c.hero === h.hero) continue;
      // The holder keeps what it gains as much from (no hand-over for a tie with itself).
      if (gainFor(h, en.item) >= best.gain) continue;
      const s = itemSize(h.reg, en.item);
      if (!bagFits(best.c, s.w, s.h)) continue;
      pushCmd(h, { op: "give", uid: en.item.uid, to: best.c.hero });
      return;
    }
  }
}

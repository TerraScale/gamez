/**
 * The town routine (§15.2 step 9): AutoState.todo walks through heal ->
 * sell -> stash -> buy -> smith -> quests -> return. Each step walks to its
 * NPC/Interactable with an interact Intent and, once within reach, queues
 * the owner's ops directly (heal, sell, stashPut, buy, acceptQuest,
 * completeQuest, usePortal / waypoint / stairs).
 */
import type { Entity } from "@gamez/kernel";
import { pushCommand } from "../bus.ts";
import { emit } from "../events.ts";
import { Belt, Inventory, Level, Life, Mana, Npc, Pos, Supplies, Wallet } from "../components.ts";
import {
  RES,
  type DungeonState,
  type QuestState,
  type StashState,
  type VendorState,
} from "../resources.ts";
import { monsterLevel, potionUnlocked, rarityRank } from "../rules.ts";
import {
  KIND,
  type ItemBaseProto,
  type ItemInstance,
  type NpcProto,
  type QuestProto,
} from "../types.ts";
import { travel } from "./explore.ts";
import { walkTo } from "./route.ts";
import { isKeeper, upgradeFor } from "./gear.ts";
import {
  addIgnore,
  balanceOf,
  bagFits,
  effectiveLevel,
  inReach,
  isCasterClass,
  itemSize,
  nearestInteractable,
  nearestNpc,
  npcsByRole,
  potionOf,
  setIntent,
  setPlan,
  stopIntent,
  type AutoCtx,
} from "./util.ts";

type StepResult = "skip" | "walk" | "done" | "wait";

/** Scrolls the routine buys up to. */
export const SCROLL_TARGET = 5;

function bagItems(c: AutoCtx): ItemInstance[] {
  return (c.world.get(c.hero, Inventory)?.items ?? []).map((e) => e.item);
}

/** Walk to `e` (interact intent, long walks in legs), or run `act` when within reach. */
function at(c: AutoCtx, e: Entity, act: () => void): StepResult {
  const same = c.st.focus === e;
  c.st.focus = e;
  if (inReach(c, e)) {
    act();
    stopIntent(c);
    return "done";
  }
  approach(c, e, same);
  return "walk";
}

function approach(c: AutoCtx, e: Entity, same: boolean): void {
  const p = c.world.read(e, Pos);
  walkTo(c, p.x >> 8, p.y >> 8, () => setIntent(c, { kind: "interact", target: e }), same);
}

function healStep(c: AutoCtx): StepResult {
  const npc = nearestNpc(c, "healer");
  if (npc === 0) return "skip";
  const life = c.world.get(c.hero, Life);
  const mana = c.world.get(c.hero, Mana);
  if ((!life || life.hp >= life.max) && (!mana || mana.mp >= mana.max)) return "skip";
  return at(c, npc, () => pushCommand(c.world, { op: "heal", npc }));
}

/**
 * What the town routine does with the bag: items below keepRarity (that are
 * not upgrades to keep) are sold; kept rarities go to the stash while it has
 * room, and are sold once it is full, so a town trip always frees the bag.
 */
export function sortBag(c: AutoCtx): { sell: ItemInstance[]; stash: ItemInstance[] } {
  const keep = rarityRank(c.cfg.keepRarity);
  let room =
    balanceOf(c.reg).stashSize - (c.world.getResource<StashState>(RES.stash)?.items.length ?? 0);
  const sell: ItemInstance[] = [];
  const stash: ItemInstance[] = [];
  for (const it of bagItems(c)) {
    if (isKeeper(c, it)) continue;
    if (rarityRank(it.rarity) < keep) sell.push(it);
    else if (room > 0) {
      stash.push(it);
      room--;
    } else sell.push(it);
  }
  return { sell, stash };
}

/** True when a town visit would free bag space (something to sell or stash). */
export function townFreesBag(c: AutoCtx): boolean {
  const { sell, stash } = sortBag(c);
  if (stash.length > 0) return true;
  return sell.length > 0 && hasJunkBuyer(c);
}

function junkBuyer(c: AutoCtx): Entity | undefined {
  return npcsByRole(c, "junk").find(
    (e) => (c.reg.get<NpcProto>(KIND.npc, c.world.read(e, Npc).proto)?.buyPct ?? 0) > 0,
  );
}

/** A junk buyer exists in the registry (callable from the dungeon too). */
function hasJunkBuyer(c: AutoCtx): boolean {
  for (const [, npc] of c.reg.all<NpcProto>(KIND.npc)) if (npc.buyPct > 0) return true;
  return false;
}

function sellStep(c: AutoCtx): StepResult {
  const junk = junkBuyer(c);
  if (junk === undefined) return "skip";
  const { sell } = sortBag(c);
  if (sell.length === 0) return "skip";
  const stashFull =
    (c.world.getResource<StashState>(RES.stash)?.items.length ?? 0) >= balanceOf(c.reg).stashSize;
  return at(c, junk, () => {
    if (stashFull && sell.some((it) => rarityRank(it.rarity) >= rarityRank(c.cfg.keepRarity)))
      emit(c.ctx, {
        type: "classic.auto.notice",
        code: "stash_full",
        message: "Stash is full: selling kept items",
      });
    for (const it of sell) pushCommand(c.world, { op: "sell", npc: junk, uid: it.uid });
  });
}

function stashStep(c: AutoCtx): StepResult {
  const stash = nearestInteractable(c, "stash");
  if (stash === 0) return "skip";
  const put = sortBag(c).stash;
  if (put.length === 0) return "skip";
  return at(c, stash, () => {
    for (const it of put) pushCommand(c.world, { op: "stashPut", uid: it.uid });
  });
}

/** Potion tier wanted at a hero level: < 10 minor, < 20 light, < 30 greater, else super. */
export function potionTier(level: number): number {
  return level < 10 ? 1 : level < 20 ? 2 : level < 30 ? 3 : 4;
}

/**
 * The sold potion base of `kind` closest to `tier` from below that `gold`
 * buys at least one of (else the cheapest one sold, so the caller can tell
 * it is not affordable).
 */
export function chooseBase(
  c: AutoCtx,
  sells: readonly string[],
  kind: "life" | "mana",
  tier: number,
  gold = Number.MAX_SAFE_INTEGER,
): { id: string; price: number } | null {
  let below: { id: string; tier: number; price: number } | null = null;
  let lowest: { id: string; tier: number; price: number } | null = null;
  const level = c.world.get(c.hero, Level)?.level ?? 1;
  for (const id of [...sells].sort()) {
    const b = c.reg.get<ItemBaseProto>(KIND.itemBase, id);
    if (!b?.potion || b.potion.kind !== kind || !potionUnlocked(b, level)) continue;
    const cand = { id, tier: b.potion.tier, price: Math.max(1, b.value) };
    if (cand.tier <= tier && cand.price <= gold && (!below || cand.tier > below.tier)) below = cand;
    if (!lowest || cand.price < lowest.price) lowest = cand;
  }
  const pick = below ?? lowest;
  return pick ? { id: pick.id, price: pick.price } : null;
}

/** Price of the life potion a restock would buy now (MAX_SAFE_INTEGER when none is sold). */
export function restockPrice(c: AutoCtx): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const [, npc] of c.reg.all<NpcProto>(KIND.npc)) {
    if (npc.role !== "alchemist" || !npc.sells) continue;
    const gold = c.world.get(c.hero, Wallet)?.gold ?? 0;
    const level = c.world.get(c.hero, Level)?.level ?? 1;
    const base = chooseBase(c, npc.sells.potions, "life", potionTier(level), gold);
    if (base) best = Math.min(best, base.price);
  }
  return best;
}

export interface Purchase {
  potion: string;
  count: number;
}

/**
 * What the alchemist routine buys with the current gold. With no life
 * potion in the belt, potions come first; otherwise scrolls up to 2 first.
 * Potions follow the class belt plan (casters 2 life + 2 mana slots, others
 * 3 + 1) at the best affordable tier up to the level's tier, then scrolls up
 * to 5.
 */
export function planPurchases(c: AutoCtx, sells: NonNullable<NpcProto["sells"]>): Purchase[] {
  const bal = balanceOf(c.reg);
  let gold = c.world.get(c.hero, Wallet)?.gold ?? 0;
  let scrolls = c.world.get(c.hero, Supplies)?.tpScrolls ?? 0;
  const out: Purchase[] = [];
  const buyScrolls = (upTo: number): void => {
    if (!sells.tpScroll) return;
    const want = Math.min(upTo, bal.maxTpScrolls) - scrolls;
    const n = Math.min(want, Math.floor(gold / Math.max(1, bal.tpScrollPrice)));
    if (n <= 0) return;
    out.push({ potion: "tp", count: n });
    gold -= n * bal.tpScrollPrice;
    scrolls += n;
  };
  const belt = c.world.get(c.hero, Belt);
  const noLife =
    belt !== undefined &&
    !belt.slots.some((s) => s.count > 0 && potionOf(c.reg, s.base)?.kind === "life");
  if (!noLife) buyScrolls(2);
  if (c.cfg.buyPotions && belt) {
    const level = c.world.get(c.hero, Level)?.level ?? 1;
    const tier = potionTier(level);
    const caster = isCasterClass(c.classProto);
    let empty = belt.slots.filter((s) => s.count <= 0 || s.base === null).length;
    for (const [kind, slots] of [
      ["life", caster ? 2 : 3],
      ["mana", caster ? 2 : 1],
    ] as const) {
      const base = chooseBase(c, sells.potions, kind, tier, gold);
      if (!base) continue;
      let kindSlots = 0;
      let room = 0;
      for (const s of belt.slots) {
        if (s.count <= 0 || s.base === null) continue;
        if (potionOf(c.reg, s.base)?.kind === kind) kindSlots++;
        if (s.base === base.id) room += Math.max(0, bal.beltStack - s.count);
      }
      const useEmpty = Math.min(empty, Math.max(0, slots - kindSlots));
      empty -= useEmpty;
      room += useEmpty * bal.beltStack;
      const n = Math.min(room, Math.floor(gold / base.price));
      if (n <= 0) continue;
      out.push({ potion: base.id, count: n });
      gold -= n * base.price;
    }
  }
  buyScrolls(SCROLL_TARGET);
  return out;
}

function buyStep(c: AutoCtx): StepResult {
  const npc = nearestNpc(c, "alchemist");
  if (npc === 0) return "skip";
  const sells = c.reg.get<NpcProto>(KIND.npc, c.world.read(npc, Npc).proto)?.sells;
  if (!sells) return "skip";
  const list = planPurchases(c, sells);
  if (list.length === 0) return "skip";
  return at(c, npc, () => {
    for (const p of list)
      pushCommand(c.world, { op: "buy", npc, index: 0, potion: p.potion, count: p.count });
  });
}

/** Smith items must beat the equipped one by this much (3 % when the hero is rich). */
const SMITH_MARGIN_PCT = 8;
const SMITH_MARGIN_RICH_PCT = 3;

/** Gold the smith routine keeps for potions and scrolls: 10 tier life potions + 2 scrolls. */
export function smithReserve(c: AutoCtx): number {
  const level = c.world.get(c.hero, Level)?.level ?? 1;
  let price = 0;
  for (const [, npc] of c.reg.all<NpcProto>(KIND.npc)) {
    if (npc.role !== "alchemist" || !npc.sells) continue;
    price = Math.max(
      price,
      chooseBase(c, npc.sells.potions, "life", potionTier(level))?.price ?? 0,
    );
  }
  return 10 * price + 2 * balanceOf(c.reg).tpScrollPrice;
}

function smithStep(c: AutoCtx): StepResult {
  const npc = nearestNpc(c, "smith");
  if (npc === 0) return "skip";
  const proto = c.world.read(npc, Npc).proto;
  const stock = c.world.getResource<VendorState>(RES.vendors)?.stocks.find((s) => s.npc === proto);
  if (!stock) return "skip";
  const gold = c.world.get(c.hero, Wallet)?.gold ?? 0;
  const budget = gold - smithReserve(c);
  let best: { index: number; gain: number } | null = null;
  stock.items.forEach((it, index) => {
    if (it.value > budget) return;
    const s = itemSize(c.reg, it);
    if (!bagFits(c, s.w, s.h)) return;
    // With plenty of gold to spare, smaller upgrades are worth buying too.
    const margin = budget >= 3 * it.value ? SMITH_MARGIN_RICH_PCT : SMITH_MARGIN_PCT;
    const up = upgradeFor(c, it, margin, true);
    if (up && (!best || up.gain > best.gain)) best = { index, gain: up.gain };
  });
  if (!best) return "skip";
  const index = (best as { index: number }).index;
  return at(c, npc, () => pushCommand(c.world, { op: "buy", npc, index, potion: null, count: 1 }));
}

function questStep(c: AutoCtx): StepResult {
  const qs = c.world.getResource<QuestState>(RES.quests);
  if (!qs) return "skip";
  const level = c.world.get(c.hero, Level)?.level ?? 1;
  const quests = c.reg.all<QuestProto>(KIND.quest);
  for (const npc of npcsByRole(c, "quest")) {
    const giver = c.world.read(npc, Npc).proto;
    const ops: ({ op: "acceptQuest"; quest: string } | { op: "completeQuest"; quest: string })[] =
      [];
    for (const [id, q] of quests) {
      if (q.giver !== giver || qs.completed.includes(id)) continue;
      const active = qs.active.find((a) => a.id === id);
      if (active) {
        if (active.done) ops.push({ op: "completeQuest", quest: id });
      } else if (q.reqLevel <= level && (q.after === "" || qs.completed.includes(q.after))) {
        ops.push({ op: "acceptQuest", quest: id });
      }
    }
    if (ops.length > 0)
      return at(c, npc, () => {
        for (const op of ops) pushCommand(c.world, op);
      });
  }
  return "skip";
}

/** Travel step result: walking to the exit, or the command was sent (wait for the transition). */
function goTravel(
  c: AutoCtx,
  e: Entity,
  cmd: Parameters<typeof pushCommand>[1],
  note: string,
): StepResult {
  setPlan(c, "toDungeon", note);
  const same = c.st.focus === e;
  c.st.focus = e;
  if (inReach(c, e)) {
    travel(c, cmd);
    return "wait";
  }
  approach(c, e, same);
  return "walk";
}

/** Back to the dungeon: open portal, else the deepest suitable waypoint, else the town stairs. */
function returnStep(c: AutoCtx): StepResult {
  const dungeon = c.world.getResource<DungeonState>(RES.dungeon);
  const avoid = c.st.deathDepth;
  if (dungeon?.portal && !(avoid > 0 && dungeon.portal.depth >= avoid)) {
    const portal = nearestInteractable(c, "portal");
    if (portal !== 0) return goTravel(c, portal, { op: "usePortal" }, "portal");
  }
  const level = effectiveLevel(c.world.get(c.hero, Level)?.level ?? 1, c.st);
  let dest = 0;
  for (const w of dungeon?.waypoints ?? []) {
    if (w <= 0 || (c.cfg.maxDepth > 0 && w > c.cfg.maxDepth)) continue;
    if (monsterLevel(w) > level + 2) continue;
    // First return after a death: below that depth (a fresh level, not the pack that won).
    if (c.st.deathDepth > 0 && w >= c.st.deathDepth && w > 1) continue;
    if (w > dest) dest = w;
  }
  if (dest > 0) {
    const wp = nearestInteractable(c, "waypoint");
    if (wp !== 0) return goTravel(c, wp, { op: "waypoint", depth: dest }, `waypoint ${dest}`);
  }
  const stairs = nearestInteractable(c, "stairsDown");
  if (stairs !== 0) return goTravel(c, stairs, { op: "stairs", target: stairs }, "stairs");
  return "skip";
}

function runStep(c: AutoCtx, step: string): StepResult {
  switch (step) {
    case "heal":
      return healStep(c);
    case "sell":
      return sellStep(c);
    case "stash":
      return stashStep(c);
    case "buy":
      return buyStep(c);
    case "smith":
      return smithStep(c);
    case "quests":
      return questStep(c);
    case "return":
      return returnStep(c);
    default:
      return "skip";
  }
}

/**
 * Runs the head of AutoState.todo. Steps with nothing to do are skipped in
 * the same tick; a step that queued its ops completes (one per tick); the
 * return step stays until the area changes. False when the list is empty.
 */
export function townStep(c: AutoCtx): boolean {
  const st = c.st;
  while (st.todo.length > 0) {
    const step = st.todo[0]!;
    const r = runStep(c, step);
    if (r === "walk" || r === "wait") {
      if (step !== "return") setPlan(c, "town", step);
      return true;
    }
    st.todo.shift();
    st.focus = 0;
    if (r === "done") {
      setPlan(c, "town", step);
      return true;
    }
  }
  return false;
}

/** Stuck walking to a town target: skip that step. */
export function skipTownStep(c: AutoCtx): void {
  const e = c.st.focus;
  if (e !== 0 && c.world.has(e, Pos)) {
    const p = c.world.read(e, Pos);
    addIgnore(c.st, p.x >> 8, p.y >> 8);
  }
  c.st.todo.shift();
  c.st.focus = 0;
}

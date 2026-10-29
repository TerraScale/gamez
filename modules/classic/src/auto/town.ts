/**
 * The town routine (§15.2 step 9; wave A §8): AutoState.todo walks through
 * heal -> sell -> repair -> buy -> smith -> craft -> gamble -> sell -> stash
 * -> quests -> return. Each step walks to its NPC/Interactable with an
 * interact Intent and, once within reach, queues the owner's ops directly
 * (heal, sell, repair, buy, socketGem/addSocket/upgrade/combineGems, gamble,
 * stashPut with a tab, acceptQuest, completeQuest, usePortal / waypoint /
 * stairs / openRift). The second sell step sells what the gamble brought
 * that is neither an upgrade nor worth keeping.
 */
import type { Entity } from "@gamez/kernel";
import { Belt, Inventory, Level, Life, Mana, Npc, Pos } from "../components.ts";
import type { HeroCommand } from "../actions.ts";
import {
  RES,
  type DungeonState,
  type QuestState,
  type StashState,
  type VendorState,
} from "../resources.ts";
import {
  isBossDepth,
  levelForXp,
  monsterLevel,
  potionUnlocked,
  rarityRank,
  stashTabCount,
} from "../rules.ts";
import {
  BALANCE_ID,
  KIND,
  type BalanceProto,
  type ItemBaseProto,
  type ItemInstance,
  type NpcProto,
  type QuestProto,
} from "../types.ts";
import { craftStep, gambleStep, repairStep } from "./craft.ts";
import { bossReady, clearObjective, liveBoss, travel } from "./dungeon.ts";
import { isKeeper, upgradeFor } from "./gear.ts";
import { partyReturnWait } from "./lead.ts";
import { riftTownStep } from "./riftLoop.ts";
import { approach, at, type StepResult } from "./visit.ts";
import {
  addIgnore,
  bagFits,
  balanceOf,
  effectiveLevel,
  emitFor,
  inReach,
  isCasterClass,
  itemSize,
  nearestInteractable,
  nearestNpc,
  npcsByRole,
  potionAmount,
  potionOf,
  bossRetreatProgress,
  purseGold,
  purseScrolls,
  pushCmd,
  retreatLoop,
  setPlan,
  type AutoCtx,
} from "./util.ts";

/** Town portal scrolls the routine buys up to. */
export const SCROLL_TARGET = 5;

function bagItems(c: AutoCtx): ItemInstance[] {
  return (c.world.get(c.hero, Inventory)?.items ?? []).map((e) => e.item);
}

function healStep(c: AutoCtx): StepResult {
  const npc = nearestNpc(c, "healer");
  if (npc === 0) return "skip";
  const life = c.world.get(c.hero, Life);
  const mana = c.world.get(c.hero, Mana);
  if ((!life || life.hp >= life.max) && (!mana || mana.mp >= mana.max)) return "skip";
  return at(c, npc, () => pushCmd(c, { op: "heal", npc }));
}

/** Stash tabs by convention (wave-A.md §8): general, sets and uniques, gems, overflow. */
export const TAB_GENERAL = 0;
export const TAB_SPECIAL = 1;
export const TAB_GEMS = 2;
export const TAB_OVERFLOW = 3;
/** Gems kept in the bag for the smith (best tiers first); the rest go to the gem tab. */
export const GEM_BAG_KEEP = 8;

function isGem(c: AutoCtx, it: ItemInstance): boolean {
  return c.reg.get<ItemBaseProto>(KIND.itemBase, it.base)?.gem !== undefined;
}

function gemTier(c: AutoCtx, it: ItemInstance): number {
  return c.reg.get<ItemBaseProto>(KIND.itemBase, it.base)?.gem?.tier ?? 0;
}

/** Preferred stash tab of an item (falls back to overflow, then any tab with room). */
export function preferredTab(c: AutoCtx, it: ItemInstance, tabs: number): number {
  const want = isGem(c, it)
    ? TAB_GEMS
    : it.rarity === "set" || it.rarity === "unique"
      ? TAB_SPECIAL
      : TAB_GENERAL;
  return want < tabs ? want : 0;
}

export interface StashPlan {
  item: ItemInstance;
  tab: number;
}

/**
 * What the town routine does with the bag: items below keepRarity (that are
 * not upgrades to keep) are sold; kept rarities go to the stash while it has
 * room, and are sold once it is full, so a town trip always frees the bag.
 * Gems: the best GEM_BAG_KEEP stay in the bag (crafting), the rest go to the
 * gem tab. Stash tabs (wave A): preferred tab, else overflow, else the first
 * tab with room; per-tab capacity BalanceProto.stashSize.
 */
export function sortBag(c: AutoCtx): { sell: ItemInstance[]; stash: StashPlan[] } {
  const keep = rarityRank(c.cfg.keepRarity);
  const bal = balanceOf(c.reg);
  const tabs = stashTabCount(bal as Parameters<typeof stashTabCount>[0]);
  const counts = Array.from({ length: tabs }, () => 0);
  for (const it of c.world.getResource<StashState>(RES.stash)?.items ?? []) {
    const t = it.tab ?? 0;
    if (t >= 0 && t < tabs) counts[t]!++;
  }
  const tabFor = (it: ItemInstance): number => {
    const pref = preferredTab(c, it, tabs);
    if (counts[pref]! < bal.stashSize) return pref;
    if (TAB_OVERFLOW < tabs && counts[TAB_OVERFLOW]! < bal.stashSize) return TAB_OVERFLOW;
    return counts.findIndex((n) => n < bal.stashSize);
  };
  const sell: ItemInstance[] = [];
  const stash: StashPlan[] = [];
  const items = bagItems(c);
  // Gems: the best tiers stay in the bag (ties: lower uid).
  const gems = items
    .filter((it) => isGem(c, it))
    .sort((a, b) => gemTier(c, b) - gemTier(c, a) || a.uid - b.uid);
  const extraGems = new Set(gems.slice(GEM_BAG_KEEP).map((it) => it.uid));
  for (const it of items) {
    if (isGem(c, it)) {
      if (!extraGems.has(it.uid)) continue;
    } else if (isKeeper(c, it)) continue;
    if (!isGem(c, it) && rarityRank(it.rarity) < keep) {
      sell.push(it);
      continue;
    }
    const tab = tabFor(it);
    if (tab >= 0) {
      stash.push({ item: it, tab });
      counts[tab]!++;
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
  const keptSold = sell.some(
    (it) => !isGem(c, it) && rarityRank(it.rarity) >= rarityRank(c.cfg.keepRarity),
  );
  return at(c, junk, () => {
    if (keptSold)
      emitFor(c, {
        type: "classic.auto.notice",
        code: "stash_full",
        message: "Stash is full: selling kept items",
      });
    for (const it of sell) pushCmd(c, { op: "sell", npc: junk, uid: it.uid });
  });
}

function stashStep(c: AutoCtx): StepResult {
  const stash = nearestInteractable(c, "stash");
  if (stash === 0) return "skip";
  const put = sortBag(c).stash;
  if (put.length === 0) return "skip";
  return at(c, stash, () => {
    for (const p of put) pushCmd(c, { op: "stashPut", uid: p.item.uid, tab: p.tab });
  });
}

/** Highest potion tier the routine considers when buying. */
export const POTION_TIER_MAX = 4;

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
    const gold = purseGold(c);
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
 * What the alchemist routine buys with the current gold. One town portal
 * scroll first (the retreat needs it); then, with no life potion in the
 * belt, potions; otherwise scrolls up to 2 first.
 * Potions follow the class belt plan (casters 2 life + 2 mana slots, others
 * 3 + 1), each kind the unlocked base that restores the most in total with
 * the gold and belt room, then scrolls up to 5.
 */
export function planPurchases(c: AutoCtx, sells: NonNullable<NpcProto["sells"]>): Purchase[] {
  const bal = balanceOf(c.reg);
  let gold = purseGold(c);
  let scrolls = purseScrolls(c);
  const out: Purchase[] = [];
  const buyScrolls = (upTo: number): void => {
    if (!sells.tpScroll) return;
    const want = Math.min(upTo, bal.maxTpScrolls) - scrolls;
    const n = Math.min(want, Math.floor(gold / Math.max(1, bal.tpScrollPrice)));
    if (n <= 0) return;
    // Consecutive scroll purchases are one op.
    const last = out[out.length - 1];
    if (last && last.potion === "tp") last.count += n;
    else out.push({ potion: "tp", count: n });
    gold -= n * bal.tpScrollPrice;
    scrolls += n;
  };
  const belt = c.world.get(c.hero, Belt);
  const noLife =
    belt !== undefined &&
    !belt.slots.some((s) => s.count > 0 && potionOf(c.reg, s.base)?.kind === "life");
  // One scroll always comes first: without it a hero with an empty belt cannot retreat
  // (playtest wave A: most warrior deaths had no potion and no scroll left).
  buyScrolls(1);
  if (!noLife) buyScrolls(2);
  if (c.cfg.buyPotions && belt) {
    const level = c.world.get(c.hero, Level)?.level ?? 1;
    // Any unlocked tier (the alchemist unlocks them by hero level); the choice below weighs
    // what the gold buys, so a poor hero still takes the cheap ones.
    const tier = POTION_TIER_MAX;
    const caster = isCasterClass(c.classProto);
    let empty = belt.slots.filter((s) => s.count <= 0 || s.base === null).length;
    for (const [kind, slots] of [
      ["life", caster ? 2 : 3],
      ["mana", caster ? 2 : 1],
    ] as const) {
      let kindSlots = 0;
      for (const s of belt.slots) {
        if (s.count > 0 && s.base !== null && potionOf(c.reg, s.base)?.kind === kind) kindSlots++;
      }
      const useEmpty = Math.min(empty, Math.max(0, slots - kindSlots));
      // The unlocked base (tier <= the level's tier) that restores the most in total with
      // this gold and belt room: a poor hero buys three minor potions, not one light one.
      let best: { id: string; price: number; n: number; total: number; tier: number } | null = null;
      for (const id of [...sells.potions].sort()) {
        const b = c.reg.get<ItemBaseProto>(KIND.itemBase, id);
        if (!b?.potion || b.potion.kind !== kind || b.potion.tier > tier) continue;
        if (!potionUnlocked(b, level)) continue;
        const price = Math.max(1, b.value);
        let room = useEmpty * bal.beltStack;
        for (const s of belt.slots)
          if (s.count > 0 && s.base === id) room += Math.max(0, bal.beltStack - s.count);
        const n = Math.min(room, Math.floor(gold / price));
        if (n <= 0) continue;
        const max =
          kind === "life"
            ? (c.world.get(c.hero, Life)?.max ?? 0)
            : (c.world.get(c.hero, Mana)?.max ?? 0);
        const total = n * potionAmount(b.potion, max, 0);
        if (!best || total > best.total || (total === best.total && b.potion.tier > best.tier))
          best = { id, price, n, total, tier: b.potion.tier };
      }
      if (!best) continue;
      // Empty slots taken by this purchase (stacks of the same base fill first).
      let left = best.n;
      for (const s of belt.slots)
        if (s.count > 0 && s.base === best.id) left -= Math.max(0, bal.beltStack - s.count);
      empty -= Math.min(useEmpty, Math.max(0, Math.ceil(left / bal.beltStack)));
      out.push({ potion: best.id, count: best.n });
      gold -= best.n * best.price;
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
      pushCmd(c, { op: "buy", npc, index: 0, potion: p.potion, count: p.count });
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
  const gold = purseGold(c);
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
  return at(c, npc, () => pushCmd(c, { op: "buy", npc, index, potion: null, count: 1 }));
}

type QuestOp = { op: "acceptQuest"; quest: string } | { op: "completeQuest"; quest: string };

/**
 * The quest giver's ops of one visit: every finished quest is turned in
 * first, then every quest the hero may take is accepted. Chains resolve in
 * the same visit: a quest turned in by this batch counts as completed for
 * the `after` check, and the level check uses the level the batch's XP
 * rewards reach (completeQuest adds its XP at once, and the commands run in
 * queue order, so the accepts see it).
 */
export function questOps(c: AutoCtx, giver: string): QuestOp[] {
  const qs = c.world.getResource<QuestState>(RES.quests);
  if (!qs) return [];
  const quests = c.reg.all<QuestProto>(KIND.quest);
  const completes: QuestOp[] = [];
  const completed = new Set(qs.completed);
  let rewardXp = 0;
  for (const [id, q] of quests) {
    if (q.giver !== giver || qs.completed.includes(id)) continue;
    if (qs.active.find((a) => a.id === id)?.done) {
      completes.push({ op: "completeQuest", quest: id });
      completed.add(id);
      rewardXp += q.reward.xp;
    }
  }
  const lvl = c.world.get(c.hero, Level);
  let level = lvl?.level ?? 1;
  const bal = c.reg.get<BalanceProto>(KIND.balance, BALANCE_ID);
  if (lvl && bal && rewardXp > 0) level = Math.max(level, levelForXp(bal, lvl.xp + rewardXp));
  const accepts: QuestOp[] = [];
  for (const [id, q] of quests) {
    if (q.giver !== giver || completed.has(id) || qs.active.some((a) => a.id === id)) continue;
    if (q.reqLevel <= level && (q.after === "" || completed.has(q.after)))
      accepts.push({ op: "acceptQuest", quest: id });
  }
  return [...completes, ...accepts];
}

function questStep(c: AutoCtx): StepResult {
  if (!c.world.getResource<QuestState>(RES.quests)) return "skip";
  for (const npc of npcsByRole(c, "quest")) {
    const ops = questOps(c, c.world.read(npc, Npc).proto);
    if (ops.length > 0)
      return at(c, npc, () => {
        for (const op of ops) pushCmd(c, op);
      });
  }
  return "skip";
}

/** Travel step result: walking to the exit, or the command was sent (wait for the transition). */
function goTravel(c: AutoCtx, e: Entity, cmd: HeroCommand, note: string): StepResult {
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

/**
 * Back to the dungeon toward a clearLevel objective at `depth`
 * (dungeon.ts clearObjective): the open portal when it leads there (the
 * half-cleared level is kept), else the waypoint of that depth, else the
 * deepest waypoint above it (or the town stairs) and the stairs down from
 * there (dungeonStep walks on down to the objective).
 */
function objectiveReturn(
  c: AutoCtx,
  depth: number,
  dungeon: DungeonState,
  loop: boolean,
): StepResult {
  const avoid = c.st.deathDepth;
  if (dungeon.portal?.depth === depth && !loop && !(avoid > 0 && depth >= avoid)) {
    const portal = nearestInteractable(c, "portal");
    if (portal !== 0) return goTravel(c, portal, { op: "usePortal" }, "quest: portal");
  }
  let dest = 0;
  for (const w of dungeon.waypoints) if (w >= 1 && w <= depth && w > dest) dest = w;
  if (dest > 0) {
    const wp = nearestInteractable(c, "waypoint");
    if (wp !== 0)
      return goTravel(c, wp, { op: "waypoint", depth: dest }, `quest: waypoint ${dest}`);
  }
  const stairs = nearestInteractable(c, "stairsDown");
  if (stairs !== 0) return goTravel(c, stairs, { op: "stairs", target: stairs }, "quest: stairs");
  return "skip";
}

/**
 * True when the open portal leads back to a level whose boss still lives and
 * the hero is ready for it (dungeon.ts bossReady): that fight comes before a
 * clearLevel objective (the objective is taken up on a later return).
 */
function portalToBoss(c: AutoCtx, dungeon: DungeonState): boolean {
  const p = dungeon.portal;
  if (!p || p.depth !== dungeon.live || !isBossDepth(p.depth) || !dungeon.liveBossAlive)
    return false;
  if (dungeon.bossesKilled.includes(p.depth)) return false;
  return bossReady(effectiveLevel(c.world.get(c.hero, Level)?.level ?? 1, c.st), p.depth);
}

/**
 * True when the portal leads back to a boss the hero is ready for
 * (portalToBoss) and that boss is at or below half its life.
 */
function bossHalfDown(c: AutoCtx, dungeon: DungeonState): boolean {
  if (!portalToBoss(c, dungeon)) return false;
  const boss = liveBoss(c, dungeon.portal!.depth);
  const l = boss === 0 ? undefined : c.world.get(boss, Life);
  return l !== undefined && l.hp * 2 <= l.max;
}

/**
 * Back to the dungeon: toward a clearLevel quest objective first
 * (objectiveReturn; unless the portal leads back to a boss the hero is
 * ready for), then a Rift run once the main dungeon is done
 * (riftLoop.ts), else the open portal, else the deepest suitable waypoint,
 * else the town stairs.
 */
function returnStep(c: AutoCtx): StepResult {
  // Party: wait (bounded) for the followers' own errands and for them to gather.
  if (c.party && partyReturnWait(c)) return "wait";
  const dungeon = c.world.getResource<DungeonState>(RES.dungeon);
  // Quick retreats: the portal leads back into a fight the hero keeps losing. Not when it
  // leads to a boss the hero is ready for, has already brought below half life, and hurt
  // between the last two retreats from its depth: the wound is kept and pressing on wins
  // (warrior vs Vessa: the second retreat came with her at 14 % and the waypoint way back
  // lost the fight). Without that progress a half-dead boss that keeps winning is a loop.
  const loop =
    retreatLoop(c) &&
    !(
      dungeon !== undefined &&
      bossHalfDown(c, dungeon) &&
      bossRetreatProgress(c, dungeon.portal!.depth)
    );
  const goal = dungeon ? clearObjective(c) : 0;
  if (goal > 0 && dungeon && !portalToBoss(c, dungeon)) {
    const r = objectiveReturn(c, goal, dungeon, loop);
    if (r !== "skip") return r;
  }
  const rift = riftTownStep(c);
  if (rift !== "skip") return rift;
  const avoid = c.st.deathDepth;
  if (dungeon?.portal && !loop && !(avoid > 0 && dungeon.portal.depth >= avoid)) {
    const portal = nearestInteractable(c, "portal");
    if (portal !== 0) return goTravel(c, portal, { op: "usePortal" }, "portal");
  }
  const level = effectiveLevel(c.world.get(c.hero, Level)?.level ?? 1, c.st);
  let dest = 0;
  for (const w of dungeon?.waypoints ?? []) {
    if (w <= 0 || (c.cfg.maxDepth > 0 && w > c.cfg.maxDepth)) continue;
    if (monsterLevel(w) > level + 2) continue;
    // First return after a death: not deeper than that depth, and never through the portal
    // (it opens next to the pack that won); the waypoint is elsewhere on the level. Going
    // further up cost two 128x128 levels of walking (~10 000 ticks) per death. After
    // repeated deaths (caution >= 2) strictly above it: the same pack won twice.
    const limit = c.st.caution >= 2 ? c.st.deathDepth - 1 : c.st.deathDepth;
    if (c.st.deathDepth > 0 && w > Math.max(1, limit)) continue;
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
    case "repair":
      return repairStep(c);
    case "stash":
      return stashStep(c);
    case "buy":
      return buyStep(c);
    case "smith":
      return smithStep(c);
    case "craft":
      return craftStep(c, smithReserve(c));
    case "gamble":
      return gambleStep(c, smithReserve(c));
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
      // What the gambler handed over and is neither equipped nor kept gets sold right away.
      if (step === "gamble") st.todo.unshift("sell");
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

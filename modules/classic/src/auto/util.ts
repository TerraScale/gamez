/**
 * Shared helpers of the auto controller (classic.auto): the per-tick
 * context, intent writing, plan changes, and small read-only queries over
 * the hero's gear, belt and bag. Everything here is deterministic sim code.
 */
import {
  defineComponent,
  type ComponentType,
  type Entity,
  type FrozenRegistry,
  type SimContext,
  type World,
} from "@gamez/kernel";
import { INTERACT_RANGE, type HeroCommandBody } from "../actions.ts";
import { pushCommand } from "../bus.ts";
import {
  AreaTag,
  AutoState,
  Belt,
  Hero,
  Intent,
  Interactable,
  Inventory,
  Life,
  Mana,
  Npc,
  Pos,
  Supplies,
  Wallet,
  type AutoPlan,
  type HeroIntentValue,
  type InteractableKind,
} from "../components.ts";
import { emit, type ClassicEventBody } from "../events.ts";
import { pct, type TilePos } from "../fixed.ts";
import { partySize, purseOf } from "../party/shared.ts";
import {
  currentDepth,
  DEFAULT_AUTO_CONFIG,
  heroOf,
  RES,
  type AutoConfig,
  type ControlState,
} from "../resources.ts";
import {
  BALANCE_ID,
  KIND,
  type BalanceProto,
  type ClassProto,
  type ItemBaseProto,
  type ItemInstance,
  type NpcProto,
  type NpcRole,
} from "../types.ts";
import { getAreaMap, type ClassicMap } from "../world/maps.ts";

/**
 * Travel commitment of the auto controller (owner: classic.auto, on the
 * hero): set while the plan is descend or toTown, kept through the fights
 * and pickups that interrupt the walk, removed on any other plan or when the
 * area changes. While it holds, fights and loot stay close (LEAVE_*_RANGE).
 */
export const AutoLeave = defineComponent<{ plan: "descend" | "toTown"; depth: number }>(
  "classic.autoLeave",
);

/**
 * Retreat memory of the auto controller (owner: classic.auto, on the hero,
 * created lazily): the ticks and depths of the last three retreats, and the
 * life of the live boss at the depth of the last two (-1: none there). See
 * retreatLoop: quick retreats mean the portal leads back into a fight the
 * hero cannot win (no potions to buy), and the next return avoids the
 * portal. Two retreats from different depths alone are no loop (a retreat
 * from a boss fight followed by one on the next level used to send the hero
 * back by waypoint, re-walking the level), three are. The optional fields
 * came later: saves without the depths count as one depth, saves without
 * prev2 need two retreats from one depth, and saves without bossHp never
 * show boss progress (town.ts returnStep).
 */
export const AutoRetreats = defineComponent<{
  last: number;
  prev: number;
  depth?: number;
  prevDepth?: number;
  /** Third-last retreat (absent until three real retreats). */
  prev2?: number;
  prev2Depth?: number;
  /** Life of the live boss at `depth` / `prevDepth` when retreating, -1 when there was none. */
  bossHp?: number;
  prevBossHp?: number;
}>("classic.autoRetreats");
/** Two retreats from one depth closer than this (2 min), or three within twice this, avoid the portal on the way back. */
export const RETREAT_LOOP_TICKS = 2400;

/**
 * Records a retreat (town portal at low life). `bossHp` is the life of the
 * live boss at the current depth (dungeon.ts liveBoss), -1 when there is none.
 */
export function noteRetreat(c: AutoCtx, bossHp: number): void {
  const r = c.world.get(c.hero, AutoRetreats);
  if (r) {
    c.world.update(c.hero, AutoRetreats, {
      last: c.tick,
      prev: r.last,
      depth: c.depth,
      prevDepth: r.depth ?? c.depth,
      // The first record's prev is the -RETREAT_LOOP_TICKS placeholder, not a retreat.
      ...(r.prev > -RETREAT_LOOP_TICKS
        ? { prev2: r.prev, prev2Depth: r.prevDepth ?? r.depth ?? c.depth }
        : {}),
      bossHp,
      prevBossHp: r.bossHp ?? -1,
    });
  } else {
    c.world.add(c.hero, AutoRetreats, {
      last: c.tick,
      prev: -RETREAT_LOOP_TICKS,
      depth: c.depth,
      prevDepth: c.depth,
      bossHp,
      prevBossHp: -1,
    });
  }
}

/**
 * True when the retreats loop (see AutoRetreats): the last one is recent
 * (within W = RETREAT_LOOP_TICKS) and either the last two came from one
 * depth within W, or the last three came within 2 W from any depths
 * (alternating retreats from a waypoint level and the boss level below it).
 */
export function retreatLoop(c: AutoCtx): boolean {
  const r = c.world.get(c.hero, AutoRetreats);
  if (r === undefined || c.tick - r.last >= RETREAT_LOOP_TICKS) return false;
  const sameDepth = (r.depth ?? 0) === (r.prevDepth ?? 0) && r.last - r.prev < RETREAT_LOOP_TICKS;
  const three = r.prev2 !== undefined && r.last - r.prev2 < 2 * RETREAT_LOOP_TICKS;
  return sameDepth || three;
}

/**
 * True when the boss of `depth` lost life between the last two retreats,
 * both from `depth` (AutoRetreats.bossHp / prevBossHp): the retreats are
 * part of a fight the hero is winning, not a loop.
 */
export function bossRetreatProgress(c: AutoCtx, depth: number): boolean {
  const r = c.world.get(c.hero, AutoRetreats);
  if (r === undefined || r.bossHp === undefined || r.bossHp < 0) return false;
  if ((r.depth ?? 0) !== depth || (r.prevDepth ?? 0) !== depth) return false;
  return (r.prevBossHp ?? -1) > r.bossHp;
}

export type ValueOf<C> = C extends ComponentType<infer T> ? T : never;
export type AutoStateValue = ValueOf<typeof AutoState>;

/** Ticks between full re-plans. */
export const REPLAN_TICKS = 10;
/** Fight engagement radius (sub): 12 tiles. */
export const FIGHT_RANGE = 12 * 256;
/**
 * While the hero is leaving the level (plan descend/toTown, AutoLeave), only
 * foes this close (sub, 4 tiles) or attacking it are fought: a crowded level
 * always has an awake foe within FIGHT_RANGE, which would keep the hero from
 * ever reaching the stairs.
 */
export const LEAVE_FIGHT_RANGE = 4 * 256;
/** Loot search radius (sub): 12 tiles. */
export const LOOT_RANGE = 12 * 256;
/** Loot search radius while leaving the level (sub): 3 tiles, so loot does not pull the hero away. */
export const LEAVE_LOOT_RANGE = 3 * 256;
/** No looting with an awake enemy this close (sub): 6 tiles. */
export const LOOT_SAFE_RANGE = 6 * 256;
/** Same tile this long while walking = stuck. */
export const STUCK_TICKS = 40;
/** No voluntary town trip (bag full, restock) for this long after leaving town: 60 s. */
export const TRIP_COOLDOWN_TICKS = 1200;
/** Watchdog: this many area changes without a kill means a travel loop. */
export const WATCHDOG_HOPS = 6;
/** Watchdog: this long in a dungeon without a kill means a stall: 2 min. */
export const WATCHDOG_TICKS = 2400;
/** Watchdog fallback duration (no town trips, seek a fresh level): 3 min. */
export const STALL_TICKS = 3600;
/** Hero level the controller plans with: the real level minus 2 per caution step (recent deaths). */
export function effectiveLevel(level: number, st: AutoStateValue): number {
  return Math.max(1, level - 2 * st.caution);
}

/** Fight hysteresis: the fight plan holds this long after the last foe left the scan. */
export const FIGHT_LINGER_TICKS = 10;
/** Max entries of AutoState.ignore. */
export const IGNORE_MAX = 32;
/** Travel commands (portal/stairs/waypoint) are re-sent at most this often. */
export const TRAVEL_RETRY_TICKS = 20;
/** Margin (sub) kept under INTERACT_RANGE before an op is pushed directly. */
export const REACH = INTERACT_RANGE - 32;

/**
 * Town routine steps, in order (wave A: repair, craft, gamble; the stash
 * comes after them so the tabs see the final bag). A gamble that queued
 * something inserts a second "sell" right after it (town.ts townStep).
 */
export const TOWN_STEPS: readonly string[] = [
  "heal",
  "sell",
  "repair",
  "buy",
  "smith",
  "craft",
  "gamble",
  "stash",
  "quests",
  "return",
];

/** Fallback balance numbers when the registry has no balance prototype. */
const FALLBACK_BALANCE: Pick<
  BalanceProto,
  "respawnDelay" | "beltStack" | "tpScrollPrice" | "maxTpScrolls" | "stashSize"
> = { respawnDelay: 60, beltStack: 5, tpScrollPrice: 50, maxTpScrolls: 10, stashSize: 50 };

export function balanceOf(reg: FrozenRegistry): Partial<BalanceProto> & typeof FALLBACK_BALANCE {
  const b = reg.get<BalanceProto>(KIND.balance, BALANCE_ID);
  return b ? (b as BalanceProto) : FALLBACK_BALANCE;
}

export function configOf(world: World): AutoConfig {
  // Read-only (no rollback copy of the whole control state): callers never change it.
  return world.peekResource<ControlState>(RES.control)?.config ?? DEFAULT_AUTO_CONFIG;
}

/** Everything one controller tick needs, gathered once. */
export interface AutoCtx {
  world: World;
  ctx: SimContext;
  reg: FrozenRegistry;
  tick: number;
  hero: Entity;
  st: AutoStateValue;
  cfg: AutoConfig;
  map: ClassicMap;
  depth: number;
  /** Hero position (sub) and tile. */
  hx: number;
  hy: number;
  tx: number;
  ty: number;
  classProto: ClassProto | undefined;
  /** tick >= AutoState.thinkAt at the start of this tick (full re-plan and travel allowed). */
  due: boolean;
  /**
   * Party (docs/design/party.md §4.2): `hero` is the controlled hero
   * (GameState.hero). Commands and events of every other member carry
   * `hero`; the controlled hero's never do (bit-identical solo snapshots).
   */
  controlled: boolean;
  /** A party of two or more members: party rules apply (false = the solo game exactly). */
  party: boolean;
}

/**
 * Queues a HeroCommand for the context's hero: unchanged for the controlled
 * hero (solo producers stay bit-identical), with `hero` for any other member.
 */
export function pushCmd(c: AutoCtx, cmd: HeroCommandBody): void {
  pushCommand(c.world, c.controlled ? cmd : { ...cmd, hero: c.hero });
}

/** Emits a classic event about the context's hero (`hero` set for non-controlled members). */
export function emitFor(c: AutoCtx, ev: ClassicEventBody): void {
  emit(c.ctx, c.controlled ? ev : { ...ev, hero: c.hero });
}

/** The shared purse's gold (party/shared.ts purseOf; solo: the hero's Wallet). */
export function purseGold(c: AutoCtx): number {
  const purse = c.party ? purseOf(c.world) : c.hero;
  return c.world.get(purse, Wallet)?.gold ?? 0;
}

/** Town portal scrolls in the shared purse (solo: the hero's Supplies). */
export function purseScrolls(c: AutoCtx): number {
  const purse = c.party ? purseOf(c.world) : c.hero;
  return c.world.peek(purse, Supplies)?.tpScrolls ?? 0;
}

/** True when the world holds a party of two or more members (party rules apply). */
export function isParty(world: World): boolean {
  return partySize(world) > 1;
}

/** True when `hero` is the controlled hero (GameState.hero). */
export function isControlled(world: World, hero: Entity): boolean {
  return heroOf(world) === hero;
}

export function makeAutoCtx(world: World, ctx: SimContext, hero: Entity): AutoCtx {
  const st = ensureAutoState(world, hero, ctx.tick);
  const p = world.peek(hero, Pos)!;
  return {
    world,
    ctx,
    reg: ctx.registry,
    tick: ctx.tick,
    hero,
    st,
    cfg: configOf(world),
    map: getAreaMap(world, ctx.registry),
    depth: currentDepth(world),
    hx: p.x,
    hy: p.y,
    tx: p.x >> 8,
    ty: p.y >> 8,
    classProto: heroClass(world, ctx.registry, hero),
    due: ctx.tick >= st.thinkAt,
    controlled: heroOf(world) === hero,
    party: isParty(world),
  };
}

/** Adds AutoState to the hero when missing and returns the live value. */
export function ensureAutoState(world: World, hero: Entity, tick: number): AutoStateValue {
  if (!world.has(hero, AutoState)) {
    const p = world.read(hero, Pos);
    world.add(hero, AutoState, {
      plan: "none",
      focus: 0,
      frontierX: -1,
      frontierY: -1,
      todo: [],
      thinkAt: tick,
      lastTileX: p.x >> 8,
      lastTileY: p.y >> 8,
      stuck: 0,
      ignore: [],
      ...AUTO_STATE_EXTRA,
    });
  }
  const st = world.read(hero, AutoState);
  // Saves from before the watchdog fields: fill them in once.
  if (typeof st.caution !== "number") world.update(hero, AutoState, { ...AUTO_STATE_EXTRA });
  return world.read(hero, AutoState);
}

/** Defaults of the AutoState fields added after the first save format. */
const AUTO_STATE_EXTRA = {
  tripAt: 0,
  killsSeen: 0,
  killAt: 0,
  hops: 0,
  stallUntil: 0,
  foeAt: -1_000_000,
  deathAt: -1,
  deathDepth: 0,
  caution: 0,
  levelSeen: 1,
} as const;

/** Changes the plan (emits classic.auto.plan when it differs). */
export function setPlan(c: AutoCtx, plan: AutoPlan, note: string): void {
  if (c.st.plan === plan) return;
  c.st.plan = plan;
  emitFor(c, { type: "classic.auto.plan", plan, note });
}

type IntentBody =
  | { kind: "idle" }
  | { kind: "move"; x: number; y: number }
  | { kind: "skill"; skill: string; target: Entity; x: number; y: number; repeat: boolean }
  | { kind: "pickup"; target: Entity }
  | { kind: "interact"; target: Entity };

/** True when `cur` already expresses `next` (so the executor is not restarted). */
function sameIntent(cur: HeroIntentValue, next: IntentBody): boolean {
  if (cur.source !== "auto" || cur.kind !== next.kind) return false;
  switch (next.kind) {
    case "idle":
      return true;
    case "move": {
      const c = cur as Extract<HeroIntentValue, { kind: "move" }>;
      return c.x === next.x && c.y === next.y;
    }
    case "skill": {
      const c = cur as Extract<HeroIntentValue, { kind: "skill" }>;
      if (c.skill !== next.skill || c.target !== next.target) return false;
      // Entity targets are tracked by the executor; point casts re-aim past a tile.
      if (next.target !== 0) return true;
      return Math.abs(c.x - next.x) < 256 && Math.abs(c.y - next.y) < 256;
    }
    case "pickup":
    case "interact": {
      const c = cur as Extract<HeroIntentValue, { kind: "pickup" | "interact" }>;
      return c.target === next.target;
    }
  }
}

/** Writes the hero Intent (source "auto") unless it already says the same thing. */
export function setIntent(c: AutoCtx, body: IntentBody): void {
  const cur = c.world.get(c.hero, Intent);
  if (cur && sameIntent(cur, body)) return;
  c.world.add(c.hero, Intent, { ...body, source: "auto", at: c.tick } as HeroIntentValue);
}

export function moveTo(c: AutoCtx, tileX: number, tileY: number): void {
  setIntent(c, { kind: "move", x: tileX, y: tileY });
}

export function stopIntent(c: AutoCtx): void {
  const cur = c.world.peek(c.hero, Intent);
  if (cur && cur.kind !== "idle" && cur.source === "auto") setIntent(c, { kind: "idle" });
}

export function currentIntent(c: AutoCtx): Readonly<HeroIntentValue> | undefined {
  return c.world.peek(c.hero, Intent);
}

export function d2To(c: AutoCtx, x: number, y: number): number {
  const dx = x - c.hx;
  const dy = y - c.hy;
  return dx * dx + dy * dy;
}

export function inReach(c: AutoCtx, e: Entity): boolean {
  const p = c.world.get(e, Pos);
  return p !== undefined && d2To(c, p.x, p.y) <= REACH * REACH;
}

export function isIgnored(st: AutoStateValue, x: number, y: number): boolean {
  for (const t of st.ignore) if (t.x === x && t.y === y) return true;
  return false;
}

export function addIgnore(st: AutoStateValue, x: number, y: number): void {
  if (x < 0 || y < 0 || isIgnored(st, x, y)) return;
  st.ignore.push({ x, y } satisfies TilePos);
  while (st.ignore.length > IGNORE_MAX) st.ignore.shift();
}

// ---------------------------------------------------------------------------
// Entities of the current area
// ---------------------------------------------------------------------------

/** Npc entities in town with the given role (ascending ids). */
export function npcsByRole(c: AutoCtx, role: NpcRole): Entity[] {
  const out: Entity[] = [];
  for (const e of c.world.query(Npc, Pos, AreaTag)) {
    if (c.world.read(e, AreaTag).depth !== c.depth) continue;
    const proto = c.reg.get<NpcProto>(KIND.npc, c.world.read(e, Npc).proto);
    if (proto && proto.role === role) out.push(e);
  }
  return out;
}

/** Nearest NPC with `role` (ties: lower id), or 0. */
export function nearestNpc(c: AutoCtx, role: NpcRole): Entity {
  return nearestOf(c, npcsByRole(c, role));
}

/** Nearest Interactable of `kind` in the current area, or 0. */
export function nearestInteractable(c: AutoCtx, kind: InteractableKind): Entity {
  const list: Entity[] = [];
  for (const e of c.world.query(Interactable, Pos, AreaTag)) {
    if (c.world.read(e, AreaTag).depth !== c.depth) continue;
    if (c.world.read(e, Interactable).kind === kind) list.push(e);
  }
  return nearestOf(c, list);
}

function nearestOf(c: AutoCtx, list: Entity[]): Entity {
  let best = 0;
  let bestD = Number.MAX_SAFE_INTEGER;
  for (const e of list) {
    const p = c.world.read(e, Pos);
    const d = d2To(c, p.x, p.y);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Vitals, belt, bag
// ---------------------------------------------------------------------------

export function lifePct(c: AutoCtx): number {
  const l = c.world.peek(c.hero, Life);
  if (!l || l.max <= 0) return 100;
  return Math.floor((l.hp * 100) / l.max);
}

export function manaPct(c: AutoCtx): number {
  const m = c.world.peek(c.hero, Mana);
  if (!m || m.max <= 0) return 100;
  return Math.floor((m.mp * 100) / m.max);
}

export function potionOf(
  reg: FrozenRegistry,
  base: string | null,
): ItemBaseProto["potion"] | undefined {
  if (base === null) return undefined;
  return reg.get<ItemBaseProto>(KIND.itemBase, base)?.potion;
}

/** Number of potions in the belt that restore `kind` (rejuvenation counts for both). */
export function beltCount(c: AutoCtx, kind: "life" | "mana", withRejuv = true): number {
  const belt = c.world.peek(c.hero, Belt);
  if (!belt) return 0;
  let n = 0;
  for (const s of belt.slots) {
    if (s.count <= 0) continue;
    const p = potionOf(c.reg, s.base);
    if (p && (p.kind === kind || (withRejuv && p.kind === "rejuv"))) n += s.count;
  }
  return n;
}

/** True when a potion of `base` can go into the belt (matching stack with room or an empty slot). */
export function beltHasRoom(c: AutoCtx, base: string): boolean {
  const belt = c.world.peek(c.hero, Belt);
  if (!belt) return false;
  const stack = balanceOf(c.reg).beltStack;
  for (const s of belt.slots) {
    if (s.count <= 0 || s.base === null) return true;
    if (s.base === base && s.count < stack) return true;
  }
  return false;
}

export function itemSize(reg: FrozenRegistry, item: ItemInstance): { w: number; h: number } {
  return reg.get<ItemBaseProto>(KIND.itemBase, item.base)?.size ?? { w: 1, h: 1 };
}

/**
 * True when a `w`x`h` footprint fits in the bag, optionally pretending the
 * items with uids in `without` are gone (first-fit, rows then columns).
 */
export function bagFits(
  c: AutoCtx,
  w: number,
  h: number,
  without: readonly number[] = [],
): boolean {
  const inv = c.world.get(c.hero, Inventory);
  if (!inv) return false;
  const cols = inv.cols;
  const rows = inv.rows;
  const used = new Uint8Array(cols * rows);
  for (const en of inv.items) {
    if (without.includes(en.item.uid)) continue;
    const s = itemSize(c.reg, en.item);
    for (let y = en.y; y < en.y + s.h && y < rows; y++)
      for (let x = en.x; x < en.x + s.w && x < cols; x++) used[y * cols + x] = 1;
  }
  for (let y = 0; y + h <= rows; y++) {
    for (let x = 0; x + w <= cols; x++) {
      let ok = true;
      for (let yy = y; ok && yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++)
          if (used[yy * cols + xx] === 1) {
            ok = false;
            break;
          }
      if (ok) return true;
    }
  }
  return false;
}

export function heroClass(world: World, reg: FrozenRegistry, hero: Entity): ClassProto | undefined {
  const h = world.peek(hero, Hero);
  return h ? reg.get<ClassProto>(KIND.class, h.classId) : undefined;
}

/** Caster classes keep two mana slots in the belt (autoAlloc favours magic). */
export function isCasterClass(cls: ClassProto | undefined): boolean {
  return cls !== undefined && cls.autoAlloc.mag >= 2;
}

/** Potion restore amount for the hero (amount + pct of max, boosted by potionPct). */
export function potionAmount(
  p: NonNullable<ItemBaseProto["potion"]>,
  max: number,
  potionPctBonus: number,
): number {
  return pct(p.amount + pct(max, p.pct), 100 + potionPctBonus);
}

// ---------------------------------------------------------------------------
// Leaving the level (AutoLeave)
// ---------------------------------------------------------------------------

/**
 * True while the hero is committed to leaving the level: the plan is descend
 * or toTown, or a fight/pickup interrupted one on this level (AutoLeave).
 */
export function leaving(c: AutoCtx): boolean {
  if (c.depth === 0) return false;
  const plan = c.st.plan;
  if (plan === "descend" || plan === "toTown") return true;
  // "recover" = a telegraph dodge (dodge.ts) in the middle of the walk.
  if (plan !== "fight" && plan !== "loot" && plan !== "recover") return false;
  const l = c.world.get(c.hero, AutoLeave);
  return l !== undefined && l.depth === c.depth;
}

/** Keeps AutoLeave in step with the plan; called once at the end of every controller tick. */
export function syncLeave(c: AutoCtx): void {
  const plan = c.st.plan;
  const cur = c.world.get(c.hero, AutoLeave);
  if (c.depth > 0 && (plan === "descend" || plan === "toTown")) {
    if (!cur || cur.plan !== plan || cur.depth !== c.depth)
      c.world.add(c.hero, AutoLeave, { plan, depth: c.depth });
    return;
  }
  if (!cur) return;
  if (
    c.depth === 0 ||
    cur.depth !== c.depth ||
    (plan !== "fight" && plan !== "loot" && plan !== "recover")
  )
    c.world.remove(c.hero, AutoLeave);
}

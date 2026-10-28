/**
 * HUD model of the classic client (docs/design/classic.md §12, §13): turns the
 * sim world into a HudSnapshot (contract.ts). Pure: reads the world and the
 * frozen registry, never mutates them. Reads go through getResource/get, so a
 * partial module set (tests, stubs) shows defaults instead of throwing.
 *
 * buildHud() keeps structural sharing: sub-objects that did not change keep
 * their identity, so selector-based React components do not re-render.
 */
import type { Entity, FrozenRegistry, World } from "@gamez/kernel";
import {
  AreaTag,
  Attributes,
  AutoState,
  Belt,
  CombatStats,
  Dead,
  Equipment,
  Hero,
  HeroStats,
  Interactable,
  Intent,
  Inventory,
  Level,
  Life,
  Loot,
  Mana,
  Monster,
  Npc,
  Pos,
  SkillBar,
  SkillBook,
  Statuses,
  Supplies,
  Wallet,
  type HeroStatsValue,
} from "../components.ts";
import { itemScore } from "../auto/score.ts";
import { SUB } from "../fixed.ts";
import {
  DEFAULT_AUTO_CONFIG,
  RES,
  exploreAreaOf,
  exploredPct,
  type AreaState,
  type ControlState,
  type DungeonState,
  type ExploreArea,
  type GameState,
  type QuestState,
  type StashState,
  type VendorState,
} from "../resources.ts";
import {
  effectiveCooldown,
  effectiveManaCost,
  potionUnlocked,
  sellPrice,
  skillManaCost,
  xpAtLevel,
} from "../rules.ts";
import { skillModsOf } from "../bonus.ts";
import { lootFilterOf, type LootFilter } from "../resources.ts";
import { buildAchievementsView } from "./model/achievements.ts";
import type { ModelContext } from "./model/context.ts";
import {
  buildCraftView,
  buildGambleView,
  buildLootFilterView,
  buildStashTabs,
} from "./model/craft.ts";
import { buildDpsView } from "./model/dps.ts";
import { extendItemView } from "./model/items.ts";
import { buildRiftView } from "./model/rift.ts";
import { buildTalentsView } from "./model/talents.ts";
import {
  BALANCE_ID,
  KIND,
  type Attr,
  type AttrBlock,
  type BalanceProto,
  type ClassProto,
  type EquipSlot,
  type ItemBaseProto,
  type ItemInstance,
  type MonsterModProto,
  type NpcProto,
  type QuestProto,
  type SkillProto,
  type StatusProto,
} from "../types.ts";
import { getAreaMap, type ClassicMap } from "../world/maps.ts";
import {
  type AreaView,
  type BeltSlotView,
  type ControlView,
  type ItemCompare,
  type HeroView,
  type HudSnapshot,
  type ItemView,
  type MinimapData,
  type QuestView,
  type SkillBarSlot,
  type SkillView,
  type StatusView,
  type TargetView,
  type VendorView,
} from "./contract.ts";
import { itemLines, skillDetailLines, statDiffs, statTotals } from "./describe.ts";
import { depthLabel } from "./hud/format.ts";

/** Per-build inputs that are not in the world (client UI state). */
export interface HudContext {
  /** Sim tick of the snapshot. */
  tick: number;
  /** Monster under the pointer (0 = none). */
  hovered: Entity;
  /** Open vendor NPC entity (0 = none). */
  vendor: Entity;
  /** Previous snapshot, for structural sharing. */
  prev: HudSnapshot | null;
}

const BELT_KEYS = ["Q", "W", "E", "R"] as const;
const BAR_KEYS = ["1", "2", "3", "4", "5", "6"] as const;
const ALL_SLOTS: EquipSlot[] = [
  "weapon",
  "offhand",
  "helm",
  "armor",
  "gloves",
  "boots",
  "amulet",
  "ring1",
  "ring2",
];

function emptyEquipmentView(): Record<EquipSlot, ItemView | null> {
  const out = {} as Record<EquipSlot, ItemView | null>;
  for (const slot of ALL_SLOTS) out[slot] = null;
  return out;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Returns `prev` wherever the new value is structurally equal to it, and
 * `next` otherwise (recursively sharing the unchanged children).
 */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (prev === next) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev) || prev.length !== next.length) return next;
    let same = true;
    const out = next.map((v: unknown, i: number) => {
      const s = shareStructure(prev[i], v);
      if (s !== prev[i]) same = false;
      return s;
    });
    return (same ? prev : out) as T;
  }
  if (isPlain(next)) {
    if (!isPlain(prev)) return next;
    const nk = Object.keys(next);
    const pk = Object.keys(prev);
    if (nk.length !== pk.length) return next;
    let same = true;
    const out: Record<string, unknown> = {};
    for (const k of nk) {
      if (!(k in prev)) {
        same = false;
        out[k] = next[k];
        continue;
      }
      const s = shareStructure(prev[k], next[k]);
      out[k] = s;
      if (s !== prev[k]) same = false;
    }
    return (same ? prev : out) as T;
  }
  return next;
}

function balanceOf(registry: FrozenRegistry): BalanceProto | undefined {
  return registry.get<BalanceProto>(KIND.balance, BALANCE_ID);
}

function classOf(registry: FrozenRegistry, id: string): ClassProto | undefined {
  return registry.get<ClassProto>(KIND.class, id);
}

/** Junk buyer percent (NpcProto.buyPct of the first junk role, sorted by id). */
export function junkBuyPct(registry: FrozenRegistry): number {
  for (const [, npc] of registry.all<NpcProto>(KIND.npc)) {
    if (npc.role === "junk") return npc.buyPct;
  }
  return 0;
}

export interface ItemContext {
  registry: FrozenRegistry;
  heroLevel: number;
  /** Total attributes for requirement checks. */
  attrs: AttrBlock;
  primary: Attr;
  /** Equipped items for the upgrade hint (null = nothing equipped). */
  equipped: Record<EquipSlot, ItemInstance | null> | null;
  /** Junk buyer percent (0 = not sellable). */
  junkPct: number;
  /** Wave A: the loot filter for ItemView.filtered (absent = not evaluated). */
  lootFilter?: LootFilter | null;
}

/** Requirements check: level, strength and dexterity. */
export function meetsRequirements(base: ItemBaseProto, level: number, attrs: AttrBlock): boolean {
  return base.reqLevel <= level && base.reqStr <= attrs.str && base.reqDex <= attrs.dex;
}

/**
 * Comparison with the equipped item in the slot the item would gain most from
 * (the upgrade score is that slot's difference, rounded; > 0 = upgrade).
 */
function compareOf(
  item: ItemInstance,
  base: ItemBaseProto,
  c: ItemContext,
): { upgrade: number; compare: ItemCompare | null } {
  if (base.slots.length === 0) return { upgrade: 0, compare: null };
  const own = itemScore(c.registry, item, c.primary);
  let best: { slot: EquipSlot; cur: ItemInstance | null; delta: number } | null = null;
  for (const slot of base.slots) {
    const cur = c.equipped?.[slot] ?? null;
    const curScore = cur ? itemScore(c.registry, cur, c.primary) : 0;
    const delta = own - curScore;
    if (best === null || delta > best.delta) best = { slot, cur, delta };
  }
  if (best === null) return { upgrade: 0, compare: null };
  const curBase = best.cur
    ? c.registry.get<ItemBaseProto>(KIND.itemBase, best.cur.base)
    : undefined;
  const stats = statDiffs(statTotals(item, base), best.cur ? statTotals(best.cur, curBase) : {});
  const upgrade = Number.isFinite(best.delta) ? Math.round(best.delta) : 0;
  return {
    upgrade,
    compare: {
      slot: best.slot,
      equipped: best.cur ? { uid: best.cur.uid, name: best.cur.name } : null,
      stats,
    },
  };
}

/** Item view for the HUD: text lines, prices, usability and the comparison with the equipped item. */
export function itemView(item: ItemInstance, c: ItemContext): ItemView {
  const base = c.registry.get<ItemBaseProto>(KIND.itemBase, item.base);
  const category = base?.category ?? "armor";
  const cmp = base ? compareOf(item, base, c) : { upgrade: 0, compare: null };
  const view: ItemView = {
    uid: item.uid,
    base: item.base,
    baseName: base?.name,
    name: item.name,
    rarity: item.rarity,
    category,
    slots: base ? [...base.slots] : [],
    ilvl: item.ilvl,
    reqLevel: base?.reqLevel ?? 1,
    lines: itemLines(c.registry, item),
    value: item.value,
    sellPrice: c.junkPct > 0 ? sellPrice(item, c.junkPct) : 0,
    icon: base?.icon ?? "icon.item.missing",
    w: base?.size.w ?? 1,
    h: base?.size.h ?? 1,
    usable: base ? meetsRequirements(base, c.heroLevel, c.attrs) : false,
    upgrade: cmp.upgrade,
    compare: cmp.compare,
  };
  return extendItemView(view, item, {
    registry: c.registry,
    equipped: c.equipped,
    lootFilter: c.lootFilter ?? null,
  });
}

function heroStatsOf(world: World, e: Entity): HeroStatsValue | undefined {
  return world.get(e, HeroStats);
}

function heroView(
  world: World,
  registry: FrozenRegistry,
  e: Entity,
  bal: BalanceProto,
  tick: number,
): HeroView | null {
  const hero = world.get(e, Hero);
  const level = world.get(e, Level);
  const life = world.get(e, Life);
  const mana = world.get(e, Mana);
  const sheet = heroStatsOf(world, e);
  const stats = world.get(e, CombatStats);
  const pos = world.get(e, Pos);
  if (!hero || !level || !life || !mana || !sheet || !stats || !pos) return null;
  const cls = classOf(registry, hero.classId);
  const base = world.get(e, Attributes) ?? sheet.attrs;
  const wallet = world.get(e, Wallet);
  const supplies = world.get(e, Supplies);
  const dead = world.get(e, Dead);
  const xpStart = xpAtLevel(bal, level.level);
  const xpNext = level.level >= bal.maxLevel ? xpStart : xpAtLevel(bal, level.level + 1);
  return {
    entity: e,
    name: hero.name,
    classId: hero.classId,
    className: cls?.name ?? hero.classId,
    level: level.level,
    xp: level.xp,
    xpLevelStart: xpStart,
    xpNextLevel: xpNext,
    life: life.hp,
    lifeMax: life.max,
    mana: mana.mp,
    manaMax: mana.max,
    gold: wallet?.gold ?? 0,
    tpScrolls: supplies?.tpScrolls ?? 0,
    statPoints: level.statPoints,
    skillPoints: level.skillPoints,
    attrs: { ...sheet.attrs },
    baseAttrs: { ...base },
    sheet: { ...sheet, attrs: { ...sheet.attrs } },
    armor: stats.armor,
    dmgMin: stats.dmgMin,
    dmgMax: stats.dmgMax,
    toHit: stats.toHit,
    critPct: stats.critPct,
    attackSpeed: stats.attackSpeed,
    castSpeed: stats.castSpeed,
    moveSpeed: stats.moveSpeed,
    res: {
      fire: stats.resFire,
      cold: stats.resCold,
      lightning: stats.resLightning,
      poison: stats.resPoison,
    },
    dead: dead !== undefined,
    respawnIn: dead ? Math.max(0, dead.at + bal.respawnDelay - tick) : 0,
    x: pos.x / SUB,
    y: pos.y / SUB,
    statuses: statusViews(world, registry, e, tick),
  };
}

/** The hero's active statuses for the status bar, soonest to expire first (ties: id). */
export function statusViews(
  world: World,
  registry: FrozenRegistry,
  e: Entity,
  tick: number,
): StatusView[] {
  const list = world.get(e, Statuses)?.list ?? [];
  const out: StatusView[] = [];
  for (const s of list) {
    if (s.until <= tick) continue;
    const proto = registry.get<StatusProto>(KIND.status, s.id);
    out.push({
      id: s.id,
      name: proto?.name ?? s.id,
      kind: proto?.kind ?? "buff",
      secondsLeft: Math.ceil((s.until - tick) / 20),
      tint: proto?.tint ?? 0xffffff,
    });
  }
  out.sort((a, b) => a.secondsLeft - b.secondsLeft || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function areaName(world: World, registry: FrozenRegistry, depth: number): string {
  try {
    return getAreaMap(world, registry).name;
  } catch {
    return depthLabel(depth);
  }
}

function areaView(world: World, registry: FrozenRegistry): AreaView | null {
  const area = world.getResource<AreaState>(RES.area);
  if (!area) return null;
  const dungeon = world.getResource<DungeonState>(RES.dungeon);
  const explore: ExploreArea | undefined = exploreAreaOf(world, area.depth);
  return {
    depth: area.depth,
    name: areaName(world, registry, area.depth),
    theme: area.theme,
    isTown: area.depth === 0,
    exploredPct: explore ? exploredPct(explore) : area.depth === 0 ? 100 : 0,
    bossAlive: dungeon?.liveBossAlive ?? false,
    killed: dungeon?.liveKilled ?? 0,
    spawned: dungeon?.liveSpawned ?? 0,
    waypoints: dungeon ? [...dungeon.waypoints] : [0],
    deepest: dungeon?.deepest ?? 0,
    portalOpen: dungeon?.portal != null,
  };
}

function controlView(world: World, hero: Entity, tick: number): ControlView {
  const c = world.getResource<ControlState>(RES.control);
  const auto = hero ? world.get(hero, AutoState) : undefined;
  const mode = c?.mode ?? "manual";
  return {
    mode,
    speed: c?.speed ?? 1,
    config: c ? { ...c.config } : { ...DEFAULT_AUTO_CONFIG },
    overridden: c !== undefined && mode !== "manual" && tick < c.overrideUntil,
    plan: auto?.plan ?? "none",
  };
}

function skillBar(world: World, registry: FrozenRegistry, e: Entity, tick: number): SkillBarSlot[] {
  const bar = e ? world.get(e, SkillBar) : undefined;
  const book = e ? world.get(e, SkillBook) : undefined;
  const mana = e ? world.get(e, Mana) : undefined;
  const dead = e !== 0 && world.has(e, Dead);
  const slots: SkillBarSlot[] = [];
  for (let i = 0; i < BAR_KEYS.length; i++) {
    const id = bar?.slots[i] ?? null;
    const skill = id ? registry.get<SkillProto>(KIND.skill, id) : undefined;
    const rank = id ? (book?.ranks.find((r) => r.skill === id)?.rank ?? 0) : 0;
    const readyAt = id ? (book?.cooldowns.find((c) => c.skill === id)?.readyAt ?? 0) : 0;
    const cooldownLeft = Math.max(0, readyAt - tick);
    const mods = id && skill ? skillModsOf(world, registry, e, id) : null;
    const cost = skill && rank > 0 && mods ? effectiveManaCost(skill, rank, mods) : 0;
    slots.push({
      slot: i,
      key: BAR_KEYS[i]!,
      skill: skill && rank > 0 ? id : null,
      name: skill?.name ?? "",
      icon: skill?.icon ?? "",
      manaCost: cost,
      cooldownLeft,
      cooldown: skill && mods ? effectiveCooldown(skill, mods) : (skill?.cooldown ?? 0),
      usable:
        skill !== undefined && rank > 0 && !dead && cooldownLeft === 0 && (mana?.mp ?? 0) >= cost,
    });
  }
  return slots;
}

function beltView(world: World, registry: FrozenRegistry, e: Entity): BeltSlotView[] {
  const belt = e ? world.get(e, Belt) : undefined;
  const count = Math.max(BELT_KEYS.length, belt?.slots.length ?? 0);
  const out: BeltSlotView[] = [];
  for (let i = 0; i < count && i < BELT_KEYS.length; i++) {
    const s = belt?.slots[i];
    const base = s?.base ? registry.get<ItemBaseProto>(KIND.itemBase, s.base) : undefined;
    out.push({
      slot: i,
      key: BELT_KEYS[i]!,
      base: s?.base ?? null,
      name: base?.name ?? "",
      kind: base?.potion?.kind ?? null,
      count: s?.count ?? 0,
    });
  }
  return out;
}

function targetView(world: World, registry: FrozenRegistry, target: Entity): TargetView | null {
  if (target === 0 || !world.exists(target)) return null;
  const m = world.get(target, Monster);
  const life = world.get(target, Life);
  if (!m || !life || world.has(target, Dead)) return null;
  const mods: string[] = [];
  for (const id of m.mods) {
    const mod = registry.get<MonsterModProto>(KIND.monsterMod, id);
    if (mod) mods.push(mod.name);
  }
  return {
    entity: target,
    name: m.name,
    rarity: m.rarity,
    level: m.level,
    life: life.hp,
    lifeMax: life.max,
    mods,
  };
}

/** The monster the hero is currently attacking (skill intent target), or 0. */
function engagedTarget(world: World, hero: Entity): Entity {
  const intent = hero ? world.get(hero, Intent) : undefined;
  if (intent?.kind === "skill" && intent.target !== 0 && world.has(intent.target, Monster)) {
    return intent.target;
  }
  return 0;
}

function itemViewsOf(items: readonly ItemInstance[], c: ItemContext): ItemView[] {
  return items.map((it) => itemView(it, c));
}

function vendorView(
  world: World,
  registry: FrozenRegistry,
  npc: Entity,
  itemCtx: ItemContext,
): VendorView | null {
  if (npc === 0 || !world.exists(npc)) return null;
  const n = world.get(npc, Npc);
  if (!n) return null;
  const proto = registry.get<NpcProto>(KIND.npc, n.proto);
  if (!proto) return null;
  const bal = balanceOf(registry);
  const vendors = world.getResource<VendorState>(RES.vendors);
  const stock = vendors?.stocks.find((s) => s.npc === n.proto);
  const sells = proto.sells;
  const potions: VendorView["potions"] = [];
  const hero = heroOfWorld(world);
  const level = hero !== 0 ? (world.get(hero, Level)?.level ?? 1) : 1;
  for (const id of sells?.potions ?? []) {
    const base = registry.get<ItemBaseProto>(KIND.itemBase, id);
    // Higher tiers appear as the hero levels up (the buy op checks the same rule).
    if (base && potionUnlocked(base, level))
      potions.push({ base: id, name: base.name, price: base.value });
  }
  if (sells?.tpScroll) {
    potions.push({ base: "tp", name: "Town Portal Scroll", price: bal?.tpScrollPrice ?? 50 });
  }
  return {
    npc,
    proto: n.proto,
    name: proto.name,
    role: proto.role,
    greeting: proto.greeting,
    stock: (stock?.items ?? []).map((it) => ({
      ...itemView(it, itemCtx),
      price: it.value,
    })),
    potions,
    buyPct: proto.buyPct,
  };
}

function questViews(
  registry: FrozenRegistry,
  quests: QuestState | undefined,
  level: number,
): QuestView[] {
  const out: QuestView[] = [];
  const completed = quests?.completed ?? [];
  for (const [id, q] of registry.all<QuestProto>(KIND.quest)) {
    const active = quests?.active.find((a) => a.id === id);
    let state: QuestView["state"] | null = null;
    let progress = 0;
    if (completed.includes(id)) {
      state = "completed";
      progress = q.count;
    } else if (active) {
      state = active.done ? "done" : "active";
      progress = active.progress;
    } else if ((q.after === "" || completed.includes(q.after)) && q.reqLevel <= level) {
      state = "available";
    }
    if (state === null) continue;
    const giver = registry.get<NpcProto>(KIND.npc, q.giver);
    const item = q.reward.item ? `, ${q.reward.item} item` : "";
    out.push({
      id,
      name: q.name,
      description: q.description,
      giver: giver?.name ?? q.giver,
      state,
      progress,
      count: q.count,
      reward: `${q.reward.gold} gold, ${q.reward.xp} XP${item}`,
    });
  }
  return out;
}

function skillViews(
  registry: FrozenRegistry,
  cls: ClassProto | undefined,
  book: { ranks: { skill: string; rank: number }[] } | undefined,
  bar: (string | null)[],
  level: number,
  skillPoints: number,
): SkillView[] {
  const out: SkillView[] = [];
  for (const id of cls?.skills ?? []) {
    const s = registry.get<SkillProto>(KIND.skill, id);
    if (!s) continue;
    const rank = book?.ranks.find((r) => r.skill === id)?.rank ?? 0;
    const idx = bar.indexOf(id);
    out.push({
      id,
      name: s.name,
      description: [s.description, ...skillDetailLines(s, Math.max(1, rank))].join(" · "),
      icon: s.icon,
      rank,
      maxRank: s.maxRank,
      reqLevel: s.reqLevel,
      learnable: rank < s.maxRank && level >= s.reqLevel && skillPoints > 0,
      manaCost: skillManaCost(s, Math.max(1, rank)),
      cooldown: s.cooldown,
      onBar: idx >= 0 ? idx : null,
      tags: [...s.ai.tags],
    });
  }
  return out;
}

/** Empty snapshot for a world without balance (no content loaded). */
function emptySnapshot(registry: FrozenRegistry, tick: number): HudSnapshot {
  return {
    tick,
    phase: "choose",
    classes: registry.all<ClassProto>(KIND.class).map(([id, c]) => ({
      id,
      name: c.name,
      description: c.description,
    })),
    hero: null,
    area: null,
    control: {
      mode: "manual",
      speed: 1,
      config: { ...DEFAULT_AUTO_CONFIG },
      overridden: false,
      plan: "none",
    },
    skillBar: BAR_KEYS.map((key, i) => ({
      slot: i,
      key,
      skill: null,
      name: "",
      icon: "",
      manaCost: 0,
      cooldownLeft: 0,
      cooldown: 0,
      usable: false,
    })),
    belt: BELT_KEYS.map((key, i) => ({
      slot: i,
      key,
      base: null,
      name: "",
      kind: null,
      count: 0,
    })),
    target: null,
    inventory: { cols: 10, rows: 4, items: [] },
    equipment: emptyEquipmentView(),
    stash: [],
    stashSize: 0,
    skills: [],
    quests: [],
    vendor: null,
  };
}

/**
 * Builds the HUD snapshot of the world. `ctx.prev` is shared structurally
 * (unchanged parts keep identity).
 */
export function buildHud(world: World, registry: FrozenRegistry, ctx: HudContext): HudSnapshot {
  const bal = balanceOf(registry);
  const game = world.getResource<GameState>(RES.game);
  const phase: "choose" | "play" = game?.phase === "play" ? "play" : "choose";
  if (!bal) return shareStructure(ctx.prev, emptySnapshot(registry, ctx.tick));

  const hero = game && game.hero !== 0 && world.exists(game.hero) ? game.hero : 0;
  const heroV = hero ? heroView(world, registry, hero, bal, ctx.tick) : null;
  const level = heroV?.level ?? 1;
  const attrs: AttrBlock = heroV?.attrs ?? { str: 0, dex: 0, mag: 0, vit: 0 };
  const sheet = hero ? heroStatsOf(world, hero) : undefined;
  const primary: Attr = sheet?.primary ?? "str";
  const equipment = hero ? world.get(hero, Equipment) : undefined;
  const junkPct = junkBuyPct(registry);
  const itemCtx: ItemContext = {
    registry,
    heroLevel: level,
    attrs,
    primary,
    equipped: equipment ?? null,
    junkPct,
    lootFilter: lootFilterOf(world),
  };
  const bag = hero ? world.get(hero, Inventory) : undefined;
  const stash = world.getResource<StashState>(RES.stash);
  const book = hero ? world.get(hero, SkillBook) : undefined;
  const bar = hero ? world.get(hero, SkillBar) : undefined;
  const cls = heroV ? classOf(registry, heroV.classId) : undefined;
  const target = targetView(
    world,
    registry,
    ctx.hovered !== 0 && world.has(ctx.hovered, Monster) ? ctx.hovered : engagedTarget(world, hero),
  );
  const equipView = {} as Record<EquipSlot, ItemView | null>;
  for (const slot of ALL_SLOTS) {
    const it = equipment?.[slot] ?? null;
    equipView[slot] = it ? itemView(it, itemCtx) : null;
  }
  const bagCols = bag?.cols ?? bal.invCols;
  const bagRows = bag?.rows ?? bal.invRows;

  const snapshot: HudSnapshot = {
    tick: ctx.tick,
    phase,
    classes: registry.all<ClassProto>(KIND.class).map(([id, c]) => ({
      id,
      name: c.name,
      description: c.description,
    })),
    hero: heroV,
    area: areaView(world, registry),
    control: controlView(world, hero, ctx.tick),
    skillBar: skillBar(world, registry, hero, ctx.tick),
    belt: beltView(world, registry, hero),
    target,
    inventory: {
      cols: bagCols,
      rows: bagRows,
      items: (bag?.items ?? []).map((entry) => ({
        x: entry.x,
        y: entry.y,
        item: itemView(entry.item, itemCtx),
      })),
    },
    equipment: equipView,
    stash: itemViewsOf(stash?.items ?? [], itemCtx),
    stashSize: bal.stashSize,
    skills: skillViews(registry, cls, book, bar?.slots ?? [], level, heroV?.skillPoints ?? 0),
    quests: questViews(registry, world.getResource(RES.quests), level),
    vendor: ctx.vendor !== 0 ? vendorView(world, registry, ctx.vendor, itemCtx) : null,
  };
  // Wave A sections, one builder file each (src/client/model/).
  const mc: ModelContext = {
    world,
    registry,
    hero,
    heroView: heroV,
    tick: ctx.tick,
    vendor: ctx.vendor,
    itemView: (it) => itemView(it, itemCtx),
  };
  snapshot.talents = buildTalentsView(mc);
  snapshot.craft = buildCraftView(mc);
  snapshot.gamble = buildGambleView(mc);
  snapshot.rift = buildRiftView(mc);
  snapshot.achievements = buildAchievementsView(mc);
  snapshot.lootFilter = buildLootFilterView(mc);
  snapshot.stashTabs = buildStashTabs(mc);
  snapshot.dps = buildDpsView(mc);
  return shareStructure(ctx.prev, snapshot);
}

/** Minimap data of the current area. `explored` is null in town (all visible). */
export function minimapData(world: World, registry: FrozenRegistry): MinimapData | null {
  let map: ClassicMap;
  try {
    map = getAreaMap(world, registry);
  } catch {
    return null;
  }
  const area = world.getResource<AreaState>(RES.area);
  const depth = area?.depth ?? 0;
  const explore: ExploreArea | undefined = exploreAreaOf(world, depth);
  const explored = depth === 0 || !explore ? null : explore.bits;
  const isSeen = (x: number, y: number): boolean => {
    if (explored === null || !explore) return true;
    const i = y * explore.width + x;
    return ((explored[i >> 5] ?? 0) & (1 << (i & 31))) !== 0;
  };
  const hero = heroOfWorld(world);
  const heroPos = hero ? world.get(hero, Pos) : undefined;
  const dots: MinimapData["dots"] = [];
  for (const e of world.query(Monster, Pos, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth || world.has(e, Dead)) continue;
    const p = world.read(e, Pos);
    const tx = p.x >> 8;
    const ty = p.y >> 8;
    if (!isSeen(tx, ty)) continue;
    const rarity = world.read(e, Monster).rarity;
    const kind: "boss" | "champion" | "monster" =
      rarity === "boss"
        ? "boss"
        : rarity === "champion" || rarity === "unique"
          ? "champion"
          : "monster";
    dots.push({ x: tx, y: ty, kind });
  }
  for (const e of world.query(Npc, Pos, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth) continue;
    const p = world.read(e, Pos);
    if (isSeen(p.x >> 8, p.y >> 8)) dots.push({ x: p.x >> 8, y: p.y >> 8, kind: "npc" });
  }
  for (const e of world.query(Loot, Pos, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth) continue;
    const p = world.read(e, Pos);
    if (isSeen(p.x >> 8, p.y >> 8)) dots.push({ x: p.x >> 8, y: p.y >> 8, kind: "loot" });
  }
  for (const e of world.query(Interactable, Pos, AreaTag)) {
    if (world.read(e, AreaTag).depth !== depth) continue;
    const it = world.read(e, Interactable);
    const pos = world.read(e, Pos);
    if (it.kind === "stash") continue;
    if (!isSeen(pos.x >> 8, pos.y >> 8)) continue;
    const kind = it.kind === "waypoint" ? "waypoint" : it.kind === "portal" ? "portal" : "stairs";
    dots.push({ x: pos.x >> 8, y: pos.y >> 8, kind });
  }
  return {
    map,
    explored,
    heroX: heroPos ? heroPos.x / SUB : 0,
    heroY: heroPos ? heroPos.y / SUB : 0,
    dots,
  };
}

/** The hero entity from the game resource (0 when none). */
export function heroOfWorld(world: World): Entity {
  const g = world.getResource<GameState>(RES.game);
  if (!g || g.hero === 0 || !world.exists(g.hero)) return 0;
  return g.hero;
}

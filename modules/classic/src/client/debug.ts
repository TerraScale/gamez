/**
 * QA debug hooks of the classic client (tools/qa). Enabled with `?debug=1`;
 * without it nothing here is installed and the game pays nothing.
 *
 * window.__gamez (shared with the renderer, which adds the `render` getter):
 *   mode      "classic"
 *   sim       live getter: tick, area, depth, hero, counts, control, autoState, lastEvents...
 *   hud / ui / log  live getters over the client stores
 *   counters  cumulative totals, not ring-buffered: tick, ticksTotal, events{type: n}, slain, heroDeaths, ringDropped
 *   controls  setMode, setSpeed, newHero, interact, openPanel, act, ... (see ClassicDebugControls)
 *
 * URL parameters (independent of ?debug):
 *   ?seed=<n>              fresh deterministic sim with that seed (the local save is neither read nor written)
 *   ?class=<id>&autostart=1  skip the new-hero screen (id: "warrior" or "classic.warrior"); &name=<hero name>
 *
 * Read-only towards the sim: every change goes through api.act (kernel actions).
 */
import type { DispatchResult, Entity, FrozenRegistry, GameEvent, World } from "@gamez/kernel";
import { ACTION } from "../actions.ts";
import {
  AreaTag,
  AutoState,
  Dead,
  Interactable,
  Loot,
  Monster,
  Npc,
  Projectile,
  Talents,
} from "../components.ts";
import { DEBUG_GRANT } from "../debug/index.ts";
import type { InteractableKind } from "../components.ts";
import {
  achievementsOf,
  heroOf,
  lootFilterOf,
  RES,
  riftOf,
  type AreaState,
  type ControlState,
  type RunStats,
} from "../resources.ts";
import { KIND, type NpcProto } from "../types.ts";
import type { ClassicClientApi, PanelId, Settings } from "./contract.ts";
import { heroOfWorld } from "./hudModel.ts";
import type { ClassicGame } from "./game.ts";

export interface DebugParams {
  /** `?debug=1`: install window.__gamez. */
  debug: boolean;
  /** `?seed=<n>`: fresh sim with this seed, no save. */
  seed: number | null;
  /** `?class=<id>` normalised to a ClassProto id. */
  classId: string | null;
  /** `?autostart=1`: create the hero right away (needs `class`). */
  autostart: boolean;
  /** `?name=`: hero name for autostart (default "QA <Class>"). */
  name: string | null;
  /** `?cheats=1` (with debug=1): load the QA cheat module (classic.debug) in its own save slot. */
  cheats: boolean;
  /** `?fresh=1`: skip the save carry-over (a stored save of another version starts a new game). */
  fresh: boolean;
}

const MAX_EVENTS = 60;

function flag(v: string | null): boolean {
  return v === "1" || v === "true" || v === "yes";
}

/** "warrior" -> "classic.warrior"; ids with a dot pass through. */
export function normalizeClassId(id: string): string {
  const t = id.trim();
  return t.includes(".") ? t : `classic.${t.toLowerCase()}`;
}

export function readDebugParams(search: string): DebugParams {
  const q = new URLSearchParams(search);
  const seedText = q.get("seed");
  const seedNum = seedText === null ? Number.NaN : Number(seedText);
  const seed =
    Number.isSafeInteger(seedNum) && seedNum > 0 && seedNum <= 0x7fffffff ? seedNum : null;
  const cls = q.get("class");
  return {
    debug: flag(q.get("debug")),
    seed,
    classId: cls ? normalizeClassId(cls) : null,
    autostart: flag(q.get("autostart")),
    name: q.get("name"),
    cheats: flag(q.get("cheats")),
    fresh: flag(q.get("fresh")),
  };
}

/** Default autostart hero name: "QA Warrior". Valid for classic.newHero (1-16 chars). */
export function defaultHeroName(classId: string): string {
  const short = classId.slice(classId.lastIndexOf(".") + 1);
  const cap = short.charAt(0).toUpperCase() + short.slice(1);
  return `QA ${cap}`.slice(0, 16);
}

/** Collects event batches for window.__gamez.sim (ring buffer plus cumulative counts). */
export class EventProbe {
  readonly ring: { tick: number; ev: GameEvent }[] = [];
  readonly counts: Record<string, number> = {};
  readonly casts: Record<string, number> = {};
  readonly effects: Record<string, number> = {};
  slain = 0;
  heroDeaths = 0;
  /** Events pushed out of the ring (the cumulative `counts` above never drop anything). */
  ringDropped = 0;
  /** Stairs-down area changes since the last new hero (classic.area.changed via stairsDown). */
  descents = 0;

  push(events: readonly GameEvent[], tick: number): void {
    for (const ev of events) {
      this.counts[ev.type] = (this.counts[ev.type] ?? 0) + 1;
      if (ev.type === "classic.area.changed" && ev.via === "stairsDown") {
        this.descents++;
      }
      if (ev.type === "classic.cast") {
        const skill = String(ev.skill);
        const effect = String(ev.effect);
        this.casts[skill] = (this.casts[skill] ?? 0) + 1;
        this.effects[effect] = (this.effects[effect] ?? 0) + 1;
      } else if (ev.type === "classic.death") {
        if (ev.isHero === true) this.heroDeaths++;
        else this.slain++;
      }
      this.ring.push({ tick, ev });
    }
    if (this.ring.length > MAX_EVENTS) {
      const drop = this.ring.length - MAX_EVENTS;
      this.ring.splice(0, drop);
      this.ringDropped += drop;
    }
  }

  reset(): void {
    this.ring.length = 0;
    for (const r of [this.counts, this.casts, this.effects]) {
      for (const k of Object.keys(r)) delete r[k];
    }
    this.slain = 0;
    this.heroDeaths = 0;
    this.ringDropped = 0;
    this.descents = 0;
  }
}

/**
 * Ticks run by every sim of this page. A new sim (newHero, newGame) starts at
 * tick 0, so the total carries the ticks of the sim it replaces. That sim's
 * ticks are counted as of the last read, so ticks run between the last read
 * and the replacement are not included (QA reads are frequent, so the gap is small).
 */
export class TickTotals {
  private sim: object | null = null;
  private lastTick = 0;
  private base = 0;

  read(sim: object, tick: number): number {
    if (sim !== this.sim) {
      if (this.sim !== null) this.base += this.lastTick;
      this.sim = sim;
    }
    this.lastTick = tick;
    return this.base + tick;
  }
}

/** Shape of window.__gamez.counters. */
export interface CountersSummary {
  /** Kernel tick of the current sim. */
  tick: number;
  /** Ticks of every sim of this page (see TickTotals). */
  ticksTotal: number;
  /** Cumulative event counts by type since the last new hero (never ring-dropped). */
  events: Record<string, number>;
  slain: number;
  heroDeaths: number;
  /** Events the ring buffer of window.__gamez.sim has dropped since the last new hero. */
  ringDropped: number;
  /** Stairs-down descents since the last new hero (never ring-dropped). */
  descents: number;
}

export function countersSummary(
  sim: object & { tick: number },
  totals: TickTotals,
  probe: EventProbe,
): CountersSummary {
  return {
    tick: sim.tick,
    ticksTotal: totals.read(sim, sim.tick),
    events: { ...probe.counts },
    slain: probe.slain,
    heroDeaths: probe.heroDeaths,
    ringDropped: probe.ringDropped,
    descents: probe.descents,
  };
}

export type InteractTarget =
  | "healer"
  | "smith"
  | "alchemist"
  | "junk"
  | "quest"
  | "gambler"
  | "stash"
  | "waypoint"
  | "stairsDown"
  | "stairsUp"
  | "portal"
  /** The Rift obelisk (town). */
  | "obelisk"
  /** The exit of a rift level (appears when the guardian dies). */
  | "riftExit";

/** Interact targets that are stations (Interactable.kind), not NPC roles. */
const STATION_OF_TARGET: Readonly<Partial<Record<InteractTarget, InteractableKind>>> = {
  obelisk: "riftObelisk",
  riftExit: "riftExit",
};

export interface ClassicDebugControls {
  setMode(mode: "manual" | "auto" | "idle"): DispatchResult;
  setSpeed(speed: 1 | 2 | 4 | 8): DispatchResult;
  /** Wipes the hero (api.newGame) and creates a new one of `classId`. */
  newHero(classId: string, name?: string): DispatchResult;
  /** Alias of newHero(classId). */
  setClass(classId: string): DispatchResult;
  /** Seed of the current sim (the ?seed value when given). */
  readonly seed: number;
  act(name: string, payload: unknown): DispatchResult;
  /** Walks to and opens an NPC (by role) or station of the current area. */
  interact(target: InteractTarget): DispatchResult;
  openPanel(p: PanelId): void;
  closePanel(p: PanelId): void;
  togglePanel(p: PanelId): void;
  closeAll(): void;
  castSlot(slot: number): void;
  drink(slot: number): void;
  respawn(): DispatchResult;
  updateSettings(patch: Partial<Settings>): void;
  /**
   * QA grant (classic.debug.grant, `?debug=1&cheats=1` only): gold, levels,
   * items {count, rarity, ilvl, category?}, gems, unlockRift, bossesKilled,
   * deepest, talentPoints. Strictly validated by the sim.
   */
  cheat(payload: Record<string, unknown>): DispatchResult;
}

function depthOf(world: World): number {
  return world.getResource<AreaState>(RES.area)?.depth ?? 0;
}

function inArea(world: World, e: Entity, depth: number): boolean {
  return world.get(e, AreaTag)?.depth === depth;
}

/** Entity of an NPC role or station in the current area, or 0. */
export function findInteractable(
  world: World,
  registry: FrozenRegistry,
  target: InteractTarget,
): Entity {
  const depth = depthOf(world);
  const station = STATION_OF_TARGET[target];
  if (station === undefined) {
    for (const e of world.query(Npc)) {
      if (!inArea(world, e, depth)) continue;
      const proto = registry.get<NpcProto>(KIND.npc, world.read(e, Npc).proto);
      if (proto?.role === target) return e;
    }
  }
  for (const e of world.query(Interactable)) {
    if (!inArea(world, e, depth)) continue;
    const kind = world.read(e, Interactable).kind;
    if (station !== undefined ? kind === station : kind === target) return e;
  }
  return 0;
}

/** Wave A summaries for window.__gamez.sim: talents, rift, achievements, loot filter. */
export function waveASummary(world: World): Record<string, unknown> {
  const hero = heroOf(world);
  const t = hero !== 0 ? world.get(hero, Talents) : undefined;
  const rift = riftOf(world);
  const ach = achievementsOf(world);
  const filter = lootFilterOf(world);
  return {
    talents: t
      ? {
          points: t.points,
          spent: t.spent,
          ranks: t.ranks.map((r) => ({ node: r.node, rank: r.rank })),
        }
      : null,
    rift: rift
      ? {
          unlocked: rift.unlocked,
          maxCompleted: rift.maxCompleted,
          best: rift.best ? { level: rift.best.level, score: rift.best.score } : null,
          historyCount: rift.history.length,
          active: rift.active
            ? {
                level: rift.active.level,
                depth: rift.active.depth,
                progress: rift.active.progress,
                goal: rift.active.goal,
                guardianSpawned: rift.active.guardianSpawned,
              }
            : null,
        }
      : null,
    achievements: ach ? { unlocked: ach.unlocked.map((u) => u.id), title: ach.title } : null,
    lootFilter: filter,
  };
}

/** JSON-friendly sim summary for window.__gamez.sim. */
export function simSummary(
  world: World,
  tick: number,
  api: ClassicClientApi,
  probe: EventProbe,
): unknown {
  const hud = api.hud.getSnapshot();
  const depth = depthOf(world);
  let monstersAlive = 0;
  let summons = 0;
  let corpses = 0;
  let bossesAlive = 0;
  for (const e of world.query(Monster)) {
    if (!inArea(world, e, depth)) continue;
    const m = world.read(e, Monster);
    if (world.has(e, Dead)) {
      corpses++;
      continue;
    }
    if (m.rarity === "summon") summons++;
    else monstersAlive++;
    if (m.rarity === "boss") bossesAlive++;
  }
  let loot = 0;
  for (const e of world.query(Loot)) if (inArea(world, e, depth)) loot++;
  let projectiles = 0;
  for (const e of world.query(Projectile)) if (inArea(world, e, depth)) projectiles++;

  const heroE = heroOfWorld(world);
  const auto = heroE !== 0 ? world.get(heroE, AutoState) : undefined;
  const control = world.getResource<ControlState>(RES.control);
  const stats = world.getResource<RunStats>(RES.stats);
  const h = hud.hero;
  return {
    tick,
    phase: hud.phase,
    depth,
    area: hud.area
      ? {
          depth: hud.area.depth,
          name: hud.area.name,
          theme: hud.area.theme,
          isTown: hud.area.isTown,
          exploredPct: hud.area.exploredPct,
          killed: hud.area.killed,
          spawned: hud.area.spawned,
          bossAlive: hud.area.bossAlive,
          deepest: hud.area.deepest,
          portalOpen: hud.area.portalOpen,
        }
      : null,
    hero: h
      ? {
          class: h.classId,
          name: h.name,
          level: h.level,
          xp: h.xp,
          xpNext: h.xpNextLevel,
          life: h.life,
          lifeMax: h.lifeMax,
          mana: h.mana,
          manaMax: h.manaMax,
          gold: h.gold,
          tpScrolls: h.tpScrolls,
          potions: hud.belt.reduce((n, b) => n + b.count, 0),
          belt: hud.belt.map((b) => ({ base: b.base, kind: b.kind, count: b.count })),
          statPoints: h.statPoints,
          skillPoints: h.skillPoints,
          dead: h.dead,
          x: h.x,
          y: h.y,
          statuses: h.statuses.map((s) => s.id),
          skillBar: hud.skillBar.map((s) => s.skill),
        }
      : null,
    counts: {
      monstersAlive,
      bossesAlive,
      summons,
      corpses,
      slain: probe.slain,
      slainInArea: hud.area?.killed ?? 0,
      lootOnGround: loot,
      projectiles,
      heroDeaths: probe.heroDeaths,
    },
    runStats: stats ?? null,
    ...waveASummary(world),
    control: control
      ? {
          mode: control.mode,
          speed: control.speed,
          overridden: hud.control.overridden,
        }
      : null,
    autoState: auto
      ? {
          plan: auto.plan,
          focus: auto.focus,
          todo: auto.todo,
          frontier: auto.frontierX >= 0 ? { x: auto.frontierX, y: auto.frontierY } : null,
          stuck: auto.stuck,
          caution: auto.caution,
        }
      : null,
    eventCounts: probe.counts,
    casts: probe.casts,
    effects: probe.effects,
    lastEvents: probe.ring.map((r) => ({ tick: r.tick, ...r.ev })),
  };
}

export interface InstallOptions {
  game: ClassicGame;
  registry: FrozenRegistry;
  probe: EventProbe;
  /** Seed of the current sim (updated by newHero through the getter). */
  seed: () => number;
}

/** Installs window.__gamez for the classic mode. Returns the uninstall function. */
export function installClassicDebug(opts: InstallOptions): () => void {
  const { game, registry, probe } = opts;
  const api = game.api;
  const g = globalThis as { __gamez?: Record<string, unknown> };
  g.__gamez ??= {};
  const root = g.__gamez;

  const controls: ClassicDebugControls = {
    setMode: (mode) => api.act(ACTION.setControl, { mode }),
    setSpeed: (speed) => api.act(ACTION.setSpeed, { speed }),
    newHero(classId, name) {
      const id = normalizeClassId(classId);
      api.newGame();
      probe.reset();
      return api.act(ACTION.newHero, { classId: id, name: name ?? defaultHeroName(id) });
    },
    setClass(classId) {
      return controls.newHero(classId);
    },
    cheat: (payload) => api.act(DEBUG_GRANT, payload),
    get seed() {
      return opts.seed();
    },
    act: (name, payload) => api.act(name, payload),
    interact(target) {
      const sim = game.currentSim();
      const e = findInteractable(sim.world, registry, target);
      if (e === 0) {
        return {
          ok: false,
          events: [],
          tick: sim.tick,
          error: { code: "not_found", message: `no ${target} in this area` },
        };
      }
      return api.act(ACTION.interact, { target: e });
    },
    openPanel: (p) => api.openPanel(p),
    closePanel: (p) => api.closePanel(p),
    togglePanel: (p) => api.togglePanel(p),
    closeAll: () => api.closeAll(),
    castSlot: (slot) => api.castSlot(slot),
    drink: (slot) => api.drink(slot),
    respawn: () => api.act(ACTION.respawn, {}),
    updateSettings: (patch) => api.updateSettings(patch),
  };

  const totals = new TickTotals();
  const getters: Record<string, () => unknown> = {
    sim: () => {
      const sim = game.currentSim();
      return simSummary(sim.world, sim.tick, api, probe);
    },
    counters: () => countersSummary(game.currentSim(), totals, probe),
    hud: () => api.hud.getSnapshot(),
    ui: () => api.ui.getSnapshot(),
    log: () => api.log.getSnapshot().slice(-40),
  };
  root.mode = "classic";
  root.controls = controls;
  for (const [name, get] of Object.entries(getters)) {
    Object.defineProperty(root, name, { get, enumerable: true, configurable: true });
  }

  return () => {
    if (root.controls === controls) {
      delete root.controls;
      delete root.mode;
      for (const name of Object.keys(getters)) {
        if (Object.getOwnPropertyDescriptor(root, name)?.get === getters[name]) delete root[name];
      }
    }
  };
}

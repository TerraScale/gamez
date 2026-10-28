/**
 * The classic client game: owns the local sim, the fixed 20 Hz loop, the
 * scene sync, the event fan-out, pointer input and the stores behind the HUD
 * (ClassicClientApi, contract.ts). Every player input becomes a kernel action
 * through sim.dispatch(name, payload, "local"); the sim is only advanced with
 * sim.step(n). Nothing here mutates the sim world.
 *
 * Errors inside the frame loop never escape: they are shown in ui.error.
 */
import {
  createSim,
  type DispatchResult,
  type Entity,
  type GameEvent,
  type LoadedMode,
  type Sim,
  type World,
} from "@gamez/kernel";
import type { ArpgWorldRenderer, FloatTextSpec, PointerInfo } from "@gamez/ui-host";
import { ACTION } from "../actions.ts";
import { Ai, AreaTag, CombatStats, Dead, Intent, Monster, Pos, SkillBar } from "../components.ts";
import { dist, SUB } from "../fixed.ts";
import { RES, type AreaState, type ControlState, type GameState } from "../resources.ts";
import { KIND, type SkillProto } from "../types.ts";
import {
  type ClassicClientApi,
  type HudSnapshot,
  type LogLine,
  type MinimapData,
  type PanelId,
  type PerfView,
  type Settings,
  type Store,
  type Toast,
  type UiState,
} from "./contract.ts";
import {
  floatPolicy,
  planEvent,
  type EffectEnv,
  type FloatPolicy,
  type Visual,
} from "./effects.ts";
import { buildHud, heroOfWorld, minimapData } from "./hudModel.ts";
import { FixedLoop, PerfWindow } from "./loop.ts";
import { PointerInput, type PointerCommand } from "./input.ts";
import { SceneSync } from "./scene.ts";
import { sanitizeSettings, type SaveRecord, type SaveStore } from "./persist.ts";

export interface GameDeps {
  loaded: LoadedMode;
  sim: Sim;
  renderer: ArpgWorldRenderer;
  save: SaveStore;
  settings: Settings;
  /** Performance clock (ms): frame timing, toast and error expiry. */
  now(): number;
  /** Wall clock (ms), stored with the save for offline progress. */
  wall(): number;
  /** A fresh random seed for a new game. */
  newSeed(): number;
  /** Viewport width in CSS px (compact layout below 700). */
  viewportWidth(): number;
  /** Leaves the mode. */
  exit(): void;
  /** QA probe (`?debug=1`, debug.ts): hears every event batch the client fans out. */
  onEvents?(events: readonly GameEvent[]): void;
}

export interface ClassicGame {
  readonly api: ClassicClientApi;
  /** Writes the local save now (index.ts calls it every 10 s and on hide/unmount). */
  save(): boolean;
  /** Stops the frame work and pointer handling. The caller destroys the renderer. */
  destroy(): void;
  /** The current local sim (replaced by newGame). Read-only use: QA debug hooks. */
  currentSim(): Sim;
}

/** Keeps the most recent log lines. */
export const LOG_LIMIT = 200;
/** Toasts shown at once. */
export const TOAST_LIMIT = 4;

const COMPACT_WIDTH = 700;
const HUD_EVERY_MS = 100;
const PERIODIC_EVERY_MS = 250;
const ERROR_MS = 3000;
const FAIL_BACKOFF_MS = 1000;
/** The vendor panel closes when the hero is further than this (tiles) from the NPC. */
const TOWN_CLOSE_RANGE = 4;

interface Cell<T> {
  store: Store<T>;
  get(): T;
  set(next: T): void;
}

/** A mutable value with a selector-friendly store face (notifies only on change). */
export function cell<T>(initial: T): Cell<T> {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    store: {
      getSnapshot: () => value,
      subscribe(cb) {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
    },
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const cb of subs) cb();
    },
  };
}

/** True on touch-first devices (`(pointer: coarse)`); false without a DOM (tests, workers). */
function isCoarsePointer(): boolean {
  try {
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
    return typeof mm === "function" ? mm.call(globalThis, "(pointer: coarse)").matches : false;
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isLiveMonster(world: World, e: Entity): boolean {
  return e !== 0 && world.exists(e) && world.has(e, Monster) && !world.has(e, Dead);
}

function posOf(world: World, e: Entity): { x: number; y: number } {
  const p = e !== 0 && world.exists(e) ? world.get(e, Pos) : undefined;
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}

function phaseOf(world: World): "choose" | "play" {
  return world.getResource<GameState>(RES.game)?.phase === "play" ? "play" : "choose";
}

/** The monster the hero is attacking (skill intent target), or 0. */
function engagedTarget(world: World): Entity {
  const hero = heroOfWorld(world);
  const intent = hero ? world.get(hero, Intent) : undefined;
  if (intent?.kind === "skill" && isLiveMonster(world, intent.target)) return intent.target;
  return 0;
}

export function createClassicGame(deps: GameDeps): ClassicGame {
  const { loaded, renderer } = deps;
  const registry = loaded.registry;
  let sim: Sim = deps.sim;
  let settings: Settings = sanitizeSettings(deps.settings);
  let destroyed = false;

  const hud = cell<HudSnapshot>(
    buildHud(sim.world, registry, { tick: sim.tick, hovered: 0, vendor: 0, prev: null }),
  );
  const log = cell<readonly LogLine[]>([]);
  const ui = cell<UiState>({
    panels: [],
    toasts: [],
    settings,
    hover: null,
    compact: deps.viewportWidth() < COMPACT_WIDTH,
    perf: { fps: 0, tickMs: 0, ticksPerSecond: 0, entities: 0, monsters: 0 },
    error: null,
  });

  /** Touch-first device (evaluated once): interact hints say "tap" instead of "click". */
  const coarsePointer = isCoarsePointer();
  const loop = new FixedLoop();
  const perf = new PerfWindow();
  const scene = new SceneSync(renderer);
  let vendorNpc: Entity = 0;
  let logId = 1;
  let toastId = 1;
  let lastHudAt = Number.NEGATIVE_INFINITY;
  let lastPeriodicAt = Number.NEGATIVE_INFINITY;
  let backoffUntil = Number.NEGATIVE_INFINITY;
  let appliedZoom = Number.NaN;
  let alpha = 0;

  // ---- stores -----------------------------------------------------------------

  function setUi(patch: Partial<UiState>): void {
    ui.set({ ...ui.get(), ...patch });
  }

  function pushLog(kind: LogLine["kind"], text: string, color: number): void {
    const line: LogLine = { id: logId++, tick: sim.tick, kind, text, color };
    log.set([...log.get(), line].slice(-LOG_LIMIT));
  }

  function pushToast(kind: Toast["kind"], title: string, body: string, ms: number): void {
    const t: Toast = { id: toastId++, kind, title, body, until: deps.now() + ms };
    setUi({ toasts: [...ui.get().toasts, t].slice(-TOAST_LIMIT) });
  }

  function setError(code: string, message: string): void {
    setUi({ error: { code, message, until: deps.now() + ERROR_MS } });
  }

  function reportError(err: unknown): void {
    setError("client", errorText(err));
  }

  // Opening or closing a panel also clears the item tooltip: the hovered item may
  // belong to a panel that just unmounted, and its pointer-leave never fires.
  function openPanel(p: PanelId): void {
    const panels = ui.get().panels;
    if (!panels.includes(p)) setUi({ panels: [...panels, p], hover: null });
  }

  function closePanel(p: PanelId): void {
    const panels = ui.get().panels;
    if (panels.includes(p)) setUi({ panels: panels.filter((x) => x !== p), hover: null });
  }

  // ---- events -----------------------------------------------------------------

  function effectEnv(world: World): EffectEnv {
    const hero = heroOfWorld(world);
    const p = hero ? world.get(hero, Pos) : undefined;
    const control = world.getResource<ControlState>(RES.control);
    return {
      world,
      registry,
      hero,
      heroX: p ? p.x / SUB : 0,
      heroY: p ? p.y / SUB : 0,
      showDamageNumbers: settings.showDamageNumbers,
      manual: control === undefined || control.mode === "manual",
    };
  }

  /** Float budget of the batch being fanned out (floatPolicy of the current speed). */
  let floats: FloatPolicy = floatPolicy(1);
  let floatsLeft = Number.POSITIVE_INFINITY;

  function applyVisual(v: Visual): void {
    switch (v.kind) {
      case "float": {
        if (floats.dropMinor && v.size === "s") return;
        if (floatsLeft <= 0) return;
        floatsLeft--;
        const spec: FloatTextSpec = { x: v.x, y: v.y, text: v.text, color: v.color, size: v.size };
        if (floats.ms !== undefined) spec.ms = floats.ms;
        renderer.floatText(spec);
        return;
      }
      case "effect":
        renderer.playEffect(v.spec);
        return;
      case "log":
        pushLog(v.logKind, v.text, v.color);
        return;
      case "toast":
        pushToast(v.toastKind, v.title, v.body, v.ms);
        return;
      case "panel":
        openPanel(v.panel);
        return;
      case "vendor":
        vendorNpc = v.npc;
        return;
      case "error":
        setError(v.code, v.message);
        return;
    }
  }

  function fanOut(events: readonly GameEvent[]): void {
    if (events.length === 0) return;
    deps.onEvents?.(events);
    const env = effectEnv(sim.world);
    const control = sim.world.getResource<ControlState>(RES.control);
    floats = floatPolicy(control && control.mode === "idle" ? control.speed : 1);
    floatsLeft = floats.perBatch;
    // Events carry no tick: they all belong to the batch that just ran, whose
    // last processed tick is sim.tick - 1 (the scene's render time base).
    const hitTick = sim.tick - 1;
    for (const ev of events) {
      if (ev.type === "classic.hit" && ev.dot !== true && typeof ev.target === "number") {
        scene.noteHit(ev.target, hitTick);
      }
      let visuals: Visual[];
      try {
        visuals = planEvent(ev, env);
      } catch (err) {
        reportError(err);
        continue;
      }
      for (const v of visuals) applyVisual(v);
    }
  }

  // ---- HUD --------------------------------------------------------------------

  function refreshHud(): void {
    const world = sim.world;
    if (vendorNpc !== 0) {
      const hero = heroOfWorld(world);
      const hp = hero ? world.get(hero, Pos) : undefined;
      const np = world.exists(vendorNpc) ? world.get(vendorNpc, Pos) : undefined;
      const far =
        !hp ||
        !np ||
        Math.max(Math.abs(hp.x - np.x), Math.abs(hp.y - np.y)) > TOWN_CLOSE_RANGE * SUB;
      if (far) {
        vendorNpc = 0;
        closePanel("vendor");
      }
    }
    hud.set(
      buildHud(world, registry, {
        tick: sim.tick,
        hovered: pointer.hovered,
        vendor: vendorNpc,
        prev: hud.get(),
      }),
    );
  }

  // ---- actions ----------------------------------------------------------------

  function act(name: string, payload: unknown): DispatchResult {
    try {
      const res = sim.dispatch(name, payload, "local");
      if (!res.ok) {
        setError(res.error?.code ?? "error", res.error?.message ?? "Action failed");
        return res;
      }
      fanOut(res.events);
      refreshHud();
      return res;
    } catch (err) {
      reportError(err);
      return {
        ok: false,
        events: [],
        tick: sim.tick,
        error: { code: "internal", message: errorText(err) },
      };
    }
  }

  function barSkill(slot: number): string | null {
    const hero = heroOfWorld(sim.world);
    if (!hero) return null;
    return sim.world.get(hero, SkillBar)?.slots[slot] ?? null;
  }

  /** Casts bar slot `slot` at `target` (monster entity) or the point x/y (sub units). */
  function castWith(slot: number, target: Entity, x: number, y: number): void {
    const id = barSkill(slot);
    if (id === null) {
      setError("empty", `Skill slot ${slot + 1} is empty`);
      return;
    }
    const skill = registry.get<SkillProto>(KIND.skill, id);
    const repeat = skill?.ai.tags.includes("basic") ?? false;
    const p = target !== 0 ? posOf(sim.world, target) : { x, y };
    act(ACTION.useSkill, { skill: id, target, x: p.x, y: p.y, repeat });
  }

  /**
   * Target of a keyboard cast: the hovered monster, else the nearest awake
   * enemy within the skill's range, else the pointer point. Self skills need none.
   */
  function castTargetFor(skill: SkillProto): { target: Entity; x: number; y: number } {
    const world = sim.world;
    if (skill.target === "self") return { target: 0, x: 0, y: 0 };
    const hovered = pointer.hovered;
    if (isLiveMonster(world, hovered)) {
      const p = posOf(world, hovered);
      return { target: hovered, x: p.x, y: p.y };
    }
    const hero = heroOfWorld(world);
    const heroPos = hero ? world.get(hero, Pos) : undefined;
    if (hero && heroPos) {
      const range =
        skill.range > 0 ? skill.range : (world.get(hero, CombatStats)?.attackRange ?? 0);
      const depth = world.getResource<AreaState>(RES.area)?.depth ?? 0;
      let best: Entity = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (const e of world.query(Monster, Pos, AreaTag)) {
        if (world.read(e, AreaTag).depth !== depth || world.has(e, Dead)) continue;
        if (world.get(e, Ai)?.state === "sleep") continue;
        const p = world.read(e, Pos);
        const d = dist(heroPos.x, heroPos.y, p.x, p.y);
        if (d <= range && d < bestD) {
          best = e;
          bestD = d;
        }
      }
      if (best !== 0) {
        const p = posOf(world, best);
        return { target: best, x: p.x, y: p.y };
      }
    }
    const pt = pointer.pointer;
    return { target: 0, x: Math.round(pt.x * SUB), y: Math.round(pt.y * SUB) };
  }

  function onPointerCommand(cmd: PointerCommand): void {
    if (destroyed || phaseOf(sim.world) !== "play") return;
    switch (cmd.kind) {
      case "move":
        act(ACTION.moveTo, { x: cmd.x, y: cmd.y });
        return;
      case "attack":
        castWith(0, cmd.entity, 0, 0);
        return;
      case "cast":
        castWith(cmd.slot, cmd.stand ? 0 : cmd.entity, cmd.x, cmd.y);
        return;
      case "pickup":
        act(ACTION.pickup, { target: cmd.entity });
        return;
      case "interact":
        act(ACTION.interact, { target: cmd.entity });
        return;
    }
  }

  const pointer = new PointerInput({ pick: (x, y) => scene.pickAt(x, y) }, onPointerCommand);

  renderer.onPointer((p: PointerInfo) => {
    if (destroyed) return;
    try {
      pointer.handle(p);
    } catch (err) {
      reportError(err);
    }
  });

  // ---- frame ------------------------------------------------------------------

  function tickSim(dtMs: number, nowMs: number): void {
    const control = sim.world.getResource<ControlState>(RES.control);
    const speed = control && control.mode === "idle" ? control.speed : 1;
    const adv = loop.advance(dtMs, speed);
    alpha = adv.alpha;
    if (adv.ticks <= 0 || nowMs < backoffUntil) return;
    scene.capture(sim.world);
    const t0 = deps.now();
    let events: GameEvent[];
    try {
      events = sim.step(adv.ticks);
    } catch (err) {
      // The kernel rolled the failed step back; pause the sim briefly and show the error.
      backoffUntil = nowMs + FAIL_BACKOFF_MS;
      loop.reset();
      reportError(err);
      return;
    }
    perf.addSteps(adv.ticks, deps.now() - t0, nowMs);
    fanOut(events);
  }

  function renderFrame(): void {
    const world = sim.world;
    if (settings.zoom !== appliedZoom) {
      appliedZoom = settings.zoom;
      renderer.setZoom(settings.zoom);
    }
    scene.render({
      world,
      registry,
      alpha,
      hovered: pointer.hovered,
      targeted: engagedTarget(world),
      showLootLabels: settings.showLootLabels,
      lighting: settings.lighting,
      tick: sim.tick,
      touch: coarsePointer,
    });
  }

  /** Expiry of toasts and errors, compact layout and perf numbers. Writes only what changed. */
  function periodic(nowMs: number): void {
    if (nowMs - lastPeriodicAt < PERIODIC_EVERY_MS) return;
    lastPeriodicAt = nowMs;
    const state = ui.get();
    const patch: Partial<UiState> = {};
    const toasts = state.toasts.filter((t) => t.until > nowMs);
    if (toasts.length !== state.toasts.length) patch.toasts = toasts;
    const error = state.error && state.error.until > nowMs ? state.error : null;
    if (error !== state.error) patch.error = error;
    const compact = deps.viewportWidth() < COMPACT_WIDTH;
    if (compact !== state.compact) patch.compact = compact;
    const stats = scene.lastStats();
    const p = state.perf;
    if (
      perf.fps !== p.fps ||
      perf.tickMs !== p.tickMs ||
      perf.ticksPerSecond !== p.ticksPerSecond ||
      stats.entities !== p.entities ||
      stats.monsters !== p.monsters
    ) {
      const perfView: PerfView = {
        fps: perf.fps,
        tickMs: perf.tickMs,
        ticksPerSecond: perf.ticksPerSecond,
        entities: stats.entities,
        monsters: stats.monsters,
      };
      patch.perf = perfView;
    }
    if (Object.keys(patch).length > 0) setUi(patch);
  }

  function frame(dtMs: number): void {
    if (destroyed) return;
    const nowMs = deps.now();
    perf.frame(nowMs);
    try {
      pointer.update(dtMs);
      tickSim(dtMs, nowMs);
      renderFrame();
      if (nowMs - lastHudAt >= HUD_EVERY_MS) {
        lastHudAt = nowMs;
        refreshHud();
      }
      periodic(nowMs);
    } catch (err) {
      reportError(err);
    }
  }

  renderer.onFrame(frame);

  // ---- API --------------------------------------------------------------------

  function newGame(): void {
    deps.save.clear();
    sim = createSim(loaded, { seed: deps.newSeed() });
    scene.reset();
    loop.reset();
    backoffUntil = Number.NEGATIVE_INFINITY;
    vendorNpc = 0;
    pointer.cancel();
    appliedZoom = Number.NaN;
    setUi({ panels: [], toasts: [], error: null, hover: null });
    log.set([]);
    lastHudAt = Number.NEGATIVE_INFINITY;
    refreshHud();
  }

  function save(): boolean {
    try {
      const record: SaveRecord = { v: 1, savedAt: deps.wall(), snapshot: sim.snapshot(), settings };
      return deps.save.save(record);
    } catch (err) {
      reportError(err);
      return false;
    }
  }

  const api: ClassicClientApi = {
    hud: hud.store,
    log: log.store,
    ui: ui.store,
    act,
    togglePanel(p) {
      if (ui.get().panels.includes(p)) closePanel(p);
      else openPanel(p);
    },
    openPanel,
    closePanel,
    closeAll() {
      vendorNpc = 0;
      setUi({ panels: [], hover: null });
    },
    setHover(h) {
      setUi({ hover: h });
    },
    updateSettings(patch) {
      settings = sanitizeSettings({ ...settings, ...patch });
      setUi({ settings });
    },
    dismissToast(id) {
      setUi({ toasts: ui.get().toasts.filter((t) => t.id !== id) });
    },
    minimap(): MinimapData | null {
      try {
        return minimapData(sim.world, registry);
      } catch (err) {
        reportError(err);
        return null;
      }
    },
    castSlot(slot) {
      const id = barSkill(slot);
      if (id === null) {
        setError("empty", `Skill slot ${slot + 1} is empty`);
        return;
      }
      const skill = registry.get<SkillProto>(KIND.skill, id);
      if (!skill) return;
      const t = castTargetFor(skill);
      // An enemy skill with nothing to hit is reported, not sent (no mana spent, no silent no-op).
      if (skill.target === "enemy" && t.target === 0) {
        setError("no_target", "No target in range");
        return;
      }
      act(ACTION.useSkill, {
        skill: id,
        target: t.target,
        x: t.x,
        y: t.y,
        repeat: skill.ai.tags.includes("basic"),
      });
    },
    drink(slot) {
      act(ACTION.drinkPotion, { slot });
    },
    newGame,
    exit() {
      save();
      deps.exit();
    },
  };

  refreshHud();

  return {
    api,
    save,
    destroy() {
      destroyed = true;
      pointer.cancel();
    },
    currentSim: () => sim,
  };
}

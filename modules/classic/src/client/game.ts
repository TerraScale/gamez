/**
 * The classic client game: owns the local sim, the fixed 20 Hz loop, the
 * scene sync, the event fan-out, pointer input and the stores behind the HUD
 * (ClassicClientApi, contract.ts). Every player input becomes a kernel action
 * through sim.dispatch(name, payload, "local"); the sim is only advanced with
 * sim.step(n). Nothing here mutates the sim world.
 *
 * Wave B (docs/design/wave-B.md §2.5): with GameDeps.server the game is
 * server-backed. Every successful dispatch is reported to the hooks (they
 * record it as a segment input), steps are split so no segment outgrows its
 * limit, the hooks may cut a segment right after each step, server-only
 * actions are refused, and newGame asks the hooks for the sim to show until
 * the server's fresh state arrives. replaceSim swaps the sim after a resync.
 *
 * Wave C (docs/design/wave-C.md §2.5): api.bank is the server's BankClient
 * (GameDeps.bank) or, without a server, a local stand-in that is always
 * blocked "local". While ServerHooks.paused() (a bank op is out) the sim does
 * not step; dispatches are refused by ServerHooks.refuse.
 *
 * Offline grants (docs/design/offline-idle.md §6): the classic.offlineProgress
 * action only queues its grantXp / grantGold / grantItems commands, which land
 * on the next sim step. A batch carrying classic.offline.summary (a local
 * dispatch, or a server grant adopted through emit) is therefore held until
 * the next step and fanned out right after it, with a fresh HUD: the "While
 * you were away" card never shows next to the pre-grant XP, level or gold.
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
import type {
  ArpgWorldRenderer,
  FloatTextSpec,
  PlatformScreen,
  PlatformServices,
  PointerInfo,
} from "@gamez/ui-host";
import { ACTION } from "../actions.ts";
import type { ClassicEvent } from "../events.ts";
import {
  Ai,
  AreaTag,
  CombatStats,
  Dead,
  Faction,
  Hero,
  Intent,
  Monster,
  Pos,
  SkillBar,
} from "../components.ts";
import { dist, SUB } from "../fixed.ts";
import { RES, type AreaState, type ControlState, type GameState } from "../resources.ts";
import { KIND, type SkillProto } from "../types.ts";
import {
  type BankClient,
  type BankView,
  type ClassicClientApi,
  type HudSnapshot,
  type LogLine,
  type MinimapData,
  type PanelId,
  type PerfView,
  type Settings,
  type Store,
  type SyncView,
  LOCAL_SYNC_VIEW,
  type Toast,
  type UiState,
} from "./contract.ts";
import {
  LOG_COLOR,
  floatPolicy,
  planEvent,
  type EffectEnv,
  type FloatPolicy,
  type Visual,
} from "./effects.ts";
import { awayStore, buildHud, heroOfWorld, minimapData } from "./hudModel.ts";
import { FixedLoop, PerfWindow } from "./loop.ts";
import { PointerInput, type PointerCommand } from "./input.ts";
import { SceneSync } from "./scene.ts";
import { sanitizeSettings, type SaveRecord, type SaveStore } from "./persist.ts";
import { createAudio } from "./audio/index.ts";
import type { GraphicsQuality } from "./contract.ts";

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
  // ---- wave B (docs/design/wave-B.md §2.5, §7)
  /** Platform services for the social panels (null/absent: offline host). */
  platform?: PlatformServices | null;
  /** Signed-in session (null/absent: none). */
  session?: { accountId: string; name: string } | null;
  /** Server sync state store (absent: LOCAL_SYNC_VIEW forever). */
  sync?: Store<SyncView>;
  /** Called once per frame after the sim stepped and the scene rendered (town presence). */
  extraFrame?(sim: Sim, nowMs: number): void;
  /** Server mode: segment recording and server-only rules (sync/ServerSync implements it). */
  server?: ServerHooks;
  // ---- wave C (docs/design/wave-C.md §2.5)
  /** The hero <-> account bank (server mode); absent: a local stand-in blocked "local". */
  bank?: BankClient;
  /** Opens a shell screen (services.openScreen); absent offline. */
  openScreen?(screen: PlatformScreen): void;
}

/**
 * What the game asks the server sync (wave-B.md §2.5). All calls are made
 * synchronously around the sim's dispatch/step; none of them may mutate the sim.
 */
export interface ServerHooks {
  /** Before a dispatch: null when allowed, else why not (server-only action, full segment). */
  refuse(name: string): { code: string; message: string } | null;
  /** After a successful dispatch made while sim.tick === tick. */
  dispatched(tick: number, name: string, payload: unknown): void;
  /** Most ticks the next sim.step() may run (room left in the open segment, >= 1). */
  room(sim: Sim): number;
  /** Right after every successful sim.step() (the only place a segment may be cut). */
  stepped(sim: Sim, nowMs: number): void;
  /** newGame: the sim to show until the server's fresh instance arrives (it restarts the server). */
  newGame(seed: number): Sim;
  /** Wave C: true while a bank op is out; the sim does not step meanwhile. Optional. */
  paused?(): boolean;
}

export interface ClassicGame {
  readonly api: ClassicClientApi;
  /** Writes the local save now (index.ts calls it every 10 s and on hide/unmount). */
  save(): boolean;
  /** Shows a toast (index.ts: the save carry-over notice). */
  notify(kind: Toast["kind"], title: string, body: string, ms?: number): void;
  /** Stops the frame work and pointer handling. The caller destroys the renderer. */
  destroy(): void;
  /** The current local sim (replaced by newGame). Read-only use: QA debug hooks. */
  currentSim(): Sim;
  /**
   * Swaps in another sim (server resync, adopted server state): resets the
   * scene, loop, pointer and panels like newGame, keeps the log and toasts.
   * keepUi: panels and the hover stay (a quiet bank resync).
   */
  replaceSim(next: Sim, opts?: { keepUi?: boolean }): void;
  /** Fans events out like the sim's own (server offline-progress summary). */
  emit(events: readonly GameEvent[]): void;
  /** Adds a system line to the log. */
  log(text: string): void;
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
/** Long toast (boss, rift and achievement news, carry-over notice). */
const TOAST_LONG_MS = 7000;
/** Colour of system log lines (server sync notices). */
const SYSTEM_LOG_COLOR = 0x9fb3c8;
/** Party toasts (docs/design/party.md §10.5): short, so a busy party does not bury the screen. */
export const PARTY_TOAST_MS = 4000;

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

/** The bank without a server (seeded runs, cheats, offline hosts): always blocked "local". */
export const LOCAL_BANK: BankClient = {
  view: {
    getSnapshot: (): BankView => LOCAL_BANK_VIEW,
    subscribe: () => () => {},
  },
  run: async () => ({
    ok: false,
    code: "unavailable",
    message: "The bank needs your account on the server",
  }),
};
const LOCAL_BANK_VIEW: BankView = { blocked: "local", last: null };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A living hostile monster (hero-team summons such as the Spark Sentry are not). */
function isLiveMonster(world: World, e: Entity): boolean {
  return (
    e !== 0 &&
    world.exists(e) &&
    world.has(e, Monster) &&
    !world.has(e, Dead) &&
    world.get(e, Faction)?.team !== "hero"
  );
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

/** What the feedback filter knows: the controlled hero and how to name a member. */
export interface FeedbackEnv {
  controlled: Entity;
  nameOf(e: Entity): string;
}

/** Name of a hero entity for feedback text ("Hero" when it is gone). */
export function heroNameIn(world: World, e: Entity): string {
  if (e === 0 || !world.exists(e)) return "Hero";
  return world.get(e, Hero)?.name ?? "Hero";
}

function partyLines(ev: GameEvent, env: FeedbackEnv): Visual[] {
  const e = ev as unknown as ClassicEvent;
  const log = (text: string, color: number): Visual => ({
    kind: "log",
    logKind: "system",
    text,
    color,
  });
  const toast = (title: string, body: string, kind: Toast["kind"] = "info"): Visual => ({
    kind: "toast",
    toastKind: kind,
    title,
    body,
    ms: PARTY_TOAST_MS,
  });
  const nameOf = (h: Entity | undefined): string => env.nameOf(h ?? 0);
  switch (e.type) {
    case "classic.party.recruited":
      return [
        log(`${e.name} joins the party (level ${e.level})`, LOG_COLOR.system),
        toast("Party", `${e.name} joined the party`),
      ];
    case "classic.party.dismissed": {
      const items =
        e.stashed > 0 ? `; ${e.stashed} item${e.stashed === 1 ? "" : "s"} to the stash` : "";
      return [
        log(`${e.name} leaves the party${items}`, LOG_COLOR.system),
        toast("Party", `${e.name} left the party`),
      ];
    }
    case "classic.party.renamed":
      return [log(`Renamed to ${e.name}`, LOG_COLOR.system)];
    case "classic.party.control": {
      const name = nameOf(e.hero);
      if (e.reason === "death") {
        return [
          log(`Control passes to ${name}`, LOG_COLOR.system),
          toast("Control", `${name} takes control`),
        ];
      }
      return [log(`Control: ${name}`, LOG_COLOR.system)];
    }
    case "classic.party.config":
      return [log("Party AI options changed", LOG_COLOR.system)];
    case "classic.party.slots":
      return [
        log(
          e.via === "gold"
            ? `Party slot ${e.slots} bought for ${e.cost} gold`
            : `Party slot ${e.slots} unlocked`,
          LOG_COLOR.level,
        ),
        toast("Party slots", `${e.slots} of 4 slots unlocked`),
      ];
    case "classic.party.downed":
      return [
        log(`${e.name} is down`, LOG_COLOR.death),
        toast("Party", `${e.name} is down. Click them to revive.`, "death"),
      ];
    case "classic.party.reviving":
      return [log(`${nameOf(e.by)} starts reviving ${nameOf(e.hero)}`, LOG_COLOR.system)];
    case "classic.party.reviveCancelled":
      return [log(`Revive of ${nameOf(e.hero)} cancelled`, LOG_COLOR.system)];
    case "classic.party.revived": {
      const name = nameOf(e.hero);
      const text =
        e.via === "ally"
          ? `${name} is back on their feet`
          : e.via === "town"
            ? `${name} returns to the party in town`
            : `${name} is revived`;
      return [log(text, LOG_COLOR.quest), toast("Party", text)];
    }
    case "classic.party.wiped":
      return [
        log("Your party has fallen", LOG_COLOR.death),
        toast("Party", "Your party has fallen", "death"),
      ];
    case "classic.party.itemGiven":
      return [log(`${nameOf(e.from)} gives ${e.name} to ${nameOf(e.to)}`, LOG_COLOR.system)];
    default:
      return [];
  }
}

/**
 * Feedback of one event (docs/design/party.md §10.5). Events about the controlled hero (no `hero`
 * field, or the controlled entity) keep every visual. A follower's event keeps only compact feedback:
 * its log lines, named ("Brannoc: Learned Strike"), and a small toast when it levels up. Floating
 * numbers, effects on the controlled hero, panels, vendors and shakes stay with the controlled hero.
 * Party events (classic.party.*) drop the planned log and toast and get the lines above instead.
 */
export function feedbackFor(ev: GameEvent, visuals: Visual[], env: FeedbackEnv): Visual[] {
  const e = ev as unknown as { type: string; hero?: Entity; level?: number };
  if (e.type.startsWith("classic.party.")) {
    return [
      ...visuals.filter((v) => v.kind !== "log" && v.kind !== "toast"),
      ...partyLines(ev, env),
    ];
  }
  const hero = e.hero ?? 0;
  if (hero === 0 || hero === env.controlled) return visuals;
  const name = env.nameOf(hero);
  if (e.type === "classic.levelUp") {
    return [
      {
        kind: "log",
        logKind: "level",
        text: `${name} reached level ${e.level ?? 0}`,
        color: LOG_COLOR.level,
      },
      {
        kind: "toast",
        toastKind: "info",
        title: name,
        body: `Reached level ${e.level ?? 0}`,
        ms: PARTY_TOAST_MS,
      },
    ];
  }
  // The hero's own death and respawn lines do not fit another member; the party events say it.
  if (e.type === "classic.hero.died" || e.type === "classic.hero.respawned") return [];
  const out: Visual[] = [];
  for (const v of visuals) {
    if (v.kind === "log") out.push({ ...v, text: `${name}: ${v.text}` });
    else if (v.kind === "effect" && v.spec.kind !== "levelup") out.push(v);
    else if (v.kind === "error") out.push(v);
  }
  return out;
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
  /** The gambler NPC whose panel is open (closed when the hero walks away). */
  let gamblerNpc: Entity = 0;
  let logId = 1;
  let toastId = 1;
  let lastHudAt = Number.NEGATIVE_INFINITY;
  let lastPeriodicAt = Number.NEGATIVE_INFINITY;
  let backoffUntil = Number.NEGATIVE_INFINITY;
  let appliedZoom = Number.NaN;
  let alpha = 0;
  /** An offline-grant batch waiting for the step that applies its commands (see the header). */
  let heldGrant: GameEvent[] | null = null;
  // Wave A: procedural audio (audio/index.ts) and renderer quality.
  const audio = createAudio({ registry, settings });
  let appliedQuality: GraphicsQuality | null = null;

  /** "auto" -> medium on touch-first or narrow screens, else high. */
  function resolveQuality(q: GraphicsQuality): "low" | "medium" | "high" {
    if (q !== "auto") return q;
    return coarsePointer || deps.viewportWidth() < COMPACT_WIDTH ? "medium" : "high";
  }

  function applyQuality(): void {
    if (settings.quality === appliedQuality) return;
    appliedQuality = settings.quality;
    try {
      renderer.setQuality?.(resolveQuality(settings.quality));
    } catch (err) {
      reportError(err);
    }
  }

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
      speed: control && control.mode === "idle" ? control.speed : 1,
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
      case "away":
        awayStore.set(v.view);
        return;
      case "panel":
        openPanel(v.panel);
        return;
      case "vendor":
        vendorNpc = v.npc;
        gamblerNpc = 0;
        return;
      case "gambler":
        gamblerNpc = v.npc;
        vendorNpc = 0;
        return;
      case "shake":
        try {
          renderer.shake?.(v.strength, v.ms);
        } catch (err) {
          reportError(err);
        }
        return;
      case "error":
        setError(v.code, v.message);
        return;
    }
  }

  /**
   * fanOut, except for a batch with an offline summary: that one waits for the
   * next step (the grant's commands apply on it). A second batch before that
   * step joins the first.
   */
  function fanOutOrHold(events: readonly GameEvent[]): void {
    if (!events.some((e) => e.type === "classic.offline.summary")) {
      fanOut(events);
      return;
    }
    if (heldGrant === null) heldGrant = [...events];
    else for (const e of events) heldGrant.push(e);
  }

  function fanOut(events: readonly GameEvent[]): void {
    if (events.length === 0) return;
    deps.onEvents?.(events);
    const env = { ...effectEnv(sim.world), batch: events };
    const control = sim.world.getResource<ControlState>(RES.control);
    floats = floatPolicy(control && control.mode === "idle" ? control.speed : 1);
    floatsLeft = floats.perBatch;
    // Events carry no tick: they all belong to the batch that just ran, whose
    // last processed tick is sim.tick - 1 (the scene's render time base).
    const hitTick = sim.tick - 1;
    try {
      audio.onEvents(events, {
        hero: env.hero,
        heroX: env.heroX,
        heroY: env.heroY,
        speed: control && control.mode === "idle" ? control.speed : 1,
      });
    } catch (err) {
      reportError(err);
    }
    for (const ev of events) {
      if (ev.type === "classic.hit" && ev.dot !== true && typeof ev.target === "number") {
        scene.noteHit(ev.target, hitTick);
      }
      let visuals: Visual[];
      try {
        visuals = feedbackFor(ev, planEvent(ev, env), {
          controlled: env.hero,
          nameOf: (e) => heroNameIn(sim.world, e),
        });
      } catch (err) {
        reportError(err);
        continue;
      }
      for (const v of visuals) applyVisual(v);
    }
  }

  // ---- HUD --------------------------------------------------------------------

  /** True when the hero is no longer within TOWN_CLOSE_RANGE of `npc` (or either is gone). */
  function npcOutOfReach(npc: Entity): boolean {
    const world = sim.world;
    const hero = heroOfWorld(world);
    const hp = hero ? world.get(hero, Pos) : undefined;
    const np = world.exists(npc) ? world.get(npc, Pos) : undefined;
    return (
      !hp || !np || Math.max(Math.abs(hp.x - np.x), Math.abs(hp.y - np.y)) > TOWN_CLOSE_RANGE * SUB
    );
  }

  function refreshHud(): void {
    const world = sim.world;
    if (vendorNpc !== 0 && npcOutOfReach(vendorNpc)) {
      vendorNpc = 0;
      closePanel("vendor");
    }
    if (gamblerNpc !== 0 && npcOutOfReach(gamblerNpc)) {
      gamblerNpc = 0;
      closePanel("gamble");
    }
    hud.set(
      buildHud(world, registry, {
        tick: sim.tick,
        hovered: pointer.hovered,
        // One trade NPC at a time: the gambler's view is built from the same slot.
        vendor: vendorNpc !== 0 ? vendorNpc : gamblerNpc,
        prev: hud.get(),
      }),
    );
  }

  // ---- actions ----------------------------------------------------------------

  function act(name: string, payload: unknown): DispatchResult {
    try {
      const refused = deps.server?.refuse(name) ?? null;
      if (refused !== null) {
        setError(refused.code, refused.message);
        return { ok: false, events: [], tick: sim.tick, error: refused };
      }
      const tick = sim.tick;
      const res = sim.dispatch(name, payload, "local");
      if (!res.ok) {
        setError(res.error?.code ?? "error", res.error?.message ?? "Action failed");
        return res;
      }
      deps.server?.dispatched(tick, name, payload);
      fanOutOrHold(res.events);
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
        // Hero-team units (the hero's own Spark Sentry) are never keyboard targets.
        if (world.get(e, Faction)?.team === "hero") continue;
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

  /**
   * sim.step(ticks), split so a server segment never outgrows its limit, with
   * the server hook after every step (where it may cut a segment).
   */
  function stepSim(ticks: number, nowMs: number): GameEvent[] {
    const server = deps.server;
    if (!server) return sim.step(ticks);
    let events: GameEvent[] | null = null;
    let left = ticks;
    while (left > 0) {
      const n = Math.max(1, Math.min(left, Math.floor(server.room(sim))));
      const batch = sim.step(n);
      left -= n;
      server.stepped(sim, nowMs);
      if (events === null) events = batch;
      else for (const ev of batch) events.push(ev);
      // A bank op went out right after this step: hold here (the rest of the frame's ticks are dropped).
      if (server.paused?.()) {
        loop.reset();
        break;
      }
    }
    return events ?? [];
  }

  function tickSim(dtMs: number, nowMs: number): void {
    const control = sim.world.getResource<ControlState>(RES.control);
    const speed = control && control.mode === "idle" ? control.speed : 1;
    if (deps.server?.paused?.()) {
      // A bank op is out: hold the sim (no time accrues) until it is answered.
      alpha = 0;
      return;
    }
    const adv = loop.advance(dtMs, speed);
    alpha = adv.alpha;
    if (adv.ticks <= 0 || nowMs < backoffUntil) return;
    scene.capture(sim.world);
    const t0 = deps.now();
    let events: GameEvent[];
    try {
      events = stepSim(adv.ticks, nowMs);
    } catch (err) {
      // The kernel rolled the failed step back; pause the sim briefly and show the error.
      backoffUntil = nowMs + FAIL_BACKOFF_MS;
      loop.reset();
      reportError(err);
      return;
    }
    const spent = deps.now() - t0;
    perf.addSteps(adv.ticks, spent, nowMs);
    // Feeds the per-frame sim budget (loop.ts FRAME_BUDGET_MS).
    loop.observe(adv.ticks, spent);
    fanOut(events);
    if (heldGrant !== null) {
      // The step applied the grant's queued commands: show the card with the new HUD.
      const held = heldGrant;
      heldGrant = null;
      fanOut(held);
      refreshHud();
    }
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
      outlineHero: settings.outlineHero,
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
      deps.extraFrame?.(sim, nowMs);
    } catch (err) {
      reportError(err);
    }
  }

  renderer.onFrame(frame);

  // ---- API --------------------------------------------------------------------

  /** Makes `next` the current sim and resets everything derived from the old one. */
  function swapSim(next: Sim, clearMessages: boolean, keepUi = false): void {
    sim = next;
    scene.reset();
    loop.reset();
    backoffUntil = Number.NEGATIVE_INFINITY;
    pointer.cancel();
    appliedZoom = Number.NaN;
    if (keepUi) {
      // Same hero, same place (a bank op applied by the server): keep the open panels.
      lastHudAt = Number.NEGATIVE_INFINITY;
      refreshHud();
      return;
    }
    vendorNpc = 0;
    gamblerNpc = 0;
    // A new game drops a grant that has not shown yet; a resync keeps it (the
    // server's state already contains it, and its commands run on the next step).
    if (clearMessages) heldGrant = null;
    if (clearMessages) {
      setUi({ panels: [], toasts: [], error: null, hover: null });
      log.set([]);
    } else {
      setUi({ panels: [], error: null, hover: null });
    }
    lastHudAt = Number.NEGATIVE_INFINITY;
    refreshHud();
  }

  function newGame(): void {
    deps.save.clear();
    const seed = deps.newSeed();
    swapSim(deps.server ? deps.server.newGame(seed) : createSim(loaded, { seed }), true);
  }

  function save(): boolean {
    try {
      const record: SaveRecord = {
        v: 1,
        savedAt: deps.wall(),
        snapshot: sim.snapshot(),
        settings,
        modules: moduleIds,
      };
      return deps.save.save(record);
    } catch (err) {
      reportError(err);
      return false;
    }
  }

  const moduleIds = loaded.modules.map((m) => m.id);

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
      gamblerNpc = 0;
      setUi({ panels: [], hover: null });
    },
    setHover(h) {
      setUi({ hover: h });
    },
    updateSettings(patch) {
      settings = sanitizeSettings({ ...settings, ...patch });
      setUi({ settings });
      audio.applySettings(settings);
      applyQuality();
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
    sync: deps.sync ?? cell<SyncView>(LOCAL_SYNC_VIEW).store,
    platform: deps.platform ?? null,
    session: deps.session ?? null,
    bank: deps.bank ?? LOCAL_BANK,
    ...(deps.openScreen
      ? { openScreen: (screen: PlatformScreen) => deps.openScreen?.(screen) }
      : {}),
  };

  refreshHud();
  audio.applySettings(settings);
  applyQuality();

  return {
    api,
    save,
    notify(kind, title, body, ms = TOAST_LONG_MS) {
      pushToast(kind, title, body, ms);
    },
    destroy() {
      destroyed = true;
      pointer.cancel();
      audio.destroy();
    },
    currentSim: () => sim,
    replaceSim(next, opts) {
      if (destroyed) return;
      swapSim(next, false, opts?.keepUi === true);
    },
    emit(events) {
      if (destroyed) return;
      try {
        fanOutOrHold(events);
        refreshHud();
      } catch (err) {
        reportError(err);
      }
    },
    log(text) {
      pushLog("system", text, SYSTEM_LOG_COLOR);
    },
  };
}

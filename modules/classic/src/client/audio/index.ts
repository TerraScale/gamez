/**
 * Procedural sound for the classic client (wave A, docs/design/wave-A.md
 * §10.2) — OWNER: T-audio. The exports below are the contract the game wires
 * (game.ts); optional members were added by T-audio.
 *
 * Everything is synthesised with WebAudio (no audio files): one-shot SFX per
 * sim event and a generative ambient score per area theme. The engine never
 * throws: without WebAudio (tests, old browsers) it is a silent no-op. It
 * starts suspended and resumes on the first user gesture (autoplay policy).
 * Client only: Math.random, timers and the clock are allowed here.
 */
import type { FrozenRegistry, GameEvent } from "@gamez/kernel";
import { SUB } from "../../fixed.ts";
import type { ClassicEvent } from "../../events.ts";
import type { Settings } from "../contract.ts";
import { cueFor, type Cue, type CueEnv } from "./cues.ts";
import { type AudioContextLike, clamp, Engine, safely } from "./engine.ts";
import { Music, type MusicTheme, themeForArea } from "./music.ts";

export interface AudioFrame {
  /** Hero entity and its position in fractional tiles (stereo pan / distance falloff). */
  hero: number;
  heroX: number;
  heroY: number;
  /** Sim speed (Full Idle x2..x8): the engine thins out repeated SFX at high speed. */
  speed: number;
}

export interface AudioStats {
  /** The context exists and is running (after a user gesture). */
  running: boolean;
  /** One-shot voices alive now (cap MAX_VOICES). */
  voices: number;
  /** Sounds started / denied by rate limits or the voice cap, since creation. */
  played: number;
  dropped: number;
  /** Voices stolen to make room. */
  stolen: number;
  theme: MusicTheme | null;
  ducked: boolean;
}

export interface ClassicAudio {
  /** One fanned-out event batch (the same events the renderer sees). */
  onEvents(events: readonly GameEvent[], frame: AudioFrame): void;
  /** Volumes and mute (Settings.masterVolume / sfxVolume / musicVolume / muted). */
  applySettings(settings: Settings): void;
  /** Resumes the AudioContext; call from a user gesture (the engine also listens for one). */
  unlock(): void;
  /** Stops everything and closes the AudioContext. */
  destroy(): void;
  /** Optional (T-audio): counters for tests and the QA harness. */
  stats?(): AudioStats;
}

/** Where the one-time gesture listeners go (window by default). */
export interface GestureTarget {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface AudioOptions {
  registry: FrozenRegistry;
  settings: Settings;
  /** Test seam (optional): builds the AudioContext. Default: the browser's. */
  context?: () => AudioContextLike;
  /** Test seam (optional): gesture listener target. Default: window; null = none. */
  target?: GestureTarget | null;
  /** Test seam (optional): wall clock in ms for rate limits. Default: performance.now. */
  clock?: () => number;
}

/** Sounds beyond this many tiles from the hero are not played. */
export const HEAR_RANGE_TILES = 26;
/** Sounds per event batch: normal, x4+, x8. */
export const BATCH_CAP = { normal: 24, fast: 8, fastest: 4 } as const;

const GESTURES = ["pointerdown", "keydown"] as const;

function browserContext(): (() => AudioContextLike) | null {
  const g = globalThis as { AudioContext?: unknown; webkitAudioContext?: unknown };
  const Ctor = (g.AudioContext ?? g.webkitAudioContext) as (new () => unknown) | undefined;
  if (typeof Ctor !== "function") return null;
  return () => new Ctor() as unknown as AudioContextLike;
}

function defaultTarget(): GestureTarget | null {
  const w = (globalThis as { window?: unknown }).window;
  if (!w || typeof (w as GestureTarget).addEventListener !== "function") return null;
  return w as GestureTarget;
}

function wallClock(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

function unit(v: number): number {
  return Number.isFinite(v) ? clamp(v / 100, 0, 1) : 1;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" && v !== null && typeof (v as PromiseLike<unknown>).then === "function"
  );
}

/** Where a cue lands: distance falloff and stereo pan, or null when out of range. */
function placement(c: Cue, frame: AudioFrame): { gain: number; pan: number } | null {
  if (!c.pos) return { gain: c.vol, pan: 0 };
  const dx = c.pos.x / SUB - frame.heroX;
  const dy = c.pos.y / SUB - frame.heroY;
  const d = Math.hypot(dx, dy);
  if (!Number.isFinite(d) || d > HEAR_RANGE_TILES) return null;
  const f = clamp(1 - d / HEAR_RANGE_TILES, 0, 1);
  // Iso screen x runs along (dx - dy).
  const pan = clamp((dx - dy) / 8, -1, 1);
  return { gain: c.vol * Math.max(0.02, f * f), pan };
}

export function createAudio(opts: AudioOptions): ClassicAudio {
  const factory = opts.context ?? browserContext();
  const clock = opts.clock ?? wallClock;
  const target: GestureTarget | null = factory
    ? opts.target !== undefined
      ? opts.target
      : defaultTarget()
    : null;
  let settings = opts.settings;
  let destroyed = false;
  let gestured = false;
  let failed = false;
  let engine: Engine | null = null;
  let music: Music | null = null;
  let theme: MusicTheme | null = null;
  let boss = false;
  let played = 0;
  let dropped = 0;
  const lastAt = new Map<string, number>();

  function unlock(): void {
    if (destroyed) return;
    gestured = true;
    const e = ensure();
    if (!e) return;
    safely(() => {
      const r = e.ctx.resume();
      if (isThenable(r)) r.then(undefined, () => undefined);
    });
  }

  function onGesture(): void {
    removeGestureListeners();
    unlock();
  }

  function addGestureListeners(): void {
    if (!target) return;
    safely(() => {
      for (const type of GESTURES) target.addEventListener(type, onGesture);
    });
  }

  function removeGestureListeners(): void {
    if (!target) return;
    safely(() => {
      for (const type of GESTURES) target.removeEventListener(type, onGesture);
    });
  }

  /** Creates the context and the graph on first use (after a gesture or an event). */
  function ensure(): Engine | null {
    if (engine || failed || destroyed || !factory) return engine;
    try {
      const e = new Engine(factory());
      engine = e;
      applyVolumes();
      const m = new Music(e);
      music = m;
      if (theme === null) theme = "town";
      m.setTheme(theme);
      m.setDucked(boss);
    } catch {
      failed = true;
      engine = null;
      music = null;
    }
    return engine;
  }

  function applyVolumes(): void {
    const e = engine;
    if (!e) return;
    const s = settings;
    safely(() => {
      e.setGain(e.master.gain, s.muted ? 0 : unit(s.masterVolume));
      e.setGain(e.sfxBus.gain, unit(s.sfxVolume));
      e.setGain(e.musicBus.gain, unit(s.musicVolume));
    });
  }

  function setTheme(key: MusicTheme): void {
    theme = key;
    safely(() => music?.setTheme(key));
  }

  /** State the score and the boss duck follow (runs even before a gesture). */
  function trackState(ev: GameEvent): void {
    const e = ev as unknown as ClassicEvent;
    switch (e.type) {
      case "classic.area.changed":
        boss = false;
        setTheme(themeForArea(e.depth, e.theme));
        safely(() => music?.setDucked(false));
        return;
      case "classic.boss.spawned":
      case "classic.boss.phase":
        boss = true;
        safely(() => music?.setDucked(true));
        return;
      case "classic.boss.killed":
        boss = false;
        safely(() => music?.setDucked(false));
        return;
      default:
        return;
    }
  }

  function allowed(c: Cue, speed: number, now: number): boolean {
    if (speed >= 8 && c.prio === 0) return false;
    const gap = c.gapMs * (speed >= 8 ? 3 : speed >= 4 ? 2 : 1);
    const last = lastAt.get(c.key);
    return last === undefined || now - last >= gap;
  }

  addGestureListeners();

  return {
    onEvents(events, frame) {
      if (destroyed || events.length === 0) return;
      for (const ev of events) safely(() => trackState(ev));
      // Autoplay policy: no sound before a gesture (state above is still tracked).
      if (!gestured && !engine) return;
      const e = ensure();
      if (!e) return;
      const speed = frame.speed > 0 ? frame.speed : 1;
      const env: CueEnv = { registry: opts.registry, hero: frame.hero };
      const cap = speed >= 8 ? BATCH_CAP.fastest : speed >= 4 ? BATCH_CAP.fast : BATCH_CAP.normal;
      const now = clock();
      let budget = cap;
      for (const ev of events) {
        if (budget <= 0) break;
        safely(() => {
          const c = cueFor(ev, env);
          if (!c || !allowed(c, speed, now)) return;
          const place = placement(c, frame);
          if (!place) return;
          if (e.play(c.prio, place.pan, place.gain, c.play)) {
            lastAt.set(c.key, now);
            played++;
            budget--;
          } else {
            dropped++;
          }
        });
      }
    },
    applySettings(next) {
      if (destroyed) return;
      settings = next;
      applyVolumes();
    },
    unlock,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeGestureListeners();
      safely(() => engine?.stopVoices());
      safely(() => music?.destroy());
      const e = engine;
      engine = null;
      music = null;
      lastAt.clear();
      if (e) {
        safely(() => {
          const r = e.ctx.close();
          if (isThenable(r)) r.then(undefined, () => undefined);
        });
      }
    },
    stats() {
      const e = engine;
      return {
        running: e !== null && e.ctx.state === "running",
        voices: e ? e.voices.length : 0,
        played,
        dropped,
        stolen: e ? e.stolen : 0,
        theme: music ? music.stats().theme : theme,
        ducked: boss,
      };
    },
  };
}

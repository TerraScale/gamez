/**
 * Generative ambient music for the classic client (wave A audio). One layer per
 * area theme: a drone, slow chord pads and a sparse melody in the theme's mode
 * and tempo. A lookahead scheduler (setInterval ~200 ms) places every note on
 * the AudioContext clock. Switching theme crossfades over 2 s; a boss fight
 * ducks the whole score by -6 dB. Client only (timers and Math.random allowed).
 */
import { isRiftDepth } from "../../rules.ts";
import type { AudioContextLike, Engine, GainLike } from "./engine.ts";
import { safely } from "./engine.ts";

export type MusicTheme = "town" | "crypt" | "caves" | "forge" | "abyss" | "rift";

export interface ThemeDef {
  key: MusicTheme;
  /** Root MIDI note (60 = C4). */
  root: number;
  /** Scale intervals in semitones. */
  scale: readonly number[];
  /** Seconds per chord (one bar). */
  barSec: number;
  /** Chord roots as scale degrees, one per bar, looped. */
  progression: readonly number[];
  padWave: "sine" | "triangle" | "sawtooth" | "square";
  padCutoff: number;
  droneWave: "sine" | "triangle" | "sawtooth";
  droneMidi: number;
  melodyWave: "sine" | "triangle";
  /** Chance a melody step sounds (sparse: low values). */
  density: number;
}

export const THEMES: Record<MusicTheme, ThemeDef> = {
  town: {
    key: "town",
    root: 62,
    scale: [0, 2, 4, 7, 9],
    barSec: 8,
    progression: [0, 3, 4, 0],
    padWave: "triangle",
    padCutoff: 1400,
    droneWave: "sine",
    droneMidi: 38,
    melodyWave: "sine",
    density: 0.3,
  },
  crypt: {
    key: "crypt",
    root: 57,
    scale: [0, 2, 3, 5, 7, 8, 10],
    barSec: 10,
    progression: [0, 5, 3, 4],
    padWave: "sawtooth",
    padCutoff: 500,
    droneWave: "sine",
    droneMidi: 33,
    melodyWave: "triangle",
    density: 0.18,
  },
  caves: {
    key: "caves",
    root: 52,
    scale: [0, 2, 3, 5, 7, 9, 10],
    barSec: 9,
    progression: [0, 3, 0, 6],
    padWave: "triangle",
    padCutoff: 900,
    droneWave: "triangle",
    droneMidi: 40,
    melodyWave: "sine",
    density: 0.22,
  },
  forge: {
    key: "forge",
    root: 49,
    scale: [0, 1, 3, 5, 7, 8, 10],
    barSec: 6,
    progression: [0, 1, 0, 4],
    padWave: "square",
    padCutoff: 700,
    droneWave: "sawtooth",
    droneMidi: 37,
    melodyWave: "triangle",
    density: 0.35,
  },
  abyss: {
    key: "abyss",
    root: 44,
    scale: [0, 1, 3, 4, 6, 8, 10],
    barSec: 12,
    progression: [0, 1, 0, 6],
    padWave: "sine",
    padCutoff: 350,
    droneWave: "sine",
    droneMidi: 32,
    melodyWave: "sine",
    density: 0.12,
  },
  rift: {
    key: "rift",
    root: 60,
    scale: [0, 2, 4, 6, 8, 10],
    barSec: 7,
    progression: [0, 2, 4, 2],
    padWave: "triangle",
    padCutoff: 2000,
    droneWave: "triangle",
    droneMidi: 36,
    melodyWave: "sine",
    density: 0.3,
  },
};

/** Lookahead window of the scheduler (seconds ahead of the clock). */
export const LOOKAHEAD_SEC = 1.2;
/** Scheduler period (ms). */
export const SCHEDULE_MS = 200;
/** Crossfade length on theme change (seconds). */
export const CROSSFADE_SEC = 2;
/** Boss-fight duck: -6 dB. */
export const DUCK_GAIN = 0.5;

const STEPS_PER_BAR = 8;

export function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Scale degree (may exceed the scale length: higher octaves) to MIDI. */
export function degreeMidi(theme: ThemeDef, degree: number): number {
  const n = theme.scale.length;
  const octave = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return theme.root + (theme.scale[idx] ?? 0) + 12 * octave;
}

interface Layer {
  def: ThemeDef;
  gain: GainLike;
  nextBarT: number;
  nextStepT: number;
  bar: number;
  step: number;
  melodyDeg: number;
  /** Set when the layer is fading out; it stops at `retireAt`. */
  retireAt: number;
  drone: { stop(when?: number): void } | null;
}

export interface MusicStats {
  theme: MusicTheme | null;
  layers: number;
  ducked: boolean;
}

/**
 * Owns the score. `bus` is the music bus; `ducker` sits between the layers and
 * the bus so a boss fight can lower the whole score without touching the
 * volume settings.
 */
export class Music {
  private readonly ctx: AudioContextLike;
  private readonly duck: GainLike;
  private readonly layers: Layer[] = [];
  private current: Layer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private ducked = false;
  private readonly rnd: () => number;

  constructor(
    private readonly eng: Engine,
    rnd: () => number = Math.random,
  ) {
    this.ctx = eng.ctx;
    this.rnd = rnd;
    this.duck = this.ctx.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(eng.musicBus);
  }

  /** Switches the score to `key` (crossfade). No-op when already playing it. */
  setTheme(key: MusicTheme): void {
    if (this.destroyed) return;
    if (this.current && this.current.def.key === key) return;
    const now = this.ctx.currentTime;
    if (this.current) this.retire(this.current, now);
    const def = THEMES[key];
    const layer = this.startLayer(def, now);
    this.layers.push(layer);
    this.current = layer;
    this.ensureTimer();
  }

  setDucked(on: boolean): void {
    if (this.destroyed || this.ducked === on) return;
    this.ducked = on;
    safely(() => this.eng.setGain(this.duck.gain, on ? DUCK_GAIN : 1));
  }

  stats(): MusicStats {
    return {
      theme: this.current ? this.current.def.key : null,
      layers: this.layers.length,
      ducked: this.ducked,
    };
  }

  /** Lookahead scheduler: places notes up to LOOKAHEAD_SEC ahead on the clock. */
  pump(): void {
    if (this.destroyed) return;
    safely(() => {
      const now = this.ctx.currentTime;
      if (this.ctx.state !== "running") {
        // Suspended: keep the grid anchored just ahead of the clock on resume.
        for (const l of this.layers) {
          l.nextBarT = 0;
          l.nextStepT = 0;
        }
        return;
      }
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const l = this.layers[i];
        if (!l) continue;
        if (l !== this.current && now >= l.retireAt) {
          this.stopLayer(l);
          this.layers.splice(i, 1);
          continue;
        }
        if (l.nextBarT < now) l.nextBarT = now + 0.05;
        if (l.nextStepT < now) l.nextStepT = now + 0.05;
        const horizon = now + LOOKAHEAD_SEC;
        const stepSec = l.def.barSec / STEPS_PER_BAR;
        while (l.nextBarT < horizon) {
          this.scheduleBar(l, l.nextBarT);
          l.nextBarT += l.def.barSec;
        }
        while (l.nextStepT < horizon) {
          this.scheduleStep(l, l.nextStepT);
          l.nextStepT += stepSec;
        }
      }
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const l of this.layers) this.stopLayer(l);
    this.layers.length = 0;
    this.current = null;
    safely(() => this.duck.disconnect());
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.destroyed) return;
    this.timer = setInterval(() => this.pump(), SCHEDULE_MS);
  }

  private startLayer(def: ThemeDef, now: number): Layer {
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + CROSSFADE_SEC);
    gain.connect(this.duck);
    const drone = this.ctx.createOscillator();
    drone.type = def.droneWave;
    drone.frequency.setValueAtTime(midiHz(def.droneMidi), now);
    const droneGain = this.ctx.createGain();
    droneGain.gain.setValueAtTime(0.07, now);
    drone.connect(droneGain);
    droneGain.connect(gain);
    drone.start(now);
    return {
      def,
      gain,
      nextBarT: now + 0.1,
      nextStepT: now + 0.1,
      bar: 0,
      step: 0,
      melodyDeg: 0,
      retireAt: Number.POSITIVE_INFINITY,
      drone,
    };
  }

  private retire(l: Layer, now: number): void {
    safely(() => {
      l.gain.gain.cancelScheduledValues(now);
      l.gain.gain.setTargetAtTime(0, now, CROSSFADE_SEC / 4);
    });
    // Fade is ~ -40 dB after 4 time constants; stop the layer after that.
    l.retireAt = now + CROSSFADE_SEC * 2;
    this.current = null;
  }

  private stopLayer(l: Layer): void {
    safely(() => l.drone?.stop());
    safely(() => l.gain.disconnect());
  }

  /** Pads: one chord per bar, three notes, two detuned voices each. */
  private scheduleBar(l: Layer, t: number): void {
    const def = l.def;
    const deg = def.progression[l.bar % def.progression.length] ?? 0;
    l.bar++;
    const notes = [deg, deg + 2, deg + 4];
    const len = def.barSec * 1.25;
    for (const d of notes) {
      const midi = degreeMidi(def, d) - 12;
      for (const det of [-6, 6]) {
        this.oscNote(l, def.padWave, midi, t, len, 0.04, def.barSec * 0.4, det, def.padCutoff);
      }
    }
  }

  /** Melody: a sparse random walk over the scale, on an eighth-note grid. */
  private scheduleStep(l: Layer, t: number): void {
    const def = l.def;
    const idx = l.step % STEPS_PER_BAR;
    l.step++;
    // Favour strong beats a little.
    const chance = idx === 0 || idx === 4 ? def.density * 1.6 : def.density;
    if (this.rnd() >= chance) return;
    const move = Math.floor(this.rnd() * 5) - 2;
    l.melodyDeg = clampInt(l.melodyDeg + move, -2, def.scale.length + 1);
    const midi = degreeMidi(def, l.melodyDeg) + 12;
    const len = (def.barSec / STEPS_PER_BAR) * 2.5;
    this.oscNote(l, def.melodyWave, midi, t, len, 0.05, 0.05, 0, def.padCutoff * 2);
  }

  private oscNote(
    l: Layer,
    wave: "sine" | "triangle" | "sawtooth" | "square",
    midi: number,
    t: number,
    len: number,
    vol: number,
    attack: number,
    detune: number,
    cutoff: number,
  ): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(midiHz(midi), t);
    osc.detune.setValueAtTime(detune, t);
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.setValueAtTime(cutoff, t);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + Math.min(attack, len * 0.5));
    env.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(filt);
    filt.connect(env);
    env.connect(l.gain);
    osc.start(t);
    osc.stop(t + len + 0.05);
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Theme for an area: rift depths, then the theme id's last segment. */
export function themeForArea(depth: number, themeId: string): MusicTheme {
  if (isRiftDepth(depth)) return "rift";
  const last = themeId.split(".").pop() ?? "";
  return (last in THEMES ? last : "town") as MusicTheme;
}

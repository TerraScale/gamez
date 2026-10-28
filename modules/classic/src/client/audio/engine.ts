/**
 * WebAudio plumbing for the classic client audio (wave A, T-audio). Client
 * code only: the clock and timers are fine here. Every entry point is guarded:
 * a missing or failing WebAudio leaves the engine silent instead of throwing.
 *
 * Graph: sfx voice bus (gain) -> panner -> sfxBus -> master -> limiter -> out,
 * and musicBus -> master as well. Music never counts against the voice cap.
 */

// ---- minimal structural WebAudio types (so tests can inject a fake) ----------

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, when: number): unknown;
  linearRampToValueAtTime(value: number, when: number): unknown;
  exponentialRampToValueAtTime(value: number, when: number): unknown;
  setTargetAtTime(target: number, when: number, timeConstant: number): unknown;
  cancelScheduledValues(when: number): unknown;
}

export interface AudioNodeLike {
  connect(dest: AudioNodeLike | AudioParamLike): unknown;
  disconnect(): unknown;
}

export interface GainLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface OscillatorLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  readonly detune: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface FilterLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface AudioBufferLike {
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

export interface SourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

export interface PannerLike extends AudioNodeLike {
  readonly pan: AudioParamLike;
}

export interface CompressorLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
}

/** The subset of AudioContext the engine uses. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  createGain(): GainLike;
  createOscillator(): OscillatorLike;
  createBiquadFilter(): FilterLike;
  createBufferSource(): SourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createDynamicsCompressor(): CompressorLike;
  createStereoPanner?(): PannerLike;
  resume(): unknown;
  close(): unknown;
}

// ---- helpers -----------------------------------------------------------------

/** Runs fn and swallows any error: audio must never break the game. */
export function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Silent by design (no WebAudio, closed context, browser policy...).
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Voice cap for one-shot SFX (docs/design/wave-A.md §10.2). */
export const MAX_VOICES = 12;

export interface ToneSpec {
  wave?: "sine" | "square" | "sawtooth" | "triangle";
  /** Start frequency in Hz. */
  f0: number;
  /** Optional exponential pitch sweep target (Hz) over `dur`. */
  f1?: number;
  /** Seconds from the voice start. */
  at?: number;
  /** Seconds. */
  dur: number;
  /** Peak gain (0..1). */
  vol: number;
  attack?: number;
  /** Detune in cents. */
  det?: number;
  /** Optional frequency modulation: a modulator at f0*ratio, depth in Hz, decaying. */
  fm?: { ratio: number; depth: number };
  /** Optional lowpass cutoff (Hz) in front of the envelope. */
  lp?: number;
  q?: number;
}

export interface NoiseSpec {
  at?: number;
  dur: number;
  vol: number;
  attack?: number;
  filter: "lowpass" | "highpass" | "bandpass";
  f0: number;
  f1?: number;
  q?: number;
}

interface StoppableNode {
  stop(when?: number): void;
}

/** One sound being built: a gain bus that is panned and tracked for stealing. */
export class Voice {
  /** Latest end time (ctx clock) of anything this voice schedules. */
  end: number;
  private readonly nodes: StoppableNode[] = [];

  constructor(
    private readonly eng: Engine,
    readonly out: GainLike,
    readonly t0: number,
  ) {
    this.end = t0;
  }

  tone(p: ToneSpec): void {
    const ctx = this.eng.ctx;
    const t = this.t0 + (p.at ?? 0);
    const dur = Math.max(0.01, p.dur);
    const stopAt = t + dur + 0.05;
    const f0 = Math.max(1, p.f0);
    const osc = ctx.createOscillator();
    osc.type = p.wave ?? "sine";
    osc.frequency.setValueAtTime(f0, t);
    if (p.f1 !== undefined && p.f1 > 0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.f1), t + dur);
    }
    if (p.det) osc.detune.setValueAtTime(p.det, t);
    if (p.fm) {
      const mod = ctx.createOscillator();
      mod.frequency.setValueAtTime(f0 * p.fm.ratio, t);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(p.fm.depth, t);
      depth.gain.linearRampToValueAtTime(0, t + dur);
      mod.connect(depth);
      depth.connect(osc.frequency);
      mod.start(t);
      mod.stop(stopAt);
      this.track(mod);
    }
    const env = ctx.createGain();
    attackRelease(env, p.vol, t, dur, p.attack);
    if (p.lp !== undefined) {
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.setValueAtTime(Math.max(20, p.lp), t);
      filt.Q.setValueAtTime(p.q ?? 0.7, t);
      osc.connect(filt);
      filt.connect(env);
    } else {
      osc.connect(env);
    }
    env.connect(this.out);
    osc.start(t);
    osc.stop(stopAt);
    this.track(osc);
    this.until(stopAt);
  }

  noise(p: NoiseSpec): void {
    const ctx = this.eng.ctx;
    const t = this.t0 + (p.at ?? 0);
    const dur = Math.max(0.01, p.dur);
    const stopAt = t + dur + 0.05;
    const src = ctx.createBufferSource();
    src.buffer = this.eng.noiseBuffer();
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = p.filter;
    filt.frequency.setValueAtTime(Math.max(20, p.f0), t);
    if (p.f1 !== undefined && p.f1 > 0) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(20, p.f1), t + dur);
    }
    filt.Q.setValueAtTime(p.q ?? 0.8, t);
    const env = ctx.createGain();
    attackRelease(env, p.vol, t, dur, p.attack);
    src.connect(filt);
    filt.connect(env);
    env.connect(this.out);
    src.start(t, this.eng.bufferOffset());
    src.stop(stopAt);
    this.track(src);
    this.until(stopAt);
  }

  /** Fades out and stops every node now (voice stealing, destroy). */
  stopNow(): void {
    const t = this.eng.ctx.currentTime;
    safely(() => {
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setTargetAtTime(0, t, 0.01);
    });
    for (const n of this.nodes) safely(() => n.stop(t + 0.03));
    this.nodes.length = 0;
  }

  private track(node: StoppableNode): void {
    this.nodes.push(node);
  }

  private until(t: number): void {
    if (t > this.end) this.end = t;
  }
}

function attackRelease(env: GainLike, vol: number, t: number, dur: number, attack?: number): void {
  const peak = Math.max(0.0002, vol);
  const a = Math.min(attack ?? 0.006, dur * 0.5);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + a);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

export interface VoiceRecord {
  readonly seq: number;
  readonly prio: number;
  readonly end: number;
  readonly stop: () => void;
}

/** Owns the context and the bus graph. Created lazily, once per AudioContext. */
export class Engine {
  readonly ctx: AudioContextLike;
  readonly master: GainLike;
  readonly sfxBus: GainLike;
  readonly musicBus: GainLike;
  /** Active one-shot voices, oldest first. */
  readonly voices: VoiceRecord[] = [];
  stolen = 0;
  private seq = 0;
  private noiseBuf: AudioBufferLike | null = null;

  constructor(ctx: AudioContextLike) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.master.connect(limiter);
    limiter.connect(ctx.destination);
  }

  /** Smoothed gain change (no zipper noise). */
  setGain(p: AudioParamLike, value: number): void {
    const t = this.ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(value, t, 0.04);
  }

  /** A cached 1.5 s white-noise buffer, shared by every noise source. */
  noiseBuffer(): AudioBufferLike {
    if (!this.noiseBuf) {
      const len = Math.max(1024, Math.floor(this.ctx.sampleRate * 1.5));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }

  /** Varying buffer offsets so repeated noise bursts do not sound identical. */
  bufferOffset(): number {
    this.seq++;
    return (this.seq * 0.317) % 1.2;
  }

  /**
   * Plays one sound. `build` schedules its nodes on the Voice. Returns false
   * when the voice cap denies it (only lower-priority voices can be stolen).
   */
  play(prio: number, pan: number, gain: number, build: (v: Voice) => void): boolean {
    const now = this.ctx.currentTime;
    this.purge(now);
    if (this.voices.length >= MAX_VOICES && !this.steal(prio)) return false;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = gain;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      out.connect(panner);
      panner.connect(this.sfxBus);
    } else {
      out.connect(this.sfxBus);
    }
    const voice = new Voice(this, out, now + 0.01);
    safely(() => build(voice));
    this.voices.push({
      seq: this.seq++,
      prio,
      end: Math.max(voice.end, now + 0.02),
      stop: () => voice.stopNow(),
    });
    return true;
  }

  /** Stops every one-shot voice (destroy, or a hard reset). */
  stopVoices(): void {
    while (this.voices.length > 0) {
      const v = this.voices.pop();
      safely(() => v?.stop());
    }
  }

  private purge(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v && v.end <= now) this.voices.splice(i, 1);
    }
  }

  /** Frees one slot: the lowest priority, then the oldest. False = deny the new sound. */
  private steal(prio: number): boolean {
    let victim = 0;
    let w = this.voices[0];
    if (!w) return false;
    for (let i = 1; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (!v) continue;
      if (v.prio < w.prio || (v.prio === w.prio && v.seq < w.seq)) {
        victim = i;
        w = v;
      }
    }
    if (w.prio > prio) return false;
    this.voices.splice(victim, 1);
    this.stolen++;
    safely(() => w.stop());
    return true;
  }
}

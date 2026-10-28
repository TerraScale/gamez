import type { ParticleStyle } from "@gamez/ui-host";
import { PARTICLE_STYLES, type BurstPlan } from "./particle-plan.ts";

/** Styles in a fixed order, so a style can be stored as a byte. */
export const PARTICLE_STYLE_ORDER: readonly ParticleStyle[] = [
  "spark",
  "ember",
  "frost",
  "poison",
  "arcane",
  "holy",
  "shadow",
  "blood",
  "dust",
  "gold",
];

/** Largest pool the simulation can hold (the high-quality cap). */
export const PARTICLE_POOL_MAX = 600;

/**
 * Pooled particle simulation (no Pixi). Struct-of-arrays with a free stack, so
 * spawning and updating never allocate. A spawn is dropped when the live count
 * has reached `cap`; the pool never grows past PARTICLE_POOL_MAX.
 */
export class ParticleSim {
  readonly x = new Float32Array(PARTICLE_POOL_MAX);
  readonly y = new Float32Array(PARTICLE_POOL_MAX);
  private readonly vx = new Float32Array(PARTICLE_POOL_MAX);
  private readonly vy = new Float32Array(PARTICLE_POOL_MAX);
  private readonly age = new Float32Array(PARTICLE_POOL_MAX);
  private readonly life = new Float32Array(PARTICLE_POOL_MAX);
  private readonly size0 = new Float32Array(PARTICLE_POOL_MAX);
  private readonly size1 = new Float32Array(PARTICLE_POOL_MAX);
  private readonly gravity = new Float32Array(PARTICLE_POOL_MAX);
  private readonly drag = new Float32Array(PARTICLE_POOL_MAX);
  private readonly spin = new Float32Array(PARTICLE_POOL_MAX);
  /** Current rotation (rad). */
  readonly rot = new Float32Array(PARTICLE_POOL_MAX);
  /** 1 = live. */
  readonly alive = new Uint8Array(PARTICLE_POOL_MAX);
  /** Style index into PARTICLE_STYLE_ORDER. */
  readonly style = new Uint8Array(PARTICLE_POOL_MAX);
  private readonly free = new Int32Array(PARTICLE_POOL_MAX);
  private freeCount = PARTICLE_POOL_MAX;
  private live = 0;
  /** Highest slot index ever used + 1; loops stop here. */
  highWater = 0;
  private capValue = PARTICLE_POOL_MAX;
  /** Random source in [0, 1); the layer supplies a seeded one. */
  private rng: () => number = () => 0.5;

  constructor() {
    for (let i = 0; i < PARTICLE_POOL_MAX; i++) this.free[i] = PARTICLE_POOL_MAX - 1 - i;
  }

  /** Live particle cap (0 = none). Lowering it does not kill live particles. */
  get cap(): number {
    return this.capValue;
  }

  set cap(v: number) {
    const n = Number.isFinite(v) ? Math.floor(v) : 0;
    this.capValue = n < 0 ? 0 : n > PARTICLE_POOL_MAX ? PARTICLE_POOL_MAX : n;
  }

  get liveCount(): number {
    return this.live;
  }

  setRandom(rng: () => number): void {
    this.rng = rng;
  }

  /**
   * Spawns the particles of a burst at screen-local (ox, oy) for an effect. Returns the
   * number actually spawned (0 when the cap is reached).
   */
  burst(plan: BurstPlan, ox: number, oy: number): number {
    let n = 0;
    for (let i = 0; i < plan.count; i++) {
      if (!this.spawn(plan, ox, oy, i)) break;
      n++;
    }
    return n;
  }

  /** Advances every live particle by dtMs and kills the ones past their life. */
  update(dtMs: number): void {
    if (!(dtMs > 0)) return;
    const s = dtMs / 1000;
    const hw = this.highWater;
    for (let i = 0; i < hw; i++) {
      if (this.alive[i] !== 1) continue;
      const age = this.age[i]! + dtMs;
      if (age >= this.life[i]!) {
        this.kill(i);
        continue;
      }
      this.age[i] = age;
      const k = Math.exp(-this.drag[i]! * s);
      const vx = this.vx[i]! * k;
      const vy = this.vy[i]! * k + this.gravity[i]! * s;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.x[i] = this.x[i]! + vx * s;
      this.y[i] = this.y[i]! + vy * s;
      this.rot[i] = this.rot[i]! + this.spin[i]! * s;
    }
  }

  /** Life fraction 0..1 of a live slot. */
  progress(i: number): number {
    const l = this.life[i]!;
    return l > 0 ? Math.min(1, this.age[i]! / l) : 1;
  }

  /** Current diameter (px) of a live slot. */
  size(i: number): number {
    return this.size0[i]! + (this.size1[i]! - this.size0[i]!) * this.progress(i);
  }

  /** Alpha 0..1 of a live slot: a quick fade in, a linear fade out. */
  alpha(i: number): number {
    const p = this.progress(i);
    const peak = PARTICLE_STYLES[PARTICLE_STYLE_ORDER[this.style[i]!] ?? "spark"].alpha;
    const a = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
    return peak * (a < 0 ? 0 : a);
  }

  /** Kills every particle (used when the layer is destroyed or the cap drops). */
  clear(): void {
    for (let i = 0; i < this.highWater; i++) {
      if (this.alive[i] === 1) this.kill(i);
    }
  }

  private spawn(plan: BurstPlan, ox: number, oy: number, index: number): boolean {
    if (this.live >= this.capValue || this.freeCount === 0) return false;
    const i = this.free[--this.freeCount]!;
    const style = PARTICLE_STYLES[plan.style];
    const sIndex = PARTICLE_STYLE_ORDER.indexOf(plan.style);
    const r = this.rng;

    let angle: number;
    let start = 0;
    let speed: number;
    if (plan.spread === "ring") {
      angle = (Math.PI * 2 * index) / Math.max(1, plan.count) + r() * 0.3;
      start = plan.ringPx;
      speed = plan.ringSpeed * (0.85 + 0.3 * r());
    } else if (plan.spread === "up") {
      angle = -Math.PI / 2 + (r() - 0.5) * 1.2;
      speed = lerp(style.speed[0], style.speed[1], r()) * plan.speedMul;
    } else if (plan.spread === "cone") {
      angle = plan.dir + (r() * 2 - 1) * plan.arc;
      speed = lerp(style.speed[0], style.speed[1], r()) * plan.speedMul;
    } else {
      angle = r() * Math.PI * 2;
      speed = lerp(style.speed[0], style.speed[1], r()) * plan.speedMul;
    }
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.x[i] = ox + c * start;
    this.y[i] = oy + s * start * 0.5;
    this.vx[i] = c * speed;
    this.vy[i] = s * speed * 0.5;
    this.age[i] = 0;
    this.life[i] = lerp(style.life[0], style.life[1], r());
    this.size0[i] = style.size[0] * (0.8 + 0.4 * r());
    this.size1[i] = style.size[1];
    this.gravity[i] = style.gravity;
    this.drag[i] = style.drag;
    this.spin[i] = (r() * 2 - 1) * style.spin;
    this.rot[i] = r() * Math.PI * 2;
    this.style[i] = sIndex < 0 ? 0 : sIndex;
    this.alive[i] = 1;
    this.live++;
    if (i + 1 > this.highWater) this.highWater = i + 1;
    return true;
  }

  private kill(i: number): void {
    if (this.alive[i] !== 1) return;
    this.alive[i] = 0;
    this.live--;
    this.free[this.freeCount++] = i;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Seeded xorshift32 in [0, 1): deterministic particle scatter for tests and replays of a session. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

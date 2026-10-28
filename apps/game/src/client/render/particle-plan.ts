import type { EffectKind, EffectSpec, GraphicsQualityLevel, ParticleStyle } from "@gamez/ui-host";
import { particleFactor } from "./quality.ts";
import { DEFAULT_ISO } from "@gamez/world";
import { slashAngle } from "./fx-plan.ts";

/** Texture shape a style uses when no manifest texture `fx.particle.<style>` exists. */
export type ParticleShape = "soft" | "streak" | "flake" | "puff";

/**
 * Motion and look of one particle style. Units: px, px/s, px/s^2 (gravity,
 * positive = down the screen), ms, 1/s (drag). `size` is the start and end
 * diameter in px; `alpha` the peak alpha.
 */
export interface StyleSpec {
  shape: ParticleShape;
  /** Additive blend (fire, arcane, holy, spark). */
  add: boolean;
  speed: readonly [number, number];
  life: readonly [number, number];
  gravity: number;
  drag: number;
  size: readonly [number, number];
  alpha: number;
  /** Max spin (rad/s); each particle gets a random sign and value below this. */
  spin: number;
}

export const PARTICLE_STYLES: Readonly<Record<ParticleStyle, StyleSpec>> = {
  spark: {
    shape: "streak",
    add: true,
    speed: [70, 170],
    life: [260, 480],
    gravity: 220,
    drag: 1.6,
    size: [9, 3],
    alpha: 1,
    spin: 0,
  },
  ember: {
    shape: "soft",
    add: true,
    speed: [20, 70],
    life: [500, 900],
    gravity: -40,
    drag: 0.8,
    size: [8, 3],
    alpha: 0.9,
    spin: 0,
  },
  frost: {
    shape: "flake",
    add: false,
    speed: [20, 60],
    life: [600, 1000],
    gravity: 30,
    drag: 1,
    size: [6, 5],
    alpha: 0.95,
    spin: 2.5,
  },
  poison: {
    shape: "soft",
    add: false,
    speed: [10, 40],
    life: [600, 900],
    gravity: -22,
    drag: 0.6,
    size: [5, 9],
    alpha: 0.7,
    spin: 0,
  },
  arcane: {
    shape: "soft",
    add: true,
    speed: [30, 90],
    life: [400, 700],
    gravity: -10,
    drag: 1.2,
    size: [8, 2],
    alpha: 0.9,
    spin: 0,
  },
  holy: {
    shape: "soft",
    add: true,
    speed: [20, 80],
    life: [600, 1000],
    gravity: -32,
    drag: 0.9,
    size: [7, 3],
    alpha: 0.95,
    spin: 0,
  },
  shadow: {
    shape: "puff",
    add: false,
    speed: [10, 40],
    life: [700, 1100],
    gravity: -10,
    drag: 0.8,
    size: [10, 22],
    alpha: 0.55,
    spin: 0.6,
  },
  blood: {
    shape: "soft",
    add: false,
    speed: [60, 140],
    life: [400, 600],
    gravity: 260,
    drag: 1.2,
    size: [7, 3],
    alpha: 0.9,
    spin: 0,
  },
  dust: {
    shape: "puff",
    add: false,
    speed: [20, 60],
    life: [500, 800],
    gravity: -5,
    drag: 1.4,
    size: [8, 18],
    alpha: 0.4,
    spin: 0.8,
  },
  gold: {
    shape: "streak",
    add: true,
    speed: [40, 110],
    life: [500, 800],
    gravity: 120,
    drag: 1,
    size: [6, 3],
    alpha: 1,
    spin: 4,
  },
};

/** Default style for a colour when neither the spec nor the kind picks one. */
export function styleFromColour(colour: number): ParticleStyle {
  const r = (colour >> 16) & 0xff;
  const g = (colour >> 8) & 0xff;
  const b = colour & 0xff;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40) return max > 200 ? "holy" : "dust";
  if (g >= r && g >= b) return "poison";
  if (b >= r && b >= g) return r > 120 ? "arcane" : "frost";
  if (r >= g && r >= b) return g > 120 ? "gold" : g > 60 ? "ember" : "blood";
  return "spark";
}

/** Style per kind when the spec has none (kinds with a clear mood). */
const KIND_STYLE: Partial<Record<EffectKind, ParticleStyle>> = {
  heal: "holy",
  levelup: "gold",
  blink: "arcane",
  portal: "arcane",
  cast: "arcane",
  aoe: "dust",
  aura: "arcane",
  chain: "spark",
  beam: "spark",
  slash: "spark",
  hit: "blood",
};

/** Particle style of an effect: spec.style, else the kind's mood, else its colour. */
export function resolveStyle(spec: EffectSpec): ParticleStyle {
  if (spec.style && PARTICLE_STYLES[spec.style]) return spec.style;
  return KIND_STYLE[spec.kind] ?? styleFromColour(spec.color);
}

export type SpreadKind = "radial" | "ring" | "up" | "cone";

/** How one effect spawns its particles, before quality and randomness. */
export interface KindBurst {
  count: number;
  spread: SpreadKind;
  /** Speed multiplier of the particles (1 = the style's own speeds). */
  speedMul: number;
}

export const KIND_BURST: Readonly<Record<EffectKind, KindBurst>> = {
  nova: { count: 18, spread: "ring", speedMul: 1.2 },
  explosion: { count: 16, spread: "radial", speedMul: 1.6 },
  chain: { count: 6, spread: "radial", speedMul: 0.5 },
  beam: { count: 4, spread: "radial", speedMul: 0.4 },
  heal: { count: 12, spread: "up", speedMul: 0.6 },
  blink: { count: 14, spread: "ring", speedMul: 0.7 },
  hit: { count: 8, spread: "radial", speedMul: 1 },
  cast: { count: 6, spread: "ring", speedMul: 0.5 },
  levelup: { count: 30, spread: "up", speedMul: 1.3 },
  portal: { count: 10, spread: "ring", speedMul: 0.3 },
  aoe: { count: 10, spread: "ring", speedMul: 0.4 },
  slash: { count: 8, spread: "cone", speedMul: 1 },
  telegraph: { count: 0, spread: "radial", speedMul: 1 },
  aura: { count: 6, spread: "ring", speedMul: 0.25 },
  burst: { count: 22, spread: "radial", speedMul: 1.2 },
};

/** Full description of one effect's particle emission. */
export interface BurstPlan {
  style: ParticleStyle;
  count: number;
  spread: SpreadKind;
  /** Direction of a cone (screen radians, y down). */
  dir: number;
  /** Half-width of a cone (radians). */
  arc: number;
  speedMul: number;
  /** Distance (px) from the origin where a ring starts. */
  ringPx: number;
  /** Speed (px/s) of a ring spread, so particles reach the radius by the end of their life. */
  ringSpeed: number;
}

/** Particle emission of an effect: none for quality low (or a kind with none). */
export function burstPlanFor(spec: EffectSpec, quality: GraphicsQualityLevel): BurstPlan | null {
  const base = KIND_BURST[spec.kind];
  if (!base) return null;
  const factor = particleFactor(quality) * clamp(spec.intensity ?? 1, 0, 2);
  const count = Math.round(base.count * factor);
  if (count <= 0) return null;
  const radius = clamp(spec.radius ?? 1, 0.2, 6);
  const halfTile = DEFAULT_ISO.tileWidth / 2;
  const ringPx = radius * halfTile * 0.8;
  const style = resolveStyle(spec);
  const lifeMid = (PARTICLE_STYLES[style].life[0] + PARTICLE_STYLES[style].life[1]) / 2;
  const cone = spec.kind === "slash" || spec.kind === "beam";
  return {
    style,
    count: Math.min(120, count),
    spread: cone ? "cone" : base.spread,
    dir:
      spec.kind === "slash" ? slashScreenAngle(spec) : spec.kind === "beam" ? beamAngle(spec) : 0,
    arc: cone ? 0.9 : 0,
    speedMul: base.speedMul,
    ringPx,
    ringSpeed: (radius * halfTile * 1000) / lifeMid,
  };
}

/** Screen-space angle of a slash (the tile-space aim angle, projected). */
function slashScreenAngle(spec: EffectSpec): number {
  return projectedAngle(slashAngle(spec));
}

function beamAngle(spec: EffectSpec): number {
  if (spec.x2 === undefined || spec.y2 === undefined) return 0;
  return projectedAngle(Math.atan2(spec.y2 - spec.y, spec.x2 - spec.x));
}

/** Screen angle of a tile-space direction (tileToScreen is linear: (cos - sin, cos + sin) * halves). */
function projectedAngle(tileAngle: number): number {
  const c = Math.cos(tileAngle);
  const s = Math.sin(tileAngle);
  return Math.atan2((c + s) * (DEFAULT_ISO.tileHeight / DEFAULT_ISO.tileWidth), c - s);
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

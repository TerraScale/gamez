import { describe, expect, it } from "vite-plus/test";
import { Texture } from "pixi.js";
import type { EffectSpec, ParticleStyle } from "@gamez/ui-host";
import {
  burstPlanFor,
  KIND_BURST,
  PARTICLE_STYLES,
  resolveStyle,
  styleFromColour,
  type BurstPlan,
} from "../../src/client/render/particle-plan.ts";
import {
  PARTICLE_POOL_MAX,
  ParticleSim,
  seededRandom,
} from "../../src/client/render/particle-sim.ts";
import { ParticleLayer } from "../../src/client/render/particles.ts";
import { FxLayer } from "../../src/client/render/fx.ts";
import { PARTICLE_CAP, particleCap, particleFactor } from "../../src/client/render/quality.ts";

const COLOUR = 0xffaa33;

function plan(extra: Partial<BurstPlan> = {}): BurstPlan {
  return {
    style: "spark",
    count: 20,
    spread: "radial",
    dir: 0,
    arc: 0,
    speedMul: 1,
    ringPx: 0,
    ringSpeed: 60,
    ...extra,
  };
}

function spec(kind: EffectSpec["kind"], extra: Partial<EffectSpec> = {}): EffectSpec {
  return { kind, x: 10, y: 10, color: COLOUR, ...extra };
}

describe("particle caps and quality", () => {
  it("caps live particles at 600 high, 250 medium and none on low", () => {
    expect(PARTICLE_CAP).toEqual({ low: 0, medium: 250, high: 600 });
    expect(particleCap("high")).toBe(600);
    expect(particleCap("medium")).toBe(250);
    expect(particleCap("low")).toBe(0);
    expect(particleFactor("medium")).toBe(0.5);
  });

  it("plans no burst on low, half the count on medium and the full count on high", () => {
    const s = spec("explosion");
    expect(burstPlanFor(s, "low")).toBeNull();
    const high = burstPlanFor(s, "high")!;
    const medium = burstPlanFor(s, "medium")!;
    expect(high.count).toBe(KIND_BURST.explosion.count);
    expect(medium.count).toBe(KIND_BURST.explosion.count / 2);
    expect(burstPlanFor(spec("explosion", { intensity: 0 }), "high")).toBeNull();
    expect(burstPlanFor(spec("burst", { intensity: 2 }), "high")!.count).toBe(44);
  });

  it("plans no particles for a kind without a burst", () => {
    expect(burstPlanFor(spec("telegraph"), "high")).toBeNull();
  });
});

describe("particle styles", () => {
  it("picks a default style from the colour family", () => {
    expect(styleFromColour(0x33ccff)).toBe("frost");
    expect(styleFromColour(0xff3300)).toBe("blood");
    expect(styleFromColour(0xffd700)).toBe("gold");
    expect(styleFromColour(0x44ff44)).toBe("poison");
    expect(styleFromColour(0xaa44ff)).toBe("arcane");
    expect(styleFromColour(0xffffff)).toBe("holy");
    expect(styleFromColour(0x808080)).toBe("dust");
  });

  it("uses the spec style, then the kind's mood, then the colour", () => {
    expect(resolveStyle(spec("nova", { style: "shadow" }))).toBe("shadow");
    expect(resolveStyle(spec("heal", { color: 0x33ccff }))).toBe("holy");
    expect(resolveStyle(spec("nova", { color: 0x44ff44 }))).toBe("poison");
  });

  it("every style has a valid preset", () => {
    for (const s of Object.keys(PARTICLE_STYLES) as ParticleStyle[]) {
      const p = PARTICLE_STYLES[s];
      expect(p.speed[0]).toBeLessThanOrEqual(p.speed[1]);
      expect(p.life[0]).toBeGreaterThan(0);
      expect(p.life[0]).toBeLessThanOrEqual(p.life[1]);
    }
  });
});

describe("ParticleSim", () => {
  it("spawns up to the cap and drops the rest", () => {
    const sim = new ParticleSim();
    sim.setRandom(seededRandom(7));
    sim.cap = 10;
    expect(sim.burst(plan({ count: 30 }), 0, 0)).toBe(10);
    expect(sim.liveCount).toBe(10);
    expect(sim.burst(plan({ count: 30 }), 0, 0)).toBe(0);
  });

  it("reuses slots after particles die and never grows the pool", () => {
    const sim = new ParticleSim();
    sim.setRandom(seededRandom(3));
    const lengthBefore = sim.x.length;
    for (let cycle = 0; cycle < 200; cycle++) {
      sim.burst(plan({ count: 120 }), cycle, cycle);
      sim.update(1500);
      expect(sim.liveCount).toBe(0);
    }
    expect(sim.x.length).toBe(lengthBefore);
    expect(sim.x.length).toBe(PARTICLE_POOL_MAX);
    expect(sim.highWater).toBeLessThanOrEqual(PARTICLE_POOL_MAX);
  });

  it("holds the high-quality cap under a flood of bursts", () => {
    const sim = new ParticleSim();
    sim.setRandom(seededRandom(11));
    sim.cap = 600;
    for (let i = 0; i < 50; i++) sim.burst(plan({ count: 120 }), 0, 0);
    expect(sim.liveCount).toBe(600);
    expect(sim.highWater).toBe(600);
  });

  it("lowering the cap stops spawns but lets live particles finish", () => {
    const sim = new ParticleSim();
    sim.setRandom(seededRandom(5));
    sim.cap = 50;
    sim.burst(plan({ count: 40 }), 0, 0);
    sim.cap = 0;
    expect(sim.burst(plan({ count: 5 }), 0, 0)).toBe(0);
    expect(sim.liveCount).toBe(40);
    sim.update(2000);
    expect(sim.liveCount).toBe(0);
  });

  it("moves particles with gravity and fades them out by their life", () => {
    const sim = new ParticleSim();
    sim.setRandom(seededRandom(9));
    sim.burst(plan({ count: 1, style: "blood" }), 0, 0);
    const y0 = sim.y[0]!;
    sim.update(100);
    expect(sim.liveCount).toBe(1);
    expect(sim.y[0]!).not.toBe(y0);
    expect(Number.isFinite(sim.x[0])).toBe(true);
    expect(sim.alpha(0)).toBeGreaterThan(0);
    // Past the longest life every particle is gone.
    sim.update(5000);
    expect(sim.liveCount).toBe(0);
  });

  it("a ring spreads particles outward from the origin", () => {
    const sim = new ParticleSim();
    sim.setRandom(seededRandom(2));
    sim.burst(plan({ count: 8, spread: "ring", ringPx: 40, ringSpeed: 200 }), 0, 0);
    for (let i = 0; i < 8; i++) {
      expect(Math.hypot(sim.x[i]!, sim.y[i]! * 2)).toBeGreaterThanOrEqual(39);
    }
  });

  it("is deterministic for a seed", () => {
    const run = () => {
      const sim = new ParticleSim();
      sim.setRandom(seededRandom(42));
      sim.burst(plan({ count: 12 }), 5, 5);
      sim.update(120);
      return [sim.x[0], sim.y[0], sim.x[11], sim.y[11]];
    };
    expect(run()).toEqual(run());
  });
});

describe("ParticleLayer", () => {
  it("emits nothing on low quality", () => {
    const layer = new ParticleLayer(() => Texture.WHITE);
    layer.setQuality("low");
    expect(layer.emit(spec("explosion"), 0, 0)).toBe(0);
    expect(layer.live).toBe(0);
    layer.destroy();
  });

  it("emits nothing without any texture (no DOM for procedural art, no manifest art)", () => {
    const layer = new ParticleLayer(() => null);
    expect(layer.emit(spec("explosion"), 0, 0)).toBe(0);
    layer.destroy();
  });

  it("reuses sprites: many bursts never create more sprites than the cap", () => {
    const layer = new ParticleLayer(() => Texture.WHITE);
    layer.setQuality("high");
    for (let i = 0; i < 80; i++) {
      layer.emit(spec("explosion"), i, i);
      layer.update(50);
    }
    expect(layer.live).toBeLessThanOrEqual(600);
    expect(layer.container.children.length).toBeLessThanOrEqual(600);
    layer.update(5000);
    expect(layer.live).toBe(0);
    for (let i = 0; i < 80; i++) {
      layer.emit(spec("explosion"), i, i);
      layer.update(50);
    }
    // Sprites are per slot and slots are reused: the second round stays under the cap too.
    expect(layer.container.children.length).toBeLessThanOrEqual(600);
    expect(layer.container.children.length).toBeGreaterThan(0);
    layer.destroy();
  });

  it("medium caps at 250", () => {
    const layer = new ParticleLayer(() => Texture.WHITE);
    layer.setQuality("medium");
    for (let i = 0; i < 40; i++) layer.emit(spec("explosion", { intensity: 2 }), 0, 0);
    expect(layer.live).toBe(250);
    layer.destroy();
  });
});

describe("FxLayer effects", () => {
  it("reports how an effect was drawn: burst animation, static sprite or procedural", () => {
    const fx = new FxLayer(
      (id) => (id === "fx.frost_ring" ? Texture.WHITE : null),
      () => null,
    );
    const origin = { sx: 0, sy: 0 };
    expect(fx.effect(spec("nova", { sprite: "fx.frost_ring" }), origin, [Texture.WHITE])).toBe(
      "anim",
    );
    expect(fx.effect(spec("nova", { sprite: "fx.frost_ring" }), origin)).toBe("sprite");
    expect(fx.effect(spec("nova", { sprite: "fx.none" }), origin)).toBe("procedural");
    fx.destroy();
  });

  it("follows the quality for particles", () => {
    const fx = new FxLayer(
      () => null,
      () => null,
      () => Texture.WHITE,
    );
    fx.setQuality("low");
    fx.effect(spec("explosion"), { sx: 0, sy: 0 });
    fx.update(16);
    expect(fx.particles.live).toBe(0);
    fx.setQuality("high");
    fx.effect(spec("explosion"), { sx: 0, sy: 0 });
    fx.update(16);
    expect(fx.particles.live).toBeGreaterThan(0);
    fx.destroy();
  });

  it("chains, beams and blinks also burst at their end point", () => {
    const fx = new FxLayer(
      () => null,
      () => null,
      () => Texture.WHITE,
    );
    fx.effect(spec("blink", { x2: 14, y2: 10 }), { sx: 0, sy: 0 });
    const one = fx.particles.live;
    fx.destroy();
    const fx2 = new FxLayer(
      () => null,
      () => null,
      () => Texture.WHITE,
    );
    fx2.effect(spec("blink"), { sx: 0, sy: 0 });
    expect(one).toBeGreaterThan(fx2.particles.live);
    fx2.destroy();
  });
});

import { Container, Sprite, Texture } from "pixi.js";
import type { EffectSpec, GraphicsQualityLevel, ParticleStyle } from "@gamez/ui-host";
import {
  burstPlanFor,
  PARTICLE_STYLES,
  type BurstPlan,
  type ParticleShape,
} from "./particle-plan.ts";
import { PARTICLE_STYLE_ORDER, ParticleSim, seededRandom } from "./particle-sim.ts";
import { particleCap } from "./quality.ts";

/** Side of the procedural particle textures (px). */
const PROC_PX = 32;

/**
 * Pixi binding of the pooled particle simulation. Sprites are created on demand
 * up to the pool size and then only shown, moved and hidden; nothing is
 * allocated per frame. Textures come from the manifest (`fx.particle.<style>`)
 * when present, else from procedural textures made once on first use.
 */
export class ParticleLayer {
  /** Above the effect graphics of the FxLayer (zIndex). */
  readonly container = new Container();
  private readonly sim = new ParticleSim();
  private readonly sprites: (Sprite | null)[] = [];
  /** Texture per style index; filled lazily. */
  private readonly styleTex: (Texture | null)[] = [];
  private procedural: Record<ParticleShape, Texture> | null = null;
  private proceduralTried = false;
  private quality: GraphicsQualityLevel = "high";

  constructor(private readonly manifestTexture: (style: ParticleStyle) => Texture | null) {
    this.container.zIndex = 10;
    this.sim.setRandom(seededRandom(0x51ed1));
    this.sim.cap = particleCap(this.quality);
  }

  /** Live particle count (QA and tests). */
  get live(): number {
    return this.sim.liveCount;
  }

  /** The pooled simulation (tests). */
  get simulation(): ParticleSim {
    return this.sim;
  }

  setQuality(q: GraphicsQualityLevel): void {
    this.quality = q;
    this.sim.cap = particleCap(q);
    if (this.sim.cap === 0) this.sim.clear();
  }

  /** Spawns the particles of an effect at its screen origin (world-local px). */
  emit(spec: EffectSpec, sx: number, sy: number): number {
    if (this.sim.cap <= 0) return 0;
    const plan = burstPlanFor(spec, this.quality);
    if (!plan) return 0;
    return this.emitPlan(plan, sx, sy);
  }

  /** Spawns a planned burst; nothing is spawned without a texture for its style. */
  emitPlan(plan: BurstPlan, sx: number, sy: number): number {
    if (!this.textureFor(plan.style)) return 0;
    return this.sim.burst(plan, sx, sy);
  }

  /** Advances the particles and mirrors the live ones onto their sprites. */
  update(dtMs: number): void {
    if (this.sim.liveCount === 0 && this.sim.highWater === 0) return;
    this.sim.update(dtMs);
    this.sync();
  }

  destroy(): void {
    this.sim.clear();
    for (const s of this.sprites) s?.destroy();
    this.sprites.length = 0;
    this.styleTex.length = 0;
    if (this.procedural) {
      for (const t of Object.values(this.procedural)) t.destroy(true);
    }
    this.procedural = null;
    this.proceduralTried = false;
    this.container.destroy({ children: true });
  }

  /** The texture a style draws with: manifest first, then the procedural shape. */
  textureFor(style: ParticleStyle): Texture | null {
    return this.textureAt(PARTICLE_STYLE_ORDER.indexOf(style));
  }

  private textureAt(idx: number): Texture | null {
    if (idx < 0) return null;
    const cached = this.styleTex[idx];
    if (cached) return cached;
    const style = PARTICLE_STYLE_ORDER[idx];
    if (!style) return null;
    const fromManifest = this.manifestTexture(style);
    const tex = fromManifest ?? this.proceduralFor(style);
    if (tex) this.styleTex[idx] = tex;
    return tex;
  }

  private proceduralFor(style: ParticleStyle): Texture | null {
    const procedural = this.ensureProcedural();
    return procedural ? procedural[PARTICLE_STYLES[style].shape] : null;
  }

  private ensureProcedural(): Record<ParticleShape, Texture> | null {
    if (!this.proceduralTried) {
      this.proceduralTried = true;
      this.procedural = makeProceduralTextures();
    }
    return this.procedural;
  }

  private sync(): void {
    const sim = this.sim;
    const hw = sim.highWater;
    for (let i = 0; i < hw; i++) {
      const sp0 = this.sprites[i] ?? null;
      if (sim.alive[i] !== 1) {
        if (sp0 && sp0.visible) sp0.visible = false;
        continue;
      }
      const idx = sim.style[i]!;
      const tex = this.textureAt(idx);
      if (!tex) continue;
      let sp = sp0;
      if (!sp) {
        sp = new Sprite(tex);
        sp.anchor.set(0.5);
        this.container.addChild(sp);
        this.sprites[i] = sp;
      }
      if (sp.texture !== tex) sp.texture = tex;
      const mode = ADD_BY_INDEX[idx] ? "add" : "normal";
      if (sp.blendMode !== mode) sp.blendMode = mode;
      if (!sp.visible) sp.visible = true;
      sp.position.set(sim.x[i]!, sim.y[i]!);
      sp.scale.set(sim.size(i) / Math.max(1, tex.width));
      sp.alpha = sim.alpha(i);
      sp.rotation = sim.rot[i]!;
    }
  }
}

/** Additive blend per style index (fixed table, read every frame). */
const ADD_BY_INDEX: readonly boolean[] = PARTICLE_STYLE_ORDER.map((s) => PARTICLE_STYLES[s].add);

/** Procedural particle textures: one per shape, drawn once. Null without a DOM (tests, SSR). */
export function makeProceduralTextures(): Record<ParticleShape, Texture> | null {
  if (typeof document === "undefined") return null;
  const soft = canvasTexture((ctx, c) => {
    const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.6)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, PROC_PX, PROC_PX);
  });
  const streak = canvasTexture((ctx, c) => {
    ctx.save();
    ctx.translate(c, c);
    ctx.scale(1, 0.22);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, c);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.5)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(-c, -c, PROC_PX, PROC_PX);
    ctx.restore();
  });
  const flake = canvasTexture((ctx, c) => {
    ctx.strokeStyle = "rgba(255,255,255,1)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (let i = 0; i < 3; i++) {
      const a = (Math.PI / 3) * i;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * c * 0.9, c + Math.sin(a) * c * 0.9);
      ctx.lineTo(c - Math.cos(a) * c * 0.9, c - Math.sin(a) * c * 0.9);
      ctx.stroke();
    }
  });
  const puff = canvasTexture((ctx, c) => {
    const spots: [number, number, number][] = [
      [c, c, c * 0.55],
      [c - c * 0.4, c + c * 0.15, c * 0.4],
      [c + c * 0.4, c - c * 0.1, c * 0.42],
    ];
    for (const [x, y, r] of spots) {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(255,255,255,0.7)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  return { soft, streak, flake, puff };
}

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, centre: number) => void): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = PROC_PX;
  canvas.height = PROC_PX;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx, PROC_PX / 2);
  return Texture.from(canvas);
}

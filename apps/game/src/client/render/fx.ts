import { Container, Graphics, Sprite, Text, type Texture } from "pixi.js";
import { DEFAULT_ISO, tileToScreen } from "@gamez/world";
import type { EffectSpec, FloatTextSpec, GraphicsQualityLevel } from "@gamez/ui-host";
import { FLOAT_STAGGER_NEAR_PX, floatStagger, frameFromProgress } from "./anim-math.ts";
import { burstScale, effectDuration, floatFontSize, floatPose } from "./fx-math.ts";
import { LINE_MIN_PX, planEffect, UNDER_COLOUR, underStroke, type FxOp } from "./fx-plan.ts";
import { ParticleLayer } from "./particles.ts";
import { Pool } from "./pool.ts";

const MAX_FLOATS = 48;
const MAX_EFFECTS = 40;
/** Ops with alpha at or below this are skipped. */
const MIN_ALPHA = 0.01;
/** "miss" floats are drawn smaller than any damage number. */
const MISS_FONT_PX = 11;
/** Floats younger than this (ms) at the same spot push a new one aside. */
const STAGGER_WINDOW_MS = 260;

interface FloatItem {
  text: Text;
  elapsed: number;
  life: number;
  baseX: number;
  baseY: number;
  /** Spawn point before staggering. */
  originX: number;
  originY: number;
}

interface EffectItem {
  g: Graphics;
  sprite: Sprite | null;
  /** One-shot `<sprite>.burst` animation, when the manifest has it. */
  burst: Sprite | null;
  burstFrames: Texture[] | null;
  spec: EffectSpec | null;
  elapsed: number;
  life: number;
}

/** Share of a burst's life at which its art starts to fade. */
const BURST_FADE_FROM = 0.7;

/** Keys of the effect layer: what a playEffect drew with. */
export type EffectArt = "anim" | "sprite" | "procedural";

/** Chains, beams and blinks also burst at their end point. */
const END_BURST_KINDS = new Set<EffectSpec["kind"]>(["chain", "beam", "blink"]);

/**
 * Float texts and one-shot effects, both from capped pools. Effects live in
 * `layer` (with the particle layer on top of them) and floats in `floatLayer`;
 * the renderer stacks both above the name labels (floats on top), so nothing
 * is allocated in the steady state beyond the small op lists the planner returns.
 */
export class FxLayer {
  readonly layer = new Container();
  /** Float texts: above effects and name labels. */
  readonly floatLayer = new Container();
  /** Pooled particles (wave A), drawn above the effect graphics. */
  readonly particles: ParticleLayer;
  private readonly floats: Pool<FloatItem>;
  private readonly effects: Pool<EffectItem>;
  private quality: GraphicsQualityLevel = "high";

  /**
   * `spriteFor` returns an exact static sprite (or null); `animFor` an exact
   * animation's frames (or null); `particleTexture` the manifest texture of a
   * particle style (or null for the procedural one).
   */
  constructor(
    private readonly spriteFor: (id: string) => Texture | null,
    private readonly animFor: (id: string) => Texture[] | null = () => null,
    particleTexture: (style: string) => Texture | null = () => null,
  ) {
    this.layer.sortableChildren = true;
    this.particles = new ParticleLayer(particleTexture);
    this.layer.addChild(this.particles.container);
    this.floats = new Pool<FloatItem>(
      () => {
        const text = new Text({
          text: "",
          style: {
            fontFamily: "system-ui, sans-serif",
            fontSize: 17,
            fontWeight: "700",
            fill: 0xffffff,
            stroke: { color: 0x000000, width: 3 },
          },
        });
        text.anchor.set(0.5, 1);
        text.visible = false;
        this.floatLayer.addChild(text);
        return { text, elapsed: 0, life: 1, baseX: 0, baseY: 0, originX: 0, originY: 0 };
      },
      (item) => {
        item.text.visible = false;
        item.elapsed = 0;
      },
      MAX_FLOATS,
    );
    this.effects = new Pool<EffectItem>(
      () => {
        const g = new Graphics();
        g.visible = false;
        this.layer.addChild(g);
        return { g, sprite: null, burst: null, burstFrames: null, spec: null, elapsed: 0, life: 1 };
      },
      (item) => {
        item.g.clear();
        item.g.visible = false;
        if (item.sprite) item.sprite.visible = false;
        if (item.burst) item.burst.visible = false;
        item.burstFrames = null;
        item.spec = null;
        item.elapsed = 0;
      },
      MAX_EFFECTS,
    );
  }

  /** `origin` is the screen position of the tile centre (world-local iso px). */
  /**
   * Floats spawned at nearly the same spot within STAGGER_WINDOW_MS are
   * staggered (alternating sideways, stacked upwards; floatStagger), so bursts
   * of hits (several per frame at high sim speed) stay readable instead of
   * printing on top of each other.
   */
  float(spec: FloatTextSpec, origin: { sx: number; sy: number }): void {
    let near = 0;
    const live = this.floats.active;
    for (let i = 0; i < live.length; i++) {
      const f = live[i]!;
      if (
        f.elapsed < STAGGER_WINDOW_MS &&
        Math.abs(f.originX - origin.sx) <= FLOAT_STAGGER_NEAR_PX &&
        Math.abs(f.originY - origin.sy) <= FLOAT_STAGGER_NEAR_PX
      ) {
        near++;
      }
    }
    const off = near > 0 ? floatStagger(near) : null;
    const x = origin.sx + (off ? off.dx : 0);
    const y = origin.sy + (off ? off.dy : 0);
    const item = this.floats.spawn();
    item.elapsed = 0;
    item.life = Math.max(1, spec.ms ?? 900);
    item.baseX = x;
    item.baseY = y;
    item.originX = origin.sx;
    item.originY = origin.sy;
    const t = item.text;
    t.text = spec.text;
    t.style.fontSize = isMiss(spec.text) ? MISS_FONT_PX : floatFontSize(spec.size);
    t.style.fill = spec.color;
    t.position.set(x, y);
    t.alpha = 1;
    t.visible = true;
  }

  /**
   * Plays a one-shot effect at `origin`. `burstFrames` are the frames of the
   * `<sprite>.burst` animation when the manifest has it; the static sprite is
   * then not drawn. Returns how the effect was drawn (for QA).
   */
  effect(
    spec: EffectSpec,
    origin: { sx: number; sy: number },
    burstFrames: Texture[] | null = null,
  ): EffectArt {
    const item = this.effects.spawn();
    item.spec = spec;
    item.elapsed = 0;
    item.life = effectDuration(spec.kind, spec.durationMs);
    item.g.position.set(origin.sx, origin.sy);
    item.g.visible = true;
    const tex = spec.sprite ? this.spriteFor(spec.sprite) : null;
    let art: EffectArt = "procedural";
    if (burstFrames && burstFrames.length > 0) {
      if (!item.burst) {
        item.burst = new Sprite();
        item.burst.anchor.set(0.5);
        this.layer.addChild(item.burst);
      }
      item.burstFrames = burstFrames;
      item.burst.texture = burstFrames[0]!;
      item.burst.position.set(origin.sx, origin.sy);
      item.burst.scale.set(burstScale(spec.radius ?? 1, DEFAULT_ISO.tileWidth));
      item.burst.alpha = 1;
      item.burst.visible = true;
      art = "anim";
    } else if (item.burst) {
      item.burst.visible = false;
    }
    if (tex) {
      if (!item.sprite) {
        item.sprite = new Sprite();
        item.sprite.anchor.set(0.5);
        this.layer.addChild(item.sprite);
      }
      item.sprite.texture = tex;
      item.sprite.position.set(origin.sx, origin.sy);
      item.sprite.visible = art !== "anim";
      if (art === "procedural") art = "sprite";
    } else if (item.sprite) {
      item.sprite.visible = false;
    }
    this.draw(item, 0);
    this.emitParticles(spec, origin);
    return art;
  }

  /** Quality: particle caps, glow and the segment count of the shapes. */
  setQuality(q: GraphicsQualityLevel): void {
    this.quality = q;
    this.particles.setQuality(q);
  }

  get currentQuality(): GraphicsQualityLevel {
    return this.quality;
  }

  update(dtMs: number): void {
    const fl = this.floats.active;
    for (let i = fl.length - 1; i >= 0; i--) {
      const item = fl[i]!;
      item.elapsed += dtMs;
      if (item.elapsed >= item.life) {
        this.floats.retire(item);
        continue;
      }
      const pose = floatPose(item.elapsed, item.life);
      item.text.position.set(item.baseX, item.baseY + pose.dy);
      item.text.alpha = pose.alpha;
    }
    const ef = this.effects.active;
    for (let i = ef.length - 1; i >= 0; i--) {
      const item = ef[i]!;
      item.elapsed += dtMs;
      if (item.elapsed >= item.life) {
        this.effects.retire(item);
        continue;
      }
      this.draw(item, item.elapsed / item.life);
    }
    this.particles.update(dtMs);
  }

  get activeFloats(): number {
    return this.floats.active.length;
  }

  get activeEffects(): number {
    return this.effects.active.length;
  }

  destroy(): void {
    this.floats.drain((item) => item.text.destroy());
    this.effects.drain((item) => {
      item.g.destroy();
      item.sprite?.destroy();
      item.burst?.destroy();
    });
    this.particles.destroy();
  }

  private emitParticles(spec: EffectSpec, origin: { sx: number; sy: number }): void {
    this.particles.emit(spec, origin.sx, origin.sy);
    if (END_BURST_KINDS.has(spec.kind) && spec.x2 !== undefined && spec.y2 !== undefined) {
      const end = tileToScreen(spec.x2 - spec.x, spec.y2 - spec.y);
      this.particles.emit(spec, origin.sx + end.sx, origin.sy + end.sy);
    }
  }

  private draw(item: EffectItem, p: number): void {
    const spec = item.spec;
    if (!spec) return;
    const g = item.g;
    g.clear();
    for (const op of planEffect(spec, p, this.quality)) drawOp(g, op);
    const frames = item.burstFrames;
    const bs = item.burst;
    if (frames && bs && bs.visible) {
      bs.texture = frames[frameFromProgress(p, frames.length)] ?? frames[0]!;
      bs.alpha = p < BURST_FADE_FROM ? 1 : 1 - (p - BURST_FADE_FROM) / (1 - BURST_FADE_FROM);
    }
    const sp = item.sprite;
    if (sp && sp.visible) {
      sp.alpha = 1 - p;
      sp.scale.set(0.6 + 0.4 * p);
    }
  }
}

function isMiss(text: string): boolean {
  return text === "miss" || text === "Miss" || text === "MISS";
}

function drawOp(g: Graphics, op: FxOp): void {
  if (op.alpha <= MIN_ALPHA) return;
  switch (op.op) {
    case "line": {
      const under = underStroke(op);
      if (under) {
        g.poly(op.pts, op.closed).stroke({
          width: under.width,
          color: UNDER_COLOUR,
          alpha: under.alpha,
          join: "round",
          cap: "round",
        });
      }
      // Coloured lines (the ones with an under-stroke) keep a minimum width.
      const width = under ? Math.max(LINE_MIN_PX, op.width) : op.width;
      g.poly(op.pts, op.closed).stroke({ width, color: op.color, alpha: op.alpha });
      return;
    }
    case "fill":
      g.poly(op.pts, true).fill({ color: op.color, alpha: op.alpha });
      return;
    case "dot":
      g.circle(op.x, op.y, op.r).fill({ color: op.color, alpha: op.alpha });
      return;
  }
}

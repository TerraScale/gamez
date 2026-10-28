import { Container, Graphics, Sprite, Text, type Texture } from "pixi.js";
import type { EffectSpec, FloatTextSpec } from "@gamez/ui-host";
import { FLOAT_STAGGER_NEAR_PX, floatStagger } from "./anim-math.ts";
import { effectDuration, floatFontSize, floatPose } from "./fx-math.ts";
import { LINE_MIN_PX, planEffect, UNDER_COLOUR, underStroke, type FxOp } from "./fx-plan.ts";
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
  spec: EffectSpec | null;
  elapsed: number;
  life: number;
}

/**
 * Float texts and one-shot effects, both from capped pools. Effects live in
 * `layer` and floats in `floatLayer`; the renderer stacks both above the name
 * labels (floats on top), so nothing is allocated in the steady state beyond
 * the small op lists the planner returns.
 */
export class FxLayer {
  readonly layer = new Container();
  /** Float texts: above effects and name labels. */
  readonly floatLayer = new Container();
  private readonly floats: Pool<FloatItem>;
  private readonly effects: Pool<EffectItem>;

  constructor(private readonly spriteFor: (id: string) => Texture | null) {
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
        return { g, sprite: null, spec: null, elapsed: 0, life: 1 };
      },
      (item) => {
        item.g.clear();
        item.g.visible = false;
        if (item.sprite) item.sprite.visible = false;
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

  effect(spec: EffectSpec, origin: { sx: number; sy: number }): void {
    const item = this.effects.spawn();
    item.spec = spec;
    item.elapsed = 0;
    item.life = effectDuration(spec.kind, spec.durationMs);
    item.g.position.set(origin.sx, origin.sy);
    item.g.visible = true;
    const tex = spec.sprite ? this.spriteFor(spec.sprite) : null;
    if (tex) {
      if (!item.sprite) {
        item.sprite = new Sprite();
        item.sprite.anchor.set(0.5);
        this.layer.addChild(item.sprite);
      }
      item.sprite.texture = tex;
      item.sprite.position.set(origin.sx, origin.sy);
      item.sprite.visible = true;
    } else if (item.sprite) {
      item.sprite.visible = false;
    }
    this.draw(item, 0);
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
    });
  }

  private draw(item: EffectItem, p: number): void {
    const spec = item.spec;
    if (!spec) return;
    const g = item.g;
    g.clear();
    for (const op of planEffect(spec, p)) drawOp(g, op);
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

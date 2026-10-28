import { Container, Graphics, Sprite, Text, type Texture } from "pixi.js";
import type { EffectSpec, FloatTextSpec } from "@gamez/ui-host";
import { effectDuration, floatFontSize, floatPose } from "./fx-math.ts";
import { planEffect, type FxOp } from "./fx-plan.ts";
import { Pool } from "./pool.ts";

const MAX_FLOATS = 48;
const MAX_EFFECTS = 40;
/** Ops with alpha at or below this are skipped. */
const MIN_ALPHA = 0.01;

interface FloatItem {
  text: Text;
  elapsed: number;
  life: number;
  baseX: number;
  baseY: number;
}

interface EffectItem {
  g: Graphics;
  sprite: Sprite | null;
  spec: EffectSpec | null;
  elapsed: number;
  life: number;
}

/**
 * Float texts and one-shot effects, both from capped pools. Everything lives
 * in one layer above the world, so nothing is allocated in the steady state
 * beyond the small op lists the planner returns.
 */
export class FxLayer {
  readonly layer = new Container();
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
        this.layer.addChild(text);
        return { text, elapsed: 0, life: 1, baseX: 0, baseY: 0 };
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
  float(spec: FloatTextSpec, origin: { sx: number; sy: number }): void {
    const item = this.floats.spawn();
    item.elapsed = 0;
    item.life = Math.max(1, spec.ms ?? 900);
    item.baseX = origin.sx;
    item.baseY = origin.sy;
    const t = item.text;
    t.text = spec.text;
    t.style.fontSize = floatFontSize(spec.size);
    t.style.fill = spec.color;
    t.position.set(origin.sx, origin.sy);
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

function drawOp(g: Graphics, op: FxOp): void {
  if (op.alpha <= MIN_ALPHA) return;
  switch (op.op) {
    case "line":
      g.poly(op.pts, op.closed).stroke({ width: op.width, color: op.color, alpha: op.alpha });
      return;
    case "fill":
      g.poly(op.pts, true).fill({ color: op.color, alpha: op.alpha });
      return;
    case "dot":
      g.circle(op.x, op.y, op.r).fill({ color: op.color, alpha: op.alpha });
      return;
  }
}

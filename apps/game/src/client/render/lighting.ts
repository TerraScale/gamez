import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { lightLayout, LIGHT_TEXTURE_HALF_PX } from "./fx-math.ts";

/** Colour of the night overlay (a dark blue-black). */
const NIGHT = 0x05070f;
const TEX = LIGHT_TEXTURE_HALF_PX * 2;

/**
 * Darkness outside a light circle. One cached radial texture (transparent in
 * the middle, opaque at the edge) is scaled to the light radius; rectangles
 * cover what lies outside the sprite's square. Lives in stage space, above the
 * world view, and follows the followed point.
 */
export class LightingOverlay {
  private texture: Texture | null = null;
  private textureTried = false;
  private sprite: Sprite | null = null;
  private frame: Graphics | null = null;
  private last: number[] = [NaN, NaN, NaN, NaN, NaN, NaN];

  constructor(private readonly parent: Container) {}

  /** `cx, cy` is the light centre in stage px; `lightPx` the radius in stage px. */
  update(
    darkness: number,
    lightPx: number,
    cx: number,
    cy: number,
    stageW: number,
    stageH: number,
  ): void {
    if (!(darkness > 0)) {
      this.setVisible(false);
      return;
    }
    if (!this.ensure()) return;
    const sp = this.sprite;
    const fr = this.frame;
    if (!sp || !fr) return;
    sp.visible = true;
    fr.visible = true;
    sp.alpha = darkness;
    sp.position.set(cx, cy);
    // Compare numbers, not a string: this runs every frame.
    if (
      darkness === this.last[0] &&
      lightPx === this.last[1] &&
      cx === this.last[2] &&
      cy === this.last[3] &&
      stageW === this.last[4] &&
      stageH === this.last[5]
    ) {
      return;
    }
    this.last = [darkness, lightPx, cx, cy, stageW, stageH];
    const layout = lightLayout(lightPx, cx, cy, stageW, stageH);
    sp.scale.set(layout.scale);
    fr.clear();
    for (const r of layout.rects)
      fr.rect(r.x, r.y, r.w, r.h).fill({ color: NIGHT, alpha: darkness });
  }

  destroy(): void {
    this.sprite?.destroy();
    this.frame?.destroy();
    this.texture?.destroy(true);
    this.sprite = null;
    this.frame = null;
    this.texture = null;
  }

  private setVisible(v: boolean): void {
    if (this.sprite) this.sprite.visible = v;
    if (this.frame) this.frame.visible = v;
  }

  private ensure(): boolean {
    if (!this.textureTried) {
      this.textureTried = true;
      this.texture = makeDarknessTexture();
    }
    if (!this.texture) return false;
    if (!this.sprite) {
      this.sprite = new Sprite(this.texture);
      this.sprite.anchor.set(0.5);
      this.sprite.tint = NIGHT;
      this.parent.addChild(this.sprite);
      this.frame = new Graphics();
      this.parent.addChild(this.frame);
    }
    return true;
  }
}

function makeDarknessTexture(): Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = TEX;
  canvas.height = TEX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const c = TEX / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  // Transparent to a quarter of the half-size, opaque from half of it outwards.
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.25, "rgba(0,0,0,0)");
  grad.addColorStop(0.5, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX, TEX);
  return Texture.from(canvas);
}

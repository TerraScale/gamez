import { GraphicsContext } from "pixi.js";
import { tileToScreen } from "@gamez/world";

/** Screen-space corners of a tile's diamond (top, right, bottom, left), flat x/y pairs. */
export function diamondPoints(x: number, y: number): number[] {
  const t = tileToScreen(x, y);
  const r = tileToScreen(x + 1, y);
  const b = tileToScreen(x + 1, y + 1);
  const l = tileToScreen(x, y + 1);
  return [t.sx, t.sy, r.sx, r.sy, b.sx, b.sy, l.sx, l.sy];
}

/** Flat colour for a ground id when its sprite is missing. */
export function groundFallbackColour(id: string): number {
  if (id.includes("stone")) return 0x7d8491;
  if (id.includes("grass")) return 0x4d7c3a;
  return 0x6b5b4b;
}

export interface Primitives {
  tree: GraphicsContext;
  box: GraphicsContext;
  hero: { self: GraphicsContext; other: GraphicsContext };
}

/** Shared shapes for the fallback props and avatars. Origin is the feet/base. */
export function buildPrimitives(): Primitives {
  return {
    tree: new GraphicsContext()
      .ellipse(0, 0, 12, 5)
      .fill({ color: 0x000000, alpha: 0.25 })
      .rect(-3, -10, 6, 10)
      .fill(0x5a3b1e)
      .poly([-15, -8, 15, -8, 0, -46])
      .fill(0x1f5a2e),
    box: new GraphicsContext()
      .ellipse(0, 0, 11, 5)
      .fill({ color: 0x000000, alpha: 0.25 })
      .rect(-10, -16, 20, 16)
      .fill(0x8a8f99),
    hero: { self: hero(0xffb020), other: hero(0x4f8cff) },
  };
}

/** Destroys the shared contexts; graphics that used them are destroyed separately. */
export function destroyPrimitives(p: Primitives): void {
  p.tree.destroy();
  p.box.destroy();
  p.hero.self.destroy();
  p.hero.other.destroy();
}

function hero(colour: number): GraphicsContext {
  return new GraphicsContext()
    .ellipse(0, 0, 10, 5)
    .fill({ color: 0x000000, alpha: 0.3 })
    .circle(0, -12, 9)
    .fill(colour)
    .stroke({ width: 2, color: 0x0b0d12 });
}

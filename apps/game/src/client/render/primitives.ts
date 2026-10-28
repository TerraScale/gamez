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

export interface Primitives {
  tree: GraphicsContext;
  box: GraphicsContext;
  hero: { self: GraphicsContext; other: GraphicsContext };
  monster: GraphicsContext;
  npc: GraphicsContext;
  loot: GraphicsContext;
  projectile: GraphicsContext;
  shadow: GraphicsContext;
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
    monster: new GraphicsContext()
      .circle(0, -10, 9)
      .fill(0xd0534a)
      .stroke({ width: 2, color: 0x0b0d12 }),
    npc: new GraphicsContext()
      .circle(0, -12, 9)
      .fill(0x5fbf6a)
      .stroke({ width: 2, color: 0x0b0d12 }),
    loot: new GraphicsContext()
      .poly([0, -8, 6, -2, 0, 4, -6, -2])
      .fill(0xffffff)
      .stroke({ width: 1.5, color: 0x0b0d12 }),
    projectile: new GraphicsContext().circle(0, 0, 4).fill(0xffffff),
    shadow: shadowShape(),
  };
}

/** Destroys the shared contexts; graphics that used them are destroyed separately. */
export function destroyPrimitives(p: Primitives): void {
  p.tree.destroy();
  p.box.destroy();
  p.hero.self.destroy();
  p.hero.other.destroy();
  p.monster.destroy();
  p.npc.destroy();
  p.loot.destroy();
  p.projectile.destroy();
  p.shadow.destroy();
}

/** A tall box for a wall without art, tinted by its colour; origin at the base centre. */
export function tallBox(colour: number): GraphicsContext {
  return new GraphicsContext()
    .ellipse(0, 0, 14, 6)
    .fill({ color: 0x000000, alpha: 0.3 })
    .rect(-14, -40, 28, 40)
    .fill(colour)
    .rect(-14, -40, 28, 6)
    .fill({ color: 0xffffff, alpha: 0.12 })
    .stroke({ width: 1, color: 0x0b0d12, alpha: 0.6 });
}

function shadowShape(): GraphicsContext {
  return new GraphicsContext().ellipse(0, 0, 11, 5).fill({ color: 0x000000, alpha: 0.3 });
}

function hero(colour: number): GraphicsContext {
  return new GraphicsContext()
    .ellipse(0, 0, 10, 5)
    .fill({ color: 0x000000, alpha: 0.3 })
    .circle(0, -12, 9)
    .fill(colour)
    .stroke({ width: 2, color: 0x0b0d12 });
}

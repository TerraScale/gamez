import { describe, expect, it } from "vite-plus/test";
import { Container, Texture } from "pixi.js";
import type { TileMap } from "@gamez/world";
import type { ArpgRenderEntity } from "@gamez/ui-host";
import { EntityLayer, type EntityView } from "../../src/client/render/entity-view.ts";
import { buildPrimitives, destroyPrimitives } from "../../src/client/render/primitives.ts";
import { buildChunk, destroyChunk } from "../../src/client/render/ground.ts";
import { FxLayer } from "../../src/client/render/fx.ts";
import type { AnimVisual, SpriteVisual, Visuals } from "../../src/client/render/visuals.ts";

/** A Visuals stand-in: exact keys in `anims` and `sprites` resolve, nothing else. */
function fakeVisuals(anims: string[], sprites: string[] = []): Visuals {
  const frame = Texture.EMPTY;
  const anim = (key: string): AnimVisual | null =>
    anims.includes(key) ? { frames: [frame], anchor: undefined, fps: 10, loop: true } : null;
  const still = (key: string): SpriteVisual | null =>
    sprites.includes(key) ? { texture: frame, anchor: undefined } : null;
  return {
    sprite: still,
    animation: anim,
    spriteExact: still,
    animationExact: anim,
  };
}

function entity(extra: Partial<ArpgRenderEntity> = {}): ArpgRenderEntity {
  return {
    id: "c1",
    name: "Zombie",
    appearance: "unit.monster.zombie",
    x: 10,
    y: 12,
    facing: "s",
    moving: false,
    isSelf: false,
    ...extra,
  };
}

function setup(visuals: Visuals) {
  const world = new Container();
  world.sortableChildren = true;
  const prims = buildPrimitives();
  const layer = new EntityLayer(world, visuals, prims);
  const view = (id = "c1"): EntityView => {
    for (const v of layer.all()) if (v.id === id) return v;
    throw new Error(`no view ${id}`);
  };
  return { world, prims, layer, view };
}

describe("EntityLayer", () => {
  it("creates one container per entity and reuses it on later upserts", () => {
    const { world, layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity());
    const first = view();
    layer.upsert(entity({ x: 11 }));
    expect(view()).toBe(first);
    expect(layer.size).toBe(1);
    expect(world.children).toHaveLength(1);
    expect(first.root.zIndex).toBe(11 + 12);
  });

  it("falls back to the primitive shape when no art resolves", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity({ kind: "unit" }));
    const v = view();
    expect(v.resolved).toBe("prim");
    expect(v.prim.visible).toBe(true);
    expect(v.anim).toBeNull();
    expect(v.still).toBeNull();
  });

  it("prefers an animation by the documented chain, then a still sprite", () => {
    const visuals = fakeVisuals(["unit.monster.zombie.walk"], ["prop.barrel"]);
    const { layer, view } = setup(visuals);
    layer.upsert(entity({ moving: true, facing: "e" }));
    expect(view().resolved).toBe("anim");
    expect(view().resolvedKey).toBe("unit.monster.zombie.walk");
    expect(view().anim?.visible).toBe(true);
    expect(view().prim.visible).toBe(false);

    layer.upsert(entity({ appearance: "prop.barrel", moving: false, kind: "prop" }));
    expect(view().resolved).toBe("still");
    expect(view().still?.visible).toBe(true);
    expect(view().anim?.visible).toBe(false);
  });

  it("uses the fallback appearance when the primary has no art", () => {
    const visuals = fakeVisuals(["unit.hero.idle"]);
    const { layer, view } = setup(visuals);
    layer.upsert(entity({ appearance: "unit.hero.warrior", fallbackAppearance: "unit.hero" }));
    expect(view().resolvedKey).toBe("unit.hero.idle");
  });

  it("lies down and keeps the entity visible when a dead unit has no death animation", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity({ dead: true }));
    expect(view().body.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(view().root.alpha).toBeLessThan(1);
  });

  it("does not lie down when a death animation plays", () => {
    const { layer, view } = setup(fakeVisuals(["unit.monster.zombie.death"]));
    layer.upsert(entity({ dead: true }));
    expect(view().resolved).toBe("anim");
    expect(view().body.rotation).toBe(0);
    expect(view().root.alpha).toBe(1);
  });

  it("never shows a shadow, label or bar for projectiles", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity({ kind: "projectile", showLabel: true, bar: 0.5, zLift: 24 }));
    expect(view().shadow.visible).toBe(false);
    expect(view().label).toBeNull();
    expect(view().bar?.visible ?? false).toBe(false);
    expect(view().body.y).toBe(-24);
  });

  it("creates the label lazily and shows it for labelled or highlighted entities", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity({ kind: "unit" }));
    expect(view().label).toBeNull();
    layer.upsert(entity({ kind: "unit", showLabel: true, labelColor: 0xa335ee }));
    expect(view().label?.visible).toBe(true);
    expect(view().label?.text).toBe("Zombie");
    layer.upsert(entity({ kind: "unit", showLabel: false, highlight: true }));
    expect(view().label?.visible).toBe(true);
    layer.upsert(entity({ kind: "unit" }));
    expect(view().label?.visible).toBe(false);
  });

  it("shows the health bar only when a bar value is given", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity({ kind: "unit", bar: 0.5, barColor: 0x40c040 }));
    expect(view().bar?.visible).toBe(true);
    layer.upsert(entity({ kind: "unit", bar: null }));
    expect(view().bar?.visible).toBe(false);
  });

  it("pulses only status-tinted entities and paints the tint they take", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity({ kind: "unit", statusTint: 0x3366ff }));
    layer.tickPulse(0);
    const a = view().paintedTint;
    layer.tickPulse(900);
    const b = view().paintedTint;
    expect(a).not.toBe(b);
    layer.upsert(entity({ kind: "unit" }));
    layer.tickPulse(1500);
    expect(view().paintedTint).toBe(0xffffff);
  });

  it("removes and clears containers without leaving children behind", () => {
    const { world, layer } = setup(fakeVisuals([]));
    layer.upsert(entity({ id: "a" }));
    layer.upsert(entity({ id: "b", x: 3 }));
    layer.remove("a");
    expect(layer.size).toBe(1);
    expect(world.children).toHaveLength(1);
    layer.clear();
    expect(layer.size).toBe(0);
    expect(world.children).toHaveLength(0);
  });
});

function smallMap(): TileMap {
  const w = 20;
  const h = 20;
  const ground: string[] = [];
  const objects: (string | null)[] = [];
  const walkable: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ground.push(x < 16 ? "tile.grass" : "tile.void");
      objects.push(x === 3 && y === 2 ? "wall.crypt" : x === 17 && y === 17 ? "prop.tree" : null);
      walkable.push(1);
    }
  }
  return { id: "t", width: w, height: h, ground, objects, walkable, spawn: { x: 0, y: 0 } };
}

describe("buildChunk", () => {
  it("builds ground and props for one chunk and tears them down", () => {
    const map = smallMap();
    const prims = buildPrimitives();
    const groundLayer = new Container();
    const world = new Container();
    world.sortableChildren = true;
    const walls = new Map();
    const ctx = { map, visuals: fakeVisuals([]), prims, walls };
    const chunk = buildChunk(ctx, 0, 0, groundLayer, world);
    expect(chunk.ground).not.toBeNull();
    expect(groundLayer.children).toHaveLength(1);
    expect(chunk.props).toHaveLength(1);
    expect(world.children).toHaveLength(1);
    // The wall had no art, so it became a shared tall box.
    expect(walls.size).toBe(1);

    destroyChunk(chunk);
    expect(world.children).toHaveLength(0);
    expect(groundLayer.children).toHaveLength(0);
    expect(chunk.ground).toBeNull();
    destroyPrimitives(prims);
  });

  it("draws void tiles as dark fallbacks and builds the edge chunk with its size", () => {
    const map = smallMap();
    const prims = buildPrimitives();
    const groundLayer = new Container();
    const world = new Container();
    const chunk = buildChunk(
      { map, visuals: fakeVisuals([]), prims, walls: new Map() },
      1,
      0,
      groundLayer,
      world,
    );
    // Chunk (1,0) covers x 16..19: all void, so the ground is one fallback Graphics.
    expect(chunk.ground?.children).toHaveLength(1);
    expect(chunk.props).toHaveLength(0);
    destroyChunk(chunk);
    destroyPrimitives(prims);
  });
});

describe("FxLayer", () => {
  it("expires floats and effects and reuses pooled items", () => {
    const fx = new FxLayer(() => null);
    fx.float({ x: 1, y: 1, text: "12", color: 0xffffff, ms: 500 }, { sx: 0, sy: 0 });
    expect(fx.activeFloats).toBe(1);
    fx.update(250);
    expect(fx.activeFloats).toBe(1);
    fx.update(300);
    expect(fx.activeFloats).toBe(0);

    for (let i = 0; i < 45; i++) {
      fx.effect({ kind: "nova", x: 2, y: 2, color: 0xff0000 }, { sx: 0, sy: 0 });
    }
    expect(fx.activeEffects).toBe(40);
    fx.update(10_000);
    expect(fx.activeEffects).toBe(0);
    fx.destroy();
  });

  it("caps float texts and recycles the oldest one", () => {
    const fx = new FxLayer(() => null);
    for (let i = 0; i < 60; i++) {
      fx.float({ x: i, y: 0, text: String(i), color: 0xffffff, size: "l" }, { sx: 0, sy: 0 });
    }
    expect(fx.activeFloats).toBe(48);
    fx.destroy();
  });
});

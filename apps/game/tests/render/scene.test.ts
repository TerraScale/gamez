import { describe, expect, it } from "vite-plus/test";
import { Container, Texture, type ColorMatrixFilter, type Text } from "pixi.js";
import type { TileMap } from "@gamez/world";
import type { ArpgRenderEntity } from "@gamez/ui-host";
import { EntityLayer, type EntityView } from "../../src/client/render/entity-view.ts";
import { buildPrimitives, destroyPrimitives } from "../../src/client/render/primitives.ts";
import { buildChunk, destroyChunk } from "../../src/client/render/ground.ts";
import { FxLayer } from "../../src/client/render/fx.ts";
import type { AnimVisual, SpriteVisual, Visuals } from "../../src/client/render/visuals.ts";

/** A Visuals stand-in: exact keys in `anims` and `sprites` resolve, nothing else. */
function fakeVisuals(anims: string[], sprites: string[] = [], frameCount = 1): Visuals {
  const frame = Texture.EMPTY;
  const cache = new Map<string, AnimVisual>();
  const anim = (key: string): AnimVisual | null => {
    if (!anims.includes(key)) return null;
    let v = cache.get(key);
    if (!v) {
      const frames = Array.from({ length: frameCount }, () => frame);
      v = { frames, anchor: undefined, fps: 10, loop: true };
      cache.set(key, v);
    }
    return v;
  };
  const still = (key: string): SpriteVisual | null =>
    sprites.includes(key) ? { texture: frame, anchor: undefined } : null;
  return {
    sprite: still,
    animation: anim,
    spriteExact: still,
    animationExact: anim,
    hasExactAnimation: (key: string) => anims.includes(key),
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

/** Stands in for ColorMatrixFilter (which needs WebGL): only the matrix and destroy matter here. */
class FakeFilter {
  matrix: number[] = [];
  destroy(): void {}
}

function setup(visuals: Visuals) {
  const world = new Container();
  world.sortableChildren = true;
  const prims = buildPrimitives();
  const labels = new Container();
  const layer = new EntityLayer(world, visuals, prims, labels);
  const view = (id = "c1"): EntityView => {
    for (const v of layer.all()) if (v.id === id) return v;
    throw new Error(`no view ${id}`);
  };
  return { world, labels, prims, layer, view };
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

  it("fades and squashes (never rotates) a dead unit without a death animation", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity({ dead: true }));
    expect(view().body.rotation).toBe(0);
    expect(view().body.scale.y).toBeLessThan(view().body.scale.x);
    expect(view().root.alpha).toBeLessThan(1);
    // The scene's corpse fade multiplies in.
    layer.upsert(entity({ dead: true, alpha: 0.5 }));
    expect(view().root.alpha).toBeCloseTo(0.5 * 0.55, 9);
  });

  it("does not squash or fade when a death animation plays", () => {
    const { layer, view } = setup(fakeVisuals(["unit.monster.zombie.death"]));
    layer.upsert(entity({ dead: true }));
    expect(view().resolved).toBe("anim");
    expect(view().body.rotation).toBe(0);
    expect(view().body.scale.y).toBe(1);
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

describe("EntityLayer animation and labels", () => {
  it("drives attack/cast frames from actionProgress and resumes autoplay without it", () => {
    const { layer, view } = setup(fakeVisuals(["unit.monster.zombie.attack"], [], 4));
    layer.upsert(entity({ action: "attack", actionProgress: 0.5 }));
    const sp = view().anim!;
    expect(sp.playing).toBe(false);
    expect(sp.currentFrame).toBe(2);
    layer.upsert(entity({ action: "attack", actionProgress: 1 }));
    expect(sp.currentFrame).toBe(3);
    // A cast without its own clip uses the attack clip, with the same frame math.
    layer.upsert(entity({ action: "cast", actionProgress: 0 }));
    expect(view().resolvedKey).toBe("unit.monster.zombie.attack");
    expect(sp.currentFrame).toBe(0);
    layer.upsert(entity({ action: "attack" }));
    expect(sp.playing).toBe(true);
  });

  it("scales the clip speed with animRate", () => {
    const { layer, view } = setup(fakeVisuals(["unit.monster.zombie.walk"], [], 4));
    layer.upsert(entity({ action: "walk" }));
    const base = view().anim!.animationSpeed;
    layer.upsert(entity({ action: "walk", animRate: 1.5 }));
    expect(view().anim!.animationSpeed).toBeCloseTo(base * 1.5, 9);
    layer.upsert(entity({ action: "walk", animRate: 9 }));
    expect(view().anim!.animationSpeed).toBeCloseTo(base * 1.8, 9);
  });

  it("flashes white with a colour filter and knocks back on a hit, then restores", () => {
    const { layer, view } = setup(fakeVisuals([]));
    const filters: FakeFilter[] = [];
    layer.makeFlashFilter = () => {
      const f = new FakeFilter();
      filters.push(f);
      return f as unknown as ColorMatrixFilter;
    };
    layer.upsert(entity({ kind: "unit", hitFlash: 1 }));
    // The body keeps its own tint: the flash is a colour matrix, not a multiply tint.
    expect(view().paintedTint).toBe(0xffffff);
    expect(view().body.filters).toHaveLength(1);
    const m = filters[0]!.matrix;
    // White mix at full flash: the colour is kept at 1 - k and the offset adds k.
    expect(m[0]).toBeLessThan(1);
    expect(m[4]).toBeGreaterThan(0);
    expect(m[4]).toBeCloseTo(m[9]!, 9);
    expect(view().body.x).not.toBe(0);
    layer.upsert(entity({ kind: "unit" }));
    expect(view().body.filters).toBeNull();
    expect(view().body.x).toBe(0);
  });

  it("uses the hit flash colour when given, and skips the flash without a filter", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.makeFlashFilter = () => null;
    layer.upsert(entity({ kind: "unit", hitFlash: 1 }));
    expect(view().body.filters ?? null).toBeNull();
    const f = new FakeFilter();
    layer.makeFlashFilter = () => f as unknown as ColorMatrixFilter;
    layer.upsert(entity({ kind: "unit", hitFlash: 1, hitFlashColor: 0x00ff00 }));
    expect(f.matrix[9]).toBeGreaterThan(0);
    expect(f.matrix[4]).toBe(0);
  });

  it("draws an additive cast glow in the skill colour and lifts the unit while casting", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity({ kind: "unit" }));
    expect(view().glow).toBeNull();
    layer.upsert(entity({ kind: "unit", castGlow: 1, glowColor: 0x33ccff }));
    const v = view();
    expect(v.glow).not.toBeNull();
    expect(v.glow!.blendMode).toBe("add");
    expect(v.glow!.alpha).toBe(1);
    expect(v.body.y).toBeLessThan(0);
    layer.upsert(entity({ kind: "unit", castGlow: 0 }));
    expect(v.glow!.visible).toBe(false);
    expect(v.body.y).toBe(0);
    // Quality low turns the halo off.
    layer.glowOn = false;
    layer.upsert(entity({ kind: "unit", castGlow: 1 }));
    expect(v.glow!.visible).toBe(false);
  });

  it("mirrors facing-less art for screen-left facings, never facing-specific clips", () => {
    const { layer, view } = setup(fakeVisuals(["unit.monster.zombie.walk"]));
    layer.upsert(entity({ action: "walk", facing: "w" }));
    expect(view().body.scale.x).toBeLessThan(0);
    layer.upsert(entity({ action: "walk", facing: "e" }));
    expect(view().body.scale.x).toBeGreaterThan(0);
    const per = setup(fakeVisuals(["unit.monster.zombie.walk.w"]));
    per.layer.upsert(entity({ action: "walk", facing: "w" }));
    expect(per.view().body.scale.x).toBeGreaterThan(0);
  });

  it("rotates projectiles along vx/vy", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(entity({ kind: "projectile", vx: 1, vy: 1 }));
    expect(view().body.rotation).toBeCloseTo(Math.PI / 2, 9);
    layer.upsert(entity({ kind: "projectile", vx: 1, vy: -1 }));
    expect(view().body.rotation).toBeCloseTo(0, 9);
  });

  it("draws names, subtitles and markers in the label layer, above every sprite", () => {
    const { world, labels, layer, view } = setup(fakeVisuals([]));
    layer.upsert(
      entity({
        kind: "npc",
        name: "Captain Hale",
        showLabel: true,
        subtitle: "Watch Captain",
        marker: "!",
      }),
    );
    const v = view();
    expect(world.children).toHaveLength(1);
    expect(labels.children).toHaveLength(1);
    expect(v.tag?.parent).toBe(labels);
    expect(v.label?.visible).toBe(true);
    expect(v.subtitle?.text).toBe("Watch Captain");
    expect(v.marker?.text).toBe("!");
    // Stack: marker above the name above the subtitle.
    expect(v.marker!.y).toBeLessThan(v.label!.y);
    expect(v.label!.y).toBeLessThan(v.subtitle!.y);
    const census = layer.census();
    expect(census.labels.npc).toBe(1);
    expect(census.labels.subtitle).toBe(1);
    expect(census.labels.marker).toBe(1);
    layer.upsert(entity({ kind: "npc", name: "Captain Hale", showLabel: true, marker: "?" }));
    expect(v.marker?.text).toBe("?");
    expect(v.subtitle?.visible).toBe(false);
    layer.upsert(entity({ kind: "npc", name: "Captain Hale", showLabel: true, marker: null }));
    expect(layer.census().labels.marker).toBe(0);
    layer.remove("c1");
    expect(labels.children).toHaveLength(0);
  });

  it("de-overlaps loot labels by priority and keeps labels inside the view", () => {
    const { layer, view } = setup(fakeVisuals([]));
    layer.upsert(
      entity({ id: "gold", kind: "loot", name: "7 gold", showLabel: true, labelPriority: 0 }),
    );
    layer.upsert(
      entity({ id: "uniq", kind: "loot", name: "Hollow Fang", showLabel: true, labelPriority: 5 }),
    );
    const rect = { x0: -10_000, y0: -10_000, x1: 10_000, y1: 10_000 };
    layer.layoutLabels(rect);
    expect(view("uniq").texts!.y).toBe(0);
    expect(view("gold").texts!.y).toBeLessThan(0);
    // The hero's own name is a fixed obstacle: loot under it steps aside.
    layer.upsert(entity({ id: "hero", kind: "unit", name: "Hero", isSelf: true }));
    layer.upsert(entity({ id: "potion", kind: "loot", name: "Potion", showLabel: true, x: 20 }));
    layer.upsert(entity({ id: "hero", kind: "unit", name: "Hero", isSelf: true, x: 20 }));
    layer.layoutLabels(rect);
    expect(view("hero").texts!.y).toBe(0);
    expect(view("potion").texts!.y).not.toBe(0);
    // A view whose left edge cuts the label pushes it right.
    const g = view("gold");
    layer.layoutLabels({ x0: g.sx - 5, y0: -10_000, x1: g.sx + 10_000, y1: 10_000 });
    expect(g.texts!.x).toBeGreaterThan(0);
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

  it("staggers floats that spawn at the same spot and shrinks misses", () => {
    const fx = new FxLayer(() => null);
    fx.float({ x: 1, y: 1, text: "12", color: 0xffffff }, { sx: 100, sy: 50 });
    fx.float({ x: 1, y: 1, text: "miss", color: 0x777777, size: "s" }, { sx: 100, sy: 50 });
    fx.float({ x: 9, y: 9, text: "3", color: 0xffffff }, { sx: 400, sy: 50 });
    const [a, b, c] = (fx as unknown as { floats: { active: { text: Text }[] } }).floats.active;
    expect(a!.text.position.x).toBe(100);
    expect(b!.text.position.x).not.toBe(100);
    expect(b!.text.position.y).toBeLessThan(50);
    expect(c!.text.position.x).toBe(400);
    expect(Number(b!.text.style.fontSize)).toBeLessThan(Number(a!.text.style.fontSize));
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

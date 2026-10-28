/** Scene mapping, diffing, interpolation, lighting, camera and picking (docs/design/classic.md §12.3). */
import { describe, expect, it } from "vite-plus/test";
import type { ArpgRenderEntity } from "@gamez/ui-host";
import type { TileMap } from "@gamez/world";
import { AreaTag, Loot, Monster, Pos, Projectile, Life, Dead } from "../src/components.ts";
import { tileCenter, SUB } from "../src/fixed.ts";
import { MONSTER_COLOR, RARITY_COLOR, GOLD_COLOR } from "../src/client/contract.ts";
import {
  interpolate,
  multiplyTint,
  sameEntity,
  SceneSync,
  type SceneInput,
  type SceneRenderer,
  TELEPORT_SUB,
} from "../src/client/scene.ts";
import { testSim, spawnTestHero, spawnTestMonster, useOpenMap } from "./support/harness.ts";

/** Records every renderer call the scene makes. */
class FakeRenderer implements SceneRenderer {
  readonly live = new Map<string, ArpgRenderEntity>();
  upserts = 0;
  removed: string[] = [];
  maps: TileMap[] = [];
  snaps: [number, number][] = [];
  lighting: { darkness: number; radius: number }[] = [];
  follows: [number, number][] = [];
  upsertEntity(e: ArpgRenderEntity): void {
    this.upserts++;
    this.live.set(e.id, { ...e });
  }
  removeEntity(id: string): void {
    this.removed.push(id);
    this.live.delete(id);
  }
  setMap(map: TileMap): void {
    this.maps.push(map);
  }
  snapCamera(x: number, y: number): void {
    this.snaps.push([x, y]);
  }
  setLighting(opts: { darkness: number; radius: number }): void {
    this.lighting.push(opts);
  }
  follow(x: number, y: number): void {
    this.follows.push([x, y]);
  }
}

function input(sim: ReturnType<typeof testSim>, over: Partial<SceneInput> = {}): SceneInput {
  return {
    world: sim.world,
    registry: sim.loaded.registry,
    alpha: 1,
    hovered: 0,
    targeted: 0,
    showLootLabels: true,
    lighting: true,
    ...over,
  };
}

function setup() {
  const sim = testSim([]);
  const map = useOpenMap(sim, 1);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
  const monster = spawnTestMonster(sim.world, { x: 8, y: 5 });
  const renderer = new FakeRenderer();
  const scene = new SceneSync(renderer);
  return { sim, map, hero, monster, renderer, scene };
}

describe("scene mapping", () => {
  it("draws the hero and the monsters of the current area", () => {
    const { sim, hero, monster, renderer, scene } = setup();
    const stats = scene.render(input(sim));
    expect(stats.monsters).toBe(1);
    const h = renderer.live.get(`c${hero}`);
    expect(h).toMatchObject({
      isSelf: true,
      kind: "unit",
      x: 5.5,
      y: 5.5,
      appearance: "unit.hero.fighter",
    });
    const m = renderer.live.get(`c${monster}`);
    expect(m).toMatchObject({
      name: "Dummy",
      x: 8.5,
      y: 5.5,
      appearance: "unit.monster.test",
      tint: 0x88ff88,
    });
    expect(m?.labelColor).toBe(MONSTER_COLOR.normal);
  });

  it("does not draw entities of other areas", () => {
    const { sim, scene, renderer } = setup();
    const other = spawnTestMonster(sim.world, { x: 3, y: 3, depth: 2 });
    scene.render(input(sim));
    expect(renderer.live.has(`c${other}`)).toBe(false);
  });

  it("sets the map, snaps the camera and sets lighting once per area", () => {
    const { sim, map, scene, renderer, hero } = setup();
    scene.render(input(sim));
    scene.render(input(sim));
    expect(renderer.maps).toEqual([map]);
    expect(renderer.snaps).toEqual([[5.5, 5.5]]);
    expect(renderer.lighting).toEqual([{ darkness: 0.5, radius: 8 }]);
    expect(renderer.follows.at(-1)).toEqual([5.5, 5.5]);
    expect(hero).toBeGreaterThan(0);
  });

  it("turns lighting off with the setting and stays dark only underground", () => {
    const { sim, scene, renderer } = setup();
    scene.render(input(sim, { lighting: false }));
    expect(renderer.lighting.at(-1)).toEqual({ darkness: 0, radius: 8 });
  });

  it("shows health bars only for damaged or targeted monsters", () => {
    const { sim, monster, scene, renderer } = setup();
    scene.render(input(sim));
    expect(renderer.live.get(`c${monster}`)?.bar).toBeUndefined();
    sim.world.update(monster, Life, { hp: 10 });
    scene.render(input(sim));
    expect(renderer.live.get(`c${monster}`)?.bar).toBe(0.5);
    sim.world.update(monster, Life, { hp: 20 });
    scene.render(input(sim, { targeted: monster }));
    expect(renderer.live.get(`c${monster}`)?.bar).toBe(1);
  });

  it("draws loot with rarity labels and projectiles above the ground", () => {
    const { sim, scene, renderer } = setup();
    const gold = sim.world.create();
    sim.world.add(gold, Loot, { kind: "gold", item: null, gold: 25, potion: "", droppedAt: 0 });
    sim.world.add(gold, Pos, { x: tileCenter(4), y: tileCenter(4) });
    sim.world.add(gold, AreaTag, { depth: 1 });
    const bolt = sim.world.create();
    sim.world.add(bolt, Projectile, {
      home: 0,
      skill: "test.skill.bolt",
      rank: 1,
      owner: 0,
      team: "hero",
      vx: 64,
      vy: 0,
      rangeLeft: 1000,
      radius: 64,
      pierceLeft: 0,
      damage: { phys: 0, fire: 1, cold: 0, lightning: 0, poison: 0 },
      canMiss: false,
      hit: [],
      sprite: "fx.test",
      explodeRadius: 0,
    });
    sim.world.add(bolt, Pos, { x: tileCenter(6), y: tileCenter(6) });
    sim.world.add(bolt, AreaTag, { depth: 1 });
    scene.render(input(sim, { showLootLabels: false }));
    const g = renderer.live.get(`c${gold}`);
    expect(g).toMatchObject({
      kind: "loot",
      name: "25 gold",
      labelColor: GOLD_COLOR,
      showLabel: false,
    });
    const p = renderer.live.get(`c${bolt}`);
    expect(p).toMatchObject({ kind: "projectile", appearance: "fx.test", zLift: 24 });
    expect(RARITY_COLOR.rare).toBeGreaterThan(0);
  });

  it("upserts only changed entities and removes missing ones", () => {
    const { sim, scene, renderer, monster } = setup();
    scene.render(input(sim));
    expect(renderer.upserts).toBe(2);
    scene.render(input(sim));
    expect(renderer.upserts).toBe(2);
    sim.world.update(monster, Monster, { name: "Dummy Two" });
    scene.render(input(sim));
    expect(renderer.upserts).toBe(3);
    sim.world.destroy(monster);
    scene.render(input(sim));
    expect(renderer.removed).toEqual([`c${monster}`]);
    expect(renderer.live.has(`c${monster}`)).toBe(false);
  });

  it("marks dead monsters and drops them from picking", () => {
    const { sim, scene, renderer, monster } = setup();
    sim.world.add(monster, Dead, { at: 0, killer: 0 });
    const stats = scene.render(input(sim));
    expect(stats.monsters).toBe(0);
    expect(renderer.live.get(`c${monster}`)).toMatchObject({ dead: true, action: "death" });
    expect(scene.pickAt(8.5, 5.5)).toBeNull();
  });

  it("resets drawn entities and the map", () => {
    const { sim, scene, renderer } = setup();
    scene.render(input(sim));
    scene.reset();
    expect(renderer.removed.length).toBe(2);
    scene.render(input(sim));
    expect(renderer.maps.length).toBe(2);
  });
});

describe("interpolation", () => {
  it("moves between the captured position and the current one by alpha", () => {
    const { sim, scene, renderer, hero } = setup();
    scene.render(input(sim));
    scene.capture(sim.world);
    sim.world.update(hero, Pos, { x: tileCenter(6), y: tileCenter(5) });
    scene.render(input(sim, { alpha: 0.5 }));
    expect(renderer.live.get(`c${hero}`)?.x).toBeCloseTo(6);
    scene.render(input(sim, { alpha: 1 }));
    expect(renderer.live.get(`c${hero}`)?.x).toBeCloseTo(6.5);
  });

  it("does not interpolate teleports", () => {
    const { sim, scene, renderer, hero } = setup();
    scene.render(input(sim));
    scene.capture(sim.world);
    sim.world.update(hero, Pos, { x: tileCenter(10), y: tileCenter(5) });
    scene.render(input(sim, { alpha: 0.5 }));
    expect(renderer.live.get(`c${hero}`)?.x).toBeCloseTo(10.5);
  });

  it("computes interpolated sub positions", () => {
    expect(interpolate(undefined, { x: 10, y: 20 }, 0.5)).toEqual({ x: 10, y: 20 });
    expect(interpolate({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5)).toEqual({ x: 50, y: 0 });
    expect(interpolate({ x: 0, y: 0 }, { x: TELEPORT_SUB + 1, y: 0 }, 0.5)).toEqual({
      x: TELEPORT_SUB + 1,
      y: 0,
    });
    expect(interpolate({ x: 0, y: 0 }, { x: 100, y: 0 }, 2)).toEqual({ x: 100, y: 0 });
  });
});

describe("picking", () => {
  it("picks the nearest unit within 0.8 tiles and prefers units over loot", () => {
    const { sim, scene, monster } = setup();
    const gold = sim.world.create();
    sim.world.add(gold, Loot, { kind: "gold", item: null, gold: 5, potion: "", droppedAt: 0 });
    sim.world.add(gold, Pos, { x: tileCenter(8), y: tileCenter(5) });
    sim.world.add(gold, AreaTag, { depth: 1 });
    scene.render(input(sim));
    expect(scene.pickAt(8.6, 5.6)?.entity).toBe(monster);
    expect(scene.pickAt(4.2, 5.5)).toBeNull();
  });

  it("picks loot when no unit is in reach and never picks the hero", () => {
    const { sim, scene, hero } = setup();
    const gold = sim.world.create();
    sim.world.add(gold, Loot, { kind: "gold", item: null, gold: 5, potion: "", droppedAt: 0 });
    sim.world.add(gold, Pos, { x: tileCenter(3), y: tileCenter(3) });
    sim.world.add(gold, AreaTag, { depth: 1 });
    scene.render(input(sim));
    expect(scene.pickAt(3.4, 3.4)?.kind).toBe("loot");
    expect(scene.pickAt(5.5, 5.5)).toBeNull();
    expect(scene.pickables().some((p) => p.entity === hero)).toBe(false);
  });
});

describe("helpers", () => {
  it("multiplies tints per channel and treats 0 as no tint", () => {
    expect(multiplyTint(0xffffff, 0x88ff88)).toBe(0x88ff88);
    expect(multiplyTint(0x808080, 0xffffff)).toBe(0x808080);
    expect(multiplyTint(0xff0000, 0x00ff00)).toBe(0);
  });

  it("compares render entities field by field", () => {
    const a: ArpgRenderEntity = {
      id: "c1",
      name: "x",
      appearance: "a",
      x: 1,
      y: 2,
      facing: "s",
      moving: false,
      isSelf: false,
    };
    expect(sameEntity(a, { ...a })).toBe(true);
    expect(sameEntity(a, { ...a, x: 1.5 })).toBe(false);
    expect(sameEntity(a, { ...a, bar: 0.5 })).toBe(false);
  });

  it("keeps sub units at 256 per tile", () => {
    expect(SUB).toBe(256);
  });
});

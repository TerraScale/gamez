/** Scene mapping, diffing, interpolation, lighting, camera and picking (docs/design/classic.md §12.3). */
import { describe, expect, it } from "vite-plus/test";
import type { ArpgRenderEntity } from "@gamez/ui-host";
import type { TileMap } from "@gamez/world";
import {
  AreaTag,
  Casting,
  Dead,
  Interactable,
  Level,
  Life,
  Loot,
  Monster,
  Mover,
  Npc,
  Pos,
  Projectile,
  Summoned,
} from "../src/components.ts";
import { RES, type QuestState } from "../src/resources.ts";
import { tileCenter, SUB } from "../src/fixed.ts";
import { resolveId } from "@gamez/assets";
import { loadMode } from "@gamez/kernel";
import { mode as classicMode, modules as classicModules } from "../src/index.ts";
import { KIND, type ItemBaseProto } from "../src/types.ts";
import {
  contrastRatio,
  MONSTER_COLOR,
  MONSTER_LABEL_COLOR,
  RARITY_COLOR,
  GOLD_COLOR,
} from "../src/client/contract.ts";
import {
  castProgress,
  FADE_TICKS,
  HINT_NEAR,
  itemSprite,
  labelInsetsFor,
  MONSTER_LABEL_PRIORITY,
  fadeAlpha,
  HIT_PROGRESS,
  HIT_TICKS,
  hitFlashAt,
  interpolate,
  LOOT_PRIORITY,
  monsterScale,
  multiplyTint,
  questMarker,
  sameEntity,
  SceneSync,
  SWING_HOLD_TICKS,
  type SceneInput,
  type SceneRenderer,
  TELEPORT_SUB,
  walkRate,
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
    tick: sim.tick,
    ...over,
  };
}

/** Starts a cast on `e` (sub-free: only the timing fields matter to the scene). */
function cast(
  sim: ReturnType<typeof testSim>,
  e: number,
  skill: string,
  startedAt: number,
  hitAt: number,
  endAt: number,
): void {
  sim.world.add(e, Casting, {
    skill,
    rank: 1,
    target: 0,
    x: 0,
    y: 0,
    startedAt,
    hitAt,
    endAt,
    fired: false,
    pulses: 0,
  });
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

describe("unit animation (client-only, keyed on sim ticks)", () => {
  it("maps a cast so the hit tick lands on HIT_PROGRESS and the clip ends at the lock end", () => {
    expect(castProgress(100, 100, 104, 110)).toBe(0);
    expect(castProgress(102, 100, 104, 110)).toBeCloseTo(HIT_PROGRESS / 2, 9);
    expect(castProgress(104, 100, 104, 110)).toBe(HIT_PROGRESS);
    // The Casting is removed at endAt - 1, so the clip completes there.
    expect(castProgress(109, 100, 104, 110)).toBe(1);
    expect(castProgress(200, 100, 104, 110)).toBe(1);
    // Instant hits start at the peak.
    expect(castProgress(100, 100, 100, 104)).toBe(HIT_PROGRESS);
  });

  it("shows attack with actionProgress at the hit tick, held after the cast ends", () => {
    const { sim, hero, scene, renderer } = setup();
    cast(sim, hero, "test.skill.strike", 10, 14, 20);
    // Render time = tick - 1 + alpha: tick 15, alpha 0 -> t = 14 = hitAt.
    scene.render(input(sim, { tick: 15, alpha: 0 }));
    const h = renderer.live.get(`c${hero}`);
    expect(h?.action).toBe("attack");
    expect(h?.actionProgress).toBe(HIT_PROGRESS);
    // Non-basic skills cast.
    sim.world.remove(hero, Casting);
    cast(sim, hero, "test.skill.bolt", 20, 22, 30);
    scene.render(input(sim, { tick: 21, alpha: 0 }));
    expect(renderer.live.get(`c${hero}`)).toMatchObject({ action: "cast", actionProgress: 0 });
  });

  it("holds the last swing frame for SWING_HOLD_TICKS instead of flashing idle", () => {
    const { sim, hero, scene, renderer } = setup();
    cast(sim, hero, "test.skill.strike", 10, 14, 20);
    scene.render(input(sim, { tick: 19, alpha: 0.5 }));
    sim.world.remove(hero, Casting);
    scene.render(input(sim, { tick: 20, alpha: 0.5 }));
    expect(renderer.live.get(`c${hero}`)).toMatchObject({ action: "attack", actionProgress: 1 });
    scene.render(input(sim, { tick: 19 + SWING_HOLD_TICKS, alpha: 0.5 }));
    expect(renderer.live.get(`c${hero}`)?.action).toBe("attack");
    scene.render(input(sim, { tick: 20 + SWING_HOLD_TICKS, alpha: 0.5 }));
    const idle = renderer.live.get(`c${hero}`);
    expect(idle?.action).toBe("idle");
    expect(idle?.actionProgress).toBeUndefined();
    // A new swing during the hold restarts from 0.
    cast(sim, hero, "test.skill.strike", 30, 34, 40);
    scene.render(input(sim, { tick: 31, alpha: 0 }));
    expect(renderer.live.get(`c${hero}`)).toMatchObject({ action: "attack", actionProgress: 0 });
  });

  it("drops the hold when the unit walks away", () => {
    const { sim, hero, scene, renderer } = setup();
    cast(sim, hero, "test.skill.strike", 10, 14, 20);
    scene.render(input(sim, { tick: 19, alpha: 0 }));
    sim.world.remove(hero, Casting);
    sim.world.update(hero, Mover, { moving: true });
    scene.render(input(sim, { tick: 20, alpha: 0 }));
    expect(renderer.live.get(`c${hero}`)?.action).toBe("walk");
  });

  it("flashes a hit unit for HIT_TICKS and plays hit only when idle", () => {
    const { sim, hero, monster, scene, renderer } = setup();
    scene.render(input(sim)); // first render sets the area (which clears old hit timers)
    scene.noteHit(monster, 50);
    scene.noteHit(hero, 50);
    cast(sim, hero, "test.skill.strike", 48, 50, 56);
    scene.render(input(sim, { tick: 51, alpha: 0 }));
    const m = renderer.live.get(`c${monster}`);
    expect(m?.action).toBe("hit");
    expect(m?.hitFlash).toBe(1);
    const h = renderer.live.get(`c${hero}`);
    expect(h?.action).toBe("attack");
    expect(h?.hitFlash).toBe(1);
    scene.render(input(sim, { tick: 53, alpha: 0 }));
    expect(renderer.live.get(`c${monster}`)?.hitFlash).toBe(0.5);
    scene.render(input(sim, { tick: 51 + HIT_TICKS, alpha: 0 }));
    const after = renderer.live.get(`c${monster}`);
    expect(after?.hitFlash).toBeUndefined();
    expect(after?.action).toBe("idle");
  });

  it("computes hit flash, fade and walk rate helpers", () => {
    expect(hitFlashAt(10, undefined)).toBe(0);
    expect(hitFlashAt(10, 10)).toBe(1);
    expect(hitFlashAt(9, 10)).toBe(1);
    expect(hitFlashAt(10 + HIT_TICKS, 10)).toBe(0);
    expect(fadeAlpha(0, 100)).toBe(1);
    expect(fadeAlpha(100 - FADE_TICKS, 100)).toBe(1);
    expect(fadeAlpha(95, 100)).toBe(0.5);
    expect(fadeAlpha(100, 100)).toBe(0);
    expect(walkRate(51)).toBe(1);
    expect(walkRate(102)).toBe(1.8);
    expect(walkRate(10)).toBe(0.6);
    expect(walkRate(0)).toBe(1);
  });

  it("sets the walk animRate from the real move speed (slows included)", () => {
    const { sim, hero, scene, renderer } = setup();
    sim.world.update(hero, Mover, { moving: true, speed: 76 });
    scene.render(input(sim));
    expect(renderer.live.get(`c${hero}`)).toMatchObject({ action: "walk", animRate: 1.5 });
    sim.world.update(hero, Mover, { speed: 51 });
    scene.render(input(sim));
    expect(renderer.live.get(`c${hero}`)?.animRate).toBeUndefined();
  });

  it("fades corpses over the last FADE_TICKS before removal", () => {
    const { sim, monster, scene, renderer } = setup();
    sim.world.add(monster, Dead, { at: 100, killer: 0 });
    // corpseTicks = 40: removed at tick 140.
    scene.render(input(sim, { tick: 120, alpha: 0 }));
    expect(renderer.live.get(`c${monster}`)?.alpha).toBeUndefined();
    scene.render(input(sim, { tick: 136, alpha: 0 }));
    expect(renderer.live.get(`c${monster}`)?.alpha).toBe(0.5);
    scene.render(input(sim, { tick: 140, alpha: 0.5 }));
    expect(renderer.live.get(`c${monster}`)?.alpha).toBe(0.05);
  });

  it("fades summons before they expire", () => {
    const { sim, monster, scene, renderer } = setup();
    sim.world.add(monster, Summoned, { owner: 0, until: 200 });
    scene.render(input(sim, { tick: 196, alpha: 0 }));
    expect(renderer.live.get(`c${monster}`)?.alpha).toBe(0.5);
  });

  it("rotates projectiles along their velocity", () => {
    const { sim, scene, renderer } = setup();
    const bolt = sim.world.create();
    sim.world.add(bolt, Projectile, {
      home: 0,
      skill: "test.skill.bolt",
      rank: 1,
      owner: 0,
      team: "hero",
      vx: 64,
      vy: -32,
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
    scene.render(input(sim));
    expect(renderer.live.get(`c${bolt}`)).toMatchObject({ vx: 64, vy: -32 });
  });
});

describe("monster presentation", () => {
  it("does not apply MonsterProto.scale twice: 100, champion 110, unique 115, boss 100", () => {
    expect(monsterScale("normal")).toBe(100);
    expect(monsterScale("champion")).toBe(110);
    expect(monsterScale("unique")).toBe(115);
    expect(monsterScale("boss")).toBe(100);
    const { sim, scene, renderer, monster } = setup();
    const champ = spawnTestMonster(sim.world, { x: 10, y: 10, rarity: "champion" });
    scene.render(input(sim));
    expect(renderer.live.get(`c${monster}`)?.scale).toBe(100);
    expect(renderer.live.get(`c${champ}`)?.scale).toBe(110);
  });

  it("labels elites always, normal monsters only when targeted or recently hit", () => {
    const { sim, scene, renderer, monster } = setup();
    const unique = spawnTestMonster(sim.world, { x: 10, y: 10, rarity: "unique" });
    scene.render(input(sim, { tick: 90 }));
    scene.render(input(sim, { tick: 100 }));
    expect(renderer.live.get(`c${unique}`)?.showLabel).toBe(true);
    expect(renderer.live.get(`c${unique}`)?.labelColor).toBe(MONSTER_COLOR.unique);
    expect(renderer.live.get(`c${monster}`)?.showLabel).toBeUndefined();
    scene.render(input(sim, { tick: 100, targeted: monster }));
    expect(renderer.live.get(`c${monster}`)?.showLabel).toBe(true);
    scene.noteHit(monster, 100);
    scene.render(input(sim, { tick: 140 }));
    expect(renderer.live.get(`c${monster}`)?.showLabel).toBe(true);
    scene.render(input(sim, { tick: 200 }));
    expect(renderer.live.get(`c${monster}`)?.showLabel).toBeUndefined();
  });

  it("shows one nameplate per champion pack; the others only when targeted or hit", () => {
    const { sim, scene, renderer } = setup();
    const a = spawnTestMonster(sim.world, { x: 10, y: 10, rarity: "champion", pack: 3 });
    const b = spawnTestMonster(sim.world, { x: 11, y: 10, rarity: "champion", pack: 3 });
    const c = spawnTestMonster(sim.world, { x: 12, y: 10, rarity: "champion", pack: 4 });
    const solo = spawnTestMonster(sim.world, { x: 13, y: 10, rarity: "champion" });
    scene.render(input(sim, { tick: 100 }));
    expect(renderer.live.get(`c${a}`)?.showLabel).toBe(true);
    expect(renderer.live.get(`c${b}`)?.showLabel).toBeUndefined();
    expect(renderer.live.get(`c${c}`)?.showLabel).toBe(true);
    expect(renderer.live.get(`c${solo}`)?.showLabel).toBe(true);
    scene.render(input(sim, { tick: 100, targeted: b }));
    expect(renderer.live.get(`c${b}`)?.showLabel).toBe(true);
    // The plate moves to the next champion once the first one dies.
    sim.world.add(a, Dead, { at: 100, killer: 0 });
    scene.render(input(sim, { tick: 101 }));
    expect(renderer.live.get(`c${a}`)?.showLabel).toBeUndefined();
    expect(renderer.live.get(`c${b}`)?.showLabel).toBe(true);
  });
});

describe("in-world signs", () => {
  function setQuests(sim: ReturnType<typeof testSim>, q: QuestState): void {
    sim.world.setResource(RES.quests, q);
  }

  function townWithNpcs() {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
    const renderer = new FakeRenderer();
    const scene = new SceneSync(renderer);
    const npc = (proto: string, x: number): number => {
      const e = sim.world.create();
      sim.world.add(e, Npc, { proto });
      sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(8) });
      sim.world.add(e, AreaTag, { depth: 1 });
      return e;
    };
    return {
      sim,
      hero,
      renderer,
      scene,
      giver: npc("test.npc.quest", 3),
      smith: npc("test.npc.smith", 7),
    };
  }

  it("marks the quest giver '!' then '?' then nothing through accept and turn-in", () => {
    const { sim, renderer, scene, giver, smith } = townWithNpcs();
    setQuests(sim, { active: [], completed: [] });
    scene.render(input(sim));
    expect(renderer.live.get(`c${giver}`)?.marker).toBe("!");
    expect(renderer.live.get(`c${smith}`)?.marker).toBeUndefined();
    setQuests(sim, {
      active: [{ id: "test.quest.hunt", progress: 1, done: false }],
      completed: [],
    });
    scene.render(input(sim));
    expect(renderer.live.get(`c${giver}`)?.marker).toBeUndefined();
    setQuests(sim, { active: [{ id: "test.quest.hunt", progress: 3, done: true }], completed: [] });
    scene.render(input(sim));
    expect(renderer.live.get(`c${giver}`)?.marker).toBe("?");
    setQuests(sim, { active: [], completed: ["test.quest.hunt"] });
    scene.render(input(sim));
    expect(renderer.live.get(`c${giver}`)?.marker).toBeUndefined();
  });

  it("respects the quest level requirement", () => {
    const { sim, hero } = townWithNpcs();
    const reg = sim.loaded.registry;
    expect(questMarker(reg, { active: [], completed: [] }, "test.npc.quest", 1)).toBe("!");
    expect(questMarker(reg, undefined, "test.npc.smith", 1)).toBeNull();
    expect(sim.world.read(hero, Level).level).toBeGreaterThan(0);
  });

  it("shows NPC titles as subtitles", () => {
    const { sim, renderer, scene, smith } = townWithNpcs();
    scene.render(input(sim));
    expect(renderer.live.get(`c${smith}`)).toMatchObject({
      showLabel: true,
      subtitle: "smith",
      labelColor: GOLD_COLOR,
    });
  });

  it("labels stairs and waypoints always, the stash nearby, and hints the nearest one", () => {
    const { sim, scene, renderer } = setup();
    const station = (kind: "stairsDown" | "waypoint" | "stash", x: number, y: number): number => {
      const e = sim.world.create();
      sim.world.add(e, Interactable, { kind, toDepth: 2 });
      sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
      sim.world.add(e, AreaTag, { depth: 1 });
      return e;
    };
    // Hero at (5, 5).
    const stairs = station("stairsDown", 25, 25);
    const wp = station("waypoint", 7, 5);
    const nearStash = station("stash", 5, 9);
    const farStash = station("stash", 20, 5);
    scene.render(input(sim));
    expect(renderer.live.get(`c${stairs}`)).toMatchObject({ showLabel: true, name: "Stairs down" });
    expect(renderer.live.get(`c${stairs}`)?.subtitle).toBeUndefined();
    expect(renderer.live.get(`c${wp}`)).toMatchObject({
      showLabel: true,
      subtitle: "click to use",
    });
    expect(renderer.live.get(`c${nearStash}`)).toMatchObject({ showLabel: true });
    expect(renderer.live.get(`c${nearStash}`)?.subtitle).toBeUndefined();
    expect(renderer.live.get(`c${farStash}`)?.showLabel).toBeUndefined();
    scene.render(input(sim, { touch: true }));
    expect(renderer.live.get(`c${wp}`)?.subtitle).toBe("tap to use");
  });

  it("ranks loot labels by rarity", () => {
    expect(LOOT_PRIORITY.unique).toBeGreaterThan(LOOT_PRIORITY.rare);
    expect(LOOT_PRIORITY.rare).toBeGreaterThan(LOOT_PRIORITY.magic);
    expect(LOOT_PRIORITY.normal).toBeGreaterThan(LOOT_PRIORITY.gold);
    const { sim, scene, renderer } = setup();
    const gold = sim.world.create();
    sim.world.add(gold, Loot, { kind: "gold", item: null, gold: 5, potion: "", droppedAt: 0 });
    sim.world.add(gold, Pos, { x: tileCenter(3), y: tileCenter(3) });
    sim.world.add(gold, AreaTag, { depth: 1 });
    scene.render(input(sim));
    expect(renderer.live.get(`c${gold}`)?.labelPriority).toBe(LOOT_PRIORITY.gold);
  });
});

describe("label readability (QA round 2)", () => {
  function stationAt(sim: ReturnType<typeof testSim>, kind: "stairsUp" | "waypoint", x: number) {
    const e = sim.world.create();
    sim.world.add(e, Interactable, { kind, toDepth: 0 });
    sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(5) });
    sim.world.add(e, AreaTag, { depth: 1 });
    return e;
  }

  it("drops the use hint when the hero stands on or right next to the station", () => {
    const { sim, scene, renderer } = setup();
    // Hero at (5, 5): one tile away (< HINT_NEAR) keeps the name, drops the hint.
    const near = stationAt(sim, "stairsUp", 6);
    scene.render(input(sim));
    expect(HINT_NEAR).toBeGreaterThanOrEqual(1);
    expect(renderer.live.get(`c${near}`)).toMatchObject({ showLabel: true, name: "Stairs up" });
    expect(renderer.live.get(`c${near}`)?.subtitle).toBeUndefined();
  });

  it("keeps the use hint for the nearest station a few tiles away", () => {
    const { sim, scene, renderer } = setup();
    const wp = stationAt(sim, "waypoint", 7);
    scene.render(input(sim));
    expect(renderer.live.get(`c${wp}`)?.subtitle).toBe("click to use");
  });

  it("requests tiered potion art that falls back to the plain potion sprite", () => {
    const reg = loadMode(classicMode, classicModules).registry;
    const tiers: string[] = [];
    for (const [id, b] of reg.all<ItemBaseProto>(KIND.itemBase)) {
      if (b.category !== "potion" || !b.potion) continue;
      const s = itemSprite(reg, id);
      expect(s.appearance).toBe(`loot.potion.${b.potion.kind}.${b.potion.tier}`);
      tiers.push(s.appearance);
    }
    expect(tiers).toContain("loot.potion.life.1");
    expect(tiers).toContain("loot.potion.life.4");
    expect(tiers).toContain("loot.potion.mana.3");
    // Before the tier frames exist the renderer falls back to loot.potion.<kind>...
    const today = { "loot.potion.life": 1, "loot.potion.mana": 1, "loot.item": 1, missing: 1 };
    expect(resolveId(today, "loot.potion.life.3")).toBe("loot.potion.life");
    expect(resolveId(today, "loot.potion.mana.2")).toBe("loot.potion.mana");
    // ...and picks the exact tier once the art pack adds it.
    expect(resolveId({ ...today, "loot.potion.life.3": 1 }, "loot.potion.life.3")).toBe(
      "loot.potion.life.3",
    );
  });

  it("maps a ground potion to its tiered appearance", () => {
    const { sim, scene, renderer } = setup();
    const p = sim.world.create();
    sim.world.add(p, Loot, {
      kind: "potion",
      item: null,
      gold: 0,
      potion: "test.item.potion.mana",
      droppedAt: 0,
    });
    sim.world.add(p, Pos, { x: tileCenter(3), y: tileCenter(3) });
    sim.world.add(p, AreaTag, { depth: 1 });
    scene.render(input(sim));
    expect(renderer.live.get(`c${p}`)?.appearance).toBe("loot.potion.mana.1");
  });

  it("plates elite names, ranks them, and uses the lighter champion nameplate colour", () => {
    const { sim, scene, renderer, monster } = setup();
    const champ = spawnTestMonster(sim.world, { x: 10, y: 10, rarity: "champion" });
    const boss = spawnTestMonster(sim.world, { x: 12, y: 10, rarity: "boss" });
    scene.render(input(sim, { tick: 99 }));
    scene.noteHit(monster, 100);
    scene.render(input(sim, { tick: 100 }));
    expect(renderer.live.get(`c${champ}`)).toMatchObject({
      showLabel: true,
      labelPlate: true,
      labelColor: MONSTER_LABEL_COLOR.champion,
      labelPriority: MONSTER_LABEL_PRIORITY.champion,
    });
    expect(renderer.live.get(`c${boss}`)).toMatchObject({
      labelPlate: true,
      labelPriority: MONSTER_LABEL_PRIORITY.boss,
    });
    // A normal monster's plate: no backing, default priority.
    expect(renderer.live.get(`c${monster}`)?.showLabel).toBe(true);
    expect(renderer.live.get(`c${monster}`)?.labelPlate).toBeUndefined();
    expect(renderer.live.get(`c${monster}`)?.labelPriority).toBeUndefined();
    expect(MONSTER_LABEL_PRIORITY.boss).toBeGreaterThan(MONSTER_LABEL_PRIORITY.unique);
    expect(MONSTER_LABEL_PRIORITY.unique).toBeGreaterThan(MONSTER_LABEL_PRIORITY.champion);
    // The HUD keeps its colour; only the world nameplate is lighter and readable on dark floors.
    expect(MONSTER_LABEL_COLOR.champion).not.toBe(MONSTER_COLOR.champion);
    for (const floor of [0x000000, 0x1a1a1a, 0x2a2f3a]) {
      expect(contrastRatio(MONSTER_LABEL_COLOR.champion, floor)).toBeGreaterThan(
        contrastRatio(MONSTER_COLOR.champion, floor),
      );
      expect(contrastRatio(MONSTER_LABEL_COLOR.champion, floor)).toBeGreaterThanOrEqual(7);
    }
  });

  it("names every recently hit pack member (the renderer then shows one name per cluster)", () => {
    // Cause of the stacked "Mighty Gnawling" plates: the scene's one-plate-per-pack
    // rule covers the always-on elite plate only; a recent hit shows each member's name.
    const { sim, scene, renderer } = setup();
    const a = spawnTestMonster(sim.world, { x: 10, y: 10, rarity: "champion", pack: 3 });
    const b = spawnTestMonster(sim.world, { x: 10, y: 11, rarity: "champion", pack: 3 });
    scene.render(input(sim, { tick: 99 }));
    scene.noteHit(b, 100);
    scene.render(input(sim, { tick: 100 }));
    expect(renderer.live.get(`c${a}`)?.showLabel).toBe(true);
    expect(renderer.live.get(`c${b}`)?.showLabel).toBe(true);
    expect(renderer.live.get(`c${a}`)?.name).toBe(renderer.live.get(`c${b}`)?.name);
  });

  it("derives world label insets from the HUD layout", () => {
    const desktop = labelInsetsFor("desktop", true);
    expect(desktop.top).toBeGreaterThan(70);
    expect(desktop.right).toBe(0);
    expect(desktop.bottom).toBe(0);
    const phone = labelInsetsFor("compact", true);
    // The phone top region (area header + mode bar) reaches below the minimap block.
    expect(phone.top).toBeGreaterThanOrEqual(140);
    expect(phone.bottom).toBeGreaterThan(200);
    const landscape = labelInsetsFor("short", true);
    // Landscape: the minimap column reaches below the top region, so it is inset on the right.
    expect(landscape.right).toBeGreaterThan(100);
    expect(labelInsetsFor("short", false).right).toBe(0);
  });
});

/** Party rendering: every member drawn, the identity outlines, name plates, downed picks, summon ink and camera switching (docs/design/party.md §10.6). */
import { describe, expect, it } from "vite-plus/test";
import type { Entity, World } from "@gamez/kernel";
import type { ArpgRenderEntity } from "@gamez/ui-host";
import type { TileMap } from "@gamez/world";
import { Dead, Hero, Pos, Reviving, Summoned } from "../src/components.ts";
import { RES, type GameState } from "../src/resources.ts";
import { tileCenter } from "../src/fixed.ts";
import {
  SceneSync,
  SWITCH_SNAP_TILES,
  type SceneInput,
  type SceneRenderer,
} from "../src/client/scene.ts";
import {
  spawnTestHero,
  spawnTestMonster,
  spawnTestParty,
  testSim,
  useOpenMap,
} from "./support/harness.ts";

/** Records what the scene asks the renderer to do. */
class FakeRenderer implements SceneRenderer {
  readonly live = new Map<string, ArpgRenderEntity>();
  snaps: [number, number][] = [];
  follows: [number, number][] = [];
  upsertEntity(e: ArpgRenderEntity): void {
    this.live.set(e.id, { ...e });
  }
  removeEntity(id: string): void {
    this.live.delete(id);
  }
  setMap(_map: TileMap): void {}
  snapCamera(x: number, y: number): void {
    this.snaps.push([x, y]);
  }
  setLighting(): void {}
  follow(x: number, y: number): void {
    this.follows.push([x, y]);
  }
}

type Sim = ReturnType<typeof testSim>;

function input(sim: Sim, over: Partial<SceneInput> = {}): SceneInput {
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

/** Three heroes (the first controlled), named Ardric, Brannoc and Celene. */
function setup(controlled = 0) {
  const sim = testSim([]);
  useOpenMap(sim, 1);
  const [warrior, rogue, sorcerer] = spawnTestParty(sim.world, [{ x: 5 }, { x: 6 }, { x: 7 }], {
    controlled,
  });
  sim.world.update(warrior!, Hero, { name: "Ardric" });
  sim.world.update(rogue!, Hero, { name: "Brannoc" });
  sim.world.update(sorcerer!, Hero, { name: "Celene" });
  const renderer = new FakeRenderer();
  const scene = new SceneSync(renderer);
  return {
    sim,
    world: sim.world as World,
    renderer,
    scene,
    warrior: warrior as Entity,
    rogue: rogue as Entity,
    sorcerer: sorcerer as Entity,
  };
}

describe("party scene: every member is drawn", () => {
  it("draws three members: the controlled one self, the others party with a name plate", () => {
    const { sim, scene, renderer, warrior, rogue, sorcerer } = setup();
    scene.render(input(sim));
    const w = renderer.live.get(`c${warrior}`);
    const r = renderer.live.get(`c${rogue}`);
    const s = renderer.live.get(`c${sorcerer}`);
    expect(w).toMatchObject({ isSelf: true, highlight: "self", name: "Ardric" });
    for (const [m, name] of [
      [r, "Brannoc"],
      [s, "Celene"],
    ] as const) {
      expect(m).toMatchObject({
        isSelf: false,
        highlight: "party",
        showLabel: true,
        name,
        kind: "unit",
      });
    }
    // The test registry has one class: every member wears its appearance.
    expect(r?.appearance).toBe("unit.hero.fighter");
    expect(s?.appearance).toBe("unit.hero.fighter");
    expect(r?.x).toBe(6.5);
    expect(s?.x).toBe(7.5);
  });

  it("keeps the camera and SceneStats on the controlled hero", () => {
    const { sim, scene, renderer, warrior } = setup();
    const stats = scene.render(input(sim));
    expect(stats.heroX).toBe(5.5);
    expect(stats.heroY).toBe(5.5);
    expect(stats.entities).toBe(3);
    expect(renderer.follows.at(-1)).toEqual([5.5, 5.5]);
    expect(renderer.live.has(`c${warrior}`)).toBe(true);
  });

  it("outlineHero false removes only the self outline", () => {
    const { sim, scene, renderer, warrior, rogue } = setup();
    scene.render(input(sim, { outlineHero: false }));
    expect(renderer.live.get(`c${warrior}`)?.highlight).toBeNull();
    expect(renderer.live.get(`c${rogue}`)?.highlight).toBe("party");
  });
});

describe("party scene: downed members and picks", () => {
  it("a downed member takes the dead pose and an ally pick; standing members have none", () => {
    const { sim, scene, renderer, rogue, sorcerer } = setup();
    sim.world.add(rogue, Dead, { at: sim.tick, killer: 0 });
    scene.render(input(sim));
    const r = renderer.live.get(`c${rogue}`);
    expect(r).toMatchObject({ action: "death", highlight: "party", subtitle: "Downed" });
    expect(scene.pickAt(6.5, 5.5)).toMatchObject({ kind: "ally", entity: rogue });
    expect(scene.pickAt(7.5, 5.5)).toBeNull();
    expect(scene.pickables().map((p) => p.entity)).not.toContain(sorcerer);
  });

  it("a revive channel shows its progress on the downed target", () => {
    const { sim, scene, renderer, rogue, sorcerer } = setup();
    sim.world.add(rogue, Dead, { at: sim.tick, killer: 0 });
    sim.world.add(sorcerer, Reviving, {
      target: rogue,
      startedAt: sim.tick - 5,
      until: sim.tick + 5,
    });
    scene.render(input(sim));
    expect(renderer.live.get(`c${rogue}`)?.subtitle).toBe("Reviving 50%");
  });
});

describe("party scene: summon ownership", () => {
  it("a summon of a follower gets the party ink, and hover keeps the hover highlight", () => {
    const { sim, scene, renderer, rogue } = setup();
    const totem = spawnTestMonster(sim.world, { x: 9, y: 5 });
    sim.world.add(totem, Summoned, { owner: rogue, until: 0 });
    scene.render(input(sim));
    expect(renderer.live.get(`c${totem}`)?.highlight).toBe("party");
    scene.render(input(sim, { hovered: totem }));
    expect(renderer.live.get(`c${totem}`)?.highlight).toBe(true);
  });

  it("a solo summon keeps the solo output (no ownership ink without a party)", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
    const totem = spawnTestMonster(sim.world, { x: 9, y: 5 });
    sim.world.add(totem, Summoned, { owner: hero, until: 0 });
    const renderer = new FakeRenderer();
    new SceneSync(renderer).render(input(sim));
    expect(renderer.live.get(`c${totem}`)?.highlight).toBe(false);
  });
});

describe("party scene: camera on control switches", () => {
  it("switching the controlled hero moves the follow target to it", () => {
    const { sim, scene, renderer, world, rogue } = setup();
    scene.render(input(sim));
    world.getResource<GameState>(RES.game)!.hero = rogue;
    const stats = scene.render(input(sim));
    expect(renderer.follows.at(-1)).toEqual([6.5, 5.5]);
    expect(stats.heroX).toBe(6.5);
    expect(renderer.snaps).toEqual([[5.5, 5.5]]);
  });

  it("a switch to a hero far from the view snaps the camera instead of panning", () => {
    const { sim, scene, renderer, world, rogue } = setup();
    scene.render(input(sim));
    expect(SWITCH_SNAP_TILES).toBe(12);
    world.update(rogue, Pos, { x: tileCenter(25), y: tileCenter(5) });
    world.getResource<GameState>(RES.game)!.hero = rogue;
    scene.render(input(sim));
    expect(renderer.snaps.at(-1)).toEqual([25.5, 5.5]);
    expect(renderer.follows.at(-1)).toEqual([25.5, 5.5]);
  });

  it("a switch to a near hero pans (follow only, no extra snap)", () => {
    const { sim, scene, renderer, world, rogue } = setup();
    scene.render(input(sim));
    world.getResource<GameState>(RES.game)!.hero = rogue;
    scene.render(input(sim));
    expect(renderer.snaps).toEqual([[5.5, 5.5]]);
  });
});

describe("party scene: solo output", () => {
  it("a solo hero is drawn exactly as before: one self entity, no party extras", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
    const renderer = new FakeRenderer();
    new SceneSync(renderer).render(input(sim));
    expect(renderer.live.size).toBe(1);
    const h = renderer.live.get(`c${hero}`)!;
    expect(Object.keys(h).sort()).toEqual(
      [
        "action",
        "appearance",
        "fallbackAppearance",
        "facing",
        "highlight",
        "id",
        "isSelf",
        "kind",
        "moving",
        "name",
        "scale",
        "statusTint",
        "tint",
        "x",
        "y",
      ].sort(),
    );
    expect(h).toMatchObject({
      id: `c${hero}`,
      name: "Tester",
      isSelf: true,
      highlight: "self",
      action: "idle",
      x: 5.5,
      y: 5.5,
      scale: 100,
    });
  });

  it("the controlled hero keeps the class appearance and an isSelf outline id", () => {
    const { sim, renderer, warrior } = setup();
    new SceneSync(renderer).render(input(sim));
    expect(renderer.live.get(`c${warrior}`)?.appearance).toBe("unit.hero.fighter");
  });
});

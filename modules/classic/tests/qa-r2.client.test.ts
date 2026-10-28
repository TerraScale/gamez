/** QA round 2 HUD logic: minimap depth and seen gates, stale item tooltip, enemy casts without a target. */
import { describe, expect, it } from "vite-plus/test";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  EffectSpec,
  FloatTextSpec,
  PointerInfo,
  RendererStats,
} from "@gamez/ui-host";
import type { AssetManifest } from "@gamez/assets";
import type { TileMap } from "@gamez/world";
import type { Sim } from "@gamez/kernel";
import { createClassicGame } from "../src/client/game.ts";
import { minimapData } from "../src/client/hudModel.ts";
import { ACTION } from "../src/actions.ts";
import { Npc, AreaTag, Pos } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { freshExploreArea } from "../src/world/explore.ts";
import { spawnInteractableAt } from "../src/world/transition.ts";
import { createSaveStore, DEFAULT_SETTINGS, type KeyValueStorage } from "../src/client/persist.ts";
import { RES, type AreaState, type ExploreState } from "../src/resources.ts";
import { spawnTestHero, spawnTestMonster, testSim, useOpenMap } from "./support/harness.ts";

function bitSet(bits: number[], width: number, x: number, y: number): void {
  const i = y * width + x;
  bits[i >> 5] = (bits[i >> 5] ?? 0) | (1 << (i & 31));
}

/** A dungeon level (depth 1) with an explore area where nothing is seen yet. */
function dungeon() {
  const sim = testSim([]);
  const map = useOpenMap(sim, 1);
  const explore = freshExploreArea(map, false);
  sim.world.getResource<ExploreState>(RES.explore)!.areas.push(explore);
  return { sim, explore };
}

describe("qa r2: minimap respects depth and exploration", () => {
  it("hides town NPCs in a dungeon and hides stairs/waypoints on unexplored tiles", () => {
    const { sim, explore } = dungeon();
    const world = sim.world;
    // Town NPC (depth 0) standing in the dungeon's view.
    const npc = world.create();
    world.add(npc, Npc, { proto: "test.npc" });
    world.add(npc, Pos, { x: tileCenter(3), y: tileCenter(3) });
    world.add(npc, AreaTag, { depth: 0 });
    // Interactables on unexplored tiles.
    spawnInteractableAt(world, "waypoint", 0, { x: 12, y: 12 }, 1);
    spawnInteractableAt(world, "stairsDown", 2, { x: 14, y: 14 }, 1);
    // One waypoint on an explored tile must still show.
    bitSet(explore.bits, explore.width, 6, 6);
    spawnInteractableAt(world, "waypoint", 0, { x: 6, y: 6 }, 1);

    const data = minimapData(world, sim.loaded.registry);
    expect(data).not.toBeNull();
    expect(data?.explored).not.toBeNull();
    const kinds = (data?.dots ?? []).map((d) => d.kind);
    expect(kinds).not.toContain("npc");
    expect(data?.dots).not.toContainEqual({ x: 12, y: 12, kind: "waypoint" });
    expect(data?.dots).not.toContainEqual({ x: 14, y: 14, kind: "stairs" });
    expect(data?.dots).toContainEqual({ x: 6, y: 6, kind: "waypoint" });
  });

  it("shows town NPC dots in town", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    sim.world.getResource<AreaState>(RES.area)!.depth = 0;
    const world = sim.world;
    const npc = world.create();
    world.add(npc, Npc, { proto: "test.npc" });
    world.add(npc, Pos, { x: tileCenter(3), y: tileCenter(3) });
    world.add(npc, AreaTag, { depth: 0 });
    const data = minimapData(world, sim.loaded.registry);
    expect(data?.explored).toBeNull();
    expect(data?.dots).toContainEqual({ x: 3, y: 3, kind: "npc" });
  });
});

class FakeRenderer implements ArpgWorldRenderer {
  readonly arpg = true as const;
  frames: ((dt: number) => void)[] = [];
  pointers: ((p: PointerInfo) => void)[] = [];
  entities = new Map<string, ArpgRenderEntity>();
  texts: FloatTextSpec[] = [];
  effects: EffectSpec[] = [];
  zoom = 1;
  async init(_host: HTMLElement, _manifest: AssetManifest, _baseUrl: string): Promise<void> {}
  setMap(_map: TileMap): void {}
  upsertEntity(e: ArpgRenderEntity): void {
    this.entities.set(e.id, e);
  }
  removeEntity(id: string): void {
    this.entities.delete(id);
  }
  follow(_x: number, _y: number): void {}
  onTileTap(_cb: (x: number, y: number) => void): void {}
  showTapMarker(_x: number, _y: number): void {}
  onFrame(cb: (dtMs: number) => void): void {
    this.frames.push(cb);
  }
  destroy(): void {}
  floatText(spec: FloatTextSpec): void {
    this.texts.push(spec);
  }
  playEffect(spec: EffectSpec): void {
    this.effects.push(spec);
  }
  onPointer(cb: (p: PointerInfo) => void): void {
    this.pointers.push(cb);
  }
  snapCamera(_x: number, _y: number): void {}
  setZoom(z: number): void {
    this.zoom = z;
  }
  getZoom(): number {
    return this.zoom;
  }
  setLighting(_opts: { darkness: number; radius: number }): void {}
  tileAtClient(_x: number, _y: number): { x: number; y: number } | null {
    return null;
  }
  stats(): RendererStats {
    return { fps: 0, entities: this.entities.size, chunks: 0, props: 0, drawMs: 0 };
  }
  frame(dt: number): void {
    for (const cb of this.frames) cb(dt);
  }
}

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function game(sim: Sim) {
  const renderer = new FakeRenderer();
  const clock = { now: 1000, wall: 1_700_000_000_000 };
  const g = createClassicGame({
    loaded: sim.loaded,
    sim,
    renderer,
    save: createSaveStore(new MemoryStorage()),
    settings: { ...DEFAULT_SETTINGS },
    now: () => clock.now,
    wall: () => clock.wall,
    newSeed: () => 99,
    viewportWidth: () => 1024,
    exit: () => {},
    onEvents: () => {},
  });
  return { g, renderer, clock };
}

describe("qa r2: item tooltip and panels", () => {
  function setup() {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestHero(sim.world, { x: 5, y: 5 });
    return game(sim);
  }

  it("clears the hover when a panel is closed by closeAll", () => {
    const { g } = setup();
    g.api.openPanel("inventory");
    g.api.setHover({ uid: 7, x: 10, y: 10 });
    g.api.closeAll();
    expect(g.api.ui.getSnapshot().hover).toBeNull();
  });

  it("clears the hover on openPanel, closePanel and togglePanel", () => {
    const { g } = setup();
    g.api.setHover({ uid: 7, x: 10, y: 10 });
    g.api.openPanel("inventory");
    expect(g.api.ui.getSnapshot().hover).toBeNull();

    g.api.setHover({ uid: 7, x: 10, y: 10 });
    g.api.closePanel("inventory");
    expect(g.api.ui.getSnapshot().hover).toBeNull();

    g.api.setHover({ uid: 7, x: 10, y: 10 });
    g.api.togglePanel("skills");
    expect(g.api.ui.getSnapshot().hover).toBeNull();

    g.api.setHover({ uid: 7, x: 10, y: 10 });
    g.api.togglePanel("skills");
    expect(g.api.ui.getSnapshot().hover).toBeNull();
  });
});

describe("qa r2: enemy skills need a target", () => {
  it("reports no_target and dispatches nothing when no enemy is in range", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestHero(sim.world, { x: 5, y: 5 });
    const { g } = game(sim);
    const sent: string[] = [];
    const dispatch = sim.dispatch.bind(sim);
    sim.dispatch = ((name: string, payload: unknown, src: string) => {
      sent.push(name);
      return dispatch(name, payload as never, src as never);
    }) as typeof sim.dispatch;
    // Slot 0 is test.skill.strike (target "enemy").
    g.api.castSlot(0);
    expect(g.api.ui.getSnapshot().error?.code).toBe("no_target");
    expect(sent).not.toContain(ACTION.useSkill);
  });

  it("casts an enemy skill when an awake enemy is in range", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestHero(sim.world, { x: 5, y: 5 });
    spawnTestMonster(sim.world, { x: 6, y: 5, awake: true });
    const { g } = game(sim);
    const sent: string[] = [];
    const dispatch = sim.dispatch.bind(sim);
    sim.dispatch = ((name: string, payload: unknown, src: string) => {
      sent.push(name);
      return dispatch(name, payload as never, src as never);
    }) as typeof sim.dispatch;
    g.api.castSlot(0);
    expect(sent).toContain(ACTION.useSkill);
    expect(g.api.ui.getSnapshot().error?.code).not.toBe("no_target");
  });
});

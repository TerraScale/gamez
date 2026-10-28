/** Client game controller with a fake ARPG renderer and fake clocks (docs/design/classic.md §12.1-§12.4). */
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
import { createClassicGame } from "../src/client/game.ts";
import {
  createSaveStore,
  DEFAULT_SETTINGS,
  SAVE_KEY,
  type KeyValueStorage,
} from "../src/client/persist.ts";
import { spawnTestHero, testSim, useOpenMap } from "./support/harness.ts";

class FakeRenderer implements ArpgWorldRenderer {
  readonly arpg = true as const;
  frames: ((dt: number) => void)[] = [];
  pointers: ((p: PointerInfo) => void)[] = [];
  entities = new Map<string, ArpgRenderEntity>();
  texts: FloatTextSpec[] = [];
  effects: EffectSpec[] = [];
  zoom = 1;
  zooms: number[] = [];
  destroyed = false;
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
  destroy(): void {
    this.destroyed = true;
  }
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
    this.zooms.push(z);
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

function setup(opts: { hero?: boolean } = {}) {
  const sim = testSim([]);
  useOpenMap(sim, 1);
  if (opts.hero !== false) spawnTestHero(sim.world, { x: 5, y: 5 });
  const renderer = new FakeRenderer();
  const storage = new MemoryStorage();
  const clock = { now: 1000, wall: 1_700_000_000_000 };
  let exits = 0;
  const game = createClassicGame({
    loaded: sim.loaded,
    sim,
    renderer,
    save: createSaveStore(storage),
    settings: { ...DEFAULT_SETTINGS },
    now: () => clock.now,
    wall: () => clock.wall,
    newSeed: () => 99,
    viewportWidth: () => 1024,
    exit: () => {
      exits++;
    },
  });
  return { sim, renderer, storage, clock, game, exits: () => exits };
}

describe("classic client game", () => {
  it("advances the sim at 20 Hz from frame time and publishes the HUD", () => {
    const { sim, renderer, clock, game } = setup();
    const before = sim.tick;
    clock.now += 250;
    renderer.frame(250);
    expect(sim.tick - before).toBe(5);
    expect(game.api.hud.getSnapshot().tick).toBe(sim.tick);
    expect(game.api.hud.getSnapshot().hero?.name).toBe("Tester");
    expect(renderer.entities.size).toBeGreaterThan(0);
  });

  it("surfaces rejected actions in ui.error and keeps the sim running", () => {
    const { renderer, clock, game } = setup();
    const res = game.api.act("classic.doesNotExist", {});
    expect(res.ok).toBe(false);
    expect(game.api.ui.getSnapshot().error?.code).toBe("unknown_action");
    clock.now += 50;
    renderer.frame(50);
    expect(game.api.ui.getSnapshot().error?.code).toBe("unknown_action");
  });

  it("opens and closes panels and applies settings to the renderer", () => {
    const { renderer, clock, game } = setup();
    game.api.togglePanel("inventory");
    expect(game.api.ui.getSnapshot().panels).toEqual(["inventory"]);
    game.api.togglePanel("inventory");
    expect(game.api.ui.getSnapshot().panels).toEqual([]);
    game.api.openPanel("skills");
    game.api.closeAll();
    expect(game.api.ui.getSnapshot().panels).toEqual([]);
    game.api.updateSettings({ zoom: 1.5 });
    clock.now += 50;
    renderer.frame(50);
    expect(renderer.zoom).toBe(1.5);
    expect(game.api.ui.getSnapshot().settings.zoom).toBe(1.5);
  });

  it("routes pointer taps through the input layer into kernel actions", () => {
    const { renderer, game } = setup();
    renderer.pointers[0]!({
      kind: "tap",
      x: 3.5,
      y: 3.5,
      button: 0,
      shift: false,
      pointerType: "mouse",
    });
    // The test content has no movement action, so the rejection proves the action was dispatched.
    expect(game.api.ui.getSnapshot().error?.code).toBe("unknown_action");
  });

  it("saves a record that loads back with the same content hash", () => {
    const { storage, game, sim } = setup();
    expect(game.save()).toBe(true);
    const raw = storage.items.get(SAVE_KEY);
    expect(raw).toBeTypeOf("string");
    const parsed = JSON.parse(raw ?? "{}") as {
      snapshot: { contentHash: string };
      settings: unknown;
    };
    expect(parsed.snapshot.contentHash).toBe(sim.loaded.contentHash);
    expect(parsed.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("starts a new game with a fresh sim and wipes the save", () => {
    const { storage, game, sim } = setup();
    game.save();
    game.api.newGame();
    expect(storage.items.has(SAVE_KEY)).toBe(false);
    expect(game.api.hud.getSnapshot().phase).toBe("choose");
    expect(game.api.hud.getSnapshot().hero).toBeNull();
    expect(sim.tick).toBeGreaterThanOrEqual(0);
  });

  it("stops frame work after destroy and exit leaves the mode", () => {
    const { renderer, sim, clock, game, exits } = setup();
    game.destroy();
    const tick = sim.tick;
    clock.now += 500;
    renderer.frame(500);
    expect(sim.tick).toBe(tick);
    game.api.exit();
    expect(exits()).toBe(1);
  });
});

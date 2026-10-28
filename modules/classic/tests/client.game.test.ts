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
import type { GameEvent } from "@gamez/kernel";
import { CastOrder, Pos } from "../src/components.ts";
import { DEFAULT_AUTO_CONFIG, heroOf, RES, type ControlState } from "../src/resources.ts";
import { spawnTestHero, spawnTestMonster, testSim, useOpenMap } from "./support/harness.ts";

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

function setup(opts: { hero?: boolean; modules?: string[] } = {}) {
  const sim = testSim(opts.modules ?? []);
  useOpenMap(sim, 1);
  if (opts.hero !== false) spawnTestHero(sim.world, { x: 5, y: 5 });
  const events: GameEvent[] = [];
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
    onEvents: (evs) => {
      events.push(...evs);
    },
  });
  return { sim, renderer, storage, clock, game, events, exits: () => exits };
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

  it("flashes the target of a direct hit in the next rendered frame", () => {
    const { sim, renderer, clock, events } = setup({ modules: ["classic.core", "classic.combat"] });
    const hero = heroOf(sim.world);
    const monster = spawnTestMonster(sim.world, { x: 6, y: 5, life: 500 });
    let hit: GameEvent | undefined;
    for (let i = 0; i < 40 && !hit; i++) {
      if (!sim.world.has(hero, CastOrder)) {
        const p = sim.world.read(monster, Pos);
        sim.world.add(hero, CastOrder, {
          skill: "test.skill.strike",
          target: monster,
          x: p.x,
          y: p.y,
        });
      }
      events.length = 0;
      clock.now += 50;
      renderer.frame(50);
      hit = events.find((e) => e.type === "classic.hit" && e.target === monster && e.dot !== true);
    }
    expect(hit).toBeDefined();
    const drawn = renderer.entities.get(`c${monster}`);
    expect(drawn?.hitFlash).toBeGreaterThan(0);
  });

  it("thins out float texts in Full Idle x8 (no small floats, shorter life, capped per frame)", () => {
    const { sim, renderer, clock } = setup({ modules: ["classic.core", "classic.combat"] });
    const control: ControlState = {
      mode: "idle",
      speed: 8,
      overrideUntil: 0,
      config: DEFAULT_AUTO_CONFIG,
    };
    sim.world.setResource(RES.control, control);
    const hero = heroOf(sim.world);
    const monsters = [6, 7, 8].map((x) => spawnTestMonster(sim.world, { x, y: 5, life: 5000 }));
    for (let i = 0; i < 40; i++) {
      for (const m of monsters) {
        if (sim.world.has(hero, CastOrder)) break;
        const p = sim.world.read(m, Pos);
        sim.world.add(hero, CastOrder, { skill: "test.skill.strike", target: m, x: p.x, y: p.y });
      }
      const before = renderer.texts.length;
      clock.now += 50;
      renderer.frame(50);
      expect(renderer.texts.length - before).toBeLessThanOrEqual(6);
    }
    expect(renderer.texts.length).toBeGreaterThan(0);
    for (const t of renderer.texts) {
      expect(t.size).not.toBe("s");
      expect(t.ms).toBe(550);
    }
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

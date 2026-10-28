/**
 * Wave A client game regressions (docs/design/wave-A.md §0.1 QA major #3):
 * a keyboard cast never targets the hero's own summons (Spark Sentry), and
 * the client can raise toast notices (save carry-over).
 */
import type { GameEvent } from "@gamez/kernel";
import type { AssetManifest } from "@gamez/assets";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  EffectSpec,
  FloatTextSpec,
  PointerInfo,
  RendererStats,
} from "@gamez/ui-host";
import type { TileMap } from "@gamez/world";
import { describe, expect, it } from "vite-plus/test";
import { Faction, Intent } from "../src/components.ts";
import { createClassicGame } from "../src/client/game.ts";
import { createSaveStore, DEFAULT_SETTINGS, type KeyValueStorage } from "../src/client/persist.ts";
import { spawnTestHero, spawnTestMonster, testSim, useOpenMap } from "./support/harness.ts";

class FakeRenderer implements ArpgWorldRenderer {
  readonly arpg = true as const;
  frames: ((dt: number) => void)[] = [];
  pointers: ((p: PointerInfo) => void)[] = [];
  entities = new Map<string, ArpgRenderEntity>();
  texts: FloatTextSpec[] = [];
  effects: EffectSpec[] = [];
  shakes: [number, number][] = [];
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
  shake(strength: number, ms: number): void {
    this.shakes.push([strength, ms]);
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

function setup() {
  const sim = testSim([]);
  useOpenMap(sim, 1);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
  const renderer = new FakeRenderer();
  const sent: { name: string; payload: unknown }[] = [];
  const dispatch = sim.dispatch.bind(sim);
  sim.dispatch = ((name: string, payload: unknown, src: string) => {
    sent.push({ name, payload });
    return dispatch(name, payload as never, src as never);
  }) as typeof sim.dispatch;
  const events: GameEvent[] = [];
  const game = createClassicGame({
    loaded: sim.loaded,
    sim,
    renderer,
    save: createSaveStore(new MemoryStorage()),
    settings: { ...DEFAULT_SETTINGS },
    now: () => 1000,
    wall: () => 1_700_000_000_000,
    newSeed: () => 99,
    viewportWidth: () => 1024,
    exit: () => {},
    onEvents: (evs) => {
      events.push(...evs);
    },
  });
  return { sim, hero, renderer, game, sent, events };
}

describe("keyboard casts (QA major #3)", () => {
  it("targets the enemy, not the hero's own sentry, when the sentry is nearer", () => {
    const { sim, game, sent } = setup();
    // The hero stands at (5,5). Its own Spark Sentry (a hero-team monster) is 1 tile away,
    // the enemy 1.4 tiles away: both are within the strike range.
    const sentry = spawnTestMonster(sim.world, { x: 6, y: 5, awake: true });
    sim.world.update(sentry, Faction, { team: "hero" });
    const enemy = spawnTestMonster(sim.world, { x: 6, y: 6, awake: true });
    game.api.castSlot(0);
    const cast = sent.find((s) => s.name === "classic.useSkill");
    expect(cast).toBeDefined();
    expect((cast!.payload as { target: number }).target).toBe(enemy);
    // The bare test sim has no core actions, so the dispatch itself may fail; it must not be "no target".
    expect(game.api.ui.getSnapshot().error?.code).not.toBe("no_target");
  });

  it("reports 'No target in range' when only the hero's own sentry is near", () => {
    const { sim, game, sent } = setup();
    const sentry = spawnTestMonster(sim.world, { x: 6, y: 5, awake: true });
    sim.world.update(sentry, Faction, { team: "hero" });
    game.api.castSlot(0);
    expect(game.api.ui.getSnapshot().error?.code).toBe("no_target");
    expect(game.api.ui.getSnapshot().error?.message).toBe("No target in range");
    expect(sent.some((s) => s.name === "classic.useSkill")).toBe(false);
  });

  it("never selects a hero-team unit as the hero's engaged target", () => {
    const { sim, hero, game } = setup();
    const sentry = spawnTestMonster(sim.world, { x: 6, y: 5, awake: true });
    sim.world.update(sentry, Faction, { team: "hero" });
    game.api.castSlot(0);
    const intent = sim.world.get(hero, Intent);
    expect(intent?.kind === "skill" ? intent.target : 0).not.toBe(sentry);
  });
});

describe("client notices", () => {
  it("shows a toast through the game (save carry-over notice)", () => {
    const { game } = setup();
    game.notify("info", "Save carried over", "Your hero was carried over to the new version", 7000);
    const toasts = game.api.ui.getSnapshot().toasts;
    expect(toasts.at(-1)).toMatchObject({
      kind: "info",
      title: "Save carried over",
      body: "Your hero was carried over to the new version",
    });
  });

  it("writes the module ids into the save record", () => {
    const { game, sim } = setup();
    const storage = new MemoryStorage();
    const store = createSaveStore(storage);
    const g2 = createClassicGame({
      loaded: sim.loaded,
      sim,
      renderer: new FakeRenderer(),
      save: store,
      settings: { ...DEFAULT_SETTINGS },
      now: () => 1000,
      wall: () => 1,
      newSeed: () => 1,
      viewportWidth: () => 1024,
      exit: () => {},
    });
    expect(g2.save()).toBe(true);
    const saved = store.load(sim.loaded.contentHash);
    expect(saved?.modules).toEqual(sim.loaded.modules.map((m) => m.id));
    game.destroy();
    g2.destroy();
  });
});

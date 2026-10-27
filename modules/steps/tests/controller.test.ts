import {
  createSim,
  type DispatchResult,
  type GameEvent,
  type Sim,
  type SimSnapshot,
} from "@gamez/kernel";
import type { InstanceConnection, InstanceView, RenderEntity, WorldRenderer } from "@gamez/ui-host";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createStepsController } from "../src/client/controller.ts";
import { Health, heroEntity, Position } from "../src/components.ts";
import { loaded, newSim } from "./fixtures.ts";

/** Records every renderer call; the client only needs the calls, not Pixi. */
class FakeRenderer implements WorldRenderer {
  maps = 0;
  entities = new Map<string, RenderEntity>();
  taps: ((x: number, y: number) => void)[] = [];
  frames: ((dt: number) => void)[] = [];
  follows: { x: number; y: number }[] = [];
  init(): Promise<void> {
    return Promise.resolve();
  }
  setMap(): void {
    this.maps++;
  }
  upsertEntity(e: RenderEntity): void {
    this.entities.set(e.id, e);
  }
  removeEntity(id: string): void {
    this.entities.delete(id);
  }
  follow(x: number, y: number): void {
    this.follows.push({ x, y });
  }
  onTileTap(cb: (x: number, y: number) => void): void {
    this.taps.push(cb);
  }
  showTapMarker(): void {}
  onFrame(cb: (dtMs: number) => void): void {
    this.frames.push(cb);
  }
  destroy(): void {}
}

/** An instance connection backed by a real sim, so views carry real worlds and events. */
class FakeConnection implements InstanceConnection {
  readonly mode = "steps";
  readonly loaded = loaded;
  readonly calls: string[] = [];
  private sim: Sim;
  private view: InstanceView;
  private listeners = new Set<(v: InstanceView) => void>();

  constructor(seed: number) {
    this.sim = newSim(seed);
    this.view = this.build([], null);
  }

  /** Test-only: edits the authoritative world, then republishes. */
  edit(fn: (sim: Sim) => void): void {
    fn(this.sim);
    this.view = this.build(this.view.events, null);
    for (const cb of this.listeners) cb(this.view);
  }

  private build(events: GameEvent[], error: InstanceView["error"]): InstanceView {
    const snapshot: SimSnapshot = this.sim.snapshot();
    const world = createSim(loaded, { seed: 0, from: snapshot }).world;
    return { status: "online", snapshot, world, events, error, pingMs: null };
  }

  getView(): InstanceView {
    return this.view;
  }
  subscribe(cb: (v: InstanceView) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  act(name: string, payload: unknown): Promise<DispatchResult> {
    this.calls.push(`${name} ${JSON.stringify(payload)}`);
    const res = this.sim.dispatch(name, payload, "tester");
    this.view = this.build(res.events, res.ok ? null : (res.error ?? null));
    for (const cb of this.listeners) cb(this.view);
    return Promise.resolve(res);
  }
  restart(): void {
    this.calls.push("restart");
  }
  close(): void {}
}

function key(k: string): void {
  window.dispatchEvent(
    Object.assign(new Event("keydown"), {
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault() {},
    }),
  );
}

beforeAll(() => {
  // The controller listens for keys on the global window; a bare EventTarget is enough here.
  (globalThis as { window?: unknown }).window = new EventTarget();
});

describe("steps client controller", () => {
  it("draws the floor, the hero and every monster on start", () => {
    const renderer = new FakeRenderer();
    createStepsController(renderer, new FakeConnection(1));
    expect(renderer.maps).toBe(1);
    const units = [...renderer.entities.values()];
    expect(units.filter((u) => u.isSelf)).toHaveLength(1);
    expect(units.some((u) => u.appearance.startsWith("unit.monster."))).toBe(true);
  });

  it("sends keys as actions and logs the events they cause", () => {
    const renderer = new FakeRenderer();
    const conn = new FakeConnection(1);
    const ctrl = createStepsController(renderer, conn);
    key("ArrowRight");
    key(".");
    expect(conn.calls[0]).toBe('steps.move {"dx":1,"dy":0}');
    expect(conn.calls[1]).toBe("steps.wait {}");
    ctrl.destroy();
    key("d");
    expect(conn.calls).toHaveLength(2);
  });

  it("taps on the hero wait, taps on a neighbour move, far taps do nothing", () => {
    const renderer = new FakeRenderer();
    const conn = new FakeConnection(1);
    createStepsController(renderer, conn);
    const hero = [...renderer.entities.values()].find((e) => e.isSelf);
    if (hero === undefined) throw new Error("no hero drawn");
    renderer.taps[0]?.(hero.x, hero.y);
    renderer.taps[0]?.(hero.x + 10, hero.y + 10);
    expect(conn.calls).toEqual(["steps.wait {}"]);
    renderer.taps[0]?.(hero.x + 1, hero.y);
    expect(conn.calls).toEqual(["steps.wait {}", 'steps.move {"dx":1,"dy":0}']);
  });

  it("follows the hero and logs combat once the run is over, then stops sending actions", () => {
    const renderer = new FakeRenderer();
    const conn = new FakeConnection(2);
    const ctrl = createStepsController(renderer, conn);
    expect(renderer.frames).toHaveLength(1);
    renderer.frames[0]?.(16);
    expect(renderer.follows.length).toBeGreaterThan(0);

    // Stand the hero next to a monster with 1 hp, so the next wait is fatal.
    conn.edit((sim) => {
      const hero = heroEntity(sim.world);
      const monster = sim.world.query(Position, Health).find((e) => e !== hero);
      if (monster === undefined) throw new Error("no monster");
      const m = sim.world.read(monster, Position);
      const spot = [
        { x: m.x + 1, y: m.y },
        { x: m.x - 1, y: m.y },
        { x: m.x, y: m.y + 1 },
        { x: m.x, y: m.y - 1 },
      ].find(
        (p) =>
          sim.world.query(Position).every((o) => {
            const q = sim.world.read(o, Position);
            return q.x !== p.x || q.y !== p.y;
          }) && !isWall(sim, p.x, p.y),
      );
      if (spot === undefined) throw new Error("no spot");
      sim.world.update(hero, Position, spot);
      sim.world.update(hero, Health, { hp: 1 });
    });
    key(".");
    expect(ctrl.store.getSnapshot().board?.run.over).toBe(true);
    expect(ctrl.store.getSnapshot().log.some((l) => l.text.includes("fall"))).toBe(true);
    const before = conn.calls.length;
    key("d");
    expect(conn.calls.length).toBe(before);

    ctrl.restart();
    expect(conn.calls.at(-1)).toBe("restart");
    expect(ctrl.store.getSnapshot().log.at(-1)?.text).toBe("A new run begins.");
    ctrl.destroy();
  });
});

function isWall(sim: Sim, x: number, y: number): boolean {
  const floor = sim.world.getResource<{ width: number; walkable: number[] }>("steps.floor");
  if (!floor) return true;
  if (x < 0 || y < 0 || x >= floor.width) return true;
  return floor.walkable[y * floor.width + x] !== 1;
}

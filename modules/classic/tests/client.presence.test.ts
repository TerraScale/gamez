/**
 * Town presence (wave-B.md §7): TownPresence with a fake PresenceConnection and a
 * fake renderer, driven by a real classic sim (modules/classic/src/index.ts).
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  PresenceConnection,
  PresenceView,
} from "@gamez/ui-host";
import { describe, expect, it } from "vite-plus/test";
import { Hero, Mover, Pos } from "../src/components.ts";
import { SUB } from "../src/fixed.ts";
import { mode, modules } from "../src/index.ts";
import { heroOf, RES, type AreaState } from "../src/resources.ts";
import {
  LEAVE_GRACE_MS,
  POSE_INTERVAL_MS,
  PRESENCE_WORLD,
  TownPresence,
} from "../src/client/presence/index.ts";

type Other = PresenceView["others"][number];
type Pose = Parameters<PresenceConnection["setPose"]>[0];

class FakeConn implements PresenceConnection {
  readonly world = PRESENCE_WORLD;
  clock = 10_000;
  closed = false;
  view: PresenceView = { status: "online", selfId: "me", others: [] };
  readonly poses: Pose[] = [];
  private listeners = new Set<(v: PresenceView) => void>();

  getView(): PresenceView {
    return this.view;
  }
  subscribe(cb: (v: PresenceView) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  setPose(pose: Pose): void {
    this.poses.push(JSON.parse(JSON.stringify(pose)) as Pose);
  }
  serverNow(): number {
    return this.clock;
  }
  close(): void {
    this.closed = true;
  }
  /** Test helper: replaces the view and notifies subscribers. */
  emit(view: PresenceView): void {
    this.view = view;
    for (const cb of this.listeners) cb(view);
  }
}

class FakeRenderer {
  readonly live = new Map<string, ArpgRenderEntity>();
  readonly upserts: ArpgRenderEntity[] = [];
  readonly removed: string[] = [];
  upsertEntity(e: ArpgRenderEntity): void {
    this.upserts.push({ ...e });
    this.live.set(e.id, { ...e });
  }
  removeEntity(id: string): void {
    this.removed.push(id);
    this.live.delete(id);
  }
}

function other(id: string, over: Partial<Other> = {}): Other {
  return {
    id,
    kind: "player",
    name: `Player ${id}`,
    appearance: "unit.hero.rogue",
    pos: { x: 10, y: 10 },
    path: [],
    pathStartedAt: 0,
    speed: 2,
    tag: "Lv 3 Rogue",
    ...over,
  };
}

function newSim(): Sim {
  const loaded = loadMode(mode, modules);
  const sim = createSim(loaded, { seed: 4242 });
  const r = sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Brask" }, null);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  // Manual control: the hero only moves when the test tells it to.
  expect(sim.dispatch("classic.setControl", { mode: "manual" }, null).ok).toBe(true);
  sim.step(1);
  return sim;
}

function setup(withJoin = true) {
  const sim = newSim();
  const conns: FakeConn[] = [];
  const joins: string[] = [];
  const renderer = new FakeRenderer();
  const services = withJoin
    ? {
        joinPresence: (world: string): PresenceConnection => {
          joins.push(world);
          const c = new FakeConn();
          conns.push(c);
          return c;
        },
      }
    : {};
  const presence = new TownPresence({
    services,
    renderer: renderer as unknown as ArpgWorldRenderer,
    registry: sim.loaded.registry,
  });
  return { sim, conns, joins, renderer, presence };
}

/** One 50 ms frame: the sim advances one tick, then the presence updates. */
function frame(sim: Sim, presence: TownPresence, t: number, stepSim = true): void {
  if (stepSim) sim.step(1);
  presence.update(sim, t);
}

function setDepth(sim: Sim, depth: number): void {
  const area = sim.world.getResource<AreaState>(RES.area);
  if (!area) throw new Error("no area resource");
  sim.world.setResource(RES.area, { ...area, depth });
}

describe("TownPresence: connection lifecycle", () => {
  it("opens only in town and closes after the grace period once the hero leaves", () => {
    const { sim, conns, joins, presence } = setup();
    expect(heroOf(sim.world)).not.toBe(0);

    let t = 0;
    for (let i = 0; i < 4; i++) frame(sim, presence, (t += 50));
    expect(joins).toEqual([PRESENCE_WORLD]);
    expect(presence.connected).toBe(true);
    const conn = conns[0];
    expect(conn).toBeDefined();

    // Leaves town: the connection stays for the grace period, avatars go at once.
    setDepth(sim, 1);
    conn!.emit({
      status: "online",
      selfId: "me",
      others: [other("a")],
    });
    presence.update(sim, (t += 50));
    expect(presence.othersShown).toBe(0);
    expect(conn!.closed).toBe(false);
    presence.update(sim, t + LEAVE_GRACE_MS - 100);
    expect(conn!.closed).toBe(false);
    presence.update(sim, t + LEAVE_GRACE_MS + 50);
    expect(conn!.closed).toBe(true);
    expect(presence.connected).toBe(false);
    // Still outside town: no reconnect.
    presence.update(sim, t + LEAVE_GRACE_MS + 1000);
    expect(joins.length).toBe(1);
  });

  it("does not reconnect while the hero stays outside town and reopens on return", () => {
    const { sim, joins, presence } = setup();
    let t = 0;
    frame(sim, presence, (t += 50));
    setDepth(sim, 2);
    for (let i = 0; i < 200; i++) presence.update(sim, (t += 50));
    expect(presence.connected).toBe(false);
    expect(joins.length).toBe(1);
    setDepth(sim, 0);
    frame(sim, presence, (t += 50));
    expect(joins.length).toBe(2);
    expect(presence.connected).toBe(true);
  });

  it("cancels the close when the hero returns within the grace period", () => {
    const { sim, conns, presence } = setup();
    let t = 0;
    frame(sim, presence, (t += 50));
    setDepth(sim, 1);
    presence.update(sim, (t += 50));
    setDepth(sim, 0);
    presence.update(sim, t + LEAVE_GRACE_MS + 5000);
    expect(conns[0]!.closed).toBe(false);
    expect(presence.connected).toBe(true);
  });

  it("closes on destroy and removes the avatars", () => {
    const { sim, conns, renderer, presence } = setup();
    let t = 0;
    frame(sim, presence, (t += 50));
    conns[0]!.emit({ status: "online", selfId: "me", others: [other("b")] });
    presence.update(sim, (t += 50));
    expect(renderer.live.has("p:b")).toBe(true);
    presence.destroy();
    expect(conns[0]!.closed).toBe(true);
    expect(renderer.removed).toContain("p:b");
    expect(presence.othersShown).toBe(0);
    // A destroyed presence is inert.
    presence.update(sim, (t += 50));
    expect(conns[0]!.poses.length).toBeGreaterThan(0);
  });
});

describe("TownPresence: pose reporting", () => {
  it("reports once for a still hero and never repeats an unchanged pose", () => {
    const { sim, conns, presence } = setup();
    let t = 0;
    for (let i = 0; i < 40; i++) frame(sim, presence, (t += 50), false);
    expect(conns[0]!.poses.length).toBe(1);
    const pose = conns[0]!.poses[0]!;
    const hero = heroOf(sim.world);
    const pos = sim.world.read(hero, Pos);
    expect(pose.pos).toEqual({ x: Math.floor(pos.x / SUB), y: Math.floor(pos.y / SUB) });
    expect(pose.path).toEqual([]);
    expect(pose.appearance).toBe("unit.hero.warrior");
    expect(pose.tag).toMatch(/^Lv \d+ Warrior$/);
    expect(pose.speed).toBeGreaterThanOrEqual(1);
    expect(pose.speed).toBeLessThanOrEqual(12);
  });

  it("sends a walking hero's pose at most 4 times a second, only on change", () => {
    const { sim, conns, presence } = setup();
    let t = 0;
    frame(sim, presence, (t += 50));
    const conn = conns[0]!;
    // Walk to a walkable tile a few steps away.
    const hero = heroOf(sim.world);
    const start = sim.world.read(hero, Pos);
    const tx = Math.floor(start.x / SUB);
    const ty = Math.floor(start.y / SUB);
    let ok = false;
    for (const [dx, dy] of [
      [5, 0],
      [0, 5],
      [-5, 0],
      [0, -5],
      [4, 4],
      [-4, 4],
      [3, 0],
      [0, 3],
    ] as const) {
      if (sim.dispatch("classic.moveTo", { x: tx + dx, y: ty + dy }, null).ok) {
        ok = true;
        break;
      }
    }
    expect(ok).toBe(true);
    sim.step(1);
    expect(sim.world.read(hero, Mover).path.length).toBeGreaterThan(0);

    const sendTimes: number[] = [];
    let seen = conn.poses.length;
    for (let i = 0; i < 80; i++) {
      frame(sim, presence, (t += 50));
      if (conn.poses.length > seen) {
        seen = conn.poses.length;
        sendTimes.push(t);
      }
    }
    // Four seconds of walking: a handful of reports, never more than 4/s.
    expect(conn.poses.length).toBeGreaterThan(1);
    expect(conn.poses.length).toBeLessThanOrEqual(4 * 4 + 1);
    for (let i = 1; i < sendTimes.length; i++) {
      expect(sendTimes[i]! - sendTimes[i - 1]!).toBeGreaterThanOrEqual(POSE_INTERVAL_MS);
    }
    // Consecutive reports always differ.
    for (let i = 1; i < conn.poses.length; i++) {
      expect(JSON.stringify(conn.poses[i])).not.toBe(JSON.stringify(conn.poses[i - 1]));
    }
    // The last report describes the hero's current path and tile.
    const last = conn.poses[conn.poses.length - 1]!;
    expect(last.path.length).toBeLessThanOrEqual(8);
    expect(last.speed).toBeGreaterThanOrEqual(1);
    expect(last.speed).toBeLessThanOrEqual(12);
  });
});

describe("TownPresence: drawing other players", () => {
  it("draws others with p: ids and removes the ones that left", () => {
    const { sim, conns, renderer, presence } = setup();
    let t = 0;
    frame(sim, presence, (t += 50));
    const conn = conns[0]!;
    conn.emit({ status: "online", selfId: "me", others: [other("a"), other("b")] });
    presence.update(sim, (t += 50));
    expect(presence.othersShown).toBe(2);
    expect(renderer.live.has("p:a")).toBe(true);
    expect(renderer.live.has("p:b")).toBe(true);
    const a = renderer.live.get("p:a")!;
    expect(a.isSelf).toBe(false);
    expect(a.name).toBe("Player a");
    expect(a.subtitle).toBe("Lv 3 Rogue");
    expect(a.showLabel).toBe(true);
    expect(a.appearance).toBe("unit.hero.rogue");
    expect(a.moving).toBe(false);
    expect(presence.avatars.map((v) => v.id)).toEqual(["p:a", "p:b"]);
    expect(presence.avatars[0]).toMatchObject({
      name: "Player a",
      tag: "Lv 3 Rogue",
      moving: false,
    });

    conn.emit({ status: "online", selfId: "me", others: [other("b")] });
    presence.update(sim, (t += 50));
    expect(renderer.removed).toContain("p:a");
    expect(renderer.live.has("p:a")).toBe(false);
    expect(presence.othersShown).toBe(1);
  });

  it("never draws the local player and interpolates walking avatars with walkAt", () => {
    const { sim, conns, renderer, presence } = setup();
    let t = 0;
    frame(sim, presence, (t += 50));
    const conn = conns[0]!;
    conn.clock = 10_000;
    conn.emit({
      status: "online",
      selfId: "me",
      others: [
        other("me"),
        other("w", {
          pos: { x: 10, y: 10 },
          path: [{ x: 12, y: 10 }],
          pathStartedAt: 10_000,
          speed: 2,
        }),
      ],
    });
    presence.update(sim, (t += 50));
    expect(renderer.live.has("p:me")).toBe(false);
    expect(renderer.live.get("p:w")!.moving).toBe(true);
    expect(renderer.live.get("p:w")!.x).toBeCloseTo(10.5, 5);

    // Half a second later at 2 tiles/s the walker is halfway along its path.
    conn.clock = 10_500;
    presence.update(sim, (t += 50));
    const w = renderer.live.get("p:w")!;
    // Drawn at tile centres (t + 0.5), like the local hero.
    expect(w.x).toBeCloseTo(11.5, 5);
    expect(w.y).toBeCloseTo(10.5, 5);
    // Isometric convention: +x on the tile grid is screen south-east.
    expect(w.facing).toBe("se");

    // Past the end of the path it stands still and stops moving.
    conn.clock = 11_000;
    presence.update(sim, (t += 50));
    expect(renderer.live.get("p:w")!.x).toBeCloseTo(12.5, 5);
    expect(renderer.live.get("p:w")!.moving).toBe(false);
    const uploads = renderer.upserts.length;
    presence.update(sim, (t += 50));
    expect(renderer.upserts.length).toBe(uploads);
  });
});

describe("TownPresence: QA hook", () => {
  it("publishes window.__gamez.presence only when the debug root exists and removes it on destroy", () => {
    const g = globalThis as { __gamez?: Record<string, unknown> };
    const before = g.__gamez;
    try {
      delete g.__gamez;
      const plain = setup();
      plain.presence.update(plain.sim, 0);
      expect(g.__gamez).toBeUndefined();
      plain.presence.destroy();

      g.__gamez = {};
      const { sim, presence } = setup();
      presence.update(sim, 0);
      expect(g.__gamez.presence).toBe(presence);
      presence.destroy();
      expect("presence" in g.__gamez).toBe(false);
    } finally {
      if (before === undefined) delete g.__gamez;
      else g.__gamez = before;
    }
  });
});

describe("TownPresence: without presence", () => {
  it("does nothing when services.joinPresence is absent", () => {
    const { sim, renderer, presence } = setup(false);
    let t = 0;
    for (let i = 0; i < 60; i++) frame(sim, presence, (t += 50));
    expect(presence.connected).toBe(false);
    expect(presence.othersShown).toBe(0);
    expect(presence.lastError).toBeNull();
    expect(renderer.upserts.length).toBe(0);
    presence.destroy();
  });

  it("waits without errors while the hero has no position yet", () => {
    const { sim, conns, presence } = setup();
    const hero = heroOf(sim.world);
    const pos = sim.world.read(hero, Pos);
    sim.world.remove(hero, Pos);
    let t = 0;
    for (let i = 0; i < 4; i++) frame(sim, presence, (t += 300), false);
    expect(presence.lastError).toBeNull();
    expect(conns[0]!.poses.length).toBe(0);
    sim.world.add(hero, Pos, pos);
    frame(sim, presence, (t += 300), false);
    expect(conns[0]!.poses.length).toBe(1);
    presence.destroy();
  });

  it("drives the hero position from the sim (Pos and Mover are read, never written)", () => {
    const { sim, conns, presence } = setup();
    const hero = heroOf(sim.world);
    const before = sim.world.read(hero, Pos);
    const hash = sim.hash();
    let t = 0;
    for (let i = 0; i < 10; i++) frame(sim, presence, (t += 50), false);
    expect(sim.world.read(hero, Pos)).toEqual(before);
    expect(sim.hash()).toBe(hash);
    expect(conns[0]!.poses.length).toBe(1);
    expect(sim.world.read(hero, Hero).name).toBe("Brask");
  });
});

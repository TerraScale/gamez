/**
 * Party presence (docs/design/party.md §11.3): the local report carries the
 * party's companions, and remote avatars draw theirs. TownPresence with a fake
 * PresenceConnection and renderer, over a real classic sim with a test party.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  PresenceConnection,
  PresenceView,
} from "@gamez/ui-host";
import { describe, expect, it } from "vite-plus/test";
import { Hero } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import {
  POSE_INTERVAL_MS,
  POSE_KEEPALIVE_MS,
  PRESENCE_WORLD,
  TownPresence,
} from "../src/client/presence/index.ts";
import { RES, type PartyState } from "../src/resources.ts";
import { KIND, type ClassProto } from "../src/types.ts";
import { spawnTestParty } from "./support/harness.ts";

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
  readonly removed: string[] = [];
  upsertEntity(e: ArpgRenderEntity): void {
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

/** A classic sim with a test party; the first hero is the controlled one (manual control). */
function partySim(heroes: { classId: string; name: string; x: number }[]): {
  sim: Sim;
  ents: number[];
} {
  const sim = createSim(loadMode(mode, modules), { seed: 4242 });
  const ents = spawnTestParty(
    sim.world,
    heroes.map((h) => ({ classId: h.classId, x: h.x, y: 5 })),
  );
  ents.forEach((e, i) => sim.world.update(e, Hero, { name: heroes[i]!.name }));
  expect(sim.dispatch("classic.setControl", { mode: "manual" }, null).ok).toBe(true);
  return { sim, ents };
}

function wire(sim: Sim) {
  const conns: FakeConn[] = [];
  const renderer = new FakeRenderer();
  const presence = new TownPresence({
    services: {
      joinPresence: (world: string): PresenceConnection => {
        expect(world).toBe(PRESENCE_WORLD);
        const c = new FakeConn();
        conns.push(c);
        return c;
      },
    },
    renderer: renderer as unknown as ArpgWorldRenderer,
    registry: sim.loaded.registry,
  });
  return { conns, renderer, presence };
}

function appearanceOf(sim: Sim, classId: string): string {
  const proto = sim.loaded.registry.get<ClassProto>(KIND.class, classId);
  if (!proto) throw new Error(`no class ${classId}`);
  return proto.appearance;
}

describe("TownPresence: party companions in the local report", () => {
  it("a local party of 3 reports 2 companions with the correct offsets and appearances", () => {
    const { sim } = partySim([
      { classId: "classic.warrior", name: "Brask", x: 5 },
      { classId: "classic.rogue", name: "Lyra", x: 6 },
      { classId: "classic.sorcerer", name: "Mira", x: 3 },
    ]);
    const { conns, presence } = wire(sim);
    presence.update(sim, 50);

    expect(appearanceOf(sim, "classic.rogue")).toBe("unit.hero.rogue");
    const pose = conns[0]!.poses[0]!;
    expect(pose.pos).toEqual({ x: 5, y: 5 });
    // R11 (ADR 0007): other players see the class name (game data), never the typed hero name.
    expect(pose.companions).toEqual([
      { appearance: "unit.hero.rogue", name: "Rogue", dx: 1, dy: 0 },
      { appearance: "unit.hero.sorcerer", name: "Sorcerer", dx: -2, dy: 0 },
    ]);
  });

  it("solo reports no companions field at all", () => {
    const { sim } = partySim([{ classId: "classic.warrior", name: "Brask", x: 5 }]);
    const { conns, presence } = wire(sim);
    presence.update(sim, 50);
    expect(conns[0]!.poses[0]).not.toHaveProperty("companions");
  });

  it("sends [] once when the party shrinks to one, then goes quiet", () => {
    const { sim, ents } = partySim([
      { classId: "classic.warrior", name: "Brask", x: 5 },
      { classId: "classic.rogue", name: "Lyra", x: 6 },
    ]);
    const { conns, presence } = wire(sim);
    presence.update(sim, 50);
    const conn = conns[0]!;
    expect(conn.poses[0]!.companions).toHaveLength(1);

    const party = sim.world.getResource<PartyState>(RES.party)!;
    sim.world.setResource(RES.party, { ...party, members: [ents[0]!] });

    presence.update(sim, 50 + POSE_INTERVAL_MS);
    expect(conn.poses).toHaveLength(2);
    expect(conn.poses[1]!.companions).toEqual([]);

    // Nothing changed: no report until the keepalive, and that one has no field.
    presence.update(sim, 50 + 2 * POSE_INTERVAL_MS);
    expect(conn.poses).toHaveLength(2);
    presence.update(sim, 50 + POSE_INTERVAL_MS + POSE_KEEPALIVE_MS);
    expect(conn.poses).toHaveLength(3);
    expect(conn.poses[2]).not.toHaveProperty("companions");
  });
});

describe("TownPresence: drawing remote companions", () => {
  /** A remote avatar "a" standing mid-walk with two companions, at clock 10 000 ms. */
  const walking = other("a", {
    pos: { x: 10, y: 10 },
    path: [{ x: 11, y: 10 }],
    pathStartedAt: 9_750,
    speed: 2,
    companions: [
      { appearance: "unit.hero.warrior", name: "Brask", dx: 1, dy: 0 },
      { appearance: "unit.hero.sorcerer", name: "Mira", dx: -1, dy: 1 },
    ],
  });

  it("draws three entities that move with the avatar, then removes them when cleared", () => {
    const { sim } = partySim([{ classId: "classic.warrior", name: "Brask", x: 5 }]);
    const { conns, renderer, presence } = wire(sim);
    presence.update(sim, 50);
    const conn = conns[0]!;
    conn.clock = 10_000;
    conn.emit({ status: "online", selfId: "me", others: [walking] });
    presence.update(sim, 100);

    const av = renderer.live.get("p:a")!;
    const c0 = renderer.live.get("p:a:c0")!;
    const c1 = renderer.live.get("p:a:c1")!;
    expect(renderer.live.size).toBe(3);
    expect(av.moving).toBe(true);
    // Avatar at 10.5 + 0.5 (tile centre); companions at the same frame plus their offsets.
    expect(av.x).toBeCloseTo(11.0);
    expect(c0.x).toBeCloseTo(av.x + 1);
    expect(c0.y).toBeCloseTo(av.y);
    expect(c1.x).toBeCloseTo(av.x - 1);
    expect(c1.y).toBeCloseTo(av.y + 1);
    expect(c0).toMatchObject({
      name: "Brask",
      appearance: "unit.hero.warrior",
      kind: "unit",
      highlight: "ally",
      isSelf: false,
      showLabel: true,
    });
    expect(c1.name).toBe("Mira");

    // A later frame: the avatar has moved on, and the companions moved with it.
    const before = av.x;
    conn.clock = 10_100;
    presence.update(sim, 150);
    const av2 = renderer.live.get("p:a")!;
    expect(av2.x).toBeGreaterThan(before);
    expect(renderer.live.get("p:a:c0")!.x).toBeCloseTo(av2.x + 1);
    expect(renderer.live.get("p:a:c1")!.x).toBeCloseTo(av2.x - 1);

    // Companions cleared: their entities go, the avatar stays.
    conn.emit({ status: "online", selfId: "me", others: [{ ...walking, companions: [] }] });
    presence.update(sim, 200);
    expect(renderer.removed).toEqual(expect.arrayContaining(["p:a:c0", "p:a:c1"]));
    expect(renderer.live.has("p:a:c0")).toBe(false);
    expect(renderer.live.has("p:a:c1")).toBe(false);
    expect(renderer.live.has("p:a")).toBe(true);
  });

  it("drops the companion entities that a shorter list no longer has", () => {
    const { sim } = partySim([{ classId: "classic.warrior", name: "Brask", x: 5 }]);
    const { conns, renderer, presence } = wire(sim);
    presence.update(sim, 50);
    const conn = conns[0]!;
    conn.clock = 10_000;
    conn.emit({ status: "online", selfId: "me", others: [walking] });
    presence.update(sim, 100);

    conn.emit({
      status: "online",
      selfId: "me",
      others: [{ ...walking, companions: [walking.companions![0]!] }],
    });
    presence.update(sim, 150);
    expect(renderer.removed).toContain("p:a:c1");
    expect(renderer.live.has("p:a:c0")).toBe(true);
    expect(renderer.live.has("p:a:c1")).toBe(false);
  });

  it("removes an avatar's companions with it when it leaves", () => {
    const { sim } = partySim([{ classId: "classic.warrior", name: "Brask", x: 5 }]);
    const { conns, renderer, presence } = wire(sim);
    presence.update(sim, 50);
    const conn = conns[0]!;
    conn.clock = 10_000;
    conn.emit({ status: "online", selfId: "me", others: [walking] });
    presence.update(sim, 100);
    expect(renderer.live.size).toBe(3);

    conn.emit({ status: "online", selfId: "me", others: [] });
    presence.update(sim, 150);
    expect(renderer.live.size).toBe(0);
    expect(renderer.removed).toEqual(expect.arrayContaining(["p:a", "p:a:c0", "p:a:c1"]));
  });
});

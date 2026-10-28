/**
 * Wave C presence (docs/design/wave-C.md §5.4, §10.4): shopkeeper ghosts, the tap on a
 * shopkeeper (shop screen), the tap on a remote hero (trade bubble -> trade screen),
 * click-to-move kept for every other tap, and the wave B carry-over: a remote hero is
 * hidden until its first pose. A real classic sim (town) and a fake renderer and
 * connection, as in client.presence.test.ts. OWNER: T-classic-ui.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  PlatformScreen,
  PointerInfo,
  PresenceConnection,
  PresenceView,
} from "@gamez/ui-host";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import { PointerInput, interceptTap, type PointerCommand } from "../src/client/input.ts";
import {
  GHOST_ALPHA,
  GHOST_TINT,
  PRESENCE_WORLD,
  SHOP_FIXTURE_PREFIX,
  TownPresence,
  plotIdOf,
  poseReady,
} from "../src/client/presence/index.ts";
import {
  clearTradeBubble,
  accountIdOfPresence,
  getTradeBubble,
} from "../src/client/presence/bubble.ts";
import { tradeScreen } from "../src/client/hud/widgets/PresenceBubble.tsx";

type Other = PresenceView["others"][number];

class FakeConn implements PresenceConnection {
  readonly world = PRESENCE_WORLD;
  clock = 10_000;
  closed = false;
  view: PresenceView = { status: "online", selfId: "me", others: [] };
  private listeners = new Set<(v: PresenceView) => void>();
  getView(): PresenceView {
    return this.view;
  }
  subscribe(cb: (v: PresenceView) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  setPose(): void {}
  serverNow(): number {
    return this.clock;
  }
  close(): void {
    this.closed = true;
  }
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

function shop(plot: string, over: Partial<Other> = {}): Other {
  return {
    id: `${SHOP_FIXTURE_PREFIX}${plot}`,
    kind: "shopkeeper",
    name: "Aria's Forge",
    appearance: "unit.hero.warrior",
    pos: { x: 46, y: 35 },
    path: [],
    pathStartedAt: 0,
    speed: 0,
    tag: "Aria · Open",
    ...over,
  };
}

function newSim(): Sim {
  const loaded = loadMode(mode, modules);
  const sim = createSim(loaded, { seed: 4242 });
  const r = sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Brask" }, null);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  sim.dispatch("classic.setControl", { mode: "manual" }, null);
  sim.step(1);
  return sim;
}

/** Every presence a test creates; destroyed after each test (a live one keeps its tap interceptor). */
const presences: TownPresence[] = [];

function setup(opts: { openScreen?: boolean } = {}) {
  const sim = newSim();
  const conns: FakeConn[] = [];
  const screens: PlatformScreen[] = [];
  const renderer = new FakeRenderer();
  const services = {
    joinPresence: (): PresenceConnection => {
      const c = new FakeConn();
      conns.push(c);
      return c;
    },
    ...(opts.openScreen === false ? {} : { openScreen: (s: PlatformScreen) => screens.push(s) }),
  };
  const presence = new TownPresence({
    services,
    renderer: renderer as unknown as ArpgWorldRenderer,
    registry: sim.loaded.registry,
  });
  presences.push(presence);
  let t = 0;
  const frame = (): void => {
    sim.step(1);
    presence.update(sim, (t += 50));
  };
  frame();
  frame();
  return { sim, conns, screens, renderer, presence, frame, now: () => t };
}

function tap(x: number, y: number, over: Partial<PointerInfo> = {}): PointerInfo {
  return { kind: "tap", x, y, button: 0, shift: false, pointerType: "mouse", ...over };
}

afterEach(() => {
  for (const p of presences.splice(0)) p.destroy();
  clearTradeBubble();
});

describe("shopkeeper ghosts", () => {
  it("draws a fixture as a translucent, cool-tinted ghost with name and tag", () => {
    const { sim, conns, renderer, presence, frame } = setup();
    frame();
    conns[0]!.emit({ status: "online", selfId: "me", others: [shop("p1")] });
    presence.update(sim, 5_000);
    const e = renderer.live.get(`p:${SHOP_FIXTURE_PREFIX}p1`);
    expect(e).toBeDefined();
    expect(e!.alpha).toBe(GHOST_ALPHA);
    expect(e!.tint).toBe(GHOST_TINT);
    // Shop ghosts are fixtures, not players: no identity outline.
    expect(e!.highlight).toBeNull();
    expect(e!.name).toBe("Aria's Forge");
    expect(e!.subtitle).toBe("Aria · Open");
    expect(e!.x).toBe(46 + 0.5);
    expect(e!.y).toBe(35 + 0.5);
  });

  it("is static: a later frame does not move it", () => {
    const { sim, conns, renderer, presence, frame } = setup();
    frame();
    conns[0]!.emit({ status: "online", selfId: "me", others: [shop("p1")] });
    presence.update(sim, 5_000);
    const before = renderer.live.get(`p:${SHOP_FIXTURE_PREFIX}p1`)!.x;
    for (let i = 0; i < 10; i++) presence.update(sim, 5_050 + i * 50);
    expect(renderer.live.get(`p:${SHOP_FIXTURE_PREFIX}p1`)!.x).toBe(before);
  });

  it("the plot id is the fixture id without its prefix", () => {
    expect(plotIdOf("shops:p1")).toBe("p1");
    expect(plotIdOf("p9")).toBe("p9");
  });
});

describe("hidden until the first pose (wave B carry-over)", () => {
  it("a remote hero without a tag is not drawn, and is drawn once its pose arrives", () => {
    const { sim, conns, renderer, presence } = setup();
    presence.update(sim, 1_000);
    const conn = conns[0]!;
    conn.emit({
      status: "online",
      selfId: "me",
      others: [other("new", { tag: undefined })],
    });
    presence.update(sim, 1_050);
    expect(renderer.live.has("p:new")).toBe(false);
    expect(presence.othersShown).toBe(0);
    conn.emit({ status: "online", selfId: "me", others: [other("new")] });
    presence.update(sim, 1_100);
    expect(renderer.live.has("p:new")).toBe(true);
    expect(presence.othersShown).toBe(1);
  });

  it("poseReady: shopkeepers always, players once tagged", () => {
    expect(poseReady(shop("p1", { tag: undefined }))).toBe(true);
    expect(poseReady(other("a", { tag: undefined }))).toBe(false);
    expect(poseReady(other("a"))).toBe(true);
  });
});

describe("taps on town presence", () => {
  it("a tap on a shopkeeper opens its shop (plotId without the prefix)", () => {
    const { sim, conns, screens, presence, frame } = setup();
    frame();
    conns[0]!.emit({
      status: "online",
      selfId: "me",
      others: [shop("p1", { pos: { x: 46, y: 35 } })],
    });
    presence.update(sim, 5_000);
    const consumed = interceptTapFromPresence(tap(46.5, 35.5));
    expect(consumed).toBe(true);
    expect(screens).toEqual([{ id: "shop", world: PRESENCE_WORLD, plotId: "p1" }]);
    expect(getTradeBubble()).toBeNull();
  });

  it("a tap on another hero opens the bubble, and the bubble opens the trade screen", () => {
    const { sim, conns, screens, presence, frame } = setup();
    frame();
    conns[0]!.emit({
      status: "online",
      selfId: "me",
      others: [other("acc_7:classic-town", { name: "Aria", pos: { x: 20, y: 20 } })],
    });
    presence.update(sim, 5_000);
    expect(interceptTapFromPresence(tap(20.5, 20.5))).toBe(true);
    expect(screens).toEqual([]);
    expect(getTradeBubble()).toEqual({ accountId: "acc_7", displayName: "Aria" });
    // The bubble's button (HUD) opens the trade screen with that account.
    expect(tradeScreen(getTradeBubble()!)).toEqual({
      id: "trade",
      with: { accountId: "acc_7", displayName: "Aria" },
    });
  });

  it("a tap on the ground clears an open bubble and does not consume the tap (walk)", () => {
    const { sim, conns, presence, frame } = setup();
    frame();
    conns[0]!.emit({
      status: "online",
      selfId: "me",
      others: [other("acc_7:classic-town", { name: "Aria", pos: { x: 20, y: 20 } })],
    });
    presence.update(sim, 5_000);
    interceptTapFromPresence(tap(20.5, 20.5));
    expect(getTradeBubble()).not.toBeNull();
    expect(interceptTapFromPresence(tap(30.5, 30.5))).toBe(false);
    expect(getTradeBubble()).toBeNull();
  });

  it("without openScreen a tap on an avatar is not consumed (the hero walks as before)", () => {
    const { sim, conns, presence, frame } = setup({ openScreen: false });
    frame();
    conns[0]!.emit({
      status: "online",
      selfId: "me",
      others: [shop("p1", { pos: { x: 46, y: 35 } })],
    });
    presence.update(sim, 5_000);
    expect(interceptTapFromPresence(tap(46.5, 35.5))).toBe(false);
  });

  it("the interceptor is gone once the presence is destroyed", () => {
    const { sim, conns, presence, frame } = setup();
    frame();
    conns[0]!.emit({
      status: "online",
      selfId: "me",
      others: [shop("p1", { pos: { x: 46, y: 35 } })],
    });
    presence.update(sim, 5_000);
    expect(interceptTapFromPresence(tap(46.5, 35.5))).toBe(true);
    presence.destroy();
    expect(conns[0]!.closed).toBe(true);
    expect(interceptTapFromPresence(tap(46.5, 35.5))).toBe(false);
  });

  it("the account id of a presence entity strips the world suffix only", () => {
    expect(accountIdOfPresence("acc_1:classic-town", PRESENCE_WORLD)).toBe("acc_1");
    expect(accountIdOfPresence("acc_1", PRESENCE_WORLD)).toBe("acc_1");
    expect(accountIdOfPresence("acc_1:plaza", PRESENCE_WORLD)).toBe("acc_1:plaza");
  });
});

describe("click-to-move is kept", () => {
  it("a tap on empty ground walks the hero, a tap on a sim unit attacks, both without presence hits", () => {
    const cmds: PointerCommand[] = [];
    const input = new PointerInput({ pick: () => null }, (c) => cmds.push(c));
    input.handle(tap(12.3, 9.8));
    expect(cmds).toEqual([{ kind: "move", x: 12, y: 9 }]);

    const cmds2: PointerCommand[] = [];
    const input2 = new PointerInput({ pick: () => ({ kind: "unit", entity: 7 }) }, (c) =>
      cmds2.push(c),
    );
    input2.handle(tap(5.5, 5.5));
    expect(cmds2).toEqual([{ kind: "attack", entity: 7, repeat: true }]);
  });

  it("a shift tap is never intercepted (it casts at the point)", () => {
    const { sim, conns, presence, frame } = setup();
    frame();
    conns[0]!.emit({
      status: "online",
      selfId: "me",
      others: [shop("p1", { pos: { x: 46, y: 35 } })],
    });
    presence.update(sim, 5_000);
    const cmds: PointerCommand[] = [];
    const input = new PointerInput({ pick: () => null }, (c) => cmds.push(c));
    input.handle(tap(46.5, 35.5, { shift: true }));
    expect(cmds[0]?.kind).toBe("cast");
  });

  it("a tap on a sim unit wins over a remote avatar under it (the interceptor is not asked)", () => {
    const { sim, conns, screens, presence, frame } = setup();
    frame();
    conns[0]!.emit({
      status: "online",
      selfId: "me",
      others: [shop("p1", { pos: { x: 46, y: 35 } })],
    });
    presence.update(sim, 5_000);
    const cmds: PointerCommand[] = [];
    const input = new PointerInput({ pick: () => ({ kind: "unit", entity: 3 }) }, (c) =>
      cmds.push(c),
    );
    input.handle(tap(46.5, 35.5));
    expect(cmds).toEqual([{ kind: "attack", entity: 3, repeat: true }]);
    expect(screens).toEqual([]);
  });
});

/** The tap interceptors as the pointer runs them (the presence registers its own on connect). */
function interceptTapFromPresence(p: PointerInfo): boolean {
  return interceptTap(p);
}

/**
 * ServerSync and offline progress (docs/design/offline-idle.md §2, §5): the
 * resume carries pendingToTick, a grant on top of already verified pending
 * play is not a loss, a long hidden tab rejoins whatever is pending, and a
 * deferred grant (resync "offline") is adopted with its summary. A scripted
 * connection plays the server, and a minimal SyncHost stands in for the game
 * (no UI), so every message and every emit is visible.
 */
import { describe, expect, it } from "vite-plus/test";
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import type {
  SegmentSubmission,
  VerifiedConnection,
  VerifiedHandlers,
  VerifiedResync,
  VerifiedState,
  VerifiedStatus,
} from "@gamez/ui-host";
import { mode, modules } from "../src/index.ts";
import { ACTION } from "../src/actions.ts";
import { DEFAULT_SETTINGS, type KeyValueStorage } from "../src/client/persist.ts";
import {
  DEFAULT_LIMITS,
  HIDDEN_RECONNECT_MS,
  ServerSync,
  SYNC_ACTOR,
  SYNC_TEXT,
  type SyncBoot,
  type SyncHost,
} from "../src/client/sync/index.ts";

const LOADED = loadMode(mode, modules);
const HOUR = 3_600_000;
const SUMMARY = "classic.offline.summary";

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

/** The socket, driven by the test (it plays the InstanceDO). */
class ScriptConn implements VerifiedConnection {
  readonly mode = "classic";
  status: VerifiedStatus = "connecting";
  h: VerifiedHandlers | null = null;
  closed = false;
  readonly submitted: SegmentSubmission[] = [];
  start(h: VerifiedHandlers): void {
    this.h = h;
  }
  submit(seg: SegmentSubmission): boolean {
    if (this.status !== "online" || this.closed) return false;
    this.submitted.push(JSON.parse(JSON.stringify(seg)) as SegmentSubmission);
    return true;
  }
  importSave(): void {}
  restart(): void {}
  serverNow(): number {
    return 0;
  }
  close(): void {
    this.closed = true;
    this.status = "closed";
  }
  /** What the real connection does on vstate: online first, then state(), then status(). */
  answer(s: VerifiedState): void {
    const was = this.status;
    this.status = "online";
    this.h!.state(s);
    if (was !== "online") this.h!.status("online");
  }
}

class Host implements SyncHost {
  replaced = 0;
  readonly emitted: GameEvent[] = [];
  readonly toasts: string[] = [];
  readonly logs: string[] = [];
  constructor(public sim: Sim) {}
  currentSim(): Sim {
    return this.sim;
  }
  replaceSim(next: Sim): void {
    this.sim = next;
    this.replaced++;
  }
  emit(events: readonly GameEvent[]): void {
    this.emitted.push(...events);
  }
  notify(_kind: string, title: string): void {
    this.toasts.push(title);
  }
  log(text: string): void {
    this.logs.push(text);
  }
  summaries(): GameEvent[] {
    return this.emitted.filter((e) => e.type === SUMMARY);
  }
}

/** One browser page: ServerSync + its connections + clocks. */
class Page {
  readonly conns: ScriptConn[] = [];
  readonly clock: { now: number; wall: number };
  readonly sync: ServerSync;
  host: Host | null = null;

  constructor(storage: MemoryStorage, wall: number) {
    this.clock = { now: 1000, wall };
    this.sync = new ServerSync({
      loaded: LOADED,
      accountId: "acc",
      connect: () => {
        const c = new ScriptConn();
        this.conns.push(c);
        return c;
      },
      storage,
      now: () => this.clock.now,
      wall: () => this.clock.wall,
      setTimer: () => 0,
      clearTimer: () => {},
    });
  }

  get conn(): ScriptConn {
    return this.conns.at(-1)!;
  }

  attach(boot: SyncBoot): Host {
    this.host = new Host(boot.sim);
    this.sync.attach(this.host);
    return this.host;
  }

  act(name: string, payload: unknown): void {
    const sim = this.host!.sim;
    const tick = sim.tick;
    const res = sim.dispatch(name, payload, SYNC_ACTOR);
    expect(res.ok, `${name}: ${res.error?.code}`).toBe(true);
    this.sync.dispatched(tick, name, payload);
  }

  /** Steps n ticks at x1 (the clock moves with them): ServerSync cuts after the step. */
  step(n: number): void {
    const sim = this.host!.sim;
    sim.step(n);
    this.clock.now += n * 50;
    this.sync.stepped(sim, this.clock.now);
  }

  /** pagehide: flush, then the game's save (ServerSync.persist). */
  pagehide(): void {
    this.sync.flush();
    expect(this.sync.persist(this.host!.sim.snapshot(), DEFAULT_SETTINGS)).toBe(true);
    this.sync.destroy();
  }
}

function vstate(
  sim: Sim,
  epoch: number,
  extra: { continued?: boolean; offline?: VerifiedState["offline"] } = {},
): VerifiedState {
  const continued = extra.continued ?? false;
  return {
    instanceId: "classic:acc:1",
    epoch,
    tick: sim.tick,
    hash: sim.hash(),
    continued,
    snapshot: continued ? null : sim.snapshot(),
    offline: extra.offline ?? null,
    imported: false,
    importable: false,
    limits: DEFAULT_LIMITS,
  };
}

/** The server's offline dispatch on a copy of `at` (the verified state). */
function granted(at: Sim, elapsedMs: number): { sim: Sim; offline: VerifiedState["offline"] } {
  const sim = createSim(LOADED, { seed: 0, from: at.snapshot() });
  const res = sim.dispatch(ACTION.offlineProgress, { elapsedMs }, "server");
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return { sim, offline: { elapsedMs, events: JSON.parse(JSON.stringify(res.events)) } };
}

const copy = (sim: Sim): Sim => createSim(LOADED, { seed: 0, from: sim.snapshot() });

/**
 * A first page booted from the server (no cache) with an Idle hero, one
 * segment verified, then another segment out without its ack.
 */
async function playing(storage = new MemoryStorage()) {
  const page = new Page(storage, 1_800_000_000_000);
  const booting = page.sync.boot();
  // No cache: the first join cannot continue anything (the server grants if it owes).
  expect(page.conn.h!.resume()).toBeNull();
  page.conn.answer(vstate(createSim(LOADED, { seed: 4242 }), 1));
  const boot = await booting;
  expect(boot?.from).toBe("server");
  page.attach(boot!);
  page.act(ACTION.newHero, { classId: "classic.warrior", name: "Sleeper" });
  page.act(ACTION.setControl, { mode: "idle" });
  page.step(100);
  const first = page.conn.submitted.at(-1)!;
  page.conn.h!.verified({
    epoch: 1,
    seq: first.seq,
    tick: first.toTick,
    hash: first.hash,
    creditMs: 1000,
  });
  const verified = copy(page.host!.sim);
  page.step(100);
  expect(page.sync.pending).toHaveLength(1);
  return { storage, page, verified };
}

describe("ServerSync offline: resume and grant on reload", () => {
  it("pagehide then reload after 2 h: resume carries pendingToTick, the grant is emitted once", async () => {
    const { storage, page } = await playing();
    // pagehide: one more segment is flushed; the server verified both, the acks were lost.
    page.host!.sim.step(10);
    page.pagehide();
    const serverState = copy(page.host!.sim);
    const lastToTick = page.sync.pending.at(-1)!.toTick;
    expect(lastToTick).toBe(serverState.tick);

    const page2 = new Page(storage, page.clock.wall + 2 * HOUR);
    const boot = await page2.sync.boot();
    expect(boot?.from).toBe("cache");
    const host = page2.attach(boot!);
    const resume = page2.conn.h!.resume();
    expect(resume).toEqual({
      tick: 100,
      hash: expect.any(String),
      pending: true,
      pendingToTick: lastToTick,
    });
    // The server's pending was already verified: it grants at once (offline-idle.md §5.2).
    const g = granted(serverState, 2 * HOUR);
    page2.conn.answer(vstate(g.sim, 5, { offline: g.offline }));
    expect(host.summaries()).toHaveLength(1);
    expect(host.sim.hash()).toBe(g.sim.hash());
    expect(page2.sync.pending).toHaveLength(0);
    expect(page2.sync.verified).toEqual({ tick: g.sim.tick, hash: g.sim.hash() });
    // Nothing real was lost: no "Progress restored" toast.
    expect(host.toasts).not.toContain(SYNC_TEXT.replacedTitle);
    expect(page2.sync.persist(host.sim.snapshot(), DEFAULT_SETTINGS)).toBe(true);
    page2.sync.destroy();

    // A quick reload: nothing pending, the server continues; no second summary.
    const page3 = new Page(storage, page2.clock.wall + 5000);
    const host3 = page3.attach((await page3.sync.boot())!);
    expect(page3.conn.h!.resume()).toEqual({
      tick: g.sim.tick,
      hash: g.sim.hash(),
      pending: false,
    });
    page3.conn.answer(vstate(g.sim, 6, { continued: true }));
    expect(host3.summaries()).toHaveLength(0);
    expect(host3.toasts).toEqual([]);
  });

  it("a grant that does not contain the pending play still reports the loss", async () => {
    const { storage, page, verified } = await playing();
    page.pagehide();
    const page2 = new Page(storage, page.clock.wall + HOUR);
    const host = page2.attach((await page2.sync.boot())!);
    // The server never got the pending segment (another device took over, say).
    const g = granted(verified, HOUR);
    page2.conn.answer(vstate(g.sim, 3, { offline: g.offline }));
    expect(host.summaries()).toHaveLength(1);
    expect(host.toasts).toContain(SYNC_TEXT.replacedTitle);
  });
});

describe("ServerSync offline: long hidden tab", () => {
  it("visible() reconnects with pending segments after HIDDEN_RECONNECT_MS, not before", async () => {
    const { page } = await playing();
    expect(page.sync.pending).toHaveLength(1);
    page.sync.visible(HIDDEN_RECONNECT_MS - 1000);
    expect(page.conns).toHaveLength(1);
    page.sync.visible(HIDDEN_RECONNECT_MS + 30_000);
    expect(page.conns).toHaveLength(2);
    expect(page.conns[0]!.closed).toBe(true);
    expect(page.conn.h!.resume()).toMatchObject({
      tick: 100,
      pending: true,
      pendingToTick: page.sync.pending.at(-1)!.toTick,
    });
  });

  it("a deferred grant (resync offline) is adopted and its events emitted, without a loss toast", async () => {
    const { page, verified } = await playing();
    const pendingSeg = page.sync.pending[0]!;
    const atPending = copy(page.host!.sim);
    page.sync.visible(2 * HOUR);
    const conn = page.conn;
    // Real pending: the server continues and the client resends it in the new epoch.
    conn.answer(vstate(verified, 2, { continued: true }));
    expect(conn.submitted.map((s) => [s.epoch, s.toTick])).toEqual([[2, pendingSeg.toTick]]);
    // The client keeps playing while the resend is verified.
    page.step(30);
    const host = page.host!;
    const replacedBefore = host.replaced;
    conn.h!.verified({
      epoch: 2,
      seq: pendingSeg.seq,
      tick: pendingSeg.toTick,
      hash: pendingSeg.hash,
      creditMs: 3000,
    });
    const g = granted(atPending, 2 * HOUR - 100 * 50);
    const resync: VerifiedResync & { offline: VerifiedState["offline"] } = {
      epoch: 3,
      seq: pendingSeg.seq,
      code: "offline",
      message: "progress while you were away",
      tick: g.sim.tick,
      hash: g.sim.hash(),
      snapshot: g.sim.snapshot(),
      offline: g.offline,
    };
    conn.h!.resync(resync);
    expect(host.replaced).toBe(replacedBefore + 1);
    expect(host.sim.hash()).toBe(g.sim.hash());
    expect(host.summaries()).toHaveLength(1);
    expect(host.toasts).toEqual([]);
    expect(page.sync.epoch).toBe(3);
    expect(page.sync.pending).toHaveLength(0);
    expect(page.sync.view.getSnapshot().lastResync).toBeNull();
    // Play goes on from the granted state in the new epoch.
    page.step(100);
    const next = conn.submitted.at(-1)!;
    expect([next.epoch, next.fromTick]).toEqual([3, g.sim.tick]);
  });
});

import type { LoadedMode } from "@gamez/kernel";
import type { InstanceServerMessage } from "@gamez/protocol";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ACTION_LIMIT,
  InstanceHost,
  type InstanceSocket,
  type InstanceStore,
  type SocketInfo,
  type StoredInstance,
} from "../../src/server/instance/host.ts";
import { CLOSE_REPLACED } from "../../src/server/instance/messages.ts";
import { clockLoaded, counterLoaded, counterLoadedV2, type Counter } from "./fixtures.ts";

class MemoryStore implements InstanceStore {
  instance: StoredInstance | null = null;
  seqs = new Map<string, number>();
  saves = 0;
  failNext = false;

  load(): StoredInstance | null {
    return this.instance ? structuredClone(this.instance) : null;
  }

  players(): Map<string, number> {
    return new Map(this.seqs);
  }

  save(instance: StoredInstance, player?: { accountId: string; lastSeq: number }): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk full");
    }
    this.saves++;
    this.instance = structuredClone(instance);
    if (player) this.seqs.set(player.accountId, player.lastSeq);
  }
}

class FakeSocket implements InstanceSocket {
  info: SocketInfo;
  open = true;
  closed: { code: number; reason: string } | null = null;
  out: InstanceServerMessage[] = [];

  constructor(accountId: string, mode: string) {
    this.info = { accountId, name: `Guest-${accountId}`, mode, joined: false };
  }

  setInfo(info: SocketInfo): void {
    this.info = info;
  }

  send(frame: string): void {
    this.out.push(JSON.parse(frame) as InstanceServerMessage);
  }

  close(code: number, reason: string): void {
    this.open = false;
    this.closed = { code, reason };
  }

  /** Messages received since the last take(). */
  take(): InstanceServerMessage[] {
    const out = this.out;
    this.out = [];
    return out;
  }
}

interface Harness {
  host: InstanceHost;
  store: MemoryStore;
  sockets: FakeSocket[];
  clock: { now: number };
  alarms: number[];
  connect(accountId?: string): FakeSocket;
  send(s: FakeSocket, msg: unknown): InstanceServerMessage[];
  /** A new host over the same store and sockets (DO woke up / was evicted). */
  restart(loaded?: LoadedMode): InstanceHost;
}

function harness(loaded: LoadedMode = counterLoaded, store = new MemoryStore()): Harness {
  const sockets: FakeSocket[] = [];
  const clock = { now: 1_000_000 };
  const alarms: number[] = [];
  let seed = 7;
  const make = (l: LoadedMode) =>
    new InstanceHost({
      name: `${l.mode.id}:acct`,
      loaded: l,
      store,
      sockets: () => sockets.filter((s) => s.open),
      now: () => clock.now,
      randomSeed: () => seed++,
      setAlarm: (at) => alarms.push(at),
    });
  const h: Harness = {
    host: make(loaded),
    store,
    sockets,
    clock,
    alarms,
    connect(accountId = "acct") {
      const s = new FakeSocket(accountId, loaded.mode.id);
      sockets.push(s);
      return s;
    },
    send(s, msg) {
      h.host.handleMessage(s, JSON.stringify(msg));
      return s.take();
    },
    restart(l = loaded) {
      h.host = make(l);
      return h.host;
    },
  };
  return h;
}

function only<T extends InstanceServerMessage["t"]>(
  msgs: InstanceServerMessage[],
  t: T,
): Extract<InstanceServerMessage, { t: T }> {
  expect(msgs.map((m) => m.t)).toEqual([t]);
  return msgs[0] as Extract<InstanceServerMessage, { t: T }>;
}

const counter = (snap: { world: { resources: Record<string, unknown> } }) =>
  snap.world.resources["tcount.counter"] as Counter;

const join = (fresh = false) => ({ t: "join", token: "tok", mode: "tcount", fresh });
const add = (seq: number, by: number) => ({
  t: "action",
  seq,
  name: "tcount.add",
  payload: { by },
});

describe("InstanceHost (event mode)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("creates a sim on first join, stores it and replies with state", () => {
    const s = h.connect();
    const state = only(h.send(s, join()), "state");
    expect(state.mode).toBe("tcount");
    expect(state.contentHash).toBe(counterLoaded.contentHash);
    expect(state.lastSeq).toBe(0);
    expect(state.instanceId).toBe("tcount:acct:00000007");
    expect(state.snapshot.contentHash).toBe(counterLoaded.contentHash);
    expect(h.store.instance?.seed).toBe(7);
    expect(h.store.seqs.get("acct")).toBe(0);
    expect(s.info.joined).toBe(true);
  });

  it("rejects actions before join", () => {
    const s = h.connect();
    const err = only(h.send(s, add(1, 1)), "error");
    expect(err.code).toBe("not_joined");
  });

  it("dispatches actions, persists snapshot and lastSeq, replies with result", () => {
    const s = h.connect();
    const start = counter(only(h.send(s, join()), "state").snapshot).value;
    const res = only(h.send(s, add(1, 3)), "result");
    expect(res).toMatchObject({ seq: 1, ok: true });
    expect(res.events).toEqual([{ type: "tcount.added", value: start + 3, actor: "acct" }]);
    expect(counter(res.snapshot).value).toBe(start + 3);
    expect(h.store.seqs.get("acct")).toBe(1);
    expect(h.store.instance?.snapshot).toEqual(res.snapshot);
  });

  it("returns the unchanged snapshot on a rejected action and does not persist", () => {
    const s = h.connect();
    h.send(s, join());
    const saves = h.store.saves;
    const res = only(h.send(s, add(1, 500)), "result");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("too_big");
    expect(res.events).toEqual([]);
    expect(h.store.saves).toBe(saves);
    const bad = only(h.send(s, { t: "action", seq: 2, name: "nope", payload: null }), "result");
    expect(bad.error?.code).toBe("unknown_action");
  });

  it("rejects stale and duplicate seqs", () => {
    const s = h.connect();
    h.send(s, join());
    expect(only(h.send(s, add(5, 1)), "result").ok).toBe(true);
    const dup = only(h.send(s, add(5, 1)), "result");
    expect(dup.error?.code).toBe("stale_seq");
    expect(only(h.send(s, add(3, 1)), "result").error?.code).toBe("stale_seq");
    expect(only(h.send(s, add(6, 1)), "result").ok).toBe(true);
  });

  it("resumes the stored sim after a restart with the same lastSeq", () => {
    const s = h.connect();
    h.send(s, join());
    const after = only(h.send(s, add(1, 2)), "result").snapshot;
    h.restart();
    const s2 = h.connect();
    const state = only(h.send(s2, join()), "state");
    expect(state.snapshot).toEqual(after);
    expect(state.lastSeq).toBe(1);
    expect(state.instanceId).toBe("tcount:acct:00000007");
  });

  it("keeps acting on hibernated sockets after a wake-up (sim reloaded lazily)", () => {
    const s = h.connect();
    h.send(s, join());
    h.send(s, add(1, 2));
    h.restart();
    const res = only(h.send(s, add(2, 1)), "result");
    expect(res.ok).toBe(true);
    expect(only(h.send(s, add(2, 1)), "result").error?.code).toBe("stale_seq");
  });

  it("join fresh=true discards the instance", () => {
    const s = h.connect();
    const first = only(h.send(s, join()), "state");
    h.send(s, add(1, 2));
    const state = only(h.send(s, join(true)), "state");
    expect(state.instanceId).not.toBe(first.instanceId);
    expect(state.snapshot.tick).toBe(0);
    // Seqs keep increasing across runs.
    expect(state.lastSeq).toBe(1);
    expect(h.store.instance?.seed).toBe(8);
  });

  it("starts fresh with a content_changed error when the mode content changed", () => {
    const s = h.connect();
    h.send(s, join());
    h.send(s, add(1, 2));
    h.restart(counterLoadedV2);
    const s2 = new FakeSocket("acct", "tcount");
    h.sockets.push(s2);
    const msgs = h.send(s2, join());
    expect(msgs.map((m) => m.t)).toEqual(["error", "state"]);
    expect(msgs[0]).toMatchObject({ t: "error", code: "content_changed" });
    const state = msgs[1] as Extract<InstanceServerMessage, { t: "state" }>;
    expect(state.contentHash).toBe(counterLoadedV2.contentHash);
    expect(state.snapshot.tick).toBe(0);
    expect(h.store.instance?.snapshot.contentHash).toBe(counterLoadedV2.contentHash);
  });

  it("rate limits actions per socket (burst 10, 10/s)", () => {
    const s = h.connect();
    h.send(s, join());
    const results = Array.from({ length: ACTION_LIMIT.burst + 2 }, (_, i) =>
      only(h.send(s, add(i + 1, 1)), "result"),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(ACTION_LIMIT.burst);
    expect(results.at(-1)?.error?.code).toBe("rate_limited");
    h.clock.now += 200; // refills 2 tokens
    expect(only(h.send(s, add(100, 1)), "result").ok).toBe(true);
    expect(only(h.send(s, add(101, 1)), "result").ok).toBe(true);
    expect(only(h.send(s, add(102, 1)), "result").error?.code).toBe("rate_limited");
  });

  it("answers ping with pong", () => {
    const s = h.connect();
    const pong = only(h.send(s, { t: "ping", clientTime: 42 }), "pong");
    expect(pong).toEqual({ t: "pong", clientTime: 42, serverTime: h.clock.now });
  });

  it("rejects malformed messages and a join for another mode", () => {
    const s = h.connect();
    h.host.handleMessage(s, "{not json");
    expect(only(s.take(), "error").code).toBe("bad_message");
    expect(only(h.send(s, { t: "action", seq: "1", name: "x" }), "error").code).toBe("bad_message");
    expect(only(h.send(s, { t: "join", token: "t", mode: "tclock" }), "error").code).toBe(
      "wrong_mode",
    );
  });

  it("replaces an older socket of the same player", () => {
    const a = h.connect();
    h.send(a, join());
    const b = h.connect();
    only(h.send(b, join()), "state");
    expect(a.closed?.code).toBe(CLOSE_REPLACED);
    expect(a.info.joined).toBe(false);
  });

  it("refuses players beyond maxPlayers", () => {
    const a = h.connect("acct");
    h.send(a, join());
    const b = h.connect("intruder");
    expect(only(h.send(b, join()), "error").code).toBe("instance_full");
    expect(only(h.send(b, add(1, 1)), "error").code).toBe("not_joined");
  });

  it("answers with the stored state when persisting fails", () => {
    const s = h.connect();
    const start = only(h.send(s, join()), "state").snapshot;
    h.store.failNext = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = only(h.send(s, add(1, 1)), "result");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("internal");
    expect(res.snapshot).toEqual(start);
    vi.restoreAllMocks();
  });
});

describe("InstanceHost (fixed mode)", () => {
  const joinClock = { t: "join", token: "tok", mode: "tclock" };
  const ticks = (snap: { world: { resources: Record<string, unknown> } }) =>
    snap.world.resources["tclock.ticks"] as number;

  it("ticks via alarm at the mode's hz while a player is connected", () => {
    const h = harness(clockLoaded);
    const s = h.connect();
    only(h.send(s, joinClock), "state");
    expect(h.host.ticking).toBe(true);
    expect(h.alarms).toEqual([h.clock.now + 50]);

    h.clock.now += 50;
    h.host.alarm();
    const state = only(s.take(), "state");
    expect(ticks(state.snapshot)).toBe(1);
    expect(state.snapshot.tick).toBe(1);
    expect(h.alarms.at(-1)).toBe(h.clock.now + 50);

    // Broadcasts are capped at 10/s: the next tick 50 ms later sends nothing.
    h.clock.now += 50;
    h.host.alarm();
    expect(s.take()).toEqual([]);
    expect(h.host.sim?.tick).toBe(2);

    // A late alarm catches up on missed ticks.
    h.clock.now += 150;
    h.host.alarm();
    expect(ticks(only(s.take(), "state").snapshot)).toBe(5);
  });

  it("caps catch-up at one second of ticks", () => {
    const h = harness(clockLoaded);
    const s = h.connect();
    h.send(s, joinClock);
    h.clock.now += 60_000;
    h.host.alarm();
    expect(h.host.sim?.tick).toBe(20);
  });

  it("stops ticking and persists when the last player leaves", () => {
    const h = harness(clockLoaded);
    const s = h.connect();
    h.send(s, joinClock);
    h.clock.now += 100;
    h.host.alarm();
    s.open = false;
    h.host.handleClose(s);
    expect(h.store.instance?.snapshot.tick).toBe(2);
    const alarms = h.alarms.length;
    h.clock.now += 100;
    h.host.alarm();
    expect(h.host.ticking).toBe(false);
    expect(h.alarms).toHaveLength(alarms);
  });

  it("applies actions between ticks and shares state with other players", () => {
    const h = harness(clockLoaded);
    const a = h.connect("a");
    const b = h.connect("b");
    h.send(a, joinClock);
    h.send(b, joinClock);
    h.clock.now += 100;
    h.host.alarm();
    a.take();
    b.take();
    const res = only(
      h.send(a, { t: "action", seq: 1, name: "tclock.reset", payload: null }),
      "result",
    );
    expect(ticks(res.snapshot)).toBe(0);
    const seen = only(b.take(), "state");
    expect(ticks(seen.snapshot)).toBe(0);
    expect(seen.lastSeq).toBe(0);
  });

  it("restarts the tick clock after an eviction", () => {
    const h = harness(clockLoaded);
    const s = h.connect();
    h.send(s, joinClock);
    h.restart();
    h.clock.now += 5000;
    h.host.alarm();
    expect(h.host.ticking).toBe(true);
    expect(h.host.sim?.tick).toBe(0);
    h.clock.now += 50;
    h.host.alarm();
    expect(h.host.sim?.tick).toBe(1);
  });
});

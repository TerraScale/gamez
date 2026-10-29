/**
 * Requirement-level tests for offline/idle progress across every way a player
 * leaves and returns (offline-idle.md §2, §5), with the real classic mode and
 * policy, the node:sqlite store and a fake server clock. Each test name reads
 * as the requirement it proves. Each return asserts exactly one grant, and
 * awayMs is the server-measured absence.
 *
 * XP amounts are the sim's business (modules/classic tests). Here we check the
 * server: which joins grant, how much time they credit, and that nothing is
 * paid twice.
 */
import { createSim, loadMode, SegmentRecorder, type GameEvent, type Sim } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  unpackSnapshot,
  VERIFIED_ACTOR,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import type { InstanceSocket, SocketInfo } from "../../src/server/instance/host.ts";
import { VerifiedHost } from "../../src/server/instance/verified-host.ts";
import { SqlVerifiedStore } from "../../src/server/instance/verified-store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const loaded = loadMode(classic.mode, classic.modules);
const policy = classic.mode.instance!.clientDriven!;
const MIN = 60_000;
const HOUR = 60 * MIN;
const MS_PER_TICK = 50;
const SEGMENT_TICKS = 400;

type Out = VerifiedServerMessage;
type VState = Extract<Out, { t: "vstate" }>;
type Resync = Extract<Out, { t: "resync" }>;
type SegmentMsg = Extract<VerifiedClientMessage, { t: "segment" }>;
type Resume = NonNullable<Extract<VerifiedClientMessage, { t: "join" }>["resume"]>;
type Summary = Extract<classic.ClassicEvent, { type: "classic.offline.summary" }>;

class Sock implements InstanceSocket {
  info: SocketInfo = { accountId: "acc", name: "Exiter", mode: "classic", joined: false };
  open = true;
  out: Out[] = [];
  setInfo(info: SocketInfo): void {
    this.info = info;
  }
  send(frame: string): void {
    this.out.push(JSON.parse(frame) as Out);
  }
  close(): void {
    this.open = false;
  }
}

interface SetupOpts {
  offlineTunables?: () => Promise<Readonly<Record<string, number>>>;
}

function setup(opts: SetupOpts = {}) {
  const db = fakeSqlStore();
  const store = new SqlVerifiedStore(db);
  const clock = { now: 9_000_000 };
  const sockets: Sock[] = [];
  const logs: string[] = [];
  const host = new VerifiedHost({
    name: "classic:acc",
    loaded,
    policy,
    store,
    sockets: () => sockets.filter((s) => s.open),
    now: () => clock.now,
    randomSeed: () => 0x0ff1,
    outbox: null,
    scheduleFlush: () => {},
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...(opts.offlineTunables ? { offlineTunables: opts.offlineTunables } : {}),
  });
  const env = {
    host,
    clock,
    store,
    logs,
    connect(): Sock {
      const s = new Sock();
      sockets.push(s);
      return s;
    },
    async send(s: Sock, msg: VerifiedClientMessage): Promise<Out[]> {
      await host.handleMessage(s, JSON.stringify(msg));
      const out = s.out;
      s.out = [];
      return out;
    },
    async join(s: Sock, resume?: Resume): Promise<VState> {
      const msg: VerifiedClientMessage = { t: "join", token: "t", mode: "classic" };
      if (resume) msg.resume = resume;
      return vstateOf(await env.send(s, msg));
    },
    async leave(s: Sock): Promise<void> {
      s.open = false;
      await host.handleClose(s);
    },
    get rec() {
      return host.record!;
    },
  };
  return env;
}
type Env = ReturnType<typeof setup>;

function vstateOf(out: Out[]): VState {
  const v = out.find((m): m is VState => m.t === "vstate");
  if (!v) throw new Error(`no vstate: ${JSON.stringify(out).slice(0, 300)}`);
  return v;
}

class Client {
  sim!: Sim;
  rec!: SegmentRecorder;
  epoch = 0;
  seq = 0;
  async adopt(m: VState | Resync): Promise<void> {
    this.epoch = m.epoch;
    if (m.snapshot)
      this.sim = createSim(loaded, { seed: 0, from: await unpackSnapshot(m.snapshot) });
    this.rec = new SegmentRecorder(this.sim.tick);
  }
  act(name: string, payload: unknown): void {
    const res = this.sim.dispatch(name, payload, VERIFIED_ACTOR);
    expect(res.ok, `${name}: ${res.error?.code}`).toBe(true);
    this.rec.record(this.sim.tick, name, payload);
  }
  segment(ticks: number): SegmentMsg {
    this.sim.step(ticks);
    return { t: "segment", epoch: this.epoch, seq: ++this.seq, ...this.rec.cut(this.sim)! };
  }
  resume(pending = false, pendingToTick = this.sim.tick): Resume {
    return { tick: this.sim.tick, hash: this.sim.hash(), pending, pendingToTick };
  }
}

/** Sends one segment of `ticks`, the clock moving by its x1 play time; expects the ack. */
async function playVerified(env: Env, sock: Sock, c: Client, ticks: number): Promise<void> {
  env.clock.now += ticks * MS_PER_TICK;
  const out = await env.send(sock, c.segment(ticks));
  expect(out.map((m) => m.t)).toEqual(["verified"]);
}

/** Plays `ticks` verified in segments of at most 400 ticks. */
async function playFor(env: Env, sock: Sock, c: Client, ticks: number): Promise<void> {
  for (let left = ticks; left > 0; left -= SEGMENT_TICKS) {
    await playVerified(env, sock, c, Math.min(SEGMENT_TICKS, left));
  }
}

/** A joined client with a fresh warrior in `control`, 100 verified ticks played. */
async function started(control: "auto" | "idle" | "manual" = "auto", opts: SetupOpts = {}) {
  const env = setup(opts);
  const sock = env.connect();
  const c = new Client();
  await c.adopt(await env.join(sock));
  c.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Exit" });
  c.act(classic.ACTION.setControl, { mode: control });
  await playVerified(env, sock, c, 100);
  return { env, sock, c };
}

/** The XP the classic sim pays for an absence of `ms` at `xpPct`, on an independent copy of `sim`. */
function simGrantXp(sim: Sim, ms: number, xpPct: number): number {
  const copy = createSim(loaded, { seed: 0, from: sim.snapshot() });
  const res = copy.dispatch(classic.ACTION.offlineProgress, { elapsedMs: ms, xpPct }, null);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return summaryOf(res.events).xp;
}

function summaryOf(events: readonly GameEvent[] | undefined): Summary {
  const s = (events ?? []).filter((e) => e.type === "classic.offline.summary");
  expect(s, "exactly one classic.offline.summary").toHaveLength(1);
  return s[0] as unknown as Summary;
}

describe("exit and return: one grant per absence (offline-idle.md §2, §5.2)", () => {
  it("closing the tab or reloading: the verified cache resumes and the absence is granted now, once", async () => {
    const { env, sock, c } = await started();
    // The cache holds play that is already verified: pendingToTick <= verifiedTick.
    const cached = c.resume(true, c.sim.tick);
    expect(cached.pendingToTick).toBeLessThanOrEqual(env.rec.verifiedTick);
    await env.leave(sock);
    env.clock.now += 45 * MIN;
    const v = await env.join(env.connect(), cached);
    expect(v.continued).toBe(false);
    expect(v.offline?.elapsedMs).toBe(45 * MIN);
    expect(summaryOf(v.offline?.events).awayMs).toBe(45 * MIN);
    // The reload rejoins again from its new state: no second grant.
    const again = await env.join(env.connect(), { tick: v.tick, hash: v.hash, pending: false });
    expect(again.offline).toBeNull();
  }, 60_000);

  it("leaving the classic mode for the picker, then returning after 2 h on a new socket: granted once", async () => {
    const { env, sock, c } = await started("idle");
    const resume = c.resume();
    // Teardown closes the socket; the picker is a different screen, no segments.
    await env.leave(sock);
    env.clock.now += 2 * HOUR;
    const v = await env.join(env.connect(), resume);
    expect(v.offline?.elapsedMs).toBe(2 * HOUR);
    expect(summaryOf(v.offline?.events).awayMs).toBe(2 * HOUR);
    const again = await env.join(env.connect(), { tick: v.tick, hash: v.hash, pending: false });
    expect(again.offline).toBeNull();
  }, 60_000);

  it("a hidden tab: socket A stays open for an hour, its close arrives, socket B joins: about 1 h granted once", async () => {
    const { env, sock, c } = await started();
    const resume = c.resume();
    // The hidden tab keeps socket A open with no progress for an hour.
    env.clock.now += HOUR;
    // The close of A arrives just before B joins (the old rule erased the absence here).
    await env.leave(sock);
    const v = await env.join(env.connect(), resume);
    expect(v.offline?.elapsedMs).toBe(HOUR);
    expect(summaryOf(v.offline?.events).awayMs).toBe(HOUR);
    expect(env.rec.offlineDueMs).toBe(0);
    const again = await env.join(env.connect(), { tick: v.tick, hash: v.hash, pending: false });
    expect(again.offline).toBeNull();
  }, 60_000);

  it("switching device: a join without resume after 3 h adopts the snapshot with the grant, once", async () => {
    const { env, sock, c } = await started();
    await env.leave(sock);
    env.clock.now += 3 * HOUR;
    // A new device has no cache: no resume at all.
    const v = await env.join(env.connect());
    expect(v.continued).toBe(false);
    expect(v.snapshot).not.toBeNull();
    expect(v.offline?.elapsedMs).toBe(3 * HOUR);
    const s = summaryOf(v.offline?.events);
    expect(s.awayMs).toBe(3 * HOUR);
    // The new device adopts the granted state (the hash covers the queued grant).
    const device2 = new Client();
    await device2.adopt(v);
    expect(device2.sim.hash()).toBe(v.hash);
    // The grant's XP is queued and lands on the next tick, on every device alike.
    const landed = (device2.sim.step(2) as classic.ClassicEvent[])
      .filter((e) => e.type === "classic.xp" && e.reason === "offline")
      .reduce((sum, e) => sum + (e.type === "classic.xp" ? e.amount : 0), 0);
    expect(landed).toBe(s.xp);
    // The original device comes back with its old cache: no second grant.
    const original = await env.join(env.connect(), c.resume());
    expect(original.offline).toBeNull();
  }, 60_000);

  it("connection lost while visible with real pending play: deferred, paid after catch-up, never twice", async () => {
    const { env, sock, c } = await started();
    const verified = c.resume();
    // 100 ticks played locally, not sent: the connection drops.
    const unsent = c.segment(100);
    await env.leave(sock);
    env.clock.now += 2 * HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, { ...verified, pending: true, pendingToTick: unsent.toTick });
    // Deferred: nothing is granted at the join, the debt is kept.
    expect(v.continued).toBe(true);
    expect(v.offline).toBeNull();
    expect(env.rec.offlineDueMs).toBe(2 * HOUR - 100 * MS_PER_TICK);

    // The client catches up: its unverified play verifies, then the debt is paid once.
    const out = await env.send(s2, { ...unsent, epoch: v.epoch });
    expect(out.map((m) => m.t)).toEqual(["verified", "resync"]);
    const r = out[1] as Resync;
    expect(r.code).toBe("offline");
    expect(summaryOf(r.offline?.events).awayMs).toBe(2 * HOUR - 100 * MS_PER_TICK);

    // The stale cache from before the drop, and a fresh rejoin, add nothing.
    env.clock.now += 3_000;
    const stale = await env.join(env.connect(), {
      ...verified,
      pending: true,
      pendingToTick: unsent.toTick,
    });
    expect(stale.offline).toBeNull();
    const fresh = await env.join(env.connect(), { tick: r.tick, hash: r.hash, pending: false });
    expect(fresh.offline).toBeNull();
    expect(env.rec.offlineDueMs).toBe(0);
    expect(env.rec.offlineDueTick).toBe(0);
  }, 60_000);

  it("reconnect storm: three rejoins within 10 s after a grant grant nothing more", async () => {
    const { env, sock, c } = await started();
    const resume = c.resume();
    await env.leave(sock);
    env.clock.now += HOUR;
    const first = await env.join(env.connect(), resume);
    expect(first.offline?.elapsedMs).toBe(HOUR);
    let cur: Resume = { tick: first.tick, hash: first.hash, pending: false };
    const storm0 = env.clock.now;
    let granted = 0;
    for (let i = 0; i < 3; i++) {
      env.clock.now += 2_000;
      const v = await env.join(env.connect(), cur);
      if (v.offline) granted++;
      expect(v.continued).toBe(true);
      cur = { tick: v.tick, hash: v.hash, pending: false };
    }
    expect(env.clock.now - storm0).toBeLessThanOrEqual(10_000);
    expect(granted).toBe(0);
  }, 60_000);

  it("the client clock is ignored: fields a client adds to the join or the resume cannot change awayMs", async () => {
    const { env, sock, c } = await started();
    const resume = c.resume();
    await env.leave(sock);
    env.clock.now += HOUR;
    // The client sends its own clock and a claimed absence; the parser keeps only known fields.
    const liarResume = {
      ...resume,
      awayMs: 1,
      elapsedMs: 9_000_000_000,
      now: 0,
      clientTime: 1,
      pendingToTick: 0,
    } as unknown as Resume;
    const liarJoin = {
      t: "join",
      token: "t",
      mode: "classic",
      resume: liarResume,
      now: 0,
      elapsedMs: 1,
      serverTime: 0,
    } as unknown as VerifiedClientMessage;
    const v = vstateOf(await env.send(env.connect(), liarJoin));
    expect(v.offline?.elapsedMs).toBe(HOUR);
    expect(summaryOf(v.offline?.events).awayMs).toBe(HOUR);
  }, 60_000);

  it("an admin change of classic.offlineXpPct between two equal absences (20, then 50) changes the factor the sim pays", async () => {
    let pct = 20;
    const { env, sock, c } = await started("auto", {
      offlineTunables: async () => ({ "classic.offlineXpPct": pct }),
    });
    // Enough verified play for the online rate to be measured (rate path, not the model).
    await playFor(env, sock, c, 9_000);
    await env.leave(sock);
    // The XP the sim itself pays for this state at 20 % (the client sim equals the verified state).
    const at20 = simGrantXp(c.sim, HOUR, 20);
    env.clock.now += HOUR;
    const sB = env.connect();
    const v1 = await env.join(sB, c.resume());
    const s1 = summaryOf(v1.offline?.events);
    expect(s1.source).toBe("rate");
    expect(s1.xpPct).toBe(20);
    expect(s1.xp, "the server paid the 20 % grant").toBe(at20);

    // The admin raises the factor. The second absence starts where the first grant left off.
    pct = 50;
    const c2 = new Client();
    await c2.adopt(v1);
    // Some verified play in between (the test below covers the case without it).
    await playVerified(env, sB, c2, 100);
    await env.leave(sB);
    // Both factors on the same state: the hero changed since the first absence (it levelled).
    const again20 = simGrantXp(c2.sim, HOUR, 20);
    const again50 = simGrantXp(c2.sim, HOUR, 50);
    env.clock.now += HOUR;
    const v2 = await env.join(env.connect(), c2.resume());
    const s2 = summaryOf(v2.offline?.events);
    expect(s2.xpPct).toBe(50);
    expect(s2.awayMs).toBe(s1.awayMs);
    expect(s2.ms).toBe(s1.ms);
    expect(s2.xp, "the server paid the 50 % grant, not the 20 % one").toBe(again50);
    // 50 % of the same base is 2.5 times 20 % of it, give or take the floors.
    expect(again20).toBeGreaterThan(0);
    expect(again50).toBeGreaterThanOrEqual(Math.floor(2.5 * again20));
    expect(again50).toBeLessThanOrEqual(2.5 * again20 + 2.5);
  }, 120_000);

  // Regression (found while writing these tests): the sim's same-tick guard
  // (RunStats.offlineAt) refused a second grant before the client played a tick, after
  // #joinOffline had cleared the owed time, so the hours were lost. The guard now exempts
  // the server actor (offline-idle.md §4.4).
  it("an absence right after a grant, with no verified play in between, is paid, not lost", async () => {
    const { env, sock, c } = await started();
    const resume = c.resume();
    await env.leave(sock);
    env.clock.now += HOUR;
    const sA = env.connect();
    const v1 = await env.join(sA, resume);
    expect(v1.offline?.elapsedMs).toBe(HOUR);
    // The client adopts the grant and leaves at once, without playing a tick.
    await env.leave(sA);
    env.clock.now += 2 * HOUR;
    const v2 = await env.join(env.connect(), { tick: v1.tick, hash: v1.hash, pending: false });
    expect(v2.offline?.elapsedMs, "the 2 h absence is granted").toBe(2 * HOUR);
  }, 60_000);
});

describe("a page frozen with its socket open (offline-idle.md §5.6)", () => {
  it("its first segment after the freeze, on the old socket, gets the absence paid once", async () => {
    const { env, sock, c } = await started("idle");
    // The page froze (mobile app switch): no frames, no segments, the socket stays open.
    env.clock.now += 5 * MIN;
    // On resume a queued segment goes out before the page rejoins.
    const out = await env.send(sock, c.segment(40));
    expect(out.map((m) => m.t)).toEqual(["verified", "resync"]);
    const r = out[1] as Resync;
    expect(r.code).toBe("offline");
    // The 5 min freeze minus the segment's own 2 s of play time.
    expect(r.offline?.elapsedMs).toBe(5 * MIN - 40 * MS_PER_TICK);
    expect(summaryOf(r.offline?.events).awayMs).toBe(5 * MIN - 40 * MS_PER_TICK);
    // The page's own rejoin right after: nothing more to pay.
    const c2 = new Client();
    await c2.adopt(r);
    const again = await env.join(env.connect(), c2.resume());
    expect(again.offline).toBeNull();
    expect(again.continued).toBe(true);
  }, 60_000);

  it("a gap under a minute, or one right after a join, is not an absence", async () => {
    const { env, sock, c } = await started("idle");
    env.clock.now += 50_000;
    let out = await env.send(sock, c.segment(40));
    expect(out.map((m) => m.t)).toEqual(["verified"]);
    // A short absence on a new socket (no grant), then play 30 s later: still no grant,
    // the gap counts from the join.
    await env.leave(sock);
    env.clock.now += 50_000;
    const s2 = env.connect();
    const v = await env.join(s2, c.resume());
    expect(v.offline).toBeNull();
    expect(v.continued).toBe(true);
    c.epoch = v.epoch;
    env.clock.now += 30_000;
    out = await env.send(s2, c.segment(40));
    expect(out.map((m) => m.t)).toEqual(["verified"]);
  }, 60_000);

  it("Manual play is never paid for a gap", async () => {
    const { env, sock, c } = await started("manual");
    env.clock.now += 5 * MIN;
    const out = await env.send(sock, c.segment(40));
    expect(out.map((m) => m.t)).toEqual(["verified"]);
    expect(env.rec.offlineDueMs).toBe(0);
  }, 60_000);
});

/**
 * Offline progress in verified play (docs/design/offline-idle.md §5) with the
 * real classic mode and policy, the node:sqlite store and a fake clock: the
 * join decision table (grant now / defer / nothing), the deferred grant
 * (resync "offline"), durable due fields, no double grant, the admin XP
 * tunable, lastActiveAt rules, Manual and Dead heroes. XP amounts are the
 * sim's business (classic tests); this file asserts the server's behaviour.
 */
import { createSim, loadMode, SegmentRecorder, type GameEvent, type Sim } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  packSnapshot,
  unpackSnapshot,
  VERIFIED_ACTOR,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import type { InstanceSocket, SocketInfo } from "../../src/server/instance/host.ts";
import { START_CREDIT_MS, VerifiedHost } from "../../src/server/instance/verified-host.ts";
import { SqlVerifiedStore } from "../../src/server/instance/verified-store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const loaded = loadMode(classic.mode, classic.modules);
const policy = classic.mode.instance!.clientDriven!;
const HOUR = 3_600_000;
const MIN = 60_000;
const CAP_MS = 8 * HOUR;
const MS_PER_TICK = 50;

type Out = VerifiedServerMessage;
type VState = Extract<Out, { t: "vstate" }>;
type Resync = Extract<Out, { t: "resync" }>;
type SegmentMsg = Extract<VerifiedClientMessage, { t: "segment" }>;
type Resume = NonNullable<Extract<VerifiedClientMessage, { t: "join" }>["resume"]>;
type Summary = Extract<classic.ClassicEvent, { type: "classic.offline.summary" }>;

class Sock implements InstanceSocket {
  info: SocketInfo = { accountId: "acc", name: "Tester", mode: "classic", joined: false };
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
  const clock = { now: 7_000_000 };
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
      const out = await env.send(s, msg);
      const v = out.find((m): m is VState => m.t === "vstate");
      if (!v) throw new Error(`no vstate: ${JSON.stringify(out).slice(0, 300)}`);
      return v;
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
}

/** Sends one segment of `ticks`, the clock moving by its x1 play time; expects the ack. */
async function playVerified(env: Env, sock: Sock, c: Client, ticks: number): Promise<void> {
  env.clock.now += ticks * MS_PER_TICK;
  const out = await env.send(sock, c.segment(ticks));
  expect(out.map((m) => m.t)).toEqual(["verified"]);
}

/** A joined client with a fresh warrior in `control`, 100 verified ticks played. */
async function started(control: "auto" | "idle" | "manual" = "auto", opts: SetupOpts = {}) {
  const env = setup(opts);
  const sock = env.connect();
  const c = new Client();
  await c.adopt(await env.join(sock));
  c.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Away" });
  c.act(classic.ACTION.setControl, { mode: control });
  await playVerified(env, sock, c, 100);
  return { env, sock, c };
}

function resumeOf(c: Client, extra: Partial<Resume> = {}): Resume {
  return { tick: c.sim.tick, hash: c.sim.hash(), pending: false, ...extra };
}

function summaryOf(events: readonly GameEvent[] | undefined): Summary {
  const s = (events ?? []).filter((e) => e.type === "classic.offline.summary");
  expect(s).toHaveLength(1);
  return s[0] as unknown as Summary;
}

describe("verified offline: join decision (offline-idle.md §5.2)", () => {
  it("(a) socket A closes 1 h after the last segment, socket B joins: ≈ 1 h is granted once", async () => {
    const { env, sock, c } = await started();
    const progressAt = env.clock.now;
    env.clock.now += HOUR;
    await env.leave(sock);
    expect(env.rec.lastActiveAt).toBe(progressAt);
    const v = await env.join(env.connect(), resumeOf(c));
    expect(v.continued).toBe(false);
    expect(v.offline?.elapsedMs).toBe(HOUR);
    const s = summaryOf(v.offline?.events);
    expect(s).toMatchObject({ awayMs: HOUR, ms: HOUR, capMs: CAP_MS, xpPct: 20 });
    expect(env.rec).toMatchObject({
      lastActiveAt: env.clock.now,
      creditMs: START_CREDIT_MS,
      baseTick: v.tick,
      verifiedHash: v.hash,
      offlineDueMs: 0,
    });
    const back = new Client();
    await back.adopt(v);
    expect(back.sim.hash()).toBe(v.hash);
  }, 60_000);

  it("(a) a 10 h absence is sent whole; the sim credits 8 h (awayMs > ms)", async () => {
    const { env, sock } = await started("idle");
    await env.leave(sock);
    env.clock.now += 10 * HOUR;
    const v = await env.join(env.connect());
    expect(v.offline?.elapsedMs).toBe(10 * HOUR);
    expect(summaryOf(v.offline?.events)).toMatchObject({ awayMs: 10 * HOUR, ms: CAP_MS });
  }, 60_000);

  it("(b) pending already verified (pendingToTick <= verifiedTick) + 2 h: granted now", async () => {
    const { env, sock, c } = await started();
    // pagehide: the last segment was flushed and verified, but its ack never arrived.
    const before = resumeOf(c);
    env.clock.now += 2000;
    const seg = c.segment(40);
    expect((await env.send(sock, seg)).map((m) => m.t)).toEqual(["verified"]);
    await env.leave(sock);
    env.clock.now += 2 * HOUR;
    const v = await env.join(env.connect(), {
      ...before,
      pending: true,
      pendingToTick: seg.toTick,
    });
    expect(v.continued).toBe(false);
    expect(v.offline?.elapsedMs).toBe(2 * HOUR);
    expect(v.tick).toBe(seg.toTick);
  }, 60_000);

  it("(c) real pending of U ticks: no grant at join, resync offline after catch-up", async () => {
    const { env, sock, c } = await started();
    const verified = resumeOf(c);
    const unsent = [c.segment(100), c.segment(100)];
    const u = 200;
    await env.leave(sock);
    env.clock.now += 2 * HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, { ...verified, pending: true, pendingToTick: c.sim.tick });
    expect(v.continued).toBe(true);
    expect(v.offline).toBeNull();
    const owed = 2 * HOUR - u * MS_PER_TICK;
    expect(env.store.load()).toMatchObject({ offlineDueMs: owed, offlineDueTick: c.sim.tick });

    const first = await env.send(s2, { ...unsent[0]!, epoch: v.epoch });
    expect(first.map((m) => m.t)).toEqual(["verified"]);
    const out = await env.send(s2, { ...unsent[1]!, epoch: v.epoch });
    expect(out.map((m) => m.t)).toEqual(["verified", "resync"]);
    const r = out[1] as Resync;
    expect(r).toMatchObject({ code: "offline", epoch: v.epoch + 1, tick: c.sim.tick });
    expect(r.offline?.elapsedMs).toBe(owed);
    expect(summaryOf(r.offline?.events)).toMatchObject({ awayMs: owed, xpPct: 20 });
    expect(env.store.load()).toMatchObject({
      offlineDueMs: 0,
      offlineDueTick: 0,
      creditMs: START_CREDIT_MS,
      lastActiveAt: env.clock.now,
      baseTick: c.sim.tick,
      verifiedHash: r.hash,
    });
    // Not a mismatch: the anti-cheat counters stay clean.
    expect(env.rec.counters.byCode.offline).toBeUndefined();
    // The client adopts it and play goes on verified in the new epoch.
    const after = new Client();
    await after.adopt(r);
    expect(after.sim.hash()).toBe(r.hash);
    await playVerified(env, s2, after, 40);
  }, 60_000);

  it("(d) the due fields survive a disconnect before catch-up and are added at the next join", async () => {
    const { env, sock, c } = await started();
    const verified = resumeOf(c);
    c.segment(100);
    await env.leave(sock);
    env.clock.now += HOUR;
    const s2 = env.connect();
    await env.join(s2, { ...verified, pending: true, pendingToTick: c.sim.tick });
    const owed = HOUR - 100 * MS_PER_TICK;
    await env.leave(s2);
    // Durable: a restarted DO reads them back.
    expect(env.store.load()).toMatchObject({ offlineDueMs: owed, offlineDueTick: c.sim.tick });
    env.clock.now += 30 * MIN;
    // Another device: no cache, nothing to continue -> grant now, owed + the new absence.
    const v = await env.join(env.connect());
    expect(v.continued).toBe(false);
    expect(v.offline?.elapsedMs).toBe(owed + 30 * MIN);
    expect(env.store.load()).toMatchObject({ offlineDueMs: 0, offlineDueTick: 0 });
  }, 60_000);

  it("(d) the same unverified play rejoining twice is not credited twice", async () => {
    const { env, sock, c } = await started();
    const verified = resumeOf(c);
    c.segment(100);
    await env.leave(sock);
    env.clock.now += HOUR;
    const resume = { ...verified, pending: true, pendingToTick: c.sim.tick };
    const s2 = env.connect();
    await env.join(s2, resume);
    await env.leave(s2);
    env.clock.now += 5 * MIN;
    await env.join(env.connect(), resume);
    // 1 h + 5 min of absence, each minus the 5 s of local play: never 2 h.
    expect(env.rec.offlineDueMs).toBe(HOUR + 5 * MIN - 2 * 100 * MS_PER_TICK);
  }, 60_000);

  it("(c) a catch-up that fails (resync) pays the deferred grant on the next verified segment", async () => {
    const { env, sock, c } = await started();
    const verified = resumeOf(c);
    const unsent = c.segment(100);
    await env.leave(sock);
    env.clock.now += HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, { ...verified, pending: true, pendingToTick: unsent.toTick });
    const bad = await env.send(s2, { ...unsent, epoch: v.epoch, hash: "0badc0de" });
    const r = bad[0] as Resync;
    expect(r.code).toBe("hash_mismatch");
    const again = new Client();
    await again.adopt(r);
    env.clock.now += 20 * MS_PER_TICK;
    const out = await env.send(s2, again.segment(20));
    expect(out.map((m) => m.t)).toEqual(["verified", "resync"]);
    const g = out[1] as Resync;
    expect(g.code).toBe("offline");
    expect(g.offline?.elapsedMs).toBe(HOUR - 100 * MS_PER_TICK);
  }, 60_000);

  it("(e) an immediate rejoin or a reload after a grant gets no second grant", async () => {
    const { env, sock, c } = await started();
    const cached = resumeOf(c, { pending: true, pendingToTick: c.sim.tick });
    await env.leave(sock);
    env.clock.now += HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, resumeOf(c));
    expect(v.offline).not.toBeNull();
    // Rejoin (hidden tab, network blip) at the granted state.
    env.clock.now += 5000;
    const again = await env.join(env.connect(), { tick: v.tick, hash: v.hash, pending: false });
    expect(again.offline).toBeNull();
    expect(again.continued).toBe(true);
    // A reload whose cache predates the grant: adopts the base (it contains the grant), no grant.
    env.clock.now += 5000;
    const reload = await env.join(env.connect(), cached);
    expect(reload.offline).toBeNull();
    expect(reload.continued).toBe(false);
    expect(reload.hash).toBe(v.hash);
  }, 60_000);

  it("(e) no second grant after a deferred grant either", async () => {
    const { env, sock, c } = await started();
    const verified = resumeOf(c);
    const unsent = c.segment(100);
    await env.leave(sock);
    env.clock.now += HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, { ...verified, pending: true, pendingToTick: c.sim.tick });
    const out = await env.send(s2, { ...unsent, epoch: v.epoch });
    const r = out[1] as Resync;
    expect(r.code).toBe("offline");
    env.clock.now += 3000;
    const again = await env.join(env.connect(), { tick: r.tick, hash: r.hash, pending: false });
    expect(again.offline).toBeNull();
    expect(again.continued).toBe(true);
  }, 60_000);

  it("(g) zero-tick segments do not move lastActiveAt", async () => {
    const { env, sock, c } = await started();
    const progressAt = env.clock.now;
    env.clock.now += 2 * MIN;
    // A throttled hidden tab: a segment that covers no tick.
    const empty: SegmentMsg = {
      t: "segment",
      epoch: c.epoch,
      seq: ++c.seq,
      fromTick: c.sim.tick,
      toTick: c.sim.tick,
      inputs: [],
      hash: c.sim.hash(),
    };
    const out = await env.send(sock, empty);
    expect(out.map((m) => m.t)).toEqual(["verified"]);
    expect(env.rec.lastActiveAt).toBe(progressAt);
    await env.leave(sock);
    const v = await env.join(env.connect(), resumeOf(c));
    expect(v.offline?.elapsedMs).toBe(2 * MIN);
  }, 60_000);

  it("(h) a Manual hero gets no grant and the due fields are cleared", async () => {
    const { env, sock, c } = await started();
    const verified = resumeOf(c);
    // Unverified play that switches to Manual, then a disconnect.
    c.act(classic.ACTION.setControl, { mode: "manual" });
    const toManual = c.segment(20);
    const rest = c.segment(100);
    await env.leave(sock);
    env.clock.now += HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, { ...verified, pending: true, pendingToTick: rest.toTick });
    expect(env.rec.offlineDueMs).toBeGreaterThan(0);
    // Only the Manual switch verifies before the client leaves again.
    expect((await env.send(s2, { ...toManual, epoch: v.epoch })).map((m) => m.t)).toEqual([
      "verified",
    ]);
    await env.leave(s2);
    env.clock.now += HOUR;
    const back = await env.join(env.connect());
    expect(back.offline).toBeNull();
    expect(env.store.load()).toMatchObject({ offlineDueMs: 0, offlineDueTick: 0 });
  }, 60_000);

  it("(h) a deferred grant whose catch-up ends in Manual pays nothing and clears the debt", async () => {
    const { env, sock, c } = await started();
    const verified = resumeOf(c);
    c.act(classic.ACTION.setControl, { mode: "manual" });
    const seg = c.segment(40);
    await env.leave(sock);
    env.clock.now += HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, { ...verified, pending: true, pendingToTick: seg.toTick });
    expect(env.rec.offlineDueMs).toBe(HOUR - 40 * MS_PER_TICK);
    const out = await env.send(s2, { ...seg, epoch: v.epoch });
    expect(out.map((m) => m.t)).toEqual(["verified"]);
    expect(env.store.load()).toMatchObject({ offlineDueMs: 0, offlineDueTick: 0 });
  }, 60_000);

  it("(h) Manual verified, pending switch to Idle, then the tab closes: paid after catch-up", async () => {
    const { env, sock, c } = await started("manual");
    const verified = resumeOf(c);
    c.act(classic.ACTION.setControl, { mode: "idle" });
    const seg = c.segment(40);
    await env.leave(sock);
    env.clock.now += HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, { ...verified, pending: true, pendingToTick: seg.toTick });
    expect(v.offline).toBeNull();
    expect(env.rec.offlineDueMs).toBe(HOUR - 40 * MS_PER_TICK);
    const out = await env.send(s2, { ...seg, epoch: v.epoch });
    expect(out.map((m) => m.t)).toEqual(["verified", "resync"]);
    const r = out[1] as { code: string; offline: { elapsedMs: number } | null };
    expect(r.code).toBe("offline");
    expect(r.offline?.elapsedMs).toBe(HOUR - 40 * MS_PER_TICK);
    expect(env.store.load()).toMatchObject({ offlineDueMs: 0, offlineDueTick: 0 });
  }, 60_000);

  it("(h) a Manual absence is consumed: switching to Idle later never pays it", async () => {
    const { env, sock, c } = await started("manual");
    await env.leave(sock);
    env.clock.now += 3 * HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, resumeOf(c));
    expect(v.offline).toBeNull();
    expect(env.rec.lastActiveAt).toBe(env.clock.now);
    // Back in the game: one tick that switches to Idle verifies, then the tab closes.
    c.act(classic.ACTION.setControl, { mode: "idle" });
    env.clock.now += MS_PER_TICK;
    const out = await env.send(s2, { ...c.segment(1), epoch: v.epoch });
    expect(out.map((m) => m.t)).toEqual(["verified"]);
    await env.leave(s2);
    env.clock.now += 30_000;
    const back = await env.join(env.connect(), resumeOf(c));
    expect(back.offline).toBeNull();
  }, 60_000);

  it("(h) a Manual hero rejoining after hours: nothing, and play continues", async () => {
    const { env, sock, c } = await started("manual");
    await env.leave(sock);
    env.clock.now += 3 * HOUR;
    const v = await env.join(env.connect(), resumeOf(c));
    expect(v.offline).toBeNull();
    expect(v.continued).toBe(true);
  }, 60_000);

  it("(i) a Dead hero in the verified state is granted and respawned", async () => {
    const env = setup();
    const sock = env.connect();
    await env.join(sock);
    // The verified state with a dead Auto hero: an imported local save.
    const local = createSim(loaded, { seed: 31 });
    expect(
      local.dispatch(classic.ACTION.newHero, { classId: "classic.rogue", name: "Fallen" }, null).ok,
    ).toBe(true);
    expect(local.dispatch(classic.ACTION.setControl, { mode: "idle" }, null).ok).toBe(true);
    local.step(20);
    const hero = classic.heroOf(local.world);
    local.world.add(hero, classic.Dead, { at: local.tick, killer: 0 });
    const imported = (
      await env.send(sock, {
        t: "import",
        snapshot: await packSnapshot(local.snapshot()),
        savedAt: 1,
      })
    )[0] as VState;
    expect(imported.t).toBe("vstate");
    expect(imported.imported).toBe(true);
    const deadSim = createSim(loaded, { seed: 0, from: await unpackSnapshot(imported.snapshot!) });
    expect(deadSim.world.has(classic.heroOf(deadSim.world), classic.Dead)).toBe(true);
    // Without the grant it would still be dead two ticks later (the respawn delay).
    deadSim.step(2);
    expect(deadSim.world.has(classic.heroOf(deadSim.world), classic.Dead)).toBe(true);
    await env.leave(sock);
    env.clock.now += HOUR;
    const v = await env.join(env.connect());
    expect(v.offline?.elapsedMs).toBe(HOUR);
    summaryOf(v.offline?.events);
    const back = new Client();
    await back.adopt(v);
    // The respawn ran before the grants (in the grant's dispatch or on the next tick).
    back.sim.step(2);
    expect(back.sim.world.has(classic.heroOf(back.sim.world), classic.Dead)).toBe(false);
  }, 60_000);
});

describe("verified offline: admin tunable (offline-idle.md §5.4)", () => {
  it("(f) classic.offlineXpPct 35 reaches the summary", async () => {
    let calls = 0;
    const { env, sock, c } = await started("auto", {
      offlineTunables: async () => {
        calls++;
        return { "classic.offlineXpPct": 35 };
      },
    });
    // Not awaited while no grant is possible.
    expect(calls).toBe(0);
    await env.leave(sock);
    env.clock.now += HOUR;
    const v = await env.join(env.connect(), resumeOf(c));
    expect(summaryOf(v.offline?.events).xpPct).toBe(35);
    expect(calls).toBe(1);
  }, 60_000);

  it("(f) a throwing tunables dep fails open to the balance default (20)", async () => {
    const { env, sock, c } = await started("auto", {
      offlineTunables: () => Promise.reject(new Error("ConfigDO down")),
    });
    await env.leave(sock);
    env.clock.now += HOUR;
    const v = await env.join(env.connect(), resumeOf(c));
    expect(summaryOf(v.offline?.events).xpPct).toBe(20);
    expect(env.logs.some((l) => l.startsWith("warn:") && l.includes("tunables"))).toBe(true);
  }, 60_000);

  it("(f) the deferred grant uses the tunable too", async () => {
    const { env, sock, c } = await started("auto", {
      offlineTunables: async () => ({ "classic.offlineXpPct": 7 }),
    });
    const verified = resumeOf(c);
    const unsent = c.segment(60);
    await env.leave(sock);
    env.clock.now += HOUR;
    const s2 = env.connect();
    const v = await env.join(s2, { ...verified, pending: true, pendingToTick: unsent.toTick });
    const out = await env.send(s2, { ...unsent, epoch: v.epoch });
    const r = out[1] as Resync;
    expect(r.code).toBe("offline");
    expect(summaryOf(r.offline?.events).xpPct).toBe(7);
  }, 60_000);
});

describe("verified offline: store schema", () => {
  it("adds the due columns to an old verified_instance table; old rows read 0", () => {
    const db = fakeSqlStore();
    db.sql.exec(`CREATE TABLE verified_instance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      instance_id TEXT NOT NULL, seed INTEGER NOT NULL, epoch INTEGER NOT NULL,
      base TEXT NOT NULL, base_tick INTEGER NOT NULL, base_at INTEGER NOT NULL,
      verified_tick INTEGER NOT NULL, verified_hash TEXT NOT NULL, credit_ms REAL NOT NULL,
      credit_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, imported INTEGER NOT NULL,
      import_used INTEGER NOT NULL, segments_total INTEGER NOT NULL, module_ids TEXT NOT NULL,
      account_id TEXT NOT NULL, display_name TEXT NOT NULL, counters TEXT NOT NULL
    )`);
    const base = createSim(loaded, { seed: 1 }).snapshot();
    db.sql.exec(
      `INSERT INTO verified_instance VALUES (1, 'classic:acc:1', 1, 3, ?, 0, 1, 0, 'h', 3000, 1, 1,
        0, 0, 0, '[]', 'acc', 'Old', '{}')`,
      JSON.stringify(base),
    );
    const store = new SqlVerifiedStore(db);
    const rec = store.load()!;
    expect(rec).toMatchObject({ epoch: 3, displayName: "Old", offlineDueMs: 0, offlineDueTick: 0 });
    rec.offlineDueMs = 12_345;
    rec.offlineDueTick = 678;
    store.saveMeta(rec);
    expect(new SqlVerifiedStore(db).load()).toMatchObject({
      offlineDueMs: 12_345,
      offlineDueTick: 678,
    });
  });
});

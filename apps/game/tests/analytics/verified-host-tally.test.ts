/**
 * The VerifiedHost's admin analytics call sites (docs/design/admin-dashboard.md
 * §11.2) with the real classic mode and policy: verified Auto play is folded
 * into "sim.tally" kill/xp points for the account, segments into
 * "verify.segment", a rejected segment into a resync code, and an offline grant
 * into one "sim.offline" point. Flushes happen at compaction and socket close.
 */
import { createSim, loadMode, SegmentRecorder, type Sim } from "@gamez/kernel";
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
import { RecordingAnalytics } from "./fake.ts";

const loaded = loadMode(classic.mode, classic.modules);
const policy = classic.mode.instance!.clientDriven!;
const MS_PER_TICK = 50;

type Out = VerifiedServerMessage;
type VState = Extract<Out, { t: "vstate" }>;

class Sock implements InstanceSocket {
  info: SocketInfo = { accountId: "acc-t", name: "Tally", mode: "classic", joined: false };
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

function setup() {
  const analytics = new RecordingAnalytics();
  const clock = { now: 5_000_000 };
  const sockets: Sock[] = [];
  const host = new VerifiedHost({
    name: "classic:acc-t",
    loaded,
    policy,
    store: new SqlVerifiedStore(fakeSqlStore()),
    sockets: () => sockets.filter((s) => s.open),
    now: () => clock.now,
    randomSeed: () => 2026,
    outbox: null,
    scheduleFlush: () => {},
    log: () => {},
    analytics,
  });
  const send = async (s: Sock, msg: VerifiedClientMessage): Promise<Out[]> => {
    await host.handleMessage(s, JSON.stringify(msg));
    const out = s.out;
    s.out = [];
    return out;
  };
  const connect = (): Sock => {
    const s = new Sock();
    sockets.push(s);
    return s;
  };
  return { host, analytics, clock, send, connect };
}

class Client {
  sim!: Sim;
  rec!: SegmentRecorder;
  epoch = 0;
  seq = 0;
  async adopt(m: VState): Promise<void> {
    this.epoch = m.epoch;
    if (m.snapshot)
      this.sim = createSim(loaded, { seed: 0, from: await unpackSnapshot(m.snapshot) });
    this.rec = new SegmentRecorder(this.sim.tick);
  }
  act(name: string, payload: unknown): void {
    expect(this.sim.dispatch(name, payload, VERIFIED_ACTOR).ok).toBe(true);
    this.rec.record(this.sim.tick, name, payload);
  }
  segment(ticks: number): Extract<VerifiedClientMessage, { t: "segment" }> {
    this.sim.step(ticks);
    return { t: "segment", epoch: this.epoch, seq: ++this.seq, ...this.rec.cut(this.sim)! };
  }
}

const vstateOf = (out: Out[]): VState => out.find((m): m is VState => m.t === "vstate")!;

describe("VerifiedHost analytics (admin-dashboard.md §11.2)", () => {
  it("verified Auto play flushes kill/xp tallies for the account; a bad segment counts its code; an offline grant writes sim.offline", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt(vstateOf(await env.send(sock, { t: "join", token: "t", mode: "classic" })));
    c.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Tally" });
    c.act(classic.ACTION.setControl, { mode: "idle" });
    // 4 000 ticks of Idle, x1, in 400-tick segments (crosses a compaction: a flush).
    for (let i = 0; i < 10; i++) {
      env.clock.now += 400 * MS_PER_TICK;
      const out = await env.send(sock, c.segment(400));
      expect(out.map((m) => m.t)).toEqual(["verified"]);
    }
    const tally = env.analytics.of("sim.tally");
    expect(tally.length).toBeGreaterThan(0);
    expect(tally.every((p) => p.index === "acc-t" && p.blobs.mode === "classic")).toBe(true);
    const metrics = new Set(tally.map((p) => p.blobs.metric));
    expect(metrics.has("kill")).toBe(true);
    expect(metrics.has("xp")).toBe(true);
    const ok = env.analytics.of("verify.segment").filter((p) => p.blobs.outcome === "ok");
    expect(ok.length).toBeGreaterThan(0);

    // A segment with a wrong hash: replay fails, the code is counted and flushed at close.
    const bad = c.segment(20);
    const out = await env.send(sock, { ...bad, hash: "0000000000000000" });
    expect(out.map((m) => m.t)).toEqual(["resync"]);
    await env.host.handleClose(Object.assign(sock, { open: false }));
    const resyncs = env.analytics.of("verify.resync").map((p) => p.blobs.code);
    expect(resyncs).toContain("hash_mismatch");
    const failed = env.analytics
      .of("verify.segment")
      .filter((p) => p.blobs.outcome === "hash_mismatch");
    expect(failed).toHaveLength(1);

    // An hour away: the join's grant is one sim.offline point (flushed by the grant's compaction).
    env.clock.now += 3_600_000;
    const s2 = env.connect();
    const v = vstateOf(await env.send(s2, { t: "join", token: "t", mode: "classic" }));
    expect(v.offline).not.toBeNull();
    const off = env.analytics.of("sim.offline");
    expect(off).toHaveLength(1);
    expect(off[0]!.index).toBe("acc-t");
    expect(off[0]!.doubles.ms).toBe(3_600_000);
    expect(off[0]!.doubles.xp).toBeGreaterThan(0);
  }, 120_000);

  it("an imported (quarantined) hero writes no sim.tally or sim.offline points, only verify health (ADR 0007 R1)", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt(vstateOf(await env.send(sock, { t: "join", token: "t", mode: "classic" })));
    // A client-authored local save: a hero on Idle (the server cannot verify how it got here).
    const local = createSim(loaded, { seed: 7 });
    expect(
      local.dispatch(
        classic.ACTION.newHero,
        { classId: "classic.warrior", name: "Forged" },
        VERIFIED_ACTOR,
      ).ok,
    ).toBe(true);
    expect(local.dispatch(classic.ACTION.setControl, { mode: "idle" }, VERIFIED_ACTOR).ok).toBe(
      true,
    );
    local.step(40);
    const imported = vstateOf(
      await env.send(sock, {
        t: "import",
        snapshot: { enc: "json", data: local.snapshot() },
        savedAt: 1,
      }),
    );
    expect(imported.imported).toBe(true);
    await c.adopt(imported);
    for (let i = 0; i < 10; i++) {
      env.clock.now += 400 * MS_PER_TICK;
      const out = await env.send(sock, c.segment(400));
      expect(out.map((m) => m.t)).toEqual(["verified"]);
    }
    await env.host.handleClose(Object.assign(sock, { open: false }));
    env.clock.now += 3_600_000;
    const v = vstateOf(await env.send(env.connect(), { t: "join", token: "t", mode: "classic" }));
    // Solo play keeps everything, offline progress included...
    expect(v.offline).not.toBeNull();
    // ...but none of it feeds the game-wide balance metrics.
    expect(env.analytics.of("sim.tally")).toHaveLength(0);
    expect(env.analytics.of("sim.offline")).toHaveLength(0);
    expect(env.analytics.of("verify.segment").some((p) => p.blobs.outcome === "ok")).toBe(true);
  }, 120_000);

  it("a fresh game (Reset progress) does not leak the imported hero's pending tally into sim.tally", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt(vstateOf(await env.send(sock, { t: "join", token: "t", mode: "classic" })));
    const local = createSim(loaded, { seed: 7 });
    expect(
      local.dispatch(
        classic.ACTION.newHero,
        { classId: "classic.warrior", name: "Forged" },
        VERIFIED_ACTOR,
      ).ok,
    ).toBe(true);
    expect(local.dispatch(classic.ACTION.setControl, { mode: "idle" }, VERIFIED_ACTOR).ok).toBe(
      true,
    );
    local.step(40);
    const imported = vstateOf(
      await env.send(sock, {
        t: "import",
        snapshot: { enc: "json", data: local.snapshot() },
        savedAt: 1,
      }),
    );
    expect(imported.imported).toBe(true);
    await c.adopt(imported);
    // Verified play below the compaction thresholds (1200 ticks, 30 s): the tally stays pending.
    for (let i = 0; i < 2; i++) {
      env.clock.now += 200 * MS_PER_TICK;
      const out = await env.send(sock, c.segment(200));
      expect(out.map((m) => m.t)).toEqual(["verified"]);
    }
    expect(env.analytics.of("verify.segment")).toHaveLength(0);

    // Reset progress: a fresh join replaces the imported record with an honest one.
    const fresh = vstateOf(
      await env.send(sock, { t: "join", token: "t", mode: "classic", fresh: true }),
    );
    expect(fresh.imported).toBe(false);
    await env.host.handleClose(Object.assign(sock, { open: false }));

    // The imported hero's kills and XP never reach the balance metrics; its verify health does.
    expect(env.analytics.of("sim.tally")).toHaveLength(0);
    expect(env.analytics.of("verify.segment").some((p) => p.blobs.outcome === "ok")).toBe(true);
  }, 120_000);
});

/**
 * VerifiedHost with the real classic mode and policy (docs/design/wave-B.md
 * §10): honest play of each class in Auto and in Full Idle at x8 verifies
 * segment by segment, a restarted host restores the same hash, the server
 * grants classic offline progress, and classic.offlineProgress from a client
 * is refused.
 */
import { createSim, loadMode, SegmentRecorder, type Sim } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  unpackSnapshot,
  VERIFIED_ACTOR,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { describe, expect, it } from "vite-plus/test";
import type { InstanceSocket, SocketInfo } from "../../src/server/instance/host.ts";
import { VerifiedHost } from "../../src/server/instance/verified-host.ts";
import { SqlVerifiedStore } from "../../src/server/instance/verified-store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const loaded = loadMode(classic.mode, classic.modules);
const policy = classic.mode.instance!.clientDriven!;

type Out = VerifiedServerMessage;
type VState = Extract<Out, { t: "vstate" }>;
type Resync = Extract<Out, { t: "resync" }>;

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

function setup() {
  const db = fakeSqlStore();
  const store = new SqlVerifiedStore(db);
  const outbox = new Outbox(db.sql, "instance:classic:acc");
  outbox.init();
  const clock = { now: 5_000_000 };
  const sockets: Sock[] = [];
  const make = () =>
    new VerifiedHost({
      name: "classic:acc",
      loaded,
      policy,
      store,
      sockets: () => sockets.filter((s) => s.open),
      now: () => clock.now,
      randomSeed: () => 0x5eed,
      outbox,
      scheduleFlush: () => {},
      log: () => {},
    });
  const env = { host: make(), clock, store, outbox, sockets };
  return {
    ...env,
    restart() {
      env.host = make();
    },
    connect(): Sock {
      const s = new Sock();
      sockets.push(s);
      return s;
    },
    async send(s: Sock, msg: VerifiedClientMessage): Promise<Out[]> {
      await env.host.handleMessage(s, JSON.stringify(msg));
      const out = s.out;
      s.out = [];
      return out;
    },
  };
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
  segment(ticks: number): Extract<VerifiedClientMessage, { t: "segment" }> {
    this.sim.step(ticks);
    return { t: "segment", epoch: this.epoch, seq: ++this.seq, ...this.rec.cut(this.sim)! };
  }
}

/** Plays `ticks` in segments of `every`, advancing the wall clock by what the ledger charges. */
async function play(
  env: ReturnType<typeof setup>,
  sock: Sock,
  c: Client,
  ticks: number,
  every: number,
): Promise<number> {
  let acks = 0;
  for (let done = 0; done < ticks; done += every) {
    const speed = classic.classicSpeedOf(c.sim.world);
    env.clock.now += Math.ceil((every * 50) / speed);
    const out = await env.send(sock, c.segment(every));
    expect(out, JSON.stringify(out).slice(0, 300)).toHaveLength(1);
    expect(out[0]!.t).toBe("verified");
    if (out[0]!.t === "verified") expect(out[0]!.hash).toBe(c.sim.hash());
    acks++;
  }
  return acks;
}

describe("VerifiedHost with classic", () => {
  for (const classId of ["classic.warrior", "classic.rogue", "classic.sorcerer"]) {
    it(`${classId}: Auto, then Full Idle at x8, verifies segment by segment and survives a restart`, async () => {
      const env = setup();
      const sock = env.connect();
      const first = (await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState;
      expect(first.t).toBe("vstate");
      const c = new Client();
      await c.adopt(first);

      c.act(classic.ACTION.newHero, { classId, name: "Verity" });
      c.act(classic.ACTION.setControl, { mode: "auto" });
      expect(await play(env, sock, c, 400, 100)).toBe(4);

      c.act(classic.ACTION.setControl, { mode: "idle" });
      c.act(classic.ACTION.setSpeed, { speed: 8 });
      expect(classic.classicSpeedOf(c.sim.world)).toBe(8);
      expect(await play(env, sock, c, 960, 320)).toBe(3);
      expect(env.host.sim!.hash()).toBe(c.sim.hash());

      // Leave and come back right away after a restart: same verified state, no offline grant
      // (no absence: lastActiveAt is the last verified segment).
      sock.open = false;
      await env.host.handleClose(sock);
      env.restart();
      const again = env.connect();
      const out = await env.send(again, {
        t: "join",
        token: "t",
        mode: "classic",
        resume: { tick: c.sim.tick, hash: c.sim.hash(), pending: true },
      });
      const v = out[0] as VState;
      expect(v.continued).toBe(true);
      expect(v.tick).toBe(1360);
      expect(env.host.sim!.hash()).toBe(c.sim.hash());
      // The report row for the hero went to the outbox.
      const hero = env.outbox.pending().filter((r) => r.table === "classic_hero");
      if (hero.length > 0) expect(hero.at(-1)!.pk).toBe("classic:acc/hero");
    }, 120_000);
  }

  it("refuses classic.offlineProgress from the client and grants it on rejoin", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
    c.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Sleepy" });
    await play(env, sock, c, 200, 100);

    const before = c.sim.hash();
    const cheat = c.segment(20);
    cheat.inputs = [
      { tick: cheat.fromTick, name: classic.ACTION.offlineProgress, payload: { elapsedMs: 3.6e6 } },
    ];
    env.clock.now += 1000;
    const r = (await env.send(sock, cheat))[0] as Resync;
    expect(r.t).toBe("resync");
    expect(r.code).toBe("server_only_action");
    expect(r.hash).toBe(before);

    sock.open = false;
    await env.host.handleClose(sock);
    env.clock.now += 10 * 60_000;
    const back = env.connect();
    const v = (
      await env.send(back, {
        t: "join",
        token: "t",
        mode: "classic",
        resume: { tick: 200, hash: before, pending: false },
      })
    )[0] as VState;
    expect(v.continued).toBe(false);
    // Absence = since the last verified progress (the refused cheat segment is not progress).
    expect(v.offline?.elapsedMs).toBe(10 * 60_000 + 1000);
    expect(v.offline?.events.some((e) => e.type.startsWith("classic.offline"))).toBe(true);
    const c2 = new Client();
    await c2.adopt(v);
    expect(c2.sim.hash()).toBe(v.hash);
    expect(c2.sim.hash()).not.toBe(before);
    // Play continues verified from the granted state.
    expect(await play(env, back, c2, 100, 100)).toBe(1);
  }, 120_000);
});

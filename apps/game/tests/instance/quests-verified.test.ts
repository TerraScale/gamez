/**
 * Quests through the server-verified classic sync (docs/design/wave-B.md §2,
 * classic.md §16): the VerifiedHost replays a client's segments that contain
 * interact -> acceptQuest -> kills -> townPortal/interact -> completeQuest.
 * Covers: every segment verifies, the quest state is in the compacted base,
 * a restart restores it, a local save imports with it, a far acceptQuest is
 * refused by the host with the replay code, and the quest actions are not
 * server-only (client-dispatchable).
 */
import { createSim, loadMode, SegmentRecorder, type Sim } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import {
  packSnapshot,
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
const RATS = "classic.quest.rats_in_the_cellar";
const HALE = "classic.npc.captain_hale";

type Out = VerifiedServerMessage;
type VState = Extract<Out, { t: "vstate" }>;
type Verified = Extract<Out, { t: "verified" }>;
type Resync = Extract<Out, { t: "resync" }>;

class Sock implements InstanceSocket {
  info: SocketInfo = { accountId: "acc", name: "Quester", mode: "classic", joined: false };
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
    expect(res.ok, `${name}: ${res.error?.code} ${res.error?.message ?? ""}`).toBe(true);
    this.rec.record(this.sim.tick, name, payload);
  }
  /** The open segment up to the sim's current tick (the sim must have stepped since the last cut). */
  cut(): Extract<VerifiedClientMessage, { t: "segment" }> {
    return { t: "segment", epoch: this.epoch, seq: ++this.seq, ...this.rec.cut(this.sim)! };
  }
}

/** Sends the open segment (already stepped) and checks the host verified it at the client's hash. */
async function submit(env: Env, sock: Sock, c: Client, ticks: number): Promise<void> {
  const speed = classic.classicSpeedOf(c.sim.world);
  env.clock.now += Math.ceil((ticks * 50) / speed);
  const out = await env.send(sock, c.cut());
  expect(out, JSON.stringify(out).slice(0, 300)).toHaveLength(1);
  expect(out[0]!.t).toBe("verified");
  expect((out[0] as Verified).hash).toBe(c.sim.hash());
}

/** One client segment of `ticks`, verified by the host (its hash must equal the client's). */
async function seg(env: Env, sock: Sock, c: Client, ticks: number): Promise<void> {
  c.sim.step(ticks);
  await submit(env, sock, c, ticks);
}

/**
 * Steps the client one tick at a time until `pred` holds (checked every tick),
 * cutting and verifying a segment every `every` ticks. Returns pred().
 */
async function runUntil(
  env: Env,
  sock: Sock,
  c: Client,
  pred: () => boolean,
  maxTicks: number,
  every = 200,
): Promise<boolean> {
  let total = 0;
  while (!pred() && total < maxTicks) {
    let n = 0;
    while (n < every && !pred()) {
      c.sim.step(1);
      n++;
    }
    total += n;
    await submit(env, sock, c, n);
  }
  return pred();
}

function haleOf(sim: Sim): number {
  for (const e of sim.world.query(classic.Npc, classic.Pos)) {
    if (sim.world.read(e, classic.Npc).proto === HALE) return e;
  }
  throw new Error("no Captain Hale");
}

/** Walks the hero to Hale with classic.interact, in verified segments. */
async function walkToHale(env: Env, sock: Sock, c: Client): Promise<void> {
  c.act(classic.ACTION.interact, { target: haleOf(c.sim) });
  for (let i = 0; i < 2; i++) await seg(env, sock, c, 200);
}

const questsOfSim = (sim: Sim) => classic.questsOf(sim.world);

describe("VerifiedHost with classic quests", () => {
  it("interact, acceptQuest, kills and completeQuest verify, persist through compaction and a restart", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);

    c.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Quester" });
    c.act(classic.ACTION.setControl, { mode: "manual" });
    await seg(env, sock, c, 2);

    await walkToHale(env, sock, c);
    c.act(classic.ACTION.acceptQuest, { quest: RATS });
    await seg(env, sock, c, 20);
    expect(questsOfSim(env.host.sim!).active.map((q) => q.id)).toEqual([RATS]);

    // Auto play kills the gnawlings; the quest turns done in the dungeon.
    c.act(classic.ACTION.setControl, { mode: "auto" });
    const isDone = () => questsOfSim(c.sim).active.some((q) => q.done);
    expect(await runUntil(env, sock, c, isDone, 40_000, 400)).toBe(true);
    expect(questsOfSim(env.host.sim!)).toEqual(questsOfSim(c.sim));

    // Take over on the first tick back in town with the quest still done (auto
    // turns it in on its own within a few ticks, so this must be per tick).
    const inTownDone = () => classic.areaOf(c.sim.world).depth === 0 && isDone();
    expect(await runUntil(env, sock, c, inTownDone, 40_000, 100)).toBe(true);
    c.act(classic.ACTION.setControl, { mode: "manual" });
    await seg(env, sock, c, 2);
    await walkToHale(env, sock, c);
    expect(questsOfSim(c.sim).active.some((q) => q.done)).toBe(true);
    c.act(classic.ACTION.completeQuest, { quest: RATS });
    await seg(env, sock, c, 20);

    expect(questsOfSim(env.host.sim!)).toEqual({ active: [], completed: [RATS] });
    expect(questsOfSim(env.host.sim!)).toEqual(questsOfSim(c.sim));

    // A long gap makes the next segment compact: the new base carries the completed quest.
    env.clock.now += 120_000;
    await seg(env, sock, c, 20);
    const base = env.store.load()!.base;
    expect(base.tick).toBe(env.store.load()!.baseTick);
    const baseSim = createSim(loaded, { seed: 0, from: base });
    expect(questsOfSim(baseSim)).toEqual({ active: [], completed: [RATS] });

    // Reload: the server restores the quest state from the base and the log.
    sock.open = false;
    await env.host.handleClose(sock);
    env.restart();
    const again = env.connect();
    const v = (
      await env.send(again, {
        t: "join",
        token: "t",
        mode: "classic",
        resume: { tick: c.sim.tick, hash: c.sim.hash(), pending: false },
      })
    )[0] as VState;
    expect(v.continued).toBe(true);
    expect(v.hash).toBe(c.sim.hash());
    expect(questsOfSim(env.host.sim!)).toEqual({ active: [], completed: [RATS] });
  }, 300_000);

  it("a local save with a quest in progress imports once and keeps the quest through a restart", async () => {
    const env = setup();
    const sock = env.connect();
    await env.send(sock, { t: "join", token: "t", mode: "classic" });

    // The legacy local save: accepted quest, some progress, plain sim.
    const local = createSim(loaded, { seed: 77 });
    const act = (name: string, payload: unknown) => {
      const res = local.dispatch(name, payload, VERIFIED_ACTOR);
      expect(res.ok, `${name}: ${res.error?.code}`).toBe(true);
    };
    act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Local" });
    act(classic.ACTION.setControl, { mode: "manual" });
    local.step(2);
    const hale = haleOf(local);
    act(classic.ACTION.interact, { target: hale });
    local.step(400);
    act(classic.ACTION.acceptQuest, { quest: RATS });
    act(classic.ACTION.setControl, { mode: "auto" });
    for (let i = 0; i < 4000 && questsOfSim(local).active[0]?.progress === 0; i++) local.step(1);
    const localQuests = questsOfSim(local);
    expect(localQuests.active[0]?.progress).toBeGreaterThan(0);

    env.clock.now += 1000;
    const out = await env.send(sock, {
      t: "import",
      snapshot: await packSnapshot(local.snapshot()),
      savedAt: 1,
    });
    const v = out.find((m): m is VState => m.t === "vstate");
    expect(v?.imported).toBe(true);
    expect(questsOfSim(env.host.sim!)).toEqual(localQuests);

    // A segment after the import verifies, and the quest keeps counting.
    const client = new Client();
    await client.adopt(v!);
    expect(questsOfSim(client.sim)).toEqual(localQuests);
    await seg(env, sock, client, 200);
    expect(questsOfSim(env.host.sim!)).toEqual(questsOfSim(client.sim));

    // Restart: the imported quest state is restored from the stored base and log.
    sock.open = false;
    await env.host.handleClose(sock);
    env.restart();
    const again = env.connect();
    const back = (
      await env.send(again, {
        t: "join",
        token: "t",
        mode: "classic",
        resume: { tick: client.sim.tick, hash: client.sim.hash(), pending: false },
      })
    )[0] as VState;
    expect(back.continued).toBe(true);
    expect(questsOfSim(env.host.sim!)).toEqual(questsOfSim(client.sim));
  }, 300_000);

  it("a far acceptQuest in a client segment is refused by the host with the replay code and nothing changes", async () => {
    const env = setup();
    const sock = env.connect();
    const c = new Client();
    await c.adopt((await env.send(sock, { t: "join", token: "t", mode: "classic" }))[0] as VState);
    c.act(classic.ACTION.newHero, { classId: "classic.warrior", name: "Cheat" });
    c.act(classic.ACTION.setControl, { mode: "manual" });
    await seg(env, sock, c, 2);
    const before = c.sim.hash();

    // The client never records a rejected dispatch, so forge the input the way a tampered client would.
    c.sim.step(20);
    const cheat = c.cut();
    cheat.inputs = [
      { tick: cheat.fromTick, name: classic.ACTION.acceptQuest, payload: { quest: RATS } },
    ];
    env.clock.now += 1000;
    const r = (await env.send(sock, cheat))[0] as Resync;
    expect(r.t).toBe("resync");
    expect(r.code).toBe("input_rejected");
    expect(r.hash).toBe(before);
    expect(questsOfSim(env.host.sim!)).toEqual({ active: [], completed: [] });
  });

  it("the quest actions are client-dispatchable, not server-only", () => {
    const serverOnly: readonly string[] = policy.serverOnlyActions;
    expect(serverOnly).not.toContain(classic.ACTION.acceptQuest);
    expect(serverOnly).not.toContain(classic.ACTION.completeQuest);
    expect(serverOnly).not.toContain(classic.ACTION.interact);
    expect(serverOnly).toContain(classic.ACTION.offlineProgress);
  });
});

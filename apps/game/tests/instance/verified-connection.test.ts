/**
 * VerifiedClient (apps/game/src/client/instance/verified.ts) against a real
 * VerifiedHost over a loopback "network" of fake sockets, with an inline
 * client-driven fixed-tick mode.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  SegmentRecorder,
  type Sim,
} from "@gamez/kernel";
import { packSnapshot, VERIFIED_ACTOR, type VerifiedClientMessage } from "@gamez/protocol";
import type {
  VerifiedAck,
  VerifiedHandlers,
  VerifiedResync,
  VerifiedState,
  VerifiedStatus,
} from "@gamez/ui-host";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { SocketLike } from "../../src/client/instance/connection.ts";
import { CLOSE_REPLACED, CLOSE_UNAUTHORIZED } from "../../src/client/instance/messages.ts";
import { parseVerifiedServerMessage, VerifiedClient } from "../../src/client/instance/verified.ts";
import { telemetryContext } from "../../src/client/telemetry/index.ts";
import type { InstanceSocket, SocketInfo } from "../../src/server/instance/host.ts";
import { VerifiedHost } from "../../src/server/instance/verified-host.ts";
import { SqlVerifiedStore } from "../../src/server/instance/verified-store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const core = defineModule({
  id: "tvl.core",
  version: "1.0.0",
  setup(world) {
    world.setResource("tvl.n", 0);
  },
  systems: [
    {
      id: "tvl.tick",
      stage: "update",
      run(world, ctx) {
        world.setResource("tvl.n", world.getResource<number>("tvl.n")! + ctx.rng.int(1, 3));
      },
    },
  ],
  actions: [
    {
      name: "tvl.add",
      parse: (_w, p) => (p as { by: number }).by,
      apply(world, by: number) {
        world.setResource("tvl.n", world.getResource<number>("tvl.n")! + by);
      },
    },
  ],
});

const loaded = loadMode(
  defineMode({
    id: "tvl",
    name: "Loop",
    description: "verified loopback",
    world: null,
    modules: ["tvl.*"],
    tick: { kind: "fixed", hz: 20 },
    instance: {
      maxPlayers: 1,
      clientDriven: {
        maxTicksPerSegment: 400,
        maxInputsPerSegment: 32,
        speedOf: () => 1,
        maxSpeed: 1,
        serverOnlyActions: [],
      },
    },
  }),
  [core],
);

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

class Net {
  readonly db = fakeSqlStore();
  readonly store = new SqlVerifiedStore(this.db);
  readonly clock = { now: 10_000_000 };
  readonly sockets: Loop[] = [];
  readonly host: VerifiedHost;

  constructor() {
    this.host = new VerifiedHost({
      name: "tvl:me",
      loaded,
      policy: loaded.mode.instance!.clientDriven!,
      store: this.store,
      sockets: () => this.sockets.filter((s) => s.readyState === 1).map((s) => s.server),
      now: () => this.clock.now,
      randomSeed: () => 7,
      outbox: null,
      scheduleFlush: () => {},
      log: () => {},
    });
  }

  connect = (url: string): SocketLike => {
    const s = new Loop(this, url);
    this.sockets.push(s);
    return s;
  };

  get last(): Loop {
    return this.sockets.at(-1)!;
  }

  /** Delivers frames both ways until nothing moves (host and client work is async). */
  async flush(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      let moved = false;
      for (const s of this.sockets) moved = (await s.deliver()) || moved;
      await tick();
      if (!moved) return;
    }
  }
}

class Loop implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  toServer: string[] = [];
  toClient: string[] = [];
  sent: VerifiedClientMessage[] = [];
  info: SocketInfo = { accountId: "me", name: "Me", mode: "tvl", joined: false };
  readonly server: InstanceSocket;
  /** When false, client frames are lost. */
  up = true;

  constructor(
    readonly net: Net,
    readonly url: string,
  ) {
    this.server = new LoopServer(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as VerifiedClientMessage);
    if (this.up) this.toServer.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    void this.net.host.handleClose(this.server);
  }

  /** The server (or the network) closes the socket. */
  serverClose(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  async deliver(): Promise<boolean> {
    let moved = false;
    while (this.toServer.length > 0 && this.readyState === 1) {
      await this.net.host.handleMessage(this.server, this.toServer.shift()!);
      moved = true;
    }
    while (this.toClient.length > 0 && this.readyState === 1) {
      this.onmessage?.({ data: this.toClient.shift()! });
      moved = true;
    }
    return moved;
  }
}

/** The server end of a Loop (what the host sees). */
class LoopServer implements InstanceSocket {
  constructor(readonly loop: Loop) {}
  get info(): SocketInfo {
    return this.loop.info;
  }
  setInfo(info: SocketInfo): void {
    this.loop.info = info;
  }
  send(frame: string): void {
    this.loop.toClient.push(frame);
  }
  close(code: number): void {
    this.loop.serverClose(code);
  }
}

/** A minimal client-side game: adopts states, records, cuts and submits. */
class Game implements VerifiedHandlers {
  sim: Sim | null = null;
  rec: SegmentRecorder | null = null;
  epoch = 0;
  seq = 0;
  verifiedTick = 0;
  verifiedHash = "";
  pending = 0;
  states: VerifiedState[] = [];
  acks: VerifiedAck[] = [];
  resyncs: VerifiedResync[] = [];
  statuses: VerifiedStatus[] = [];
  errors: string[] = [];
  resumes = 0;
  /** What resume() answers (null: adopt the server). */
  resumeWith: { tick: number; hash: string; pending: boolean } | null = null;

  resume() {
    this.resumes++;
    return this.resumeWith;
  }
  state(s: VerifiedState): void {
    this.states.push(s);
    this.epoch = s.epoch;
    this.verifiedTick = s.tick;
    this.verifiedHash = s.hash;
    if (s.snapshot) this.sim = createSim(loaded, { seed: 0, from: s.snapshot });
    this.rec = new SegmentRecorder(this.sim!.tick);
  }
  verified(a: VerifiedAck): void {
    this.acks.push(a);
    this.verifiedTick = a.tick;
    this.verifiedHash = a.hash;
  }
  resync(r: VerifiedResync): void {
    this.resyncs.push(r);
    this.epoch = r.epoch;
    this.sim = createSim(loaded, { seed: 0, from: r.snapshot });
    this.rec = new SegmentRecorder(this.sim.tick);
  }
  status(s: VerifiedStatus): void {
    this.statuses.push(s);
  }
  error(code: string): void {
    this.errors.push(code);
  }

  segment(ticks: number, hash?: string) {
    this.sim!.dispatch("tvl.add", { by: 2 }, VERIFIED_ACTOR);
    this.rec!.record(this.sim!.tick, "tvl.add", { by: 2 });
    this.sim!.step(ticks);
    const seg = this.rec!.cut(this.sim!)!;
    return { ...seg, hash: hash ?? seg.hash, epoch: this.epoch, seq: ++this.seq };
  }
}

const opened: VerifiedClient[] = [];
afterEach(() => {
  for (const c of opened.splice(0)) c.close();
});

async function connected(opts: { resumeWith?: Game["resumeWith"] } = {}) {
  const net = new Net();
  const game = new Game();
  game.resumeWith = opts.resumeWith ?? null;
  const unauthorized: number[] = [];
  const client = new VerifiedClient({
    mode: "tvl",
    session: () => ({ token: "tok", accountId: "me", name: "Me" }),
    url: (token, mode) => `ws://test/ws/instance?token=${token}&mode=${mode}`,
    createSocket: net.connect,
    now: () => net.clock.now,
    random: () => 0,
    onUnauthorized: () => unauthorized.push(1),
  });
  opened.push(client);
  client.start(game);
  await tick();
  await net.flush();
  return { net, game, client, unauthorized };
}

describe("VerifiedClient", () => {
  it("joins, adopts the state, submits segments and gets acks", async () => {
    const { net, game, client } = await connected();
    expect(net.last.url).toBe("ws://test/ws/instance?token=tok&mode=tvl");
    expect(net.last.sent[0]).toEqual({ t: "join", token: "tok", mode: "tvl" });
    expect(game.resumes).toBe(1);
    expect(game.states).toHaveLength(1);
    expect(game.states[0]!.snapshot?.tick).toBe(0);
    expect(game.statuses).toEqual(["connecting", "online"]);
    expect(client.status).toBe("online");
    // Telemetry events carry the server's contentHash (admin-dashboard.md §11.5).
    expect(telemetryContext()).toMatchObject({ mode: "tvl", contentHash: loaded.contentHash });

    net.clock.now += 5000;
    expect(client.submit(game.segment(20))).toBe(true);
    expect(client.submit(game.segment(20))).toBe(true);
    await net.flush();
    expect(game.acks.map((a) => a.tick)).toEqual([20, 40]);
    expect(game.verifiedHash).toBe(game.sim!.hash());
  });

  it("submit is false until online", () => {
    const net = new Net();
    const client = new VerifiedClient({
      mode: "tvl",
      session: () => ({ token: "t", accountId: "me", name: "Me" }),
      createSocket: net.connect,
      url: () => "ws://x",
    });
    opened.push(client);
    const seg = { fromTick: 0, toTick: 1, inputs: [], hash: "h", epoch: 1, seq: 1 };
    expect(client.submit(seg)).toBe(false);
    client.start(new Game());
    expect(client.submit(seg)).toBe(false);
  });

  it("delivers resyncs with the unpacked snapshot", async () => {
    const { net, game, client } = await connected();
    net.clock.now += 5000;
    client.submit(game.segment(20, "bad"));
    await net.flush();
    expect(game.resyncs).toHaveLength(1);
    expect(game.resyncs[0]!.code).toBe("hash_mismatch");
    expect(game.resyncs[0]!.snapshot.tick).toBe(0);
    // Continues verified in the new epoch.
    client.submit(game.segment(20));
    await net.flush();
    expect(game.acks.at(-1)?.epoch).toBe(game.resyncs[0]!.epoch);
  });

  it("reconnects after a drop and resumes from handlers.resume()", async () => {
    const { net, game, client } = await connected();
    net.clock.now += 5000;
    client.submit(game.segment(20));
    await net.flush();
    game.resumeWith = { tick: game.verifiedTick, hash: game.verifiedHash, pending: false };
    net.last.serverClose(1006);
    expect(client.status).toBe("offline");
    expect(client.submit(game.segment(5))).toBe(false);
    await tick();
    await tick();
    await net.flush();
    expect(net.sockets).toHaveLength(2);
    expect(net.last.sent[0]).toEqual({
      t: "join",
      token: "tok",
      mode: "tvl",
      resume: { tick: 20, hash: game.verifiedHash, pending: false },
    });
    expect(game.resumes).toBe(2);
    expect(game.states.at(-1)?.continued).toBe(true);
    expect(game.statuses).toEqual(["connecting", "online", "offline", "connecting", "online"]);
  });

  it("stops on CLOSE_REPLACED and reports it", async () => {
    const { net, game, client } = await connected();
    net.last.serverClose(CLOSE_REPLACED);
    await tick();
    await tick();
    expect(client.status).toBe("closed");
    expect(game.errors).toContain("replaced");
    expect(net.sockets).toHaveLength(1);
  });

  it("calls onUnauthorized on 4401 and reconnects", async () => {
    const { net, client, unauthorized } = await connected();
    net.last.serverClose(CLOSE_UNAUTHORIZED);
    expect(unauthorized).toEqual([1]);
    await tick();
    await tick();
    await net.flush();
    expect(net.sockets).toHaveLength(2);
    expect(client.status).toBe("online");
  });

  it("restart() joins fresh", async () => {
    const { net, game, client } = await connected();
    net.clock.now += 5000;
    client.submit(game.segment(40));
    await net.flush();
    client.restart();
    await net.flush();
    expect(net.last.sent.at(-1)).toMatchObject({ t: "join", fresh: true });
    expect(game.states.at(-1)?.tick).toBe(0);
    expect(game.states.at(-1)?.instanceId).toBe("tvl:me:00000007");
  });

  it("importSave packs and sends the save; the answer is a new state", async () => {
    const { net, game, client } = await connected();
    const local = createSim(loaded, { seed: 3 });
    local.step(30);
    client.importSave(local.snapshot(), 123);
    await tick();
    await net.flush();
    const sent = net.last.sent.find((m) => m.t === "import");
    expect(sent).toMatchObject({ t: "import", savedAt: 123, snapshot: { enc: "json" } });
    expect(game.states.at(-1)).toMatchObject({ imported: true, importable: false, tick: 30 });
    expect(game.sim!.hash()).toBe(local.hash());
  });

  it("importSave sends plain JSON and refuses a save over the import limits (R8)", async () => {
    const { net, game, client } = await connected();
    const local = createSim(loaded, { seed: 3 });
    local.step(30);
    const big = local.snapshot();
    (big.world.resources as Record<string, unknown>)["zz.junk"] = Array.from(
      { length: 60_000 },
      () => 0,
    );
    const before = net.last.sent.length;
    client.importSave(big, 123);
    await tick();
    await net.flush();
    expect(net.last.sent.length).toBe(before);
    expect(game.errors).toContain("import_failed");
  });

  it("estimates the server clock from pongs", async () => {
    const { net, client } = await connected();
    // Server and client share the fake clock: offset 0.
    expect(client.serverNow()).toBe(net.clock.now);
  });

  it("keeps frame order across async unpacking", async () => {
    const { net, game } = await connected();
    const snap = createSim(loaded, { seed: 1 }).snapshot();
    const packed = await packSnapshot(snap, { forceGzip: true });
    net.last.toClient.push(
      JSON.stringify({
        t: "resync",
        epoch: 9,
        seq: 1,
        code: "gap",
        message: "",
        tick: 0,
        hash: "h",
        snapshot: packed,
      }),
      JSON.stringify({ t: "verified", epoch: 9, seq: 2, tick: 5, hash: "x", creditMs: 0 }),
    );
    await net.flush();
    // Gzip unpacking is async and can outlast one macrotask under load, so wait
    // (bounded) for the resync and its ack instead of a single tick.
    for (let i = 0; i < 1000 && !(game.resyncs.length === 1 && game.acks.at(-1)?.seq === 2); i++) {
      await tick();
    }
    expect(game.resyncs).toHaveLength(1);
    expect(game.acks.at(-1)?.seq).toBe(2);
    expect(game.resyncs[0]!.epoch).toBe(9);
  });

  it("close() stops everything", async () => {
    const { net, client } = await connected();
    client.close();
    expect(client.status).toBe("closed");
    expect(net.last.readyState).toBe(3);
    expect(client.submit({ fromTick: 0, toTick: 1, inputs: [], hash: "h", epoch: 1, seq: 1 })).toBe(
      false,
    );
  });
});

describe("parseVerifiedServerMessage", () => {
  it("accepts server messages and rejects junk", () => {
    expect(
      parseVerifiedServerMessage(JSON.stringify({ t: "pong", clientTime: 1, serverTime: 2 })),
    ).not.toBeNull();
    for (const bad of [
      "nope",
      JSON.stringify({ t: "vstate" }),
      JSON.stringify({ t: "resync", epoch: 1, seq: 1, code: "x", tick: 1, hash: "h" }),
      JSON.stringify({ t: "verified", epoch: "1" }),
      JSON.stringify({ t: "error", code: 1 }),
      JSON.stringify([1]),
    ]) {
      expect(parseVerifiedServerMessage(bad)).toBeNull();
    }
    expect(parseVerifiedServerMessage(new ArrayBuffer(2))).toBeNull();
  });
});

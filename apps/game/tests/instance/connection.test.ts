import type { InstanceClientMessage } from "@gamez/protocol";
import type { InstanceView } from "@gamez/ui-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { InstanceClient, PING_MS, type SocketLike } from "../../src/client/instance/connection.ts";
import { CLOSE_REPLACED, CLOSE_UNAUTHORIZED } from "../../src/client/instance/messages.ts";
import {
  InstanceHost,
  type InstanceSocket,
  type InstanceStore,
  type SocketInfo,
  type StoredInstance,
} from "../../src/server/instance/host.ts";
import { counterLoaded, type Counter } from "./fixtures.ts";

/**
 * Loopback "network": client sockets talk to a real InstanceHost. Frames are
 * queued in both directions and delivered by flush(), like a real network.
 */
class Net {
  store: InstanceStore & { instance: StoredInstance | null; seqs: Map<string, number> } = {
    instance: null,
    seqs: new Map(),
    load() {
      return this.instance ? structuredClone(this.instance) : null;
    },
    players() {
      return new Map(this.seqs);
    },
    save(instance, player) {
      this.instance = structuredClone(instance);
      if (player) this.seqs.set(player.accountId, player.lastSeq);
    },
  };
  sockets: Loop[] = [];
  host = new InstanceHost({
    name: "tcount:me",
    loaded: counterLoaded,
    store: this.store,
    sockets: () => this.sockets.filter((s) => s.readyState === 1).map((s) => s.server),
    now: () => Date.now(),
    randomSeed: () => 3,
    setAlarm: () => {},
  });
  /** When false, client frames are dropped (the server never sees them). */
  up = true;

  connect = (url: string): SocketLike => {
    const s = new Loop(this, url);
    this.sockets.push(s);
    return s;
  };

  get last(): Loop {
    return this.sockets.at(-1)!;
  }

  flush(): void {
    for (let i = 0; i < 20; i++) {
      let moved = false;
      for (const s of this.sockets) moved = s.deliver() || moved;
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
  sent: InstanceClientMessage[] = [];
  closedWith: number | null = null;
  info: SocketInfo = { accountId: "me", name: "Me", mode: "tcount", joined: false };
  readonly server: InstanceSocket;

  constructor(
    readonly net: Net,
    readonly url: string,
  ) {
    const info = () => this.info;
    this.server = {
      get info() {
        return info();
      },
      setInfo: (next) => (this.info = next),
      send: (frame) => this.toClient.push(frame),
      close: (code) => this.drop(code),
    };
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as InstanceClientMessage);
    if (this.net.up) this.toServer.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Server-side close (or network failure). */
  drop(code = 1006): void {
    this.readyState = 3;
    this.closedWith = code;
    this.onclose?.({ code });
  }

  deliver(): boolean {
    const up = this.toServer.splice(0);
    const down = this.toClient.splice(0);
    for (const f of up) this.net.host.handleMessage(this.server, f);
    for (const f of down) this.onmessage?.({ data: f });
    return up.length + down.length > 0;
  }
}

const value = (view: InstanceView) =>
  (view.snapshot!.world.resources["tcount.counter"] as Counter).value;

describe("InstanceClient", () => {
  let net: Net;
  let unauthorized: number;
  let client: InstanceClient;

  const start = async () => {
    client = new InstanceClient({
      mode: "tcount",
      loaded: counterLoaded,
      session: async () => ({ token: "tok", accountId: "me", name: "Me" }),
      onUnauthorized: () => unauthorized++,
      url: (token, mode) => `ws://test/ws/instance?token=${token}&mode=${mode}`,
      createSocket: net.connect,
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    net.last.open();
    net.flush();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    net = new Net();
    unauthorized = 0;
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  it("connects, joins and exposes the server state", async () => {
    const views: InstanceView[] = [];
    await start();
    client.subscribe((v) => views.push(v));
    expect(net.last.url).toBe("ws://test/ws/instance?token=tok&mode=tcount");
    expect(net.last.sent.map((m) => m.t)).toEqual(["join", "ping"]);
    const view = client.getView();
    expect(view.status).toBe("online");
    expect(view.snapshot?.contentHash).toBe(counterLoaded.contentHash);
    expect(view.world?.getResource<Counter>("tcount.counter")).toEqual(
      view.snapshot?.world.resources["tcount.counter"],
    );
    expect(view.pingMs).not.toBeNull();
  });

  it("predicts actions instantly and resolves with the server result", async () => {
    await start();
    const before = value(client.getView());
    const p = client.act("tcount.add", { by: 4 });
    // Predicted before any server round trip.
    expect(value(client.getView())).toBe(before + 4);
    expect(net.last.sent.at(-1)).toEqual({
      t: "action",
      seq: 1,
      name: "tcount.add",
      payload: { by: 4 },
    });
    net.flush();
    const res = await p;
    expect(res).toMatchObject({ ok: true, tick: 1 });
    expect(res.events).toEqual([{ type: "tcount.added", value: before + 4, actor: "me" }]);
    expect(client.getView().snapshot).toEqual(net.host.sim?.snapshot());
    expect(client.getView().events).toEqual(res.events);
  });

  it("shows rejections from the server", async () => {
    await start();
    const res = client.act("tcount.add", { by: 1000 });
    net.flush();
    expect((await res).error?.code).toBe("too_big");
    expect(client.getView().error?.code).toBe("too_big");
  });

  it("reconnects with backoff, re-joins and re-sends unanswered actions", async () => {
    await start();
    const before = value(client.getView());
    net.up = false;
    const p1 = client.act("tcount.add", { by: 1 });
    const p2 = client.act("tcount.add", { by: 2 });
    net.last.drop();
    expect(client.getView().status).toBe("offline");
    // Predictions survive the disconnect.
    expect(value(client.getView())).toBe(before + 3);
    net.up = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(net.sockets).toHaveLength(2);
    expect(client.getView().status).toBe("connecting");
    net.last.open();
    net.flush();
    expect(
      net.last.sent.filter((m) => m.t === "action").map((m) => m.t === "action" && m.seq),
    ).toEqual([1, 2]);
    expect((await p1).ok).toBe(true);
    expect((await p2).ok).toBe(true);
    expect(client.getView().status).toBe("online");
    expect(value(client.getView())).toBe(before + 3);
  });

  it("does not re-apply actions the server already handled", async () => {
    await start();
    const before = value(client.getView());
    const p = client.act("tcount.add", { by: 5 });
    // The server handles it, but the socket dies before the result arrives.
    net.last.deliver();
    net.last.toClient = [];
    net.last.drop();
    await vi.advanceTimersByTimeAsync(1);
    net.last.open();
    net.flush();
    expect(net.last.sent.some((m) => m.t === "action")).toBe(false);
    expect((await p).ok).toBe(true);
    expect(value(client.getView())).toBe(before + 5);
    // New actions continue after the server's lastSeq.
    void client.act("tcount.roll", null);
    expect(net.last.sent.at(-1)).toMatchObject({ t: "action", seq: 2 });
  });

  it("restart() joins fresh and drops pending actions", async () => {
    await start();
    const first = client.getView().snapshot;
    void client.act("tcount.add", { by: 1 });
    net.flush();
    const pending = client.act("tcount.add", { by: 1 });
    client.restart();
    expect(net.last.sent.at(-1)).toEqual({ t: "join", token: "tok", mode: "tcount", fresh: true });
    expect((await pending).error?.code).toBe("restarted");
    net.flush();
    expect(client.getView().snapshot?.tick).toBe(0);
    expect(client.getView().snapshot).toEqual(first);
  });

  it("pings every PING_MS", async () => {
    await start();
    const pings = () => net.last.sent.filter((m) => m.t === "ping").length;
    expect(pings()).toBe(1);
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(pings()).toBe(2);
  });

  it("stops reconnecting when another connection replaced it", async () => {
    await start();
    net.last.drop(CLOSE_REPLACED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.sockets).toHaveLength(1);
    expect(client.getView()).toMatchObject({ status: "offline", error: { code: "replaced" } });
  });

  it("reports an invalid token and reconnects", async () => {
    await start();
    net.last.drop(CLOSE_UNAUTHORIZED);
    expect(unauthorized).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(net.sockets).toHaveLength(2);
  });

  it("close() stops everything and rejects later actions", async () => {
    await start();
    client.close();
    expect(client.getView().status).toBe("offline");
    expect((await client.act("tcount.roll", null)).error?.code).toBe("closed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.sockets).toHaveLength(1);
  });
});

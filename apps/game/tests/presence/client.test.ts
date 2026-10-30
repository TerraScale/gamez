import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EntityState, ServerMessage } from "@gamez/protocol";
import { PresenceClient, presenceUrl } from "../../src/client/presence/connection.ts";
import { presenceConnector } from "../../src/client/presence/index.ts";
import { codec } from "../../src/shared/codec.ts";

/** A WebSocket stand-in the test drives by hand (open, receive, drop). */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  binaryType = "";
  readonly sent: Array<string | Uint8Array> = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | Uint8Array }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = FakeSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** Delivers a server message in the wire codec, as the RelayDO sends it to an announcing client. */
  receive(msg: ServerMessage): void {
    this.onmessage?.({ data: codec.encodeServer(msg) as Uint8Array });
  }

  drop(code: number): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  /** Decoded client messages sent so far, filtered by tag. */
  sentOf(t: string): unknown[] {
    return this.sent.map((s) => codec.decodeClient(s) as { t: string }).filter((m) => m.t === t);
  }
}

function entity(id: string, over: Partial<EntityState> = {}): EntityState {
  return {
    id,
    kind: "player",
    name: id,
    appearance: "unit.hero",
    pos: { x: 10, y: 10 },
    path: [],
    pathStartedAt: 0,
    speed: 4,
    ...over,
  };
}

function welcome(selfId: string, entities: EntityState[], seq = 1): ServerMessage {
  return {
    t: "welcome",
    selfId,
    chunkId: "classic-town:0:0",
    seq,
    serverTime: Date.now(),
    entities,
  };
}

function delta(seq: number, upserts: EntityState[] = [], removes: string[] = []): ServerMessage {
  return { t: "delta", chunkId: "classic-town:0:0", seq, upserts, removes };
}

/** Lets the connection's async url() resolve and the socket get created. */
async function socketCount(n: number): Promise<void> {
  await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(n));
}

describe("presenceUrl", () => {
  it("builds ws and wss URLs with the token and world", () => {
    expect(presenceUrl("game.example", false, "a b+c", "classic-town")).toBe(
      "ws://game.example/ws?token=a%20b%2Bc&world=classic-town&codec=binary",
    );
    expect(presenceUrl("game.example", true, "t", "plaza")).toBe(
      "wss://game.example/ws?token=t&world=plaza&codec=binary",
    );
  });
});

describe("PresenceClient", () => {
  let client: PresenceClient | null = null;

  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  afterEach(() => {
    client?.close();
    client = null;
    vi.unstubAllGlobals();
  });

  function connect(token = "tok-A"): PresenceClient {
    client = new PresenceClient("classic-town", async () =>
      presenceUrl("game.example", false, token, "classic-town"),
    );
    return client;
  }

  it("starts connecting to its world with no others", async () => {
    const c = connect();
    expect(c.world).toBe("classic-town");
    expect(c.getView()).toEqual({ status: "connecting", selfId: null, others: [] });
    await socketCount(1);
    expect(FakeSocket.instances[0]!.url).toBe(
      "ws://game.example/ws?token=tok-A&world=classic-town&codec=binary",
    );
  });

  it("goes online on welcome and lists everyone but self", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.receive(welcome("me", [entity("me"), entity("other")]));
    expect(c.getView().status).toBe("online");
    expect(c.getView().selfId).toBe("me");
    expect(c.getView().others.map((e) => e.id)).toEqual(["other"]);
  });

  it("notifies on roster changes but not on self-only deltas", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.receive(welcome("me", [entity("me")]));
    const seen: string[][] = [];
    c.subscribe((v) => seen.push(v.others.map((e) => e.id)));

    ws.receive(delta(2, [entity("me", { pos: { x: 11, y: 10 } })]));
    expect(seen).toEqual([]);

    ws.receive(delta(3, [entity("bob")]));
    expect(seen).toEqual([["bob"]]);

    ws.receive(delta(4, [], ["bob"]));
    expect(seen).toEqual([["bob"], []]);
    expect(c.getView().others).toEqual([]);
  });

  it("applies changed poses of others in place", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.receive(welcome("me", [entity("me"), entity("ann")]));
    ws.receive(delta(2, [entity("ann", { tag: "Lv 3 Mage", path: [{ x: 11, y: 10 }] })]));
    const ann = c.getView().others[0];
    expect(ann?.tag).toBe("Lv 3 Mage");
    expect(ann?.path).toEqual([{ x: 11, y: 10 }]);
  });

  it("holds a pose reported while connecting and sends it with the welcome", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    c.setPose({ pos: { x: 1, y: 1 }, path: [], speed: 4 });
    c.setPose({ pos: { x: 5, y: 6 }, path: [], speed: 4, tag: "Lv 2 Mage" });
    expect(ws.sentOf("pose")).toEqual([]);
    ws.open();
    expect(ws.sentOf("pose")).toEqual([]);
    // The join pose of a hero that never moves again: the latest one goes out on welcome.
    ws.receive(welcome("me", []));
    expect(ws.sentOf("pose")).toEqual([
      { t: "pose", pos: { x: 5, y: 6 }, path: [], speed: 4, tag: "Lv 2 Mage" },
    ]);
  });

  it("resends the last pose after a reconnect", async () => {
    const c = connect();
    await socketCount(1);
    const first = FakeSocket.instances[0]!;
    first.open();
    first.receive(welcome("me", []));
    c.setPose({ pos: { x: 4, y: 4 }, path: [], speed: 4, tag: "Lv 1 Warrior" });
    expect(first.sentOf("pose")).toHaveLength(1);
    first.drop(1006);
    await socketCount(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    second.receive(welcome("me", []));
    expect(second.sentOf("pose")).toEqual([
      { t: "pose", pos: { x: 4, y: 4 }, path: [], speed: 4, tag: "Lv 1 Warrior" },
    ]);
  });

  it("sends poses while online", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.receive(welcome("me", []));
    c.setPose({
      pos: { x: 2, y: 3 },
      path: [{ x: 3, y: 3 }],
      speed: 4,
      tag: "Lv 1 Rogue",
    });
    expect(ws.sentOf("pose")).toEqual([
      { t: "pose", pos: { x: 2, y: 3 }, path: [{ x: 3, y: 3 }], speed: 4, tag: "Lv 1 Rogue" },
    ]);
  });

  it("resyncs with a fresh socket after a missed delta", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.receive(welcome("me", [entity("me")], 5));
    ws.receive(delta(9, [entity("bob")]));
    await socketCount(2);
    expect(FakeSocket.instances[0]!.closeCalls).toBeGreaterThan(0);
    expect(c.getView().others).toEqual([]);
  });

  it("reports offline on drop and reconnects", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.receive(welcome("me", [entity("me"), entity("bob")]));
    ws.drop(1006);
    expect(c.getView().status).toBe("offline");
    await socketCount(2);
  });

  it("stops for good on unauthorized and does not reconnect", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.receive(welcome("me", []));
    ws.drop(4401);
    expect(c.getView().status).toBe("offline");
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeSocket.instances.length).toBe(1);
  });

  it("close() ends the socket, silences listeners and drops poses", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.receive(welcome("me", []));
    const seen: unknown[] = [];
    const unsubscribe = c.subscribe((v) => seen.push(v));
    c.close();
    expect(ws.closeCalls).toBeGreaterThan(0);
    expect(c.getView().status).toBe("offline");
    const after = seen.length;
    c.setPose({ pos: { x: 1, y: 1 }, path: [], speed: 4 });
    expect(ws.sentOf("pose")).toEqual([]);
    ws.receive(delta(2, [entity("bob")]));
    expect(seen.length).toBe(after);
    unsubscribe();
    client = null;
  });

  it("serverNow() follows the server clock estimate", async () => {
    const c = connect();
    await socketCount(1);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    const before = Date.now();
    ws.receive(welcome("me", [], 1));
    const now = c.serverNow();
    expect(Math.abs(now - before)).toBeLessThan(1000);
  });
});

describe("presenceConnector", () => {
  it("returns a factory that builds a presence connection per world", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { host: "game.example", protocol: "https:" });
    FakeSocket.instances = [];
    try {
      const connect = presenceConnector(() => ({
        token: "tok-B",
        accountId: "acc",
        name: "Bo",
      }));
      expect(connect).toBeDefined();
      const conn = connect!("classic-town");
      expect(conn.world).toBe("classic-town");
      conn.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

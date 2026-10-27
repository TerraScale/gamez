import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { backoffDelay, Connection } from "../../src/client/net.ts";
import { ClockSync } from "../../src/client/clock.ts";

describe("backoffDelay", () => {
  it("grows exponentially up to the cap", () => {
    const top = () => 1;
    expect(backoffDelay(0, 500, 10_000, top)).toBe(500);
    expect(backoffDelay(1, 500, 10_000, top)).toBe(1000);
    expect(backoffDelay(3, 500, 10_000, top)).toBe(4000);
    expect(backoffDelay(10, 500, 10_000, top)).toBe(10_000);
  });

  it("applies full jitter", () => {
    expect(backoffDelay(3, 500, 10_000, () => 0)).toBe(0);
    expect(backoffDelay(3, 500, 10_000, () => 0.5)).toBe(2000);
  });
});

/** Minimal stand-in for the browser WebSocket: the test drives open, message and close by hand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** The server (or network) closes the socket with `code`. */
  shut(code: number): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Connection", () => {
  const realWebSocket = globalThis.WebSocket;
  let conn: Connection | null = null;
  let logins = 0;
  let unauthorized = 0;
  const statuses: string[] = [];

  function connect(): Connection {
    const c = new Connection({
      url: async () => {
        logins++;
        return "ws://test/ws";
      },
      clock: new ClockSync(),
      onMessage: () => {},
      onStatus: (s) => statuses.push(s),
      onUnauthorized: () => unauthorized++,
    });
    conn = c;
    c.start();
    return c;
  }

  beforeEach(() => {
    FakeSocket.instances = [];
    logins = 0;
    unauthorized = 0;
    statuses.length = 0;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
  });

  afterEach(() => {
    conn?.stop();
    conn = null;
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  it("drops the token and asks for a new login on close 4401", async () => {
    connect();
    await flush();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.shut(4401);
    expect(unauthorized).toBe(1);
    expect(logins).toBe(1);
  });

  it("only reconnects, without logging in again, on an ordinary close", async () => {
    connect();
    await flush();
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.shut(1006);
    expect(unauthorized).toBe(0);
    expect(statuses.at(-1)).toBe("offline");
  });

  it("resync() replaces the socket once, with no extra reconnect", async () => {
    connect();
    await flush();
    FakeSocket.instances[0]!.open();
    conn!.resync();
    await flush();
    expect(FakeSocket.instances.length).toBe(2);
    expect(FakeSocket.instances[0]!.readyState).toBe(FakeSocket.CLOSED);
    expect(FakeSocket.instances[1]!.readyState).toBe(FakeSocket.CONNECTING);
  });
});

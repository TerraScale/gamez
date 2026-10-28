/**
 * R9 (ADR 0007): block messages are rate limited per socket and each blocker
 * keeps at most BLOCK_LIMIT rows in the channel's SQLite. Refusals never reach
 * AccountDO and never echo the full block list.
 */
import type { ChatServerMessage } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { ChatHost, type ChatSocket, type ChatSocketInfo } from "../../src/server/chat/host.ts";
import { StubModerator } from "../../src/server/chat/moderation.ts";
import { ChatStore } from "../../src/server/chat/store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const START = 1_700_000_000_000;
const LIMIT = 200;

class FakeSocket implements ChatSocket {
  readonly frames: ChatServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(readonly info: ChatSocketInfo) {}
  send(frame: string): void {
    this.frames.push(JSON.parse(frame) as ChatServerMessage);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

function setup() {
  const store = new ChatStore(fakeSqlStore(), "global");
  store.init();
  let clock = START;
  const socket = new FakeSocket({
    accountId: "blocker",
    name: "Blocker",
    kind: "registered",
    tag: null,
  });
  const remote: { target: string; blocked: boolean }[] = [];
  const host = new ChatHost({
    channel: "global",
    store,
    sockets: () => [socket],
    now: () => clock,
    moderator: new StubModerator(),
    outbox: { append() {}, scheduleFlush() {} },
    remoteBlocks: async () => [],
    remoteSetBlocked: async (_a, target, blocked) => {
      remote.push({ target, blocked });
    },
    waitUntil: () => {},
    log: () => {},
  });
  return {
    host,
    store,
    socket,
    remote,
    advance: (ms: number) => {
      clock += ms;
    },
    block: (target: string, blocked = true) =>
      void host.handleMessage(socket, JSON.stringify({ t: "block", accountId: target, blocked })),
  };
}

const errors = (s: FakeSocket) =>
  s.frames.filter((f): f is Extract<ChatServerMessage, { t: "error" }> => f.t === "error");

describe("block messages: rate limit (R9)", () => {
  it("rate limits a burst of block messages after the burst", () => {
    const h = setup();
    for (let i = 0; i < 50; i++) h.block(`target-${i}`);
    // BLOCK_RATE: burst 10, no time passes, so only the burst is accepted.
    expect(h.remote).toHaveLength(10);
    expect(h.store.blockList("blocker")).toHaveLength(10);
    const refused = errors(h.socket);
    expect(refused).toHaveLength(40);
    expect(refused.every((e) => e.code === "rate_limited")).toBe(true);
    // A refused message answers only the error, never the block list.
    expect(h.socket.frames.filter((f) => f.t === "blocked")).toHaveLength(10);
  });
});

describe("block messages: per-blocker cap (R9)", () => {
  it("stops at BLOCK_LIMIT rows with block_limit and makes no AccountDO call for refused blocks", () => {
    const h = setup();
    for (let i = 0; i < LIMIT + 1; i++) {
      h.advance(2_000); // one token refills per 2 s
      h.block(`target-${i}`);
    }
    expect(h.store.blockList("blocker")).toHaveLength(LIMIT);
    expect(h.remote).toHaveLength(LIMIT);
    const refused = errors(h.socket);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.code).toBe("block_limit");
    // The refusal does not echo the list.
    const last = h.socket.frames.at(-1)!;
    expect(last.t).toBe("error");
    expect(last).not.toHaveProperty("blocked");
  });

  it("re-blocking an existing target at the limit is accepted without a new row", () => {
    const h = setup();
    for (let i = 0; i < LIMIT; i++) {
      h.advance(2_000);
      h.block(`target-${i}`);
    }
    h.advance(2_000);
    h.block("target-0");
    expect(errors(h.socket)).toHaveLength(0);
    expect(h.store.blockList("blocker")).toHaveLength(LIMIT);
  });

  it("unblocking still works at the limit", () => {
    const h = setup();
    for (let i = 0; i < LIMIT; i++) {
      h.advance(2_000);
      h.block(`target-${i}`);
    }
    h.advance(2_000);
    h.block("target-0", false);
    expect(errors(h.socket)).toHaveLength(0);
    expect(h.store.blockList("blocker")).toHaveLength(LIMIT - 1);
    expect(h.remote.at(-1)).toEqual({ target: "target-0", blocked: false });

    h.advance(2_000);
    h.block("fresh-target");
    expect(errors(h.socket)).toHaveLength(0);
    expect(h.store.blockList("blocker")).toHaveLength(LIMIT);
  });
});

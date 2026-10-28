import type { ChatMessage, ChatServerMessage } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  AUTO_MUTE_MS,
  ChatHost,
  DUPLICATE_WINDOW_MS,
  MODERATION_REPORTER,
  RETAIN_MESSAGES,
  STRIKE_WINDOW_MS,
  type ChatOutbox,
  type ChatSocket,
  type ChatSocketInfo,
  withTimeout,
} from "../../src/server/chat/host.ts";
import { ChatStore } from "../../src/server/chat/store.ts";
import { StubModerator, type Moderator, type Verdict } from "../../src/server/chat/moderation.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

type Frame = ChatServerMessage;

class FakeSocket implements ChatSocket {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(readonly info: ChatSocketInfo) {}
  send(frame: string): void {
    this.frames.push(JSON.parse(frame) as Frame);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  of<T extends Frame["t"]>(t: T): Extract<Frame, { t: T }>[] {
    return this.frames.filter((f): f is Extract<Frame, { t: T }> => f.t === t);
  }
  last<T extends Frame["t"]>(t: T): Extract<Frame, { t: T }> | undefined {
    return this.of(t).at(-1);
  }
}

interface Harness {
  host: ChatHost;
  store: ChatStore;
  sockets: FakeSocket[];
  outbox: ChatOutbox & {
    records: { table: string; pk: string; payload: unknown }[];
    flushes: number;
  };
  remoteSet: { accountId: string; target: string; blocked: boolean }[];
  now(): number;
  advance(ms: number): void;
  drain(): Promise<void>;
  connect(
    accountId: string,
    opts?: {
      kind?: "guest" | "registered";
      name?: string;
      tag?: string | null;
      remoteBlocks?: string[];
    },
  ): Promise<FakeSocket>;
  send(s: FakeSocket, text: string, nonce?: string): void;
  rebuild(): ChatHost;
}

function harness(
  opts: {
    moderator?: Moderator;
    remoteBlocks?: (accountId: string) => Promise<string[]>;
    remoteSetBlocked?: () => Promise<unknown>;
    start?: number;
  } = {},
): Harness {
  const store = new ChatStore(fakeSqlStore(), "global");
  store.init();
  let clock = opts.start ?? 1_700_000_000_000;
  const sockets: FakeSocket[] = [];
  const background: Promise<unknown>[] = [];
  const remoteSet: Harness["remoteSet"] = [];
  const outbox: Harness["outbox"] = {
    records: [],
    flushes: 0,
    append(table, pk, payload) {
      this.records.push({ table, pk, payload });
    },
    scheduleFlush() {
      this.flushes++;
    },
  };
  const deps = () => ({
    channel: "global",
    store,
    sockets: () => sockets,
    now: () => clock,
    moderator: opts.moderator ?? new StubModerator(),
    outbox,
    remoteBlocks: opts.remoteBlocks ?? (async () => []),
    remoteSetBlocked:
      opts.remoteSetBlocked ??
      (async (accountId: string, target: string, blocked: boolean) => {
        remoteSet.push({ accountId, target, blocked });
      }),
    waitUntil: (p: Promise<unknown>) => void background.push(p),
    log: () => {},
  });
  let host = new ChatHost(deps());
  const h: Harness = {
    get host() {
      return host;
    },
    store,
    sockets,
    outbox,
    remoteSet,
    now: () => clock,
    advance(ms) {
      clock += ms;
    },
    async drain() {
      while (background.length) await Promise.allSettled(background.splice(0));
    },
    async connect(accountId, o = {}) {
      const s = new FakeSocket({
        accountId,
        name: o.name ?? `name-${accountId}`,
        kind: o.kind ?? "registered",
        tag: o.tag ?? null,
      });
      sockets.push(s);
      if (o.remoteBlocks) {
        const list = o.remoteBlocks;
        const prev = opts.remoteBlocks;
        opts.remoteBlocks = async (id) => (id === accountId ? list : (prev?.(id) ?? []));
        host = new ChatHost(deps());
      }
      await host.open(s);
      return s;
    },
    send(s, text, nonce = `n${Math.random().toString(36).slice(2, 8)}`) {
      host.handleMessage(s, JSON.stringify({ t: "send", text, nonce }));
    },
    rebuild() {
      host = new ChatHost(deps());
      return host;
    },
  };
  return h;
}

/** The ack id of the last send by `s` (or undefined when it was rejected). */
function lastAckId(s: FakeSocket): string | undefined {
  return s.last("ack")?.id;
}

describe("welcome and history", () => {
  it("welcomes a socket with the channel, self and the recent history", async () => {
    const h = harness();
    const a = await h.connect("acc-a", { name: "Alice" });
    h.send(a, "first", "1");
    h.send(a, "second", "2");
    const b = await h.connect("acc-b", { name: "Bob" });
    const welcome = b.last("welcome");
    expect(welcome).toMatchObject({
      t: "welcome",
      channel: "global",
      self: { accountId: "acc-b", displayName: "Bob" },
      mutedUntil: null,
      blocked: [],
    });
    expect(welcome?.history.map((m) => m.text)).toEqual(["first", "second"]);
    expect(welcome?.history[0]).toMatchObject({ from: "acc-a", name: "Alice", channel: "global" });
  });

  it("sends at most CHAT_HISTORY messages in the welcome", async () => {
    const h = harness();
    for (let i = 0; i < 60; i++) h.host.notice(`notice ${i}`);
    const s = await h.connect("acc-x");
    expect(s.last("welcome")?.history).toHaveLength(50);
    expect(s.last("welcome")?.history.at(-1)?.text).toBe("notice 59");
  });

  it("keeps only the newest RETAIN_MESSAGES messages", () => {
    const h = harness();
    for (let i = 0; i < RETAIN_MESSAGES + 5; i++) h.host.notice(`n${i}`);
    const all = h.host.recent(200);
    expect(all).toHaveLength(RETAIN_MESSAGES);
    expect(all[0]?.text).toBe("n5");
  });
});

describe("send", () => {
  it("acks the sender and broadcasts to everyone, with the sender's tag", async () => {
    const h = harness();
    const a = await h.connect("acc-a", { tag: "ALP" });
    const b = await h.connect("acc-b");
    h.send(a, "  hello   world ", "nonce-1");
    await h.drain();
    const ack = a.last("ack");
    expect(ack).toMatchObject({ t: "ack", nonce: "nonce-1" });
    const got = b.last("message")?.msg as ChatMessage;
    expect(got).toMatchObject({
      from: "acc-a",
      name: "name-acc-a",
      tag: "ALP",
      text: "hello world",
    });
    expect(got.id).toBe(ack?.id);
    expect(h.store.getMessage(got.id)?.verdict).toBe("safe");
    expect(a.of("message")).toHaveLength(1);
  });

  it("rejects empty and too long text", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    h.send(a, "   ", "e1");
    expect(a.last("error")).toMatchObject({ code: "empty", nonce: "e1" });
    h.send(a, "x".repeat(281), "e2");
    expect(a.last("error")).toMatchObject({ code: "too_long", nonce: "e2" });
    h.send(a, "x".repeat(280), "e3");
    expect(a.last("ack")).toMatchObject({ nonce: "e3" });
  });

  it("masks listed words and rejects blocked ones", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    const b = await h.connect("acc-b");
    h.send(a, "damn it", "m1");
    expect(b.last("message")?.msg.text).toBe("**** it");
    h.send(a, "please kys", "m2");
    expect(a.last("error")).toMatchObject({ code: "filtered", nonce: "m2" });
    expect(b.of("message")).toHaveLength(1);
  });

  it("refuses links from guests but accepts them from registered accounts", async () => {
    const h = harness();
    const guest = await h.connect("acc-g", { kind: "guest" });
    const reg = await h.connect("acc-r", { kind: "registered" });
    h.send(guest, "see https://example.com", "g1");
    expect(guest.last("error")).toMatchObject({ code: "filtered", nonce: "g1" });
    h.send(reg, "see https://example.com", "r1");
    expect(reg.last("ack")).toMatchObject({ nonce: "r1" });
  });
});

describe("rate limits", () => {
  it("lets registered accounts burst 5, then one message per 2 s", async () => {
    const h = harness();
    const a = await h.connect("acc-a", { kind: "registered" });
    for (let i = 0; i < 5; i++) h.send(a, `m${i}`, `n${i}`);
    expect(a.of("ack")).toHaveLength(5);
    h.send(a, "m5", "n5");
    expect(a.last("error")).toMatchObject({ code: "rate_limited", nonce: "n5" });
    h.advance(2000);
    h.send(a, "m6", "n6");
    expect(a.last("ack")).toMatchObject({ nonce: "n6" });
  });

  it("lets guests burst 3, then one message per 5 s", async () => {
    const h = harness();
    const g = await h.connect("acc-g", { kind: "guest" });
    for (let i = 0; i < 3; i++) h.send(g, `g${i}`, `n${i}`);
    expect(g.of("ack")).toHaveLength(3);
    h.send(g, "g3", "n3");
    expect(g.last("error")).toMatchObject({ code: "rate_limited" });
    h.advance(4000);
    h.send(g, "g4", "n4");
    expect(g.last("error")).toMatchObject({ code: "rate_limited", nonce: "n4" });
    h.advance(1000);
    h.send(g, "g5", "n5");
    expect(g.last("ack")).toMatchObject({ nonce: "n5" });
  });

  it("limits per account, so a second socket of the same account shares the bucket", async () => {
    const h = harness();
    const a1 = await h.connect("acc-a", { kind: "guest" });
    const a2 = await h.connect("acc-a", { kind: "guest" });
    for (let i = 0; i < 3; i++) h.send(a1, `x${i}`, `n${i}`);
    h.send(a2, "other", "z");
    expect(a2.last("error")).toMatchObject({ code: "rate_limited" });
  });
});

describe("duplicates and mutes", () => {
  it("rejects the same text within 30 s, and allows it after the window", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    h.send(a, "Same thing", "d1");
    h.advance(1000);
    h.send(a, "same thing", "d2");
    expect(a.last("error")).toMatchObject({ code: "duplicate", nonce: "d2" });
    h.advance(DUPLICATE_WINDOW_MS);
    h.send(a, "Same thing", "d3");
    expect(a.last("ack")).toMatchObject({ nonce: "d3" });
  });

  it("mutes an account: the mute is announced, sends are refused until it ends", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    const until = h.now() + 60_000;
    h.host.mute("acc-a", until, "spam");
    expect(a.last("muted")).toEqual({ t: "muted", until, reason: "spam" });
    h.send(a, "hello", "mu1");
    expect(a.last("error")).toMatchObject({ code: "muted", nonce: "mu1" });
    h.advance(61_000);
    h.send(a, "hello again", "mu2");
    expect(a.last("ack")).toMatchObject({ nonce: "mu2" });
  });

  it("tells a late joiner about its mute in the welcome", async () => {
    const h = harness();
    const until = h.now() + 60_000;
    h.host.mute("acc-m", until, "spam");
    const s = await h.connect("acc-m");
    expect(s.last("welcome")?.mutedUntil).toBe(until);
  });
});

describe("blocks", () => {
  it("hides a blocked sender from the blocker, live and in the history", async () => {
    const h = harness();
    const alice = await h.connect("acc-alice");
    const bob = await h.connect("acc-bob");
    const carol = await h.connect("acc-carol");
    h.send(alice, "before the block", "b0");
    await h.drain();
    bob.frames.length = 0;

    h.host.handleMessage(
      bob,
      JSON.stringify({ t: "block", accountId: "acc-alice", blocked: true }),
    );
    expect(bob.last("blocked")?.blocked).toEqual(["acc-alice"]);
    h.send(alice, "after the block", "b1");
    await h.drain();

    expect(bob.of("message").map((f) => f.msg.text)).toEqual([]);
    expect(carol.of("message").map((f) => f.msg.text)).toEqual([
      "before the block",
      "after the block",
    ]);
    expect(alice.last("ack")).toMatchObject({ nonce: "b1" });

    // A new socket of the blocker: alice's messages are missing from its history.
    h.send(carol, "from carol", "b2");
    const bob2 = await h.connect("acc-bob");
    expect(bob2.last("welcome")?.history.map((m) => m.text)).toEqual(["from carol"]);
    expect(bob2.last("welcome")?.blocked).toEqual(["acc-alice"]);
    // Every socket of the blocker sees the update.
    expect(bob.last("blocked")?.blocked).toEqual(["acc-alice"]);
  });

  it("persists blocks to AccountDO and still applies them when that fails", async () => {
    const h = harness({
      remoteSetBlocked: async () => {
        throw new Error("AccountDO unavailable");
      },
    });
    const bob = await h.connect("acc-bob");
    const alice = await h.connect("acc-alice");
    h.host.handleMessage(
      bob,
      JSON.stringify({ t: "block", accountId: "acc-alice", blocked: true }),
    );
    await h.drain();
    h.send(alice, "blocked for bob", "x1");
    await h.drain();
    expect(bob.of("message")).toHaveLength(0);
    expect(bob.last("error")).toBeUndefined();
  });

  it("calls AccountDO with the block change", async () => {
    const h = harness();
    const bob = await h.connect("acc-bob");
    h.host.handleMessage(
      bob,
      JSON.stringify({ t: "block", accountId: "acc-alice", blocked: true }),
    );
    h.host.handleMessage(
      bob,
      JSON.stringify({ t: "block", accountId: "acc-alice", blocked: false }),
    );
    await h.drain();
    expect(h.remoteSet).toEqual([
      { accountId: "acc-bob", target: "acc-alice", blocked: true },
      { accountId: "acc-bob", target: "acc-alice", blocked: false },
    ]);
    expect(bob.last("blocked")?.blocked).toEqual([]);
  });

  it("refreshes the block list from AccountDO on join", async () => {
    const h = harness({ remoteBlocks: async (id) => (id === "acc-bob" ? ["acc-zed"] : []) });
    const bob = await h.connect("acc-bob");
    expect(bob.last("welcome")?.blocked).toEqual(["acc-zed"]);
  });

  it("refuses to block yourself", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    h.host.handleMessage(a, JSON.stringify({ t: "block", accountId: "acc-a", blocked: true }));
    expect(a.last("error")).toMatchObject({ code: "bad_message" });
  });
});

describe("moderation", () => {
  it("hides an unsafe message after broadcasting it, and records it for review", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    const b = await h.connect("acc-b");
    h.send(a, "[unsafe-test] hi", "u1");
    const id = lastAckId(a);
    expect(b.last("message")?.msg.id).toBe(id);
    await h.drain();

    expect(b.last("hidden")).toEqual({ t: "hidden", ids: [id] });
    expect(h.store.getMessage(id!)).toMatchObject({ hidden: true, verdict: "unsafe" });
    expect(a.last("error")).toMatchObject({ code: "filtered" });
    expect(h.outbox.records).toEqual([
      {
        table: "chat_report",
        pk: `global/${id}/${MODERATION_REPORTER}`,
        payload: {
          channel: "global",
          messageId: id,
          reporterId: MODERATION_REPORTER,
          reportedId: "acc-a",
          reason: "abuse",
          text: "[unsafe-test] hi",
          at: h.now(),
          verdict: "unsafe",
        },
      },
    ]);
    expect(h.outbox.flushes).toBeGreaterThan(0);
    expect(h.host.recent(10).map((m) => m.id)).not.toContain(id);
  });

  it("mutes an account after three unsafe messages in 24 h", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    for (let i = 0; i < 2; i++) {
      h.send(a, `[unsafe-test] ${i}`, `s${i}`);
      await h.drain();
    }
    expect(a.of("muted")).toHaveLength(0);
    h.send(a, "[unsafe-test] 2", "s2");
    const t0 = h.now();
    await h.drain();
    expect(a.last("muted")).toEqual({
      t: "muted",
      until: t0 + AUTO_MUTE_MS,
      reason: "repeated_unsafe",
    });
    h.advance(1000);
    h.send(a, "back again", "s3");
    expect(a.last("error")).toMatchObject({ code: "muted", nonce: "s3" });
  });

  it("does not count strikes older than 24 h", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    h.send(a, "[unsafe-test] old", "o1");
    await h.drain();
    h.advance(STRIKE_WINDOW_MS + 1000);
    h.send(a, "[unsafe-test] two", "o2");
    await h.drain();
    h.send(a, "[unsafe-test] three", "o3");
    await h.drain();
    expect(a.of("muted")).toHaveLength(0);
  });

  it("leaves a message visible when the moderator errors", async () => {
    const errorModerator: Moderator = {
      name: "llama-guard",
      classify: async () => ({ safe: true, categories: [], source: "error" }),
    };
    const h = harness({ moderator: errorModerator });
    const a = await h.connect("acc-a");
    const id = (h.send(a, "fine", "e1"), lastAckId(a))!;
    await h.drain();
    expect(h.store.getMessage(id)).toMatchObject({ hidden: false, verdict: "unknown" });
    expect(a.of("hidden")).toHaveLength(0);
  });

  it("does not throw when the moderator rejects", async () => {
    const throwing: Moderator = {
      name: "llama-guard",
      classify: async (): Promise<Verdict> => {
        throw new Error("boom");
      },
    };
    const h = harness({ moderator: throwing });
    const a = await h.connect("acc-a");
    h.send(a, "hello", "t1");
    await h.drain();
    expect(a.last("ack")).toMatchObject({ nonce: "t1" });
  });
});

describe("reports", () => {
  it("stores one report per message and reporter, with the moderation verdict", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    const b = await h.connect("acc-b");
    h.send(a, "report me", "r0");
    const id = lastAckId(a)!;
    await h.drain();

    h.host.handleMessage(b, JSON.stringify({ t: "report", id, reason: "spam" }));
    h.host.handleMessage(b, JSON.stringify({ t: "report", id, reason: "abuse" }));
    expect(b.frames.filter((f) => f.t === "error")).toHaveLength(0);
    const mine = h.outbox.records.filter((r) => r.pk === `global/${id}/acc-b`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      table: "chat_report",
      payload: {
        channel: "global",
        messageId: id,
        reporterId: "acc-b",
        reportedId: "acc-a",
        reason: "spam",
        text: "report me",
        verdict: "safe",
      },
    });
  });

  it("refuses reports of unknown, system and own messages", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    h.host.notice("hello all");
    const sys = h.host.recent(1)[0]!;
    h.host.handleMessage(a, JSON.stringify({ t: "report", id: sys.id, reason: "spam" }));
    expect(a.last("error")).toMatchObject({ code: "bad_message" });
    h.host.handleMessage(a, JSON.stringify({ t: "report", id: "nope", reason: "spam" }));
    expect(a.last("error")).toMatchObject({ code: "bad_message" });
    h.send(a, "mine", "own");
    const own = lastAckId(a)!;
    h.host.handleMessage(a, JSON.stringify({ t: "report", id: own, reason: "other" }));
    expect(a.last("error")).toMatchObject({
      code: "bad_message",
      message: "you cannot report yourself",
    });
    expect(h.outbox.records).toHaveLength(0);
  });
});

describe("protocol edges", () => {
  it("answers bad frames with bad_message and never throws", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    h.host.handleMessage(a, "not json");
    h.host.handleMessage(a, JSON.stringify({ t: "unknown" }));
    h.host.handleMessage(a, new TextEncoder().encode('{"t":"send"}').buffer as ArrayBuffer);
    expect(a.of("error").map((e) => e.code)).toEqual(["bad_message", "bad_message", "bad_message"]);
  });

  it("answers pings, dropping bursts above 3 per second", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    for (let i = 0; i < 5; i++)
      h.host.handleMessage(a, JSON.stringify({ t: "ping", clientTime: i }));
    expect(a.of("pong")).toHaveLength(3);
    expect(a.last("pong")).toMatchObject({ clientTime: 2, serverTime: h.now() });
  });

  it("gives ids that keep increasing, also after a restart in the same millisecond", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    h.send(a, "one", "i1");
    const first = lastAckId(a)!;
    h.send(a, "two", "i2");
    const second = lastAckId(a)!;
    expect(second > first).toBe(true);
    // Same clock millisecond, new host (a restarted DO): the id counter is seeded from storage.
    h.rebuild();
    h.send(a, "three", "i3");
    const third = lastAckId(a)!;
    expect(third > second).toBe(true);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("delivers admin notices and hides, and keeps hidden messages out of history", async () => {
    const h = harness();
    const a = await h.connect("acc-a");
    h.send(a, "to hide", "h1");
    const id = lastAckId(a)!;
    h.host.hide([id], "admin:test");
    expect(a.last("hidden")).toEqual({ t: "hidden", ids: [id] });
    h.host.notice("maintenance soon");
    expect(a.last("message")?.msg).toMatchObject({
      system: true,
      from: "system",
      text: "maintenance soon",
    });
    const late = await h.connect("acc-late");
    expect(late.last("welcome")?.history.map((m) => m.text)).toEqual(["maintenance soon"]);
  });
});

describe("join timeout", () => {
  it("sends the welcome even when AccountDO never answers the block refresh", async () => {
    const hung = new Promise<string[]>(() => {});
    const h = harness({ remoteBlocks: () => hung });
    // The refresh is capped (BLOCK_REFRESH_MS); the welcome is built without it.
    const joined = h.connect("acc-slow");
    await expect(withTimeout(hung, 5)).rejects.toThrow("timed out after 5 ms");
    const s = await joined;
    expect(s.last("welcome")).toMatchObject({ t: "welcome", blocked: [] });
  }, 10_000);
});

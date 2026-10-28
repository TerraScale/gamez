/**
 * R10 (ADR 0007): revoke closes one account's sockets with 4403, and a guild
 * channel re-checks membership on send (cached 60 s per account).
 */
import type { ChatServerMessage } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  ChatHost,
  MEMBERSHIP_STALE_MS,
  MEMBERSHIP_TTL_MS,
  type ChatSocket,
  type ChatSocketInfo,
} from "../../src/server/chat/host.ts";
import { StubModerator } from "../../src/server/chat/moderation.ts";
import { ChatStore } from "../../src/server/chat/store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const START = 1_700_000_000_000;

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
  acks(): number {
    return this.frames.filter((f) => f.t === "ack").length;
  }
}

function setup(channel: string, guildLookup?: (accountId: string) => Promise<string | null>) {
  const store = new ChatStore(fakeSqlStore(), channel);
  store.init();
  let clock = START;
  const sockets: FakeSocket[] = [];
  const host = new ChatHost({
    channel,
    store,
    sockets: () => sockets,
    now: () => clock,
    moderator: new StubModerator(),
    outbox: { append() {}, scheduleFlush() {} },
    remoteBlocks: async () => [],
    remoteSetBlocked: async () => {},
    waitUntil: () => {},
    log: () => {},
    ...(guildLookup ? { guildLookup } : {}),
  });
  const connect = (accountId: string) => {
    const s = new FakeSocket({ accountId, name: accountId, kind: "registered", tag: null });
    sockets.push(s);
    return s;
  };
  let n = 0;
  const send = (s: FakeSocket, text = `hello ${n++}`) =>
    void host.handleMessage(s, JSON.stringify({ t: "send", text, nonce: `n${n}` }));
  return {
    host,
    sockets,
    connect,
    send,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("revoke (R10)", () => {
  it("closes only that account's sockets with 4403 and returns the count", () => {
    const h = setup("guild:iron-wolves");
    const a1 = h.connect("acc-a");
    const a2 = h.connect("acc-a");
    const b = h.connect("acc-b");
    expect(h.host.revoke("acc-a", "kicked")).toBe(2);
    expect(a1.closed).toEqual({ code: 4403, reason: "kicked" });
    expect(a2.closed).toEqual({ code: 4403, reason: "kicked" });
    expect(b.closed).toBeNull();
  });

  it("is idempotent: a second revoke closes nothing more", () => {
    const h = setup("guild:iron-wolves");
    h.connect("acc-a");
    expect(h.host.revoke("acc-a", "left")).toBe(1);
    expect(h.host.revoke("acc-a", "left")).toBe(0);
  });

  it("returns 0 for an account with no sockets", () => {
    const h = setup("global");
    h.connect("acc-b");
    expect(h.host.revoke("acc-z", "kicked")).toBe(0);
  });
});

describe("guild send membership re-check (R10)", () => {
  it("a kicked member's next send is refused and the socket is closed once the cache expires", async () => {
    let member: string | null = "iron-wolves";
    const h = setup("guild:iron-wolves", async () => member);
    const s = h.connect("acc-a");

    await h.host.handleMessage(s, JSON.stringify({ t: "send", text: "first", nonce: "n1" }));
    expect(s.acks()).toBe(1);

    member = null; // kicked, and the revoke was lost
    const framesBefore = s.frames.length;
    h.advance(MEMBERSHIP_TTL_MS + 1);
    await h.host.handleMessage(s, JSON.stringify({ t: "send", text: "second", nonce: "n2" }));
    expect(s.acks()).toBe(1);
    expect(s.closed).toEqual({ code: 4403, reason: "not a member" });
    // The refused message is not broadcast: nothing new arrives on the socket.
    expect(s.frames.length).toBe(framesBefore);
  });

  it("uses the cached membership within the TTL (no lookup per send)", async () => {
    let lookups = 0;
    const h = setup("guild:iron-wolves", async () => {
      lookups++;
      return "iron-wolves";
    });
    const s = h.connect("acc-a");
    await h.host.handleMessage(s, JSON.stringify({ t: "send", text: "one", nonce: "n1" }));
    h.advance(1000);
    await h.host.handleMessage(s, JSON.stringify({ t: "send", text: "two", nonce: "n2" }));
    expect(lookups).toBe(1);
    expect(s.acks()).toBe(2);
  });

  it("a failed lookup keeps the last known membership", async () => {
    let fail = false;
    const h = setup("guild:iron-wolves", async () => {
      if (fail) throw new Error("AccountDO down");
      return "iron-wolves";
    });
    const s = h.connect("acc-a");
    await h.host.handleMessage(s, JSON.stringify({ t: "send", text: "one", nonce: "n1" }));
    fail = true;
    h.advance(MEMBERSHIP_TTL_MS + 1);
    await h.host.handleMessage(s, JSON.stringify({ t: "send", text: "two", nonce: "n2" }));
    expect(s.closed).toBeNull();
    expect(s.acks()).toBe(2);
  });

  it("does not look up membership in non-guild channels", async () => {
    let lookups = 0;
    const h = setup("global", async () => {
      lookups++;
      return null;
    });
    const s = h.connect("acc-a");
    h.send(s, "hi there");
    expect(lookups).toBe(0);
    expect(s.acks()).toBe(1);
  });
});

describe("guild join re-check (R10 variant 1: revoke before open)", () => {
  it("a socket accepted after the kick's revoke is closed without history", async () => {
    let member: string | null = "iron-wolves";
    const h = setup("guild:iron-wolves", async () => member);
    const insider = h.connect("acc-b");
    await h.host.open(insider);
    await h.host.handleMessage(
      insider,
      JSON.stringify({ t: "send", text: "old secret", nonce: "x" }),
    );
    // The upgrade checked membership (member), then the kick released the slot and
    // revoked while no socket existed yet; only now is the socket accepted.
    member = null;
    expect(h.host.revoke("acc-a", "kicked")).toBe(0);
    const late = h.connect("acc-a");
    await h.host.open(late);
    expect(late.closed).toEqual({ code: 4403, reason: "not a member" });
    expect(late.frames).toEqual([]); // no welcome, no history
    // Later guild traffic never reaches it, and its sends are dropped.
    await h.host.handleMessage(
      insider,
      JSON.stringify({ t: "send", text: "later secret", nonce: "y" }),
    );
    await h.host.handleMessage(late, JSON.stringify({ t: "send", text: "hi", nonce: "z" }));
    expect(late.frames).toEqual([]);
    expect(insider.frames.some((f) => f.t === "message" && f.msg.text === "hi")).toBe(false);
  });

  it("a revoke that lands while the join lookup runs closes the socket", async () => {
    let release!: (v: string | null) => void;
    const h = setup(
      "guild:iron-wolves",
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );
    const s = h.connect("acc-a");
    const opening = h.host.open(s);
    // Broadcasts during the lookup skip the unconfirmed socket.
    h.host.notice("guild meeting at dawn");
    expect(h.host.revoke("acc-a", "kicked")).toBe(1);
    release("iron-wolves"); // a stale answer: the revoke still wins
    await opening;
    expect(s.closed).toEqual({ code: 4403, reason: "kicked" });
    expect(s.frames).toEqual([]);
  });

  it("a member joins normally after a fresh lookup", async () => {
    let lookups = 0;
    const h = setup("guild:iron-wolves", async () => {
      lookups++;
      return "iron-wolves";
    });
    const s = h.connect("acc-a");
    await h.host.open(s);
    expect(lookups).toBe(1);
    expect(s.closed).toBeNull();
    expect(s.frames[0]?.t).toBe("welcome");
    // The join answer is cached for sends.
    await h.host.handleMessage(s, JSON.stringify({ t: "send", text: "hello all", nonce: "n1" }));
    expect(lookups).toBe(1);
    expect(s.acks()).toBe(1);
  });

  it("a failed join lookup closes with a retryable code", async () => {
    const h = setup("guild:iron-wolves", async () => {
      throw new Error("AccountDO down");
    });
    const s = h.connect("acc-a");
    await h.host.open(s);
    expect(s.closed).toEqual({ code: 1013, reason: "membership unavailable" });
    expect(s.frames).toEqual([]);
  });
});

describe("guild membership sweep (R10 variant 2: lost revoke, silent reader)", () => {
  it("closes a silent reader whose revoke was lost, and keeps members", async () => {
    const members = new Map<string, string | null>([
      ["acc-a", "iron-wolves"],
      ["acc-b", "iron-wolves"],
    ]);
    const h = setup("guild:iron-wolves", async (id) => members.get(id) ?? null);
    const reader = h.connect("acc-a");
    const talker = h.connect("acc-b");
    await h.host.open(reader);
    await h.host.open(talker);
    expect(h.host.needsMembershipSweep()).toBe(true);

    members.set("acc-a", null); // kicked; the revoke RPC failed
    h.advance(MEMBERSHIP_TTL_MS);
    await h.host.sweepMembers();
    expect(reader.closed).toEqual({ code: 4403, reason: "not a member" });
    expect(talker.closed).toBeNull();
    const seen = reader.frames.length;
    await h.host.handleMessage(
      talker,
      JSON.stringify({ t: "send", text: "later secret", nonce: "s" }),
    );
    expect(reader.frames.length).toBe(seen);
    expect(talker.acks()).toBe(1);
  });

  it("keeps sockets through brief lookup failures, closes them once stale", async () => {
    let fail = false;
    const h = setup("guild:iron-wolves", async () => {
      if (fail) throw new Error("AccountDO down");
      return "iron-wolves";
    });
    const s = h.connect("acc-a");
    await h.host.open(s);
    fail = true;
    h.advance(MEMBERSHIP_TTL_MS);
    await h.host.sweepMembers();
    expect(s.closed).toBeNull();
    h.advance(MEMBERSHIP_STALE_MS);
    await h.host.sweepMembers();
    expect(s.closed).toEqual({ code: 1013, reason: "membership unavailable" });
    expect(h.host.needsMembershipSweep()).toBe(false);
  });

  it("is a no-op outside guild channels", async () => {
    let lookups = 0;
    const h = setup("global", async () => {
      lookups++;
      return null;
    });
    const s = h.connect("acc-a");
    await h.host.open(s);
    await h.host.sweepMembers();
    expect(lookups).toBe(0);
    expect(s.closed).toBeNull();
    expect(h.host.needsMembershipSweep()).toBe(false);
  });
});

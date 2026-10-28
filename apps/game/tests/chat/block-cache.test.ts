/**
 * R9 round 2 (ADR 0007): the channel's chat_block table is a cache of the
 * AccountDO block lists of connected accounts only. Rotating free guest
 * accounts (open, block, close, repeat) must not grow the shared channel's
 * storage: an account's rows go when its last socket closes, a host start drops
 * the rows of accounts with no socket, and the rows stay bounded by open
 * sockets x BLOCK_LIMIT.
 */
import type { ChatServerMessage } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { BLOCK_LIMIT } from "../../src/server/account/social.ts";
import {
  BLOCK_SWEEP_MS,
  ChatHost,
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
}

const guest = (id: string) => new FakeSocket({ accountId: id, name: id, kind: "guest", tag: null });

function setup(opts: { store?: ChatStore; remote?: Map<string, string[]> } = {}) {
  const store =
    opts.store ??
    (() => {
      const s = new ChatStore(fakeSqlStore(), "global");
      s.init();
      return s;
    })();
  const remote = opts.remote ?? new Map<string, string[]>();
  let clock = START;
  const open = new Set<FakeSocket>();
  let remoteGate: Promise<void> | null = null;
  const pending: Promise<unknown>[] = [];
  const logs: string[] = [];
  const deps = {
    channel: "global",
    store,
    sockets: () => [...open],
    now: () => clock,
    moderator: new StubModerator(),
    outbox: { append() {}, scheduleFlush() {} },
    remoteBlocks: async (accountId: string) => {
      if (remoteGate) await remoteGate;
      return [...(remote.get(accountId) ?? [])];
    },
    remoteSetBlocked: async (accountId: string, target: string, blocked: boolean) => {
      const list = new Set(remote.get(accountId) ?? []);
      if (blocked) list.add(target);
      else list.delete(target);
      remote.set(accountId, [...list].sort());
    },
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    log: (m: string) => void logs.push(m),
  };
  const make = () => new ChatHost(deps);
  const host = make();
  return {
    host,
    make,
    store,
    remote,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
    gateRemote(gate: Promise<void> | null) {
      remoteGate = gate;
    },
    async join(s: FakeSocket, h = host) {
      open.add(s);
      await h.open(s);
    },
    /** The runtime reports a close (ChatChannelDO.webSocketClose). */
    leave(s: FakeSocket, h = host) {
      open.delete(s);
      h.socketClosed(s);
    },
    /** A close the runtime never reported (the socket just disappears). */
    vanish(s: FakeSocket) {
      open.delete(s);
    },
    async block(s: FakeSocket, target: string, blocked = true, h = host) {
      await h.handleMessage(s, JSON.stringify({ t: "block", accountId: target, blocked }));
      await Promise.all(pending.splice(0));
    },
  };
}

const welcome = (s: FakeSocket) =>
  s.frames.find((f): f is Extract<ChatServerMessage, { t: "welcome" }> => f.t === "welcome");

describe("chat block rows are a cache of connected accounts (R9)", () => {
  it("rotating guest accounts leaves no rows in the shared channel", async () => {
    const h = setup();
    for (let i = 0; i < 500; i++) {
      const s = guest(`guest-${i}`);
      await h.join(s);
      for (let j = 0; j < 10; j++) await h.block(s, `made-up-${i}-${j}`.padEnd(100, "x"));
      h.leave(s);
    }
    expect(h.store.blockRowCount()).toBe(0);
  });

  it("rows stay bounded by open sockets x BLOCK_LIMIT", async () => {
    const h = setup();
    const live: FakeSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = guest(`live-${i}`);
      live.push(s);
      await h.join(s);
      for (let j = 0; j < BLOCK_LIMIT + 5; j++) {
        h.advance(2_000);
        await h.block(s, `t-${i}-${j}`);
      }
    }
    expect(h.store.blockRowCount()).toBe(3 * BLOCK_LIMIT);
    h.leave(live[0]!);
    expect(h.store.blockRowCount()).toBe(2 * BLOCK_LIMIT);
  });

  it("blocks keep filtering while connected and come back from AccountDO on rejoin", async () => {
    const h = setup();
    const victim = guest("victim");
    const troll = guest("troll");
    await h.join(victim);
    await h.join(troll);
    await h.block(victim, "troll");
    await h.host.handleMessage(troll, JSON.stringify({ t: "send", text: "hi", nonce: "n1" }));
    expect(victim.frames.some((f) => f.t === "message")).toBe(false);

    h.leave(victim);
    expect(h.store.blockList("victim")).toEqual([]);
    expect(h.remote.get("victim")).toEqual(["troll"]);

    const again = guest("victim");
    await h.join(again);
    expect(welcome(again)?.blocked).toEqual(["troll"]);
    expect(welcome(again)?.history.some((m) => m.from === "troll")).toBe(false);
    h.advance(10_000);
    await h.host.handleMessage(troll, JSON.stringify({ t: "send", text: "again", nonce: "n2" }));
    expect(again.frames.some((f) => f.t === "message")).toBe(false);
  });

  it("keeps an account's rows while another of its sockets is open", async () => {
    const h = setup();
    const a = guest("multi");
    const b = guest("multi");
    await h.join(a);
    await h.join(b);
    await h.block(a, "someone");
    h.leave(a);
    expect(h.store.blockList("multi")).toEqual(["someone"]);
    h.leave(b);
    expect(h.store.blockList("multi")).toEqual([]);
  });

  it("a socket that closes while AccountDO answers leaves no merged rows", async () => {
    const remote = new Map([["slow", ["a", "b", "c"]]]);
    const h = setup({ remote });
    let release!: () => void;
    h.gateRemote(new Promise<void>((r) => (release = r)));
    const s = guest("slow");
    const joining = h.join(s);
    h.leave(s);
    release();
    await joining;
    expect(h.store.blockRowCount()).toBe(0);
  });

  it("a host start drops the rows of accounts with no open socket", async () => {
    const store = new ChatStore(fakeSqlStore(), "global");
    store.init();
    // Rows left behind by sockets a restart dropped without a close event.
    for (let i = 0; i < 50; i++) store.setBlockRow(`old-${i}`, "x", true);
    const h = setup({ store });
    expect(h.store.blockRowCount()).toBe(0);
  });

  it("a join sweeps rows of sockets whose close was never reported", async () => {
    const h = setup();
    const ghost = guest("ghost");
    await h.join(ghost);
    await h.block(ghost, "x");
    h.vanish(ghost);
    expect(h.store.blockRowCount()).toBe(1);

    h.advance(BLOCK_SWEEP_MS);
    await h.join(guest("fresh"));
    expect(h.store.blockRowCount()).toBe(0);
  });

  it("a host-closed socket (guild revoke) drops the account's rows", async () => {
    const h = setup();
    const t = guest("kicked");
    await h.join(t);
    await h.block(t, "y");
    // The runtime may still list the socket until its close completes.
    h.host.revoke("kicked", "removed");
    expect(t.closed?.code).toBe(4403);
    expect(h.store.blockList("kicked")).toEqual([]);
  });
});

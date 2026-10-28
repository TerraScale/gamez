/**
 * R9b (ADR 0007): chat reports, strikes, mutes and send rate buckets stay
 * bounded however many free guest accounts join the shared channel.
 *
 * - A socket's reports are rate limited (REPORT_RATE).
 * - Only the first REPORTERS_PER_MESSAGE reporters of a message write a
 *   chat_seen_report row and an outbox (D1 chat_report) record.
 * - prune() drops the report rows of pruned messages, strikes older than
 *   STRIKE_WINDOW_MS and expired mutes.
 * - An account's send rate bucket goes once its last socket closed and the
 *   bucket is full again.
 * - Messages for one account use the per-account socket lookup, not a scan.
 */
import type { ChatServerMessage } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  BLOCK_SWEEP_MS,
  ChatHost,
  REPORT_RATE,
  REPORTERS_PER_MESSAGE,
  RETAIN_MESSAGES,
  STRIKE_WINDOW_MS,
  type ChatSocket,
  type ChatSocketInfo,
} from "../../src/server/chat/host.ts";
import { StubModerator } from "../../src/server/chat/moderation.ts";
import { ChatStore } from "../../src/server/chat/store.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const START = 1_700_000_000_000;

class FakeSocket implements ChatSocket {
  readonly frames: ChatServerMessage[] = [];
  constructor(readonly info: ChatSocketInfo) {}
  send(frame: string): void {
    this.frames.push(JSON.parse(frame) as ChatServerMessage);
  }
  close(): void {}
  errors(code: string): number {
    return this.frames.filter((f) => f.t === "error" && f.code === code).length;
  }
}

const guest = (id: string) => new FakeSocket({ accountId: id, name: id, kind: "guest", tag: null });

function setup() {
  const store = new ChatStore(fakeSqlStore(), "global");
  store.init();
  let clock = START;
  const open = new Set<FakeSocket>();
  const appends: { table: string; pk: string }[] = [];
  let scans = 0;
  const host = new ChatHost({
    channel: "global",
    store,
    sockets: () => {
      scans++;
      return [...open];
    },
    socketsOf: (accountId) => [...open].filter((s) => s.info.accountId === accountId),
    now: () => clock,
    moderator: new StubModerator(),
    outbox: { append: (table, pk) => void appends.push({ table, pk }), scheduleFlush() {} },
    remoteBlocks: async () => [],
    remoteSetBlocked: async () => undefined,
    waitUntil: () => {},
    log: () => {},
  });
  return {
    host,
    store,
    appends,
    scans: () => scans,
    advance: (ms: number) => {
      clock += ms;
    },
    async join(s: FakeSocket) {
      open.add(s);
      await host.open(s);
    },
    leave(s: FakeSocket) {
      open.delete(s);
      host.socketClosed(s);
    },
    async send(s: FakeSocket, text: string) {
      await host.handleMessage(s, JSON.stringify({ t: "send", text, nonce: text }));
    },
    async report(s: FakeSocket, id: string) {
      await host.handleMessage(s, JSON.stringify({ t: "report", id, reason: "spam" }));
    },
  };
}

/** Fills the channel with RETAIN_MESSAGES messages from distinct authors; returns their ids. */
async function fill(h: ReturnType<typeof setup>, prefix: string): Promise<string[]> {
  for (let i = 0; i < RETAIN_MESSAGES; i++) {
    const s = guest(`${prefix}-author-${i}`);
    await h.join(s);
    await h.send(s, `${prefix} message ${i}`);
    h.leave(s);
  }
  return h.host.recent(RETAIN_MESSAGES).map((m) => m.id);
}

describe("chat report storage is bounded (R9b)", () => {
  it("rate limits a socket's reports", async () => {
    const h = setup();
    const ids = await fill(h, "a");
    const s = guest("reporter");
    await h.join(s);
    for (const id of ids.slice(0, REPORT_RATE.burst + 10)) await h.report(s, id);
    expect(h.store.rowCounts().reports).toBe(REPORT_RATE.burst);
    expect(s.errors("rate_limited")).toBe(10);
    h.advance(1000 / REPORT_RATE.perSecond);
    await h.report(s, ids[REPORT_RATE.burst + 10]!);
    expect(h.store.rowCounts().reports).toBe(REPORT_RATE.burst + 1);
  });

  it("records only the first REPORTERS_PER_MESSAGE reporters of a message", async () => {
    const h = setup();
    const [id] = await fill(h, "a");
    h.appends.length = 0;
    for (let i = 0; i < 50; i++) {
      const s = guest(`reporter-${i}`);
      await h.join(s);
      await h.report(s, id!);
      h.leave(s);
    }
    expect(h.store.reportCount(id!)).toBe(REPORTERS_PER_MESSAGE);
    expect(h.appends.filter((a) => a.table === "chat_report")).toHaveLength(REPORTERS_PER_MESSAGE);
    // Moderation keeps the first reporters' records.
    expect(h.appends.map((a) => a.pk).slice(0, 2)).toEqual([
      `global/${id}/reporter-0`,
      `global/${id}/reporter-1`,
    ]);
  });

  it("rotating guests reporting every kept message stay within RETAIN x REPORTERS_PER_MESSAGE", async () => {
    const h = setup();
    const ids = await fill(h, "a");
    h.appends.length = 0;
    const guests = 40;
    for (let g = 0; g < guests; g++) {
      const s = guest(`reporter-${g}`);
      await h.join(s);
      for (const id of ids) {
        h.advance(1000 / REPORT_RATE.perSecond);
        await h.report(s, id);
      }
      h.leave(s);
    }
    const rows = h.store.rowCounts().reports;
    const appends = h.appends.filter((a) => a.table === "chat_report").length;
    // Before R9b: 40 x 200 = 8,000 rows and 8,000 appends.
    expect(rows).toBe(RETAIN_MESSAGES * REPORTERS_PER_MESSAGE);
    expect(appends).toBe(RETAIN_MESSAGES * REPORTERS_PER_MESSAGE);
  });

  it("pruning messages drops their report rows", async () => {
    const h = setup();
    const ids = await fill(h, "a");
    const s = guest("reporter");
    await h.join(s);
    for (const id of ids.slice(0, 20)) {
      h.advance(1000 / REPORT_RATE.perSecond);
      await h.report(s, id);
    }
    expect(h.store.rowCounts().reports).toBe(20);
    await fill(h, "b"); // pushes every reported message out of the channel
    expect(h.store.getMessage(ids[0]!)).toBeNull();
    expect(h.store.rowCounts().reports).toBe(0);
  });

  it("pruning drops strikes older than STRIKE_WINDOW_MS and expired mutes", async () => {
    const h = setup();
    for (let i = 0; i < 100; i++) {
      h.store.addStrike(`old-${i}`, START);
      h.store.setMute(`old-${i}`, START + 1000, "test");
    }
    h.store.addStrike("recent", START + STRIKE_WINDOW_MS);
    h.store.setMute("recent", START + STRIKE_WINDOW_MS * 2, "test");
    h.advance(STRIKE_WINDOW_MS + 1);
    const s = guest("author");
    await h.join(s);
    await h.send(s, "hello");
    expect(h.store.rowCounts()).toMatchObject({ strikes: 1, mutes: 1 });
    expect(h.store.strikesSince("recent", START)).toBe(1);
    expect(h.store.muteOf("recent")?.until).toBe(START + STRIKE_WINDOW_MS * 2);
  });
});

describe("chat host memory (R9b)", () => {
  it("drops an account's send bucket when its last socket closes", async () => {
    const h = setup();
    for (let i = 0; i < 200; i++) {
      const s = guest(`g-${i}`);
      await h.join(s);
      await h.send(s, "hi");
      h.advance(10_000); // the bucket refills while connected
      h.leave(s);
    }
    expect(h.host.rateBucketCount).toBe(0);
  });

  it("keeps a draining bucket until it refills, then a sweep drops it", async () => {
    const h = setup();
    const s = guest("spammer");
    await h.join(s);
    for (let i = 0; i < 5; i++) await h.send(s, `spam ${i}`);
    expect(s.errors("rate_limited")).toBeGreaterThan(0);
    h.leave(s);
    expect(h.host.rateBucketCount).toBe(1);
    // Reconnecting does not refill the bucket early.
    const again = guest("spammer");
    await h.join(again);
    await h.send(again, "spam again");
    expect(again.errors("rate_limited")).toBe(1);
    h.leave(again);
    h.advance(BLOCK_SWEEP_MS);
    await h.join(guest("someone"));
    expect(h.host.rateBucketCount).toBe(0);
  });

  it("block and mute frames use the per-account socket lookup, not a channel scan", async () => {
    const h = setup();
    const me = guest("me");
    for (let i = 0; i < 20; i++) await h.join(guest(`other-${i}`));
    await h.join(me);
    const before = h.scans();
    await h.host.handleMessage(me, JSON.stringify({ t: "block", accountId: "x", blocked: true }));
    h.host.mute("me", START + 60_000, "test");
    expect(me.frames.some((f) => f.t === "blocked")).toBe(true);
    expect(me.frames.some((f) => f.t === "muted")).toBe(true);
    expect(h.scans() - before).toBe(0);
  });
});

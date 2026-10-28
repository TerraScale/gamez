/** App shell: notices bell polling and feature-flag reads (wave-C.md §9.2, §10.4). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Notice as InboxNotice, NoticesResponse } from "@gamez/protocol";
import type { ApiResult, ConfigApi, VaultApi } from "@gamez/ui-host";
import {
  NOTICE_POLL_MS,
  createFlagWatcher,
  createNoticePoller,
  type InboxState,
} from "../../src/client/app/pollers.ts";

function notice(id: string, over: Partial<InboxNotice> = {}): InboxNotice {
  return {
    id,
    at: 1,
    kind: "trade.invite",
    text: `invite ${id}`,
    data: { tradeId: `tr-${id}` },
    read: false,
    ...over,
  };
}

/** A vault whose notices() answers from `current`, counting the reads. */
function fakeVault(current: { value: NoticesResponse | null }) {
  const calls = { n: 0 };
  const vault = {
    vault: vi.fn(),
    markRead: vi.fn(),
    notices: vi.fn(async (): Promise<ApiResult<NoticesResponse>> => {
      calls.n++;
      if (current.value === null) return { ok: false, code: "unavailable", message: "down" };
      return { ok: true, value: current.value };
    }),
  } as unknown as VaultApi & { notices: ReturnType<typeof vi.fn> };
  return { vault, calls };
}

/** Lets the pending read settle (the fake clock also drains microtasks). */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("createNoticePoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads at once and then every 20 s", async () => {
    const current = { value: { notices: [], unread: 2 } as NoticesResponse };
    const { vault, calls } = fakeVault(current);
    const states: InboxState[] = [];
    const poller = createNoticePoller({
      vault,
      onState: (s) => states.push(s),
      onFreshInvite: () => {},
    });

    poller.start();
    await flush();
    expect(calls.n).toBe(1);
    expect(states.at(-1)?.unread).toBe(2);
    expect(NOTICE_POLL_MS).toBe(20_000);

    await vi.advanceTimersByTimeAsync(19_000);
    expect(calls.n).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.n).toBe(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.n).toBe(2);
  });

  it("skips the tick while the page is hidden", async () => {
    const { vault, calls } = fakeVault({ value: { notices: [], unread: 0 } });
    let visible = false;
    const poller = createNoticePoller({
      vault,
      visible: () => visible,
      onState: () => {},
      onFreshInvite: () => {},
    });
    poller.start();
    await flush();
    expect(calls.n).toBe(1);
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS * 3);
    expect(calls.n).toBe(1);
    visible = true;
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS);
    expect(calls.n).toBe(2);
    poller.stop();
  });

  it("start is idempotent: one timer, one immediate read", async () => {
    const { vault, calls } = fakeVault({ value: { notices: [], unread: 0 } });
    const poller = createNoticePoller({ vault, onState: () => {}, onFreshInvite: () => {} });
    poller.start();
    poller.start();
    await flush();
    expect(calls.n).toBe(1);
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MS);
    expect(calls.n).toBe(2);
    poller.stop();
  });

  it("concurrent refreshes share one request", async () => {
    const { vault, calls } = fakeVault({ value: { notices: [], unread: 0 } });
    const poller = createNoticePoller({ vault, onState: () => {}, onFreshInvite: () => {} });
    await Promise.all([poller.refresh(), poller.refresh(), poller.refresh()]);
    expect(calls.n).toBe(1);
  });

  it("a trade invite that arrives after the first read toasts once; the backlog never does", async () => {
    const current: { value: NoticesResponse | null } = {
      value: { notices: [notice("old")], unread: 1 },
    };
    const { vault } = fakeVault(current);
    const fresh: InboxNotice[] = [];
    const poller = createNoticePoller({
      vault,
      onState: () => {},
      onFreshInvite: (n) => fresh.push(n),
    });

    await poller.refresh();
    expect(fresh).toEqual([]);

    current.value = {
      notices: [notice("new"), notice("old")],
      unread: 2,
    };
    await poller.refresh();
    expect(fresh.map((n) => n.id)).toEqual(["new"]);

    // Read again without change: no second toast.
    await poller.refresh();
    expect(fresh.map((n) => n.id)).toEqual(["new"]);
  });

  it("rent due and repossession toast like invites", async () => {
    const current: { value: NoticesResponse | null } = { value: { notices: [], unread: 0 } };
    const { vault } = fakeVault(current);
    const fresh: InboxNotice[] = [];
    const poller = createNoticePoller({
      vault,
      onState: () => {},
      onFreshInvite: (n) => fresh.push(n),
    });
    await poller.refresh();
    current.value = {
      notices: [
        notice("rent", { kind: "shop.rent_due" }),
        notice("gone", { kind: "shop.repossessed" }),
        notice("pass", { kind: "pass.tier" }),
      ],
      unread: 3,
    };
    await poller.refresh();
    expect(fresh.map((n) => n.id)).toEqual(["rent", "gone"]);
  });

  it("only unread trade invites toast (not market notices, not read invites)", async () => {
    const current: { value: NoticesResponse | null } = { value: { notices: [], unread: 0 } };
    const { vault } = fakeVault(current);
    const fresh: InboxNotice[] = [];
    const poller = createNoticePoller({
      vault,
      onState: () => {},
      onFreshInvite: (n) => fresh.push(n),
    });
    await poller.refresh();
    current.value = {
      notices: [
        notice("sold", { kind: "market.sold" }),
        notice("read", { read: true }),
        notice("invite"),
      ],
      unread: 3,
    };
    await poller.refresh();
    expect(fresh.map((n) => n.id)).toEqual(["invite"]);
  });

  it("a failed read keeps the last count", async () => {
    const current: { value: NoticesResponse | null } = { value: { notices: [], unread: 4 } };
    const { vault } = fakeVault(current);
    const states: InboxState[] = [];
    const poller = createNoticePoller({
      vault,
      onState: (s) => states.push(s),
      onFreshInvite: () => {},
    });
    await poller.refresh();
    current.value = null;
    await poller.refresh();
    expect(states.map((s) => s.unread)).toEqual([4]);
  });
});

describe("createFlagWatcher", () => {
  function config(
    answer: () => Promise<
      ApiResult<{ flags: Record<string, boolean>; seasonId: string; serverTime: number }>
    >,
  ) {
    return { get: vi.fn(answer) } as unknown as ConfigApi;
  }

  it("reports the flags of a good answer", async () => {
    const seen: unknown[] = [];
    const watcher = createFlagWatcher(
      config(async () => ({
        ok: true,
        value: { flags: { market: false }, seasonId: "s1", serverTime: 1 },
      })) as never,
      (f) => seen.push(f),
    );
    await watcher.refresh();
    expect(seen).toEqual([{ market: false }]);
  });

  it("an error or a throw reports null (every feature shows)", async () => {
    const seen: unknown[] = [];
    const bad = createFlagWatcher(
      config(async () => ({ ok: false, code: "unavailable", message: "Coming soon" })) as never,
      (f) => seen.push(f),
    );
    await bad.refresh();
    const thrown = createFlagWatcher(
      config(async () => {
        throw new Error("offline");
      }) as never,
      (f) => seen.push(f),
    );
    await thrown.refresh();
    expect(seen).toEqual([null, null]);
  });
});

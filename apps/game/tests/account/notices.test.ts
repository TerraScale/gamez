import { NOTICES_MAX, type NoticeInput } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { EconomyError } from "../../src/server/account/economy.ts";
import { AccountNotices } from "../../src/server/account/notices.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

function fresh(): { notices: AccountNotices; tick: () => void } {
  let now = 1_000;
  const notices = new AccountNotices(fakeSqlStore(), () => now);
  notices.init();
  notices.init();
  return { notices, tick: () => (now += 1) };
}

const n = (id: string, extra: Partial<NoticeInput> = {}): NoticeInput => ({
  id,
  kind: "system",
  text: `notice ${id}`,
  data: {},
  ...extra,
});

describe("notices", () => {
  it("is idempotent by id and lists oldest first with the unread count", () => {
    const { notices } = fresh();
    notices.notify(n("a", { data: { tradeId: "t1", n: 2, ok: true, none: null } }));
    notices.notify(n("a", { text: "changed" }));
    notices.notify(n("b", { at: 5 }));
    const all = notices.notices(null);
    expect(all.unread).toBe(2);
    expect(all.notices).toEqual([
      {
        id: "a",
        at: 1_000,
        kind: "system",
        text: "notice a",
        data: { n: 2, none: null, ok: true, tradeId: "t1" },
        read: false,
      },
      { id: "b", at: 5, kind: "system", text: "notice b", data: {}, read: false },
    ]);
  });

  it("since returns newer ones; unknown since returns all", () => {
    const { notices } = fresh();
    for (const id of ["a", "b", "c"]) notices.notify(n(id));
    expect(notices.notices("a").notices.map((x) => x.id)).toEqual(["b", "c"]);
    expect(notices.notices("c").notices).toEqual([]);
    expect(notices.notices("zzz").notices.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("markRead marks up to and including the id and returns how many changed", () => {
    const { notices } = fresh();
    for (const id of ["a", "b", "c"]) notices.notify(n(id));
    expect(notices.markRead("b")).toBe(2);
    expect(notices.markRead("b")).toBe(0);
    expect(notices.markRead("nope")).toBe(0);
    const r = notices.notices(null);
    expect(r.unread).toBe(1);
    expect(r.notices.map((x) => x.read)).toEqual([true, true, false]);
  });

  it("keeps only the newest NOTICES_MAX, truncates text and drops bad data", () => {
    const { notices } = fresh();
    for (let i = 0; i < NOTICES_MAX + 5; i++) notices.notify(n(`n${i}`));
    const all = notices.notices(null).notices;
    expect(all).toHaveLength(NOTICES_MAX);
    expect(all[0]!.id).toBe("n5");
    notices.notify(
      n("long", {
        text: "x".repeat(500),
        data: { obj: { a: 1 } as unknown as string, nan: Number.NaN, s: "y".repeat(300) },
      }),
    );
    const last = notices.notices("n104").notices[0]!;
    expect(last.text).toHaveLength(140);
    expect(last.data).toEqual({ s: "y".repeat(200) });
  });

  it("rejects a notice without id or kind", () => {
    const { notices } = fresh();
    expect(() => notices.notify(n(""))).toThrow(EconomyError);
    expect(() => notices.notify(n("x", { kind: "" as "system" }))).toThrow(EconomyError);
  });
});

describe("trade index", () => {
  it("links open trades, closes them, and never reopens a closed one", () => {
    const { notices, tick } = fresh();
    notices.linkTrade("t1", true);
    tick();
    notices.linkTrade("t2", true);
    notices.linkTrade("t1", true);
    expect(notices.openTrades()).toEqual(["t1", "t2"]);
    notices.linkTrade("t1", false);
    notices.linkTrade("t1", false);
    expect(notices.openTrades()).toEqual(["t2"]);
    notices.linkTrade("t1", true);
    expect(notices.openTrades()).toEqual(["t2"]);
    // Closing an unknown trade is harmless.
    notices.linkTrade("t9", false);
    expect(notices.openTrades()).toEqual(["t2"]);
  });
});

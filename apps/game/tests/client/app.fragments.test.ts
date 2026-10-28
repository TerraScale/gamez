/** App shell: payment return and #admin fragments (wave-C.md §10.4). */
import { describe, expect, it } from "vite-plus/test";
import {
  firstPaidReturn,
  ORDER_ID_MAX,
  parseShellFragment,
  SEEN_ORDERS_KEY,
} from "../../src/client/app/fragments.ts";
import { consumeAuthFragment } from "../../src/client/session.ts";

describe("parseShellFragment", () => {
  it("a paid return carries the order id", () => {
    expect(parseShellFragment("#store=paid&order=ord_123")).toEqual({
      kind: "store",
      outcome: "paid",
      order: "ord_123",
    });
  });

  it("a paid return without an order id, or with one too long, has order null", () => {
    expect(parseShellFragment("#store=paid")).toEqual({
      kind: "store",
      outcome: "paid",
      order: null,
    });
    expect(parseShellFragment(`#store=paid&order=${"x".repeat(ORDER_ID_MAX + 1)}`)).toEqual({
      kind: "store",
      outcome: "paid",
      order: null,
    });
  });

  it("a cancelled checkout", () => {
    expect(parseShellFragment("#store=cancel")).toEqual({ kind: "store", outcome: "cancel" });
  });

  it("the admin route, with or without the leading #", () => {
    expect(parseShellFragment("#admin")).toEqual({ kind: "admin" });
    expect(parseShellFragment("admin")).toEqual({ kind: "admin" });
  });

  it("anything else is not a shell fragment", () => {
    expect(parseShellFragment("")).toBeNull();
    expect(parseShellFragment("#")).toBeNull();
    expect(parseShellFragment("#store=weird")).toBeNull();
    expect(parseShellFragment("#adminx")).toBeNull();
  });

  it("the OAuth fragment is not ours (session.ts still reads it)", () => {
    expect(parseShellFragment("#auth=abc")).toBeNull();
    expect(parseShellFragment("#auth_error=access_denied")).toBeNull();
    // Without a window, the OAuth reader sees nothing and returns null.
    expect(consumeAuthFragment()).toBeNull();
  });
});

describe("firstPaidReturn", () => {
  function memory() {
    const m = new Map<string, string>();
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  }

  it("is true once per order, so a reloaded return URL is not a new purchase", () => {
    const s = memory();
    expect(firstPaidReturn("ord-1", s)).toBe(true);
    expect(firstPaidReturn("ord-1", s)).toBe(false);
    expect(firstPaidReturn("ord-2", s)).toBe(true);
    expect(JSON.parse(s.m.get(SEEN_ORDERS_KEY)!)).toEqual(["ord-1", "ord-2"]);
  });

  it("treats a missing order id, no storage and broken storage as new", () => {
    expect(firstPaidReturn(null, memory())).toBe(true);
    expect(firstPaidReturn("ord-1", null)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(firstPaidReturn("ord-1", broken)).toBe(true);
  });

  it("keeps only the most recent orders", () => {
    const s = memory();
    for (let i = 0; i < 25; i++) firstPaidReturn(`ord-${i}`, s);
    const kept = JSON.parse(s.m.get(SEEN_ORDERS_KEY)!) as string[];
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe("ord-5");
  });
});

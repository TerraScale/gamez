/** App shell: payment return and #admin fragments (wave-C.md §10.4). */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  firstPaidReturn,
  ORDER_ID_MAX,
  parseShellFragment,
  SEEN_ORDERS_KEY,
} from "../../src/client/app/fragments.ts";
import { applyAuthFragment } from "../../src/client/app/notices.ts";
import { consumeAuthFragment, loadSession, setSession } from "../../src/client/session.ts";

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

describe("OAuth return at boot (ADR 0007 R4)", () => {
  const GUEST = { token: "guest.tok", accountId: "guest-1", name: "Guest-1" };

  function memory(initial: Record<string, string> = {}) {
    const m = new Map(Object.entries(initial));
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  }

  function tokenFor(identity: Record<string, unknown>): string {
    const b64 = btoa(JSON.stringify(identity))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    return `${b64}.c2ln`;
  }

  /** Boots like App.tsx with `hash` in the URL; returns the stores. */
  function boot(hash: string, nonce?: string) {
    const local = memory({ "gamez.guest.v1": JSON.stringify(GUEST) });
    const tab = memory(nonce ? { "gamez.oauth.nonce": nonce } : {});
    const loc = { hash, pathname: "/", search: "" };
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", tab);
    vi.stubGlobal("location", loc);
    vi.stubGlobal("history", {
      state: null,
      replaceState() {
        loc.hash = "";
      },
    });
    const notice = applyAuthFragment(consumeAuthFragment(), setSession);
    return { local, tab, loc, notice };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ATTACKER = tokenFor({ accountId: "attacker", name: "Mallory", issuedAt: 1 });
  const NONCE = "abcdefghijklmnop-0123";

  it("a planted #auth=<token> without a stored nonce keeps the guest session", () => {
    const { local, loc, notice } = boot(`#auth=${ATTACKER}&n=${NONCE}`);
    expect(loadSession()).toEqual(GUEST);
    expect(local.m.has("gamez.guest.prev.v1")).toBe(false);
    expect(loc.hash).toBe("");
    expect(notice?.tone).toBe("error");
    expect(notice?.text).toBe("Sign-in expired. Try again.");
  });

  it("a forged token (no nonce at all) cannot overwrite the guest either", () => {
    boot(`#auth=${tokenFor({ accountId: "x", name: "y" })}`);
    expect(loadSession()).toEqual(GUEST);
  });

  it("the browser's own sign-in (matching nonce) is adopted, the guest is backed up", () => {
    const { local, tab, notice } = boot(`#auth=${ATTACKER}&n=${NONCE}`, NONCE);
    expect(loadSession()?.accountId).toBe("attacker");
    expect(JSON.parse(local.m.get("gamez.guest.prev.v1") ?? "null")).toEqual(GUEST);
    expect(tab.m.has("gamez.oauth.nonce")).toBe(false);
    expect(notice?.tone).toBe("ok");
  });
});

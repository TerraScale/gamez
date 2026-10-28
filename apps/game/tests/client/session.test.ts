import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearSession,
  consumeAuthFragment,
  decodeTokenPayload,
  getSession,
  loadSession,
  onSessionChange,
  setSession,
  type GuestSession,
} from "../../src/client/session.ts";

/** In-memory localStorage stand-in. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const KEY = "gamez.guest.v1";

/** A token in the server's format: base64url(JSON identity) + "." + signature. */
function tokenFor(identity: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${b64}.c2ln`;
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session storage", () => {
  it("round-trips a session, keeping kind", () => {
    const s: GuestSession = { token: "t", accountId: "a", name: "Hero", kind: "registered" };
    setSession(s);
    expect(JSON.parse(storage.data.get(KEY) ?? "null")).toEqual(s);
    expect(loadSession()).toEqual(s);
  });

  it("loads a guest session without kind as a guest", () => {
    storage.data.set(KEY, JSON.stringify({ token: "t", accountId: "a", name: "Guest" }));
    expect(loadSession()).toEqual({ token: "t", accountId: "a", name: "Guest" });
  });

  it("ignores corrupt or incomplete stored sessions", () => {
    storage.data.set(KEY, "{not json");
    expect(loadSession()).toBeNull();
    storage.data.set(KEY, JSON.stringify({ token: "t" }));
    expect(loadSession()).toBeNull();
  });

  it("clearSession removes the stored session", () => {
    setSession({ token: "t", accountId: "a", name: "n" });
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it("survives blocked storage (reads answer null, writes are dropped)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadSession()).toBeNull();
    expect(() => setSession({ token: "t", accountId: "a", name: "n" })).not.toThrow();
    expect(() => clearSession()).not.toThrow();
  });
});

describe("session change notifications", () => {
  it("notifies every listener on setSession and stops after unsubscribe", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = onSessionChange(first);
    onSessionChange(second);
    setSession({ token: "t1", accountId: "a", name: "n" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    setSession({ token: "t2", accountId: "a", name: "n" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("one throwing listener does not block the others", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const later = vi.fn();
    onSessionChange(() => {
      throw new Error("boom");
    });
    onSessionChange(later);
    setSession({ token: "t", accountId: "a", name: "n" });
    expect(later).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("getSession", () => {
  it("returns the cached session without a request", async () => {
    setSession({ token: "cached", accountId: "a", name: "n" });
    const fetchFn = vi.fn();
    expect(await getSession(fetchFn)).toEqual({ token: "cached", accountId: "a", name: "n" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("creates a guest with POST /api/guest when nothing is cached, and does not notify", async () => {
    const notified = vi.fn();
    const unsubscribe = onSessionChange(notified);
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ token: "new", accountId: "g1", name: "Guest-1", kind: "guest" }),
          {
            status: 200,
          },
        ),
    );
    const s = await getSession(fetchFn);
    expect(s).toEqual({ token: "new", accountId: "g1", name: "Guest-1", kind: "guest" });
    expect(fetchFn).toHaveBeenCalledWith("/api/guest", { method: "POST" });
    expect(loadSession()).toEqual(s);
    expect(notified).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("throws when the guest request fails", async () => {
    const fetchFn = async () => new Response("no", { status: 503 });
    await expect(getSession(fetchFn)).rejects.toThrow(/503/);
  });
});

describe("decodeTokenPayload", () => {
  it("reads accountId, name and kind without verifying", () => {
    const token = tokenFor({
      accountId: "acc-9",
      name: "Hero Ünï",
      issuedAt: 1,
      kind: "registered",
    });
    expect(decodeTokenPayload(token)).toEqual({
      accountId: "acc-9",
      name: "Hero Ünï",
      kind: "registered",
    });
  });

  it("returns null for junk", () => {
    expect(decodeTokenPayload("")).toBeNull();
    expect(decodeTokenPayload("not-base64.sig")).toBeNull();
    expect(decodeTokenPayload(tokenFor({ name: "no account" }))).toBeNull();
  });
});

describe("consumeAuthFragment", () => {
  interface FakeWindow {
    hash: string;
    pathname: string;
    search: string;
    replaced: string[];
  }

  /** Installs a fake location/history pair and returns it for inspection. */
  function fakeWindow(hash: string): FakeWindow {
    const win: FakeWindow = { hash, pathname: "/", search: "?x=1", replaced: [] };
    vi.stubGlobal("location", win);
    vi.stubGlobal("history", {
      state: null,
      replaceState(_state: unknown, _title: string, url: string) {
        win.replaced.push(url);
        win.hash = "";
      },
    });
    return win;
  }

  it("turns #auth=<token> into a session and clears the fragment", () => {
    const token = tokenFor({
      accountId: "acc-7",
      name: "Oauth Hero",
      issuedAt: 2,
      kind: "registered",
    });
    const win = fakeWindow(`#auth=${token}`);
    expect(consumeAuthFragment()).toEqual({
      session: { token, accountId: "acc-7", name: "Oauth Hero", kind: "registered" },
    });
    expect(win.replaced).toEqual(["/?x=1"]);
    expect(win.hash).toBe("");
  });

  it("returns the error code of #auth_error=<code> and clears the fragment", () => {
    const win = fakeWindow("#auth_error=identity_taken");
    expect(consumeAuthFragment()).toEqual({ error: "identity_taken" });
    expect(win.replaced).toHaveLength(1);
  });

  it("reports a malformed token as bad_token", () => {
    fakeWindow("#auth=garbage");
    expect(consumeAuthFragment()).toEqual({ error: "bad_token" });
  });

  it("returns null without an auth fragment and leaves the URL alone", () => {
    const win = fakeWindow("#some-other-anchor");
    expect(consumeAuthFragment()).toBeNull();
    expect(win.replaced).toHaveLength(0);
    win.hash = "";
    expect(consumeAuthFragment()).toBeNull();
  });

  it("returns null when there is no window (node tests, workers)", () => {
    vi.stubGlobal("location", undefined);
    expect(consumeAuthFragment()).toBeNull();
  });
});

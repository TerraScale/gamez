/** Guest login, cached in localStorage so a reload keeps the same character. */

export interface GuestSession {
  token: string;
  accountId: string;
  name: string;
  /** Wave B: absent = guest. */
  kind?: "guest" | "registered";
}

const KEY = "gamez.guest.v1";

function parseSession(raw: unknown): GuestSession | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<GuestSession>;
  if (
    typeof s.token !== "string" ||
    typeof s.accountId !== "string" ||
    typeof s.name !== "string"
  ) {
    return null;
  }
  const session: GuestSession = { token: s.token, accountId: s.accountId, name: s.name };
  if (s.kind === "guest" || s.kind === "registered") session.kind = s.kind;
  return session;
}

export function loadSession(): GuestSession | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    return parseSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveSession(s: GuestSession): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or blocked storage: the session just won't survive a reload.
  }
}

export function clearSession(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Ignore.
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Cached session, or a new guest from POST /api/guest. `fetchFn` is injectable
 * for tests; the new guest is cached but listeners are not notified (use
 * setSession for that).
 */
export async function getSession(
  fetchFn: FetchLike = (input, init) => globalThis.fetch(input, init),
): Promise<GuestSession> {
  const cached = loadSession();
  if (cached) return cached;
  const res = await fetchFn("/api/guest", { method: "POST" });
  if (!res.ok) throw new Error(`guest login failed: ${res.status}`);
  const s = parseSession(await res.json());
  if (!s) throw new Error("guest login failed: bad response");
  saveSession(s);
  return s;
}

// ---- wave B (docs/design/wave-B.md §8.1). CONTRACT: keep these signatures.

const listeners = new Set<() => void>();

/** Tells every listener that the session changed (used after logout failures too). */
export function notifySessionChange(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (err) {
      console.warn("session listener failed", err);
    }
  }
}

/** Stores a new session (login, register, OAuth return, logout -> new guest) and notifies listeners. */
export function setSession(s: GuestSession): void {
  saveSession(s);
  notifySessionChange();
}

/** Subscribes to session changes; returns the unsubscribe function. */
export function onSessionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Decodes the payload part of a session token (base64url JSON), without verifying it. */
export function decodeTokenPayload(
  token: string,
): { accountId: string; name: string; kind?: "guest" | "registered" } | null {
  try {
    const part = token.split(".")[0] ?? "";
    if (!part) return null;
    const b64 = part.replaceAll("-", "+").replaceAll("_", "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof data.accountId !== "string" || !data.accountId) return null;
    const name = typeof data.name === "string" ? data.name : "";
    const out: { accountId: string; name: string; kind?: "guest" | "registered" } = {
      accountId: data.accountId,
      name,
    };
    if (data.kind === "guest" || data.kind === "registered") out.kind = data.kind;
    return out;
  } catch {
    return null;
  }
}

/** Longest error code we accept from the fragment (anything longer is noise). */
const MAX_FRAGMENT_CODE = 64;

/**
 * After an OAuth redirect the Worker sends the browser to `/#auth=<token>` or
 * `/#auth_error=<code>`. Reads and clears that fragment (history.replaceState).
 * The token's payload (base64url JSON, not verified here) gives accountId and name.
 * Returns null when the URL carries no auth fragment (or there is no window).
 * The caller decides whether to setSession().
 */
export function consumeAuthFragment(): { session: GuestSession } | { error: string } | null {
  try {
    const loc = (globalThis as { location?: Location }).location;
    if (!loc || typeof loc.hash !== "string" || !loc.hash.includes("auth")) return null;
    const params = new URLSearchParams(loc.hash.replace(/^#/, ""));
    const token = params.get("auth");
    const errorCode = params.get("auth_error");
    if (!token && errorCode === null) return null;

    clearFragment(loc);

    if (errorCode !== null) {
      return { error: errorCode.slice(0, MAX_FRAGMENT_CODE) || "oauth_failed" };
    }
    const payload = token ? decodeTokenPayload(token) : null;
    if (!token || !payload) return { error: "bad_token" };
    const session: GuestSession = { token, accountId: payload.accountId, name: payload.name };
    if (payload.kind) session.kind = payload.kind;
    return { session };
  } catch {
    return null;
  }
}

/** Removes the fragment without a navigation or a hashchange event. */
function clearFragment(loc: Location): void {
  try {
    const history = (globalThis as { history?: History }).history;
    if (history) history.replaceState(history.state, "", loc.pathname + loc.search);
  } catch {
    // Ignore: the fragment stays, and consumeAuthFragment reads it again next boot.
  }
}

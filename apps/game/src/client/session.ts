/** Guest login, cached in localStorage so a reload keeps the same character. */

export interface GuestSession {
  token: string;
  accountId: string;
  name: string;
  /** Wave B: absent = guest. */
  kind?: "guest" | "registered";
}

const KEY = "gamez.guest.v1";
/** ADR 0007 R4: the last guest session replaced by another account (recoverable). */
export const PREV_GUEST_KEY = "gamez.guest.prev.v1";
/** ADR 0007 R4: per-tab nonce of the OAuth flow this browser started. */
export const OAUTH_NONCE_KEY = "gamez.oauth.nonce";
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

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

/**
 * Stores a new session (login, register, OAuth return, logout -> new guest) and notifies listeners.
 * A guest session replaced by a different account is first copied to
 * PREV_GUEST_KEY: a guest has no other credential, so it stays recoverable.
 */
export function setSession(s: GuestSession): void {
  backupGuest(loadSession(), s);
  saveSession(s);
  notifySessionChange();
}

function backupGuest(current: GuestSession | null, next: GuestSession): void {
  if (!current || (current.kind ?? "guest") !== "guest") return;
  if (current.accountId === next.accountId) return;
  try {
    globalThis.localStorage?.setItem(PREV_GUEST_KEY, JSON.stringify(current));
  } catch {
    // Blocked storage: nothing to keep.
  }
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
/** Longest link code we accept from the fragment. */
const MAX_LINK_CODE = 2048;

function tabStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  return (globalThis as { sessionStorage?: Storage }).sessionStorage;
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Starts an OAuth flow (ADR 0007 R4): a fresh random nonce (32 of
 * [A-Za-z0-9_-]) stored in sessionStorage for this tab, to pass to /start
 * as `?n=`. The return fragment is accepted only when it echoes it. Blocked
 * storage still returns a nonce; that flow then fails safely on return.
 */
export function beginOAuthNonce(): string {
  const nonce = randomNonce();
  try {
    tabStorage()?.setItem(OAUTH_NONCE_KEY, nonce);
  } catch {
    // Blocked storage: the return is refused ("sign-in expired").
  }
  return nonce;
}

/** True (and the nonce is used up) when `n` is this tab's pending OAuth nonce. */
function takeNonce(n: string | null): boolean {
  try {
    const store = tabStorage();
    const stored = store?.getItem(OAUTH_NONCE_KEY) ?? null;
    if (!stored || !NONCE_PATTERN.test(stored) || n !== stored) return false;
    store?.removeItem(OAUTH_NONCE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** What an OAuth return fragment means for the app shell. */
export type AuthFragmentResult = { session: GuestSession } | { link: string } | { error: string };

/**
 * After an OAuth redirect the Worker sends the browser to `/#auth=<token>&n=`,
 * `/#oauth_link=<code>&n=` or `/#auth_error=<code>&n=`. Reads and always clears
 * that fragment (history.replaceState). ADR 0007 R4: the result counts only
 * when `n` equals the nonce this tab stored at beginOAuthNonce() (then removed);
 * anything else (a planted link, another tab's flow) is `{ error: "oauth_expired" }`
 * and never a session. The token's payload (base64url JSON, not verified here)
 * gives accountId and name. Returns null when the URL carries no auth fragment
 * (or there is no window). The caller decides whether to setSession().
 */
export function consumeAuthFragment(): AuthFragmentResult | null {
  try {
    const loc = (globalThis as { location?: Location }).location;
    if (!loc || typeof loc.hash !== "string" || !loc.hash.includes("auth")) return null;
    const params = new URLSearchParams(loc.hash.replace(/^#/, ""));
    const token = params.get("auth");
    const linkCode = params.get("oauth_link");
    const errorCode = params.get("auth_error");
    if (!token && !linkCode && errorCode === null) return null;

    clearFragment(loc);

    if (!takeNonce(params.get("n"))) return { error: "oauth_expired" };
    if (errorCode !== null) {
      return { error: errorCode.slice(0, MAX_FRAGMENT_CODE) || "oauth_failed" };
    }
    if (linkCode) {
      return linkCode.length <= MAX_LINK_CODE ? { link: linkCode } : { error: "oauth_failed" };
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

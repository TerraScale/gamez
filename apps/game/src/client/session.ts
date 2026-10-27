/** Guest login, cached in localStorage so a reload keeps the same character. */

export interface GuestSession {
  token: string;
  accountId: string;
  name: string;
}

const KEY = "gamez.guest.v1";

export function loadSession(): GuestSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<GuestSession>;
    return typeof s.token === "string" &&
      typeof s.accountId === "string" &&
      typeof s.name === "string"
      ? { token: s.token, accountId: s.accountId, name: s.name }
      : null;
  } catch {
    return null;
  }
}

export function saveSession(s: GuestSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or blocked storage: the session just won't survive a reload.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Ignore.
  }
}

/** Cached session, or a new guest from POST /api/guest. */
export async function getSession(): Promise<GuestSession> {
  const cached = loadSession();
  if (cached) return cached;
  const res = await fetch("/api/guest", { method: "POST" });
  if (!res.ok) throw new Error(`guest login failed: ${res.status}`);
  const s = (await res.json()) as GuestSession;
  saveSession(s);
  return s;
}

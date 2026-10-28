/**
 * Onboarding tips, step 4: which tips the player dismissed, remembered in localStorage under
 * `gamez.classic.tips.v1` (a JSON array of tip ids). Every storage access is wrapped: a private
 * window, blocked storage or a full quota falls back to memory for the session.
 */
export const TIPS_STORAGE_KEY = "gamez.classic.tips.v1";
/** Upper bound of stored ids (the tip catalogue is much smaller). */
const MAX_IDS = 100;

export interface TipStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TipsStore {
  /** Stable Set object until it changes (safe for useSyncExternalStore). */
  dismissed(): ReadonlySet<string>;
  dismiss(id: string): void;
  /** Forgets every dismissal (Settings: "Reset tips"). */
  reset(): void;
  subscribe(onChange: () => void): () => void;
}

/** Parses a stored value: a JSON array of strings (anything else is ignored). */
export function parseDismissed(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string").slice(0, MAX_IDS);
  } catch {
    return [];
  }
}

/** The browser's localStorage, or null when it is missing or blocked. */
export function browserTipStorage(): TipStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function createTipsStore(storage: TipStorage | null): TipsStore {
  const read = (): Set<string> => {
    try {
      return new Set(parseDismissed(storage ? storage.getItem(TIPS_STORAGE_KEY) : null));
    } catch {
      return new Set();
    }
  };
  let state = read();
  const listeners = new Set<() => void>();
  const save = (): void => {
    try {
      if (state.size === 0) storage?.removeItem(TIPS_STORAGE_KEY);
      else storage?.setItem(TIPS_STORAGE_KEY, JSON.stringify([...state]));
    } catch {
      // Storage is unavailable: the dismissals still hold for this session.
    }
  };
  const emit = (): void => {
    for (const l of listeners) l();
  };
  return {
    dismissed: () => state,
    dismiss(id) {
      if (state.has(id)) return;
      state = new Set([...state, id]);
      save();
      emit();
    },
    reset() {
      if (state.size === 0) {
        save();
        return;
      }
      state = new Set();
      save();
      emit();
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}

/** The app-wide store (browser storage when available). */
export const tipsStore: TipsStore = createTipsStore(browserTipStorage());

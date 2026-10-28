/**
 * React glue for the economy components: a ticking clock for timers and the
 * shared "action in flight" state (disable while pending, show the server's
 * message on failure).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResult } from "../../platform.ts";
import { economyErrorText } from "./text.ts";
import type { LoadState } from "./flows.ts";

/** Current time (epoch ms), refreshed every `intervalMs`. Initial value is read during render. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export interface ActionState {
  /** True while any action of this component is in flight. */
  busy: boolean;
  /** The last failure: the server's message, else the plain-words copy for its code. */
  error: string | null;
  /** Runs one action; resolves to its result and never rejects. */
  run<T>(fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>;
  clear(): void;
}

export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async <T>(fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    setBusy(true);
    setError(null);
    let res: ApiResult<T>;
    try {
      res = await fn();
    } catch {
      res = { ok: false, code: "network", message: "" };
    }
    if (alive.current) {
      setBusy(false);
      if (!res.ok) setError(res.message || economyErrorText(res.code));
    }
    return res;
  }, []);

  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}

/**
 * Loads `load()` for `key` (a string of every input it depends on) and keeps the
 * last answer while `reload()` fetches again, so a refresh after a bid or a
 * stock change does not unmount a form the player is editing. `state` is
 * undefined while the current key has no answer yet.
 */
export function useReload<T>(
  load: () => Promise<LoadState<T>>,
  key: string,
): { state: LoadState<T> | undefined; reload: () => void } {
  const [rev, setRev] = useState(0);
  const [seen, setSeen] = useState<{ key: string; state: LoadState<T> } | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((state) => {
      if (live) setSeen({ key, state });
    });
    return () => {
      live = false;
    };
    // Re-runs when the key or a reload request changes; `load` reads the same inputs as `key`.
  }, [key, rev]);
  const reload = useCallback(() => setRev((r) => r + 1), []);
  return { state: seen && seen.key === key ? seen.state : undefined, reload };
}

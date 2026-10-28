import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { GAME_DIR, VP_BIN } from "./paths.ts";

export interface DevServer {
  url: string;
  /** Milliseconds from spawn until /api/health answered. */
  startupMs: number;
  stop(): Promise<void>;
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Private state for the e2e server on `port` (apps/game/vite.config.ts reads the env). */
export function e2eStateDirs(port: number): { persist: string; cache: string } {
  const base = `/tmp/gamez-e2e-state-${port}`;
  return { persist: `${base}/persist`, cache: `${base}/vite` };
}

/** Wipes the e2e server's private state: each e2e run starts from empty DOs and D1. */
export function resetE2eState(port: number): void {
  const { persist } = e2eStateDirs(port);
  rmSync(persist, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
}

/**
 * Starts `vp dev` for apps/game in its own process group (so stop() also ends
 * workerd) and waits for /api/health. Output is appended to `logFile`.
 * The server persists into /tmp/gamez-e2e-state-<port> (DO + D1 SQLite, Vite dep
 * cache), never into apps/game/.cloudflare/state, which the live :5173 server uses:
 * two workerd processes on one SQLite file hit SQLITE_BUSY, and a shared dep cache
 * makes one server's re-optimisation answer 504 to the other.
 */
export async function startDevServer(port: number, logFile: string): Promise<DevServer> {
  const url = `http://localhost:${port}`;
  if (await healthy(url))
    throw new Error(`something already serves ${url}; stop it or set E2E_PORT`);
  const log = openSync(logFile, "a");
  const started = performance.now();
  const dirs = e2eStateDirs(port);
  const child = spawn(VP_BIN, ["dev", "--port", String(port), "--strictPort"], {
    cwd: GAME_DIR,
    env: { ...process.env, GAMEZ_PERSIST_STATE: dirs.persist, GAMEZ_VITE_CACHE_DIR: dirs.cache },
    detached: true,
    stdio: ["ignore", log, log],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let dead = false;
  void exited.then(() => (dead = true));

  const stop = async (): Promise<void> => {
    if (dead || child.pid === undefined) return;
    process.kill(-child.pid, "SIGTERM");
    const timeout = setTimeout(() => {
      if (!dead && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, 5000);
    await exited;
    clearTimeout(timeout);
  };

  const deadline = Date.now() + 60_000;
  while (!(await healthy(url))) {
    if (dead) throw new Error(`dev server exited during startup; see ${logFile}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`dev server did not become healthy in 60 s; see ${logFile}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { url, startupMs: performance.now() - started, stop };
}

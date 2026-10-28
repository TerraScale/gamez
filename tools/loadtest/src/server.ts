/**
 * Starts a private `vp dev` for the swarm (never the user's :5173) in its own
 * process group, so stop() ends workerd too. Mirrors tools/e2e/src/dev-server.ts
 * but exposes the pid for CPU sampling.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GAME_DIR = resolve(ROOT, "apps/game");
const VP_BIN = resolve(ROOT, "node_modules/.bin/vp");
const ISOLATED_CONFIG = resolve(ROOT, "tools/loadtest/vite.isolated.config.mjs");

/** The user's live dev server; the swarm refuses to touch it. */
export const PROTECTED_PORTS: readonly number[] = [5173];

export interface SwarmServer {
  url: string;
  pid: number;
  stop(): Promise<void>;
}

export function assertSafeUrl(url: string): void {
  const port = Number(new URL(url).port || 80);
  if (PROTECTED_PORTS.includes(port)) {
    throw new Error(`refusing to load-test ${url}: port ${port} is the live dev server`);
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/**
 * Starts the game on `port`. With `stateDir` (the default for the swarm) the
 * server persists into that directory instead of apps/game/.cloudflare/state,
 * which the user's live server and the e2e servers share: a load test on the
 * shared files makes both workerd processes hit SQLITE_BUSY on the same ChunkDO.
 */
export async function startServer(
  port: number,
  logFile: string,
  stateDir: string | null = `/tmp/gamez-loadtest-state/${port}`,
  extraEnv: Record<string, string> = {},
  /** "dev" (vp dev, vite module runner) or "preview" (the production build in .cloudflare/output). */
  mode: "dev" | "preview" = "dev",
): Promise<SwarmServer> {
  const url = `http://127.0.0.1:${port}`;
  assertSafeUrl(url);
  if (await healthy(url))
    throw new Error(`something already serves ${url}; pick another --serve port`);
  const log = openSync(logFile, "a");
  const args = [mode, "--port", String(port), "--strictPort"];
  if (stateDir) args.push("--config", ISOLATED_CONFIG);
  const child = spawn(VP_BIN, args, {
    cwd: GAME_DIR,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      ...extraEnv,
      ...(stateDir ? { GAMEZ_LOADTEST_STATE: stateDir } : {}),
    },
  });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  let dead = false;
  void exited.then(() => (dead = true));
  const pid = child.pid!;
  const stop = async (): Promise<void> => {
    if (dead) return;
    process.kill(-pid, "SIGTERM");
    const t = setTimeout(() => !dead && process.kill(-pid, "SIGKILL"), 5000);
    await exited;
    clearTimeout(t);
  };
  const deadline = Date.now() + 90_000;
  // Preview needs a build first: `node_modules/.bin/vp -C apps/game build`.
  while (!(await healthy(url))) {
    if (dead) throw new Error(`dev server exited during startup; see ${logFile}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`dev server not healthy in 90 s; see ${logFile}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { url, pid, stop };
}

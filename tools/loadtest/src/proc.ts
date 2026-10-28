/**
 * CPU and memory of a local process tree from /proc (Linux only; elsewhere
 * every sample is empty). Used to watch the workerd processes under a dev server.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

let clockTicks: number | null = null;

/** Kernel clock ticks per second (CLK_TCK), usually 100. */
export function ticksPerSecond(): number {
  if (clockTicks === null) {
    try {
      clockTicks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
    } catch {
      clockTicks = 100;
    }
  }
  return clockTicks;
}

interface Stat {
  pid: number;
  ppid: number;
  comm: string;
  /** utime + stime in clock ticks. */
  ticks: number;
}

function readStat(pid: number): Stat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const comm = raw.slice(raw.indexOf("(") + 1, close);
    const f = raw.slice(close + 2).split(" ");
    // f[0] = state (field 3), so field n is f[n - 3].
    return { pid, ppid: Number(f[1]), comm, ticks: Number(f[11]) + Number(f[12]) };
  } catch {
    return null;
  }
}

function rssKb(pid: number): number {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** Every live process below `root` (excluding it). */
export function descendants(root: number): Stat[] {
  let all: Stat[];
  try {
    all = readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .map((d) => readStat(Number(d)))
      .filter((s): s is Stat => s !== null);
  } catch {
    return [];
  }
  const children = new Map<number, Stat[]>();
  for (const s of all) {
    const list = children.get(s.ppid) ?? [];
    list.push(s);
    children.set(s.ppid, list);
  }
  const out: Stat[] = [];
  const stack = [root];
  while (stack.length > 0) {
    for (const c of children.get(stack.pop()!) ?? []) {
      out.push(c);
      stack.push(c.pid);
    }
  }
  return out;
}

export interface ProcSample {
  at: number;
  /** pid -> cpu ticks. */
  ticks: Map<number, number>;
  rssKb: number;
  procs: string[];
}

/** Samples the processes below `root` whose name matches `match` (default: workerd). */
export function sampleTree(root: number | null, match = /workerd/): ProcSample {
  const at = performance.now();
  const ticks = new Map<number, number>();
  let rss = 0;
  const procs: string[] = [];
  if (root !== null) {
    for (const s of descendants(root)) {
      if (!match.test(s.comm)) continue;
      ticks.set(s.pid, s.ticks);
      rss += rssKb(s.pid);
      procs.push(`${s.comm}:${s.pid}`);
    }
  }
  return { at, ticks, rssKb: rss, procs };
}

/** CPU use between two samples, in % of one core (200 = two cores busy). */
export function cpuPercent(a: ProcSample, b: ProcSample): number {
  let ticks = 0;
  for (const [pid, t] of b.ticks) ticks += t - (a.ticks.get(pid) ?? t);
  const seconds = (b.at - a.at) / 1000;
  return seconds > 0 ? (ticks / ticksPerSecond() / seconds) * 100 : 0;
}

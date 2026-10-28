/**
 * Analytics factories (docs/design/admin-dashboard.md §4). OWNER: T-analytics-core.
 *
 * Write path (`analyticsFor`): every point goes to the Analytics Engine binding
 * when bound (never awaited, errors swallowed) and, when the local sink is on,
 * to a per-isolate buffer that flushes to MetricsDO "local" through
 * `waitUntil`: at LOCAL_LIMITS.flushAt points, shortly after the first
 * buffered point (LOCAL_FLUSH_DELAY_MS, so callers that never call flush()
 * still deliver), and on flush(). Above LOCAL_LIMITS.perSecond points per
 * second per isolate the local sink keeps 1 in N points with sample = N, so
 * weighted sums stay right. AE applies its own sampling.
 *
 * Query path (`analyticsQueryFor`): AE SQL with credentials, else MetricsDO,
 * else EMPTY_QUERY.
 */
import { aeSqlQuery } from "./ae-sql.ts";
import { localQuery, LOCAL_METRICS_NAME, type MetricsNamespaceLike } from "./query-local.ts";
import {
  METRICS,
  toStoredPoint,
  type BlobsOf,
  type DoublesOf,
  type MetricName,
  type StoredPoint,
} from "./schema.ts";
import {
  LOCAL_LIMITS,
  type Analytics,
  type AnalyticsEnv,
  type AnalyticsQuery,
  type DistinctQuery,
  type QuantileQuery,
  type SeriesQuery,
  type SeriesRow,
  type TotalsQuery,
  type TotalsRow,
} from "./types.ts";

export type { Analytics, AnalyticsEnv, AnalyticsQuery } from "./types.ts";

export type WaitUntil = (promise: Promise<unknown>) => void;

/** A writer that drops everything (tests, and envs without any sink). */
export const NOOP_ANALYTICS: Analytics = {
  write() {},
  flush: () => Promise.resolve(),
};

/** True when points should also go to MetricsDO "local". */
export function localSinkOn(env: AnalyticsEnv): boolean {
  if (env.ANALYTICS_LOCAL === "0" || !env.METRICS) return false;
  if (env.ANALYTICS_LOCAL === "1") return true;
  return !(env.ANALYTICS_ACCOUNT_ID && env.ANALYTICS_API_TOKEN);
}

/** AE limit on index1. */
export const MAX_INDEX_BYTES = 96;
/** Delay of the automatic local flush after the first buffered point. */
export const LOCAL_FLUSH_DELAY_MS = 100;

/** Cuts a string to at most `max` UTF-8 bytes without splitting a code point. */
export function cutUtf8(s: string, max = MAX_INDEX_BYTES): string {
  if (s.length * 3 <= max) return s;
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > max) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/** Per-isolate local sink state (one module-level instance; tests make their own). */
export interface LocalSinkState {
  buffer: StoredPoint[];
  scheduled: boolean;
  /** Current second (epoch s) and points seen in it. */
  second: number;
  seen: number;
  /** Points seen in the previous second (seeds N when a burst continues). */
  prevSeen: number;
  /** Current 1-in-N rate for points beyond perSecond, and the overflow counter. */
  every: number;
  overflow: number;
}

export function newLocalSinkState(): LocalSinkState {
  return {
    buffer: [],
    scheduled: false,
    second: -1,
    seen: 0,
    prevSeen: 0,
    every: 1,
    overflow: 0,
  };
}

const ISOLATE_STATE = newLocalSinkState();

/**
 * The sample weight a new local point gets (0 = drop it): 1 for the first
 * `perSecond` points of a second, then 1 in N with weight N, N a power of two
 * at least (points this second, or last second) / perSecond.
 */
export function admitLocal(
  state: LocalSinkState,
  t: number,
  perSecond: number = LOCAL_LIMITS.perSecond,
): number {
  const sec = Math.floor(t / 1000);
  if (sec !== state.second) {
    state.prevSeen = sec === state.second + 1 ? state.seen : 0;
    state.second = sec;
    state.seen = 0;
    state.every = 1;
    state.overflow = 0;
  }
  state.seen++;
  if (state.seen <= perSecond) return 1;
  const ratio = Math.max(state.seen, state.prevSeen) / perSecond;
  let n = Math.max(2, state.every);
  while (n < ratio) n *= 2;
  state.every = n;
  const k = state.overflow++;
  return k % n === 0 ? n : 0;
}

export interface AnalyticsOptions {
  now?: () => number;
  /** Per-isolate state by default; tests pass a fresh one. */
  state?: LocalSinkState;
  /** Waits before the automatic flush; tests pass an immediate one. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** analyticsFor with injectable clock, state and timer (tests). */
export function createAnalytics(
  env: AnalyticsEnv,
  waitUntil: WaitUntil,
  opts: AnalyticsOptions = {},
): Analytics {
  const ae = env.ANALYTICS;
  const ns = localSinkOn(env) ? (env.METRICS as unknown as MetricsNamespaceLike) : null;
  if (!ae && !ns) return NOOP_ANALYTICS;
  const now = opts.now ?? Date.now;
  const state = opts.state ?? ISOLATE_STATE;
  const sleep = opts.sleep ?? defaultSleep;

  const keep = (p: Promise<unknown>): void => {
    try {
      waitUntil(p);
    } catch {
      // A waitUntil outside an invocation: the promise still runs.
    }
  };

  /** Sends the buffer now; never rejects. */
  const send = (): Promise<void> => {
    if (!ns || state.buffer.length === 0) return Promise.resolve();
    const batch = state.buffer.splice(0, state.buffer.length);
    try {
      return ns
        .getByName(LOCAL_METRICS_NAME)
        .ingest(batch)
        .catch((err: unknown) => {
          console.warn("analytics: local flush failed", err);
        });
    } catch (err) {
      console.warn("analytics: local flush failed", err);
      return Promise.resolve();
    }
  };

  const schedule = (): void => {
    if (state.scheduled) return;
    state.scheduled = true;
    keep(
      sleep(LOCAL_FLUSH_DELAY_MS).then(() => {
        state.scheduled = false;
        return send();
      }),
    );
  };

  return {
    write(metric, blobs, doubles, index) {
      try {
        if (typeof metric !== "string" || !Object.hasOwn(METRICS, metric)) return;
        const t = now();
        const idx = cutUtf8(typeof index === "string" ? index : "");
        const p = toStoredPoint<MetricName>(
          metric,
          (blobs ?? {}) as BlobsOf<MetricName>,
          (doubles ?? {}) as DoublesOf<MetricName>,
          idx,
          t,
        );
        p.blobs = p.blobs.map((b) => (typeof b === "string" ? b : String(b)));
        if (ae) {
          try {
            ae.writeDataPoint({ blobs: p.blobs, doubles: p.doubles, indexes: [idx] });
          } catch (err) {
            console.warn("analytics: writeDataPoint failed", err);
          }
        }
        if (ns) {
          const weight = admitLocal(state, t);
          if (weight === 0) return;
          p.sample = weight;
          state.buffer.push(p);
          if (state.buffer.length >= LOCAL_LIMITS.flushAt) keep(send());
          else schedule();
        }
      } catch (err) {
        // write() never throws into gameplay or request code.
        console.warn("analytics: write failed", err);
      }
    },
    flush() {
      const p = send();
      keep(p);
      return p;
    },
  };
}

/**
 * The writer for one invocation (Worker fetch/queue, or a DO). `waitUntil`
 * keeps the local flush alive past the response. Never throws.
 */
export function analyticsFor(env: AnalyticsEnv, waitUntil: WaitUntil): Analytics {
  return createAnalytics(env, waitUntil);
}

/** An AnalyticsQuery answering nothing (source "none"). */
export const EMPTY_QUERY: AnalyticsQuery = {
  source: "none",
  totals: <M extends MetricName>(_q: TotalsQuery<M>): Promise<TotalsRow[]> => Promise.resolve([]),
  series: <M extends MetricName>(_q: SeriesQuery<M>): Promise<SeriesRow[]> => Promise.resolve([]),
  quantiles: <M extends MetricName>(q: QuantileQuery<M>): Promise<number[]> =>
    Promise.resolve(q.q.map(() => 0)),
  distinct: <M extends MetricName>(_q: DistinctQuery<M>): Promise<number> => Promise.resolve(0),
};

/**
 * The query backend: AE SQL API when ANALYTICS_ACCOUNT_ID + ANALYTICS_API_TOKEN
 * are set, else MetricsDO "local" when bound and not disabled, else EMPTY_QUERY.
 */
export function analyticsQueryFor(
  env: AnalyticsEnv,
  fetchFn: typeof fetch = fetch,
): AnalyticsQuery {
  if (env.ANALYTICS_ACCOUNT_ID && env.ANALYTICS_API_TOKEN) {
    return aeSqlQuery({
      accountId: env.ANALYTICS_ACCOUNT_ID,
      token: env.ANALYTICS_API_TOKEN,
      dataset: env.ANALYTICS_DATASET,
      fetchFn,
    });
  }
  if (env.METRICS && env.ANALYTICS_LOCAL !== "0") {
    return localQuery(env.METRICS as unknown as MetricsNamespaceLike);
  }
  return EMPTY_QUERY;
}

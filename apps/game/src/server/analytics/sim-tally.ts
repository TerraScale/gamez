/**
 * Folds verified play into "sim.tally" / "sim.offline" / "verify.*" points
 * (docs/design/admin-dashboard.md §5). OWNER: T-sim-analytics.
 *
 * Lifecycle inside VerifiedHost (one SimTally per instance, in memory):
 *   replaySegment(sim, msg, { ..., onEvents: tally.onEvents })
 *   ok   -> tally.commit(sim.world, msg.toTick - msg.fromTick, out.costMs)
 *   fail -> tally.abort(out.code)            (pending events dropped)
 *   resync sent      -> tally.resync(code)
 *   offline granted  -> tally.offline(sim.world, elapsedMs, res.events)
 *   compaction / socket close / tally.due(now) -> tally.flush(analytics, accountId, now)
 * Never throws: hook errors are swallowed (analytics must not break verification).
 *
 * Points written by flush (one AE point each, index1 = accountId):
 *   - verify.segment: one per outcome ("ok" or a ResyncCode) per flush, doubles
 *     ticks/costMs summed over the flush. Its point count is per flush, so it
 *     is not a segment count: use the `verify.segments` counter for that.
 *   - verify.resync: one per code per flush (presence only; count in `verify.resyncs`).
 *   - sim.offline: one per offline grant (merged into "other" beyond the cap).
 *   - sim.tally: one per non-zero (metric, k1, k2) counter; `amount` is the sum.
 *     Excess counters fold into k1 = "other" per metric.
 * The counters `verify.segments` (k1 outcome) and `verify.resyncs` (k1 code)
 * carry the true counts (amount = 1 per event), so sums give exact totals.
 */
import type { GameEvent, ModeAnalytics, World } from "@gamez/kernel";
import { MAX_BLOB_CHARS } from "./schema.ts";
import type { Analytics } from "./types.ts";

/** Most points one flush writes (AE allows 250 per invocation; leave room for others). */
export const TALLY_MAX_POINTS = 150;
/** A tally with data flushes at least this often. */
export const TALLY_FLUSH_MS = 5 * 60_000;
/** Distinct counters kept before a flush is due regardless of time. */
export const TALLY_MAX_KEYS = 400;
/**
 * Sim milliseconds per tick used for "sim.ms". Classic runs at 20 Hz (50 ms).
 * The constructor signature is frozen, so the rate is a default here; a mode
 * with another tick rate needs a hook (documented in §5 of the design).
 */
export const MS_PER_TICK = 50;

/** The "other" bucket name used when counters are folded away. */
const OTHER = "other";

interface Counter {
  metric: string;
  k1: string;
  k2: string;
  amount: number;
}

interface SegmentTotals {
  ticks: number;
  costMs: number;
}

interface OfflinePoint {
  levelBand: string;
  ms: number;
  kills: number;
  xp: number;
  gold: number;
  items: number;
  levels: number;
}

const counterKey = (metric: string, k1: string, k2: string): string =>
  `${metric}\u0000${k1}\u0000${k2}`;

const clip = (s: string): string => (s.length > MAX_BLOB_CHARS ? s.slice(0, MAX_BLOB_CHARS) : s);

/** A non-negative finite number, or 0. */
const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** Sorts counters by amount (desc), then by key (asc), so flushes are deterministic. */
function byAmount(a: Counter, b: Counter): number {
  if (a.amount !== b.amount) return b.amount - a.amount;
  const ka = counterKey(a.metric, a.k1, a.k2);
  const kb = counterKey(b.metric, b.k1, b.k2);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Keeps at most `budget` counters. When more exist, the lowest ones fold into
 * k1 = "other" per metric, reserving one slot for each metric's bucket.
 */
export function capCounters(list: readonly Counter[], budget: number): Counter[] {
  if (budget <= 0) return [];
  const sorted = [...list].sort(byAmount);
  if (sorted.length <= budget) return sorted;
  const metrics = new Set(sorted.map((c) => c.metric));
  const keep = Math.max(0, budget - metrics.size);
  const out = new Map<string, Counter>();
  for (const c of sorted.slice(0, keep)) {
    out.set(counterKey(c.metric, c.k1, c.k2), { ...c });
  }
  for (const c of sorted.slice(keep)) {
    const key = counterKey(c.metric, OTHER, "");
    const cur = out.get(key);
    if (cur) cur.amount += c.amount;
    else out.set(key, { metric: c.metric, k1: OTHER, k2: "", amount: c.amount });
  }
  return [...out.values()].sort(byAmount).slice(0, budget);
}

/** Keeps at most `budget` offline points; the overflow merges into one "other" point. */
export function capOffline(list: readonly OfflinePoint[], budget: number): OfflinePoint[] {
  if (budget <= 0) return [];
  if (list.length <= budget) return [...list];
  const keep = Math.max(0, budget - 1);
  const rest = list.slice(keep);
  const merged: OfflinePoint = {
    levelBand: OTHER,
    ms: 0,
    kills: 0,
    xp: 0,
    gold: 0,
    items: 0,
    levels: 0,
  };
  for (const p of rest) {
    merged.ms += p.ms;
    merged.kills += p.kills;
    merged.xp += p.xp;
    merged.gold += p.gold;
    merged.items += p.items;
    merged.levels += p.levels;
  }
  return [...list.slice(0, keep), merged].slice(0, budget);
}

export class SimTally {
  readonly mode: string;
  readonly hooks: ModeAnalytics | undefined;

  /** Events of the segment being replayed; folded on commit, dropped on abort. */
  #buffer: GameEvent[] = [];
  #counters = new Map<string, Counter>();
  /** Per outcome ("ok" or a code): summed ticks/costMs for verify.segment points. */
  #segments = new Map<string, SegmentTotals>();
  /** Per resync code: presence for verify.resync points. */
  #resyncs = new Map<string, number>();
  #offline: OfflinePoint[] = [];
  /** When the first unflushed data was seen by due(); undefined while empty. */
  #since: number | undefined;

  constructor(mode: string, hooks: ModeAnalytics | undefined) {
    this.mode = mode;
    this.hooks = hooks;
  }

  /** Pass as ReplayOptions.onEvents: buffers the segment's events until commit/abort. */
  readonly onEvents = (events: readonly GameEvent[]): void => {
    for (const e of events) this.#buffer.push(e);
  };

  /** The segment verified: fold buffered events, add play ticks by dims, count the segment. */
  commit(world: World, ticks: number, costMs: number): void {
    const events = this.#buffer;
    this.#buffer = [];
    const t = nonNeg(ticks);
    const cost = nonNeg(costMs);
    this.#addSegment("ok", t, cost);
    this.#add("verify.segments", "ok", "", 1);
    const hooks = this.hooks;
    if (!hooks) return;
    const dims = this.#dims(world);
    if (dims) {
      this.#add("play.ms", dims.control, dims.levelBand, cost);
      this.#add("sim.ms", dims.control, dims.levelBand, t * MS_PER_TICK);
    }
    try {
      hooks.fold(events, world, (metric, k1, k2, amount) => this.#add(metric, k1, k2, amount));
    } catch {
      // Analytics must not break verification: a failing fold keeps what it added.
    }
  }

  /** The segment failed (code = replay error / resync code): drop buffered events, count it. */
  abort(code: string): void {
    this.#buffer = [];
    this.#addSegment(clip(code), 0, 0);
    this.#add("verify.segments", clip(code), "", 1);
  }

  /** A resync was sent to the client. */
  resync(code: string): void {
    const c = clip(code);
    this.#resyncs.set(c, (this.#resyncs.get(c) ?? 0) + 1);
    this.#add("verify.resyncs", c, "", 1);
  }

  /**
   * An offline grant was applied (events = the grant dispatch's events). Adds
   * one pending sim.offline point from hooks.offline. The events are not folded.
   */
  offline(world: World, elapsedMs: number, events: readonly GameEvent[]): void {
    const hooks = this.hooks;
    if (!hooks?.offline) return;
    try {
      const summary = hooks.offline(events, world);
      if (!summary) return;
      const dims = this.#dims(world);
      this.#offline.push({
        levelBand: dims?.levelBand ?? "unknown",
        ms: nonNeg(elapsedMs),
        kills: nonNeg(summary.kills),
        xp: nonNeg(summary.xp),
        gold: nonNeg(summary.gold),
        items: nonNeg(summary.items),
        levels: nonNeg(summary.levels),
      });
    } catch {
      // Ignored: analytics never breaks the grant.
    }
  }

  /**
   * True when a flush is due: data older than TALLY_FLUSH_MS or more than
   * TALLY_MAX_KEYS counters. The data's age starts at the first due() call
   * that sees it (no clock is read here), so call it after each commit.
   */
  due(now: number): boolean {
    if (!this.#hasData()) {
      this.#since = undefined;
      return false;
    }
    if (this.#since === undefined) this.#since = now;
    return now - this.#since >= TALLY_FLUSH_MS || this.#counters.size > TALLY_MAX_KEYS;
  }

  /** Writes and clears the counters; returns the number of points written. */
  flush(analytics: Analytics, accountId: string, _now: number): number {
    let written = 0;
    try {
      const mode = this.mode;
      const segKeys = [...this.#segments.keys()].sort();
      const resyncKeys = [...this.#resyncs.keys()].sort();
      const fixed = segKeys.length + resyncKeys.length;
      const offline = capOffline(this.#offline, TALLY_MAX_POINTS - fixed);
      const budget = Math.max(0, TALLY_MAX_POINTS - fixed - offline.length);
      const counters = capCounters([...this.#counters.values()], budget);

      for (const outcome of segKeys) {
        const s = this.#segments.get(outcome);
        if (!s) continue;
        analytics.write(
          "verify.segment",
          { mode, outcome },
          { ticks: s.ticks, costMs: s.costMs },
          accountId,
        );
        written++;
      }
      for (const code of resyncKeys) {
        analytics.write("verify.resync", { mode, code }, {}, accountId);
        written++;
      }
      for (const p of offline) {
        analytics.write(
          "sim.offline",
          { mode, levelBand: p.levelBand },
          { ms: p.ms, kills: p.kills, xp: p.xp, gold: p.gold, items: p.items, levels: p.levels },
          accountId,
        );
        written++;
      }
      for (const c of counters) {
        analytics.write(
          "sim.tally",
          { mode, metric: c.metric, k1: c.k1, k2: c.k2 },
          { amount: c.amount },
          accountId,
        );
        written++;
      }
    } catch {
      // Analytics never throws into the host: the rest of this flush is dropped.
    } finally {
      this.#reset();
    }
    return written;
  }

  #add(metric: string, k1: string, k2: string, amount: number): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    const a = clip(k1);
    const b = clip(k2);
    const key = counterKey(metric, a, b);
    const cur = this.#counters.get(key);
    if (cur) cur.amount += amount;
    else this.#counters.set(key, { metric, k1: a, k2: b, amount });
  }

  #addSegment(outcome: string, ticks: number, costMs: number): void {
    const cur = this.#segments.get(outcome);
    if (cur) {
      cur.ticks += ticks;
      cur.costMs += costMs;
    } else {
      this.#segments.set(outcome, { ticks, costMs });
    }
  }

  #dims(world: World): { control: string; levelBand: string } | null {
    try {
      const d = this.hooks?.dims(world);
      if (!d) return null;
      return { control: clip(d.control), levelBand: clip(d.levelBand) };
    } catch {
      return null;
    }
  }

  #hasData(): boolean {
    return (
      this.#counters.size > 0 ||
      this.#segments.size > 0 ||
      this.#resyncs.size > 0 ||
      this.#offline.length > 0
    );
  }

  #reset(): void {
    this.#counters = new Map();
    this.#segments = new Map();
    this.#resyncs = new Map();
    this.#offline = [];
    this.#since = undefined;
  }
}

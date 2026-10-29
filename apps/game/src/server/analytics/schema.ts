/**
 * Metric catalogue (docs/design/admin-dashboard.md §3). CONTRACT (architect).
 *
 * One Analytics Engine dataset ("gamez_events"). Every data point is:
 *   blob1   = metric name (a key of METRICS)
 *   blob2.. = the metric's `blobs`, in order (strings, bounded cardinality)
 *   double1.. = the metric's `doubles`, in order
 *   index1  = the sampling key: accountId (server events of a player), the
 *             client session id (client.*), the DO id (do.active), or "".
 * The local stub (MetricsDO) stores the same columns, so both query paths
 * read one layout. Adding a field: append it (never reorder) and bump nothing;
 * old points read the new field as "" / 0.
 *
 * Cardinality rule: blob values come from enums, registry ids, route keys or
 * build ids. Never put account ids, names, chat text or raw URLs in a blob.
 */

export const METRICS = {
  /** Every Worker fetch (analytics/http.ts). route = routeKey(pathname). */
  "http.request": {
    blobs: ["route", "method", "statusClass", "country"],
    doubles: ["ms", "status"],
  },
  /** WebSocket accepted / closed. kind: "presence" | "instance" | "chat". */
  "ws.open": { blobs: ["kind", "mode"], doubles: [] },
  "ws.close": { blobs: ["kind", "mode", "code"], doubles: ["durationS"] },
  /** At most once per DO id per DO_ACTIVE_EVERY_MS (index1 = DO name). */
  "do.active": { blobs: ["class"], doubles: [] },
  /** One per queue message (sync consumer). outcome: "ok" | "retry" | "dead". */
  "sync.batch": {
    blobs: ["source", "outcome"],
    doubles: ["records", "lagMs", "applyMs", "attempts"],
  },
  /** Timed D1 reads/writes we own (admin readers, sync apply). outcome: "ok" | "error". */
  "d1.query": { blobs: ["label", "outcome"], doubles: ["ms", "rows"] },
  /** Verified segment results. outcome: "ok" | ResyncCode. */
  "verify.segment": { blobs: ["mode", "outcome"], doubles: ["ticks", "costMs"] },
  /** Resyncs sent to a client (anti-cheat / desync). code: ResyncCode. */
  "verify.resync": { blobs: ["mode", "code"], doubles: [] },
  /**
   * Folded sim counters of verified play (analytics/sim-tally.ts). metric/k1/k2
   * come from ModeAnalytics (kernel types.ts): e.g. ("kill", monsterId, rarity),
   * ("gold", levelBand, source). The host adds ("play.ms", control, levelBand)
   * = wall time (replay cost) and ("sim.ms", control, levelBand) = sim time.
   */
  "sim.tally": { blobs: ["mode", "metric", "k1", "k2"], doubles: ["amount"] },
  /** One per offline grant. */
  "sim.offline": {
    blobs: ["mode", "levelBand"],
    doubles: ["ms", "kills", "xp", "gold", "items", "levels"],
  },
  /** Chat message accepted or blocked. channelKind: "world" | "guild" | "party" | "whisper" | … */
  "chat.message": { blobs: ["channelKind", "outcome"], doubles: ["chars"] },
  /** Moderation action. action: "mute" | "hide" | "report" | "filter" | "guard"; by: "admin" | "auto" | "player". */
  "mod.action": { blobs: ["action", "by"], doubles: [] },
  /**
   * Client session lifecycle (routes/telemetry.ts). phase: "start" | "heartbeat" | "end".
   * lengthBand (end only): "<1m" | "1-5m" | "5-15m" | "15-30m" | "30-60m" | "1-2h" | "2h+".
   */
  "client.session": {
    blobs: [
      "phase",
      "platform",
      "device",
      "country",
      "continent",
      "build",
      "contentHash",
      "mode",
      "lengthBand",
    ],
    doubles: ["elapsedS", "loadMs", "visible"],
  },
  /** Sampled client frame stats. */
  "client.perf": {
    blobs: ["mode", "platform", "device", "build"],
    doubles: ["fpsP50", "fpsP95", "frameMsP95", "samples", "heapMb"],
  },
  /** Client errors; messageKey = normalised message (digits stripped, <= 120 chars). */
  "client.error": { blobs: ["kind", "build", "messageKey", "platform"], doubles: [] },
} as const satisfies Record<string, { blobs: readonly string[]; doubles: readonly string[] }>;

export type MetricName = keyof typeof METRICS;
export type BlobName<M extends MetricName> = (typeof METRICS)[M]["blobs"][number];
export type DoubleName<M extends MetricName> = (typeof METRICS)[M]["doubles"][number];

/** Values of one point, by field name (missing blobs read "", missing doubles 0). */
export type BlobsOf<M extends MetricName> = Partial<Record<BlobName<M>, string>>;
export type DoublesOf<M extends MetricName> = Partial<Record<DoubleName<M>, number>>;

/** Column layout of one stored point (AE and the local stub). */
export interface StoredPoint {
  /** Epoch ms. */
  t: number;
  /** blob1..blob10: blob1 is the metric name. */
  blobs: string[];
  /** double1..double10. */
  doubles: number[];
  index: string;
  /** AE _sample_interval (1 = not sampled). The local stub stores 1 unless it sampled. */
  sample: number;
}

/** Most blobs/doubles any metric uses (columns of the local table). */
export const MAX_BLOBS = 10;
export const MAX_DOUBLES = 10;
/** Longest blob value written (longer values are cut). */
export const MAX_BLOB_CHARS = 120;
export const DO_ACTIVE_EVERY_MS = 10 * 60_000;
export const DATASET_DEFAULT = "gamez_events";

/** 1-based AE column of a blob field ("blob2"…), or null when unknown. */
export function blobColumn<M extends MetricName>(metric: M, field: BlobName<M>): string | null {
  const i = (METRICS[metric].blobs as readonly string[]).indexOf(field);
  return i < 0 ? null : `blob${i + 2}`;
}

/** 1-based AE column of a double field ("double1"…), or null when unknown. */
export function doubleColumn<M extends MetricName>(metric: M, field: DoubleName<M>): string | null {
  const i = (METRICS[metric].doubles as readonly string[]).indexOf(field);
  return i < 0 ? null : `double${i + 1}`;
}

/** Builds the stored layout of one point (pure; cuts long blobs, maps non-finite doubles to 0). */
export function toStoredPoint<M extends MetricName>(
  metric: M,
  blobs: BlobsOf<M>,
  doubles: DoublesOf<M>,
  index: string,
  t: number,
): StoredPoint {
  const spec = METRICS[metric];
  const b: string[] = [metric];
  for (const name of spec.blobs as readonly string[]) {
    const v = (blobs as Record<string, string | undefined>)[name] ?? "";
    b.push(v.length > MAX_BLOB_CHARS ? v.slice(0, MAX_BLOB_CHARS) : v);
  }
  const d: number[] = [];
  for (const name of spec.doubles as readonly string[]) {
    const v = (doubles as Record<string, number | undefined>)[name] ?? 0;
    d.push(Number.isFinite(v) ? v : 0);
  }
  return { t, blobs: b, doubles: d, index, sample: 1 };
}

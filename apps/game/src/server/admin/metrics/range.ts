/**
 * `?from=&to=&bucket=` parsing for /api/admin/* metric endpoints
 * (docs/design/admin-dashboard.md §7.1). CONTRACT (architect, implemented).
 */
import type { AdminBucket, AdminRange } from "@gamez/protocol";
import { DAY_MS, HOUR_MS } from "./util.ts";

export const RANGE_DEFAULT_DAYS = 7;
export const RANGE_MAX_DAYS = 90;
export const RANGE_MAX_BUCKETS = 400;

/** Epoch ms from "1730000000000" or "YYYY-MM-DD" (UTC midnight); null otherwise. */
export function parseInstant(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const ms = Date.parse(`${raw}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  if (/^\d{1,15}$/.test(raw)) return Number(raw);
  return null;
}

/**
 * The range of a request. Defaults: the last 7 days up to now. `to` is
 * exclusive; a "YYYY-MM-DD" `to` means the end of that day. The span is
 * clamped to 1 hour..90 days; `bucket` defaults to "hour" for spans up to two
 * days, else "day", and becomes "day" when hours would exceed 400 buckets.
 * `from` is aligned down and `to` up to the bucket.
 */
export function parseRange(params: URLSearchParams, now: number): AdminRange {
  const rawTo = params.get("to");
  let to = parseInstant(rawTo) ?? now;
  if (rawTo && /^\d{4}-\d{2}-\d{2}$/.test(rawTo)) to += DAY_MS;
  to = Math.min(to, now + DAY_MS);
  let from = parseInstant(params.get("from")) ?? to - RANGE_DEFAULT_DAYS * DAY_MS;
  if (from >= to) from = to - HOUR_MS;
  if (to - from > RANGE_MAX_DAYS * DAY_MS) from = to - RANGE_MAX_DAYS * DAY_MS;

  const asked = params.get("bucket");
  let bucket: AdminBucket =
    asked === "hour" || asked === "day" ? asked : to - from <= 2 * DAY_MS ? "hour" : "day";
  if (bucket === "hour" && (to - from) / HOUR_MS > RANGE_MAX_BUCKETS) bucket = "day";
  const bucketMs = bucket === "hour" ? HOUR_MS : DAY_MS;
  from = Math.floor(from / bucketMs) * bucketMs;
  to = Math.ceil(to / bucketMs) * bucketMs;
  return { from, to, bucket, bucketMs };
}

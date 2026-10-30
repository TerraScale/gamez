/**
 * Per-isolate response cache for admin metric reads (docs/design/admin-dashboard.md §7.2).
 * CONTRACT (architect, implemented). Admin data is the same for every admin,
 * so the key is the path + sorted query. Entries live METRICS_CACHE_MS; the
 * dashboard's "refresh" sends `fresh=1` to bypass (and refill) the cache.
 */
export const METRICS_CACHE_MS = 30_000;
/**
 * The tech section reads Analytics Engine (the slowest source, p95 ~1.3 s in dev)
 * and its numbers move slowly, so it lives longer. The refresh button still bypasses it.
 */
export const TECH_CACHE_MS = 300_000;
export const METRICS_CACHE_MAX = 100;

const cache = new Map<string, { at: number; body: unknown }>();

/** Cache key of a URL: pathname + its query sorted, without `fresh`. */
export function cacheKey(url: URL): string {
  const params = [...url.searchParams.entries()]
    .filter(([k]) => k !== "fresh")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${url.pathname}?${new URLSearchParams(params).toString()}`;
}

/**
 * The cached body, or the result of `load`. The result is cached unless `load`
 * throws or `keep(body)` is false; a body that is not kept also drops any older
 * entry, so the next read loads again.
 */
export async function cached<T>(
  key: string,
  now: number,
  fresh: boolean,
  load: () => Promise<T>,
  ttlMs: number = METRICS_CACHE_MS,
  keep: (body: T) => boolean = () => true,
): Promise<{ body: T; hit: boolean }> {
  const hit = cache.get(key);
  if (!fresh && hit && now - hit.at < ttlMs) return { body: hit.body as T, hit: true };
  const body = await load();
  cache.delete(key);
  if (!keep(body)) return { body, hit: false };
  cache.set(key, { at: now, body });
  while (cache.size > METRICS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return { body, hit: false };
}

/** Drops every entry (tests; tunables writes). */
export function resetMetricsCache(): void {
  cache.clear();
}

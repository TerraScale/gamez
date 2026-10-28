/**
 * Crawls the client module graph the dev server serves, starting from the
 * page's entry script, and fetches every same-origin module it imports
 * (static, re-exports and dynamic imports). Vite rewrites bare imports to
 * absolute URLs, so a regex over the transformed code finds them.
 *
 * Why: classic runs its sim in the browser, so one module that fails to
 * transform (a stale or missing import) breaks the game with no server error.
 * The e2e requires the whole graph to load.
 */

export interface ClientGraph {
  /** Module URLs fetched (paths, without the origin). */
  modules: string[];
  /** Modules that did not answer 200, with their status or error. */
  failed: { url: string; status: string }[];
}

const MAX_MODULES = 5000;
const CONCURRENCY = 16;
const IMPORT_RE =
  /(?:\bimport|\bexport)\s*(?:[\w*{}\s,$]*?\bfrom\s*)?["'](\/[^"'/][^"']*)["']|\bimport\(\s*["'](\/[^"'/][^"']*)["']\s*\)/g;

/** The `src` of each `<script type="module">` in the page. */
function entryScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)) out.push(m[1]!);
  return out;
}

export async function crawlClientGraph(origin: string): Promise<ClientGraph> {
  const page = await fetch(`${origin}/`, { signal: AbortSignal.timeout(10_000) });
  if (!page.ok) throw new Error(`GET / answered ${page.status}`);
  const queue = entryScripts(await page.text());
  if (queue.length === 0) throw new Error("the page has no module entry script");
  const seen = new Set<string>(queue);
  const failed: ClientGraph["failed"] = [];

  async function visit(url: string): Promise<void> {
    let text: string;
    try {
      const res = await fetch(`${origin}${url}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        failed.push({ url, status: String(res.status) });
        return;
      }
      text = await res.text();
    } catch (err) {
      failed.push({ url, status: err instanceof Error ? err.message : String(err) });
      return;
    }
    for (const m of text.matchAll(IMPORT_RE)) {
      const dep = m[1] ?? m[2];
      if (dep === undefined || seen.has(dep) || seen.size >= MAX_MODULES) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }

  const running = new Set<Promise<void>>();
  while (queue.length > 0 || running.size > 0) {
    while (queue.length > 0 && running.size < CONCURRENCY) {
      const p: Promise<void> = visit(queue.shift()!).finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size > 0) await Promise.race(running);
  }
  return { modules: [...seen].sort(), failed };
}

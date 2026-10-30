/**
 * Loads instance modes on the client, on first use, once per page (the result
 * is immutable). Each mode loads only its own package, so starting duel never
 * pulls the classic sim. tests/shared/mode-modules.test.ts pins that the
 * loaded mode has the same contentHash as the server's.
 */
import { loadMode, type LoadedMode, type ModeSpec, type ModuleSpec } from "@gamez/kernel";

/** A mode spec and the modules its package exports. */
interface ModulePackage {
  mode: ModeSpec;
  modules: readonly ModuleSpec[];
}

/** One lazy loader per instance mode id (MODE_META lists the same ids). */
export const MODE_PACKAGES: ReadonlyMap<string, () => Promise<ModulePackage>> = new Map([
  [
    "classic",
    () => import("@gamez/mode-classic").then((m) => ({ mode: m.mode, modules: m.modules })),
  ],
  ["duel", () => import("@gamez/mode-duel").then((m) => ({ mode: m.mode, modules: m.modules }))],
  ["steps", () => import("@gamez/mode-steps").then((m) => ({ mode: m.mode, modules: m.modules }))],
]);

const cache = new Map<string, Promise<LoadedMode>>();

/**
 * The loaded mode with this id, or null for an unknown id. A failed load is
 * dropped from the cache, so the next call retries it.
 */
export function loadedMode(id: string): Promise<LoadedMode | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  const load = MODE_PACKAGES.get(id);
  if (!load) return Promise.resolve(null);
  const pending = load().then(({ mode, modules }) => loadMode(mode, modules));
  cache.set(id, pending);
  pending.catch(() => cache.delete(id));
  return pending;
}

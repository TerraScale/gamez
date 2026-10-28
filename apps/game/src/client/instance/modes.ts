/** Loads catalog modes on the client, once per page (the result is immutable). */
import { loadMode, type LoadedMode, type ModeSpec } from "@gamez/kernel";
import { MODULE_CATALOG } from "../../shared/catalog.ts";

const cache = new Map<string, LoadedMode>();

/** The loaded mode with this id, or null when `modes` has none. */
export function loadedMode(id: string, modes: readonly ModeSpec[]): LoadedMode | null {
  const hit = cache.get(id);
  if (hit) return hit;
  const spec = modes.find((m) => m.id === id);
  if (!spec) return null;
  const loaded = loadMode(spec, MODULE_CATALOG);
  cache.set(id, loaded);
  return loaded;
}

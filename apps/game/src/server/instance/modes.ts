/**
 * Mode lookup and loading for instances. loadMode() is pure and its result
 * immutable, so one LoadedMode per mode is shared by every sim in the isolate.
 */
import { loadMode, type LoadedMode, type ModeSpec, type ModuleSpec } from "@gamez/kernel";
import { MODES, MODULE_CATALOG } from "../../shared/catalog.ts";

const cache = new WeakMap<readonly ModeSpec[], Map<string, LoadedMode>>();

/** The catalog mode with this id, if any. */
export function findMode(id: string, modes: readonly ModeSpec[] = MODES): ModeSpec | undefined {
  return modes.find((m) => m.id === id);
}

/** Loads (once per isolate) the mode with this id; null when the catalog has no such mode. */
export function loadedMode(
  id: string,
  modes: readonly ModeSpec[] = MODES,
  catalog: readonly ModuleSpec[] = MODULE_CATALOG,
): LoadedMode | null {
  let byId = cache.get(modes);
  if (!byId) {
    byId = new Map();
    cache.set(modes, byId);
  }
  const hit = byId.get(id);
  if (hit) return hit;
  const spec = findMode(id, modes);
  if (!spec) return null;
  const loaded = loadMode(spec, catalog);
  byId.set(id, loaded);
  return loaded;
}

/** InstanceDO name: one live instance per player per mode. */
export function instanceName(mode: string, accountId: string): string {
  return `${mode}:${accountId}`;
}

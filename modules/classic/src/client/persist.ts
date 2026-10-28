/**
 * Local save of the classic client (docs/design/classic.md §12.1). One
 * localStorage record under SAVE_KEY holds the sim snapshot and the client
 * settings. It is a per-browser convenience, never shared and never read by
 * the server. Every storage access is wrapped: private windows, blocked site
 * data and quota errors just mean "no save".
 */
import { createSim, type LoadedMode, type Sim, type SimSnapshot } from "@gamez/kernel";
import type { Settings } from "./contract.ts";

export const SAVE_KEY = "gamez.classic.save.v1";
/** Saves of `?debug=1&cheats=1` (a different content hash) live under their own key. */
export const CHEATS_SAVE_KEY = `${SAVE_KEY}.cheats`;
export const SAVE_VERSION = 1;
/** Ticks stepped after a carried-over restore: a validation run that must not throw. */
export const CARRY_TICKS = 20;
/**
 * Module ids of the classic mode before wave A. Saves written before the
 * `modules` field existed were made with exactly these modules.
 */
export const LEGACY_MODULE_IDS: readonly string[] = [
  "classic.content",
  "classic.core",
  "classic.world",
  "classic.combat",
  "classic.monsters",
  "classic.items",
  "classic.progression",
  "classic.auto",
];

export const DEFAULT_SETTINGS: Settings = {
  showDamageNumbers: true,
  showLootLabels: true,
  showMinimap: true,
  zoom: 1,
  lighting: true,
  showPerf: false,
  masterVolume: 70,
  sfxVolume: 80,
  musicVolume: 45,
  muted: false,
  quality: "auto",
  tips: true,
};

export interface SaveRecord {
  v: 1;
  /** Wall clock (Date.now) of the save, used for offline progress. */
  savedAt: number;
  snapshot: SimSnapshot;
  settings: Settings;
  /** Module ids the save was made with (wave A; absent in older saves: LEGACY_MODULE_IDS). */
  modules?: string[];
}

/** The part of the Storage API the save uses (a Map-backed fake works in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** window.localStorage, or null when it is missing or throws (private mode, blocked). */
export function browserStorage(): KeyValueStorage | null {
  try {
    const s = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSnapshot(v: unknown): v is SimSnapshot {
  if (!isRecord(v)) return false;
  const rng = v.rng;
  return (
    typeof v.modeId === "string" &&
    typeof v.contentHash === "string" &&
    typeof v.tick === "number" &&
    Number.isSafeInteger(v.tick) &&
    v.tick >= 0 &&
    Array.isArray(rng) &&
    rng.length === 4 &&
    isRecord(v.world) &&
    isRecord(v.world.components) &&
    isRecord(v.world.resources)
  );
}

/** Settings with defaults for missing or malformed fields. */
export function sanitizeSettings(v: unknown): Settings {
  const src = isRecord(v) ? v : {};
  const bool = (x: unknown, d: boolean): boolean => (typeof x === "boolean" ? x : d);
  const vol = (x: unknown, d: number): number =>
    typeof x === "number" && Number.isFinite(x) ? Math.min(100, Math.max(0, Math.round(x))) : d;
  const zoom =
    typeof src.zoom === "number" && Number.isFinite(src.zoom)
      ? Math.min(2, Math.max(0.5, src.zoom))
      : DEFAULT_SETTINGS.zoom;
  return {
    showDamageNumbers: bool(src.showDamageNumbers, DEFAULT_SETTINGS.showDamageNumbers),
    showLootLabels: bool(src.showLootLabels, DEFAULT_SETTINGS.showLootLabels),
    showMinimap: bool(src.showMinimap, DEFAULT_SETTINGS.showMinimap),
    zoom,
    lighting: bool(src.lighting, DEFAULT_SETTINGS.lighting),
    showPerf: bool(src.showPerf, DEFAULT_SETTINGS.showPerf),
    masterVolume: vol(src.masterVolume, DEFAULT_SETTINGS.masterVolume),
    sfxVolume: vol(src.sfxVolume, DEFAULT_SETTINGS.sfxVolume),
    musicVolume: vol(src.musicVolume, DEFAULT_SETTINGS.musicVolume),
    muted: bool(src.muted, DEFAULT_SETTINGS.muted),
    quality:
      src.quality === "low" ||
      src.quality === "medium" ||
      src.quality === "high" ||
      src.quality === "auto"
        ? src.quality
        : DEFAULT_SETTINGS.quality,
    tips: bool(src.tips, DEFAULT_SETTINGS.tips),
  };
}

/**
 * Parses a stored record. Returns null for anything that is not a valid
 * version-1 record or whose contentHash differs from the loaded mode.
 */
/** Parses a version-1 record (any contentHash). Null for anything malformed. */
function parseRecord(text: string | null): (SaveRecord & { rawModules: unknown }) | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.v !== SAVE_VERSION) return null;
    if (!isSnapshot(raw.snapshot)) return null;
    if (typeof raw.savedAt !== "number" || !Number.isFinite(raw.savedAt)) return null;
    return {
      v: SAVE_VERSION,
      savedAt: raw.savedAt,
      snapshot: raw.snapshot,
      settings: sanitizeSettings(raw.settings),
      rawModules: raw.modules,
    };
  } catch {
    return null;
  }
}

/** The module ids a record was saved with (LEGACY_MODULE_IDS when the field is absent or malformed). */
export function modulesOfRecord(rawModules: unknown): string[] {
  if (Array.isArray(rawModules) && rawModules.every((m) => typeof m === "string")) {
    return rawModules as string[];
  }
  return [...LEGACY_MODULE_IDS];
}

/**
 * Parses a stored record. Returns null for anything that is not a valid
 * version-1 record or whose contentHash differs from the loaded mode.
 */
export function decodeSave(text: string | null, expectedHash: string): SaveRecord | null {
  const rec = parseRecord(text);
  if (rec === null || rec.snapshot.contentHash !== expectedHash) return null;
  return {
    v: SAVE_VERSION,
    savedAt: rec.savedAt,
    snapshot: rec.snapshot,
    settings: rec.settings,
    modules: modulesOfRecord(rec.rawModules),
  };
}

/**
 * A record whose contentHash differs from `expectedHash` but whose modules
 * all still exist in the loaded mode (wave A carry-over, dev convenience).
 * Null when it is malformed, already matches, or lost a module.
 */
export function decodeCarryable(
  text: string | null,
  expectedHash: string,
  moduleIds: readonly string[],
): SaveRecord | null {
  const rec = parseRecord(text);
  if (rec === null || rec.snapshot.contentHash === expectedHash) return null;
  const modules = modulesOfRecord(rec.rawModules);
  const current = new Set(moduleIds);
  if (!modules.every((m) => current.has(m))) return null;
  return {
    v: SAVE_VERSION,
    savedAt: rec.savedAt,
    snapshot: rec.snapshot,
    settings: rec.settings,
    modules,
  };
}

/**
 * Restores a carried-over record under the loaded content hash and steps it
 * CARRY_TICKS ticks as a validation run. The sim, or null when it does not
 * restore or throws while stepping (the caller starts a fresh game). Lazy
 * module resources (§1.1 rule 3) make the restore safe across versions.
 */
export function restoreCarried(loaded: LoadedMode, record: SaveRecord): Sim | null {
  try {
    const from: SimSnapshot = { ...record.snapshot, contentHash: loaded.contentHash };
    const sim = createSim(loaded, { seed: 0, from });
    sim.step(CARRY_TICKS);
    return sim;
  } catch {
    return null;
  }
}

export interface SaveStore {
  /** The saved record when it matches `expectedHash`, else null. Never throws. */
  load(expectedHash: string): SaveRecord | null;
  /** A record of another content version whose modules all still exist (see decodeCarryable). Never throws. */
  loadCarryable(expectedHash: string, moduleIds: readonly string[]): SaveRecord | null;
  /** Writes the record; false when storage refused it. Never throws. */
  save(record: SaveRecord): boolean;
  /** Removes the record. Never throws. */
  clear(): void;
}

/** Save store over any key-value storage (null storage = no persistence). */
export function createSaveStore(storage: KeyValueStorage | null, key = SAVE_KEY): SaveStore {
  return {
    load(expectedHash) {
      if (!storage) return null;
      try {
        return decodeSave(storage.getItem(key), expectedHash);
      } catch {
        return null;
      }
    },
    loadCarryable(expectedHash, moduleIds) {
      if (!storage) return null;
      try {
        return decodeCarryable(storage.getItem(key), expectedHash, moduleIds);
      } catch {
        return null;
      }
    },
    save(record) {
      if (!storage) return false;
      try {
        storage.setItem(key, JSON.stringify(record));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      if (!storage) return;
      try {
        storage.removeItem(key);
      } catch {
        // Nothing to do: the next save overwrites it.
      }
    },
  };
}

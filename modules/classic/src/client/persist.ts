/**
 * Local save of the classic client (docs/design/classic.md §12.1). One
 * localStorage record under SAVE_KEY holds the sim snapshot and the client
 * settings. It is a per-browser convenience, never shared and never read by
 * the server. Every storage access is wrapped: private windows, blocked site
 * data and quota errors just mean "no save".
 */
import type { SimSnapshot } from "@gamez/kernel";
import type { Settings } from "./contract.ts";

export const SAVE_KEY = "gamez.classic.save.v1";
export const SAVE_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  showDamageNumbers: true,
  showLootLabels: true,
  showMinimap: true,
  zoom: 1,
  lighting: true,
  showPerf: false,
};

export interface SaveRecord {
  v: 1;
  /** Wall clock (Date.now) of the save, used for offline progress. */
  savedAt: number;
  snapshot: SimSnapshot;
  settings: Settings;
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
  };
}

/**
 * Parses a stored record. Returns null for anything that is not a valid
 * version-1 record or whose contentHash differs from the loaded mode.
 */
export function decodeSave(text: string | null, expectedHash: string): SaveRecord | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.v !== SAVE_VERSION) return null;
    if (!isSnapshot(raw.snapshot)) return null;
    if (raw.snapshot.contentHash !== expectedHash) return null;
    if (typeof raw.savedAt !== "number" || !Number.isFinite(raw.savedAt)) return null;
    return {
      v: SAVE_VERSION,
      savedAt: raw.savedAt,
      snapshot: raw.snapshot,
      settings: sanitizeSettings(raw.settings),
    };
  } catch {
    return null;
  }
}

export interface SaveStore {
  /** The saved record when it matches `expectedHash`, else null. Never throws. */
  load(expectedHash: string): SaveRecord | null;
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

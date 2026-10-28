/** Local save round trip, validation and storage failures (docs/design/classic.md §12.1). */
import { createSim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import {
  createSaveStore,
  DEFAULT_SETTINGS,
  decodeSave,
  sanitizeSettings,
  SAVE_KEY,
  type KeyValueStorage,
  type SaveRecord,
} from "../src/client/persist.ts";
import { testSim } from "./support/harness.ts";

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function recordOf(sim: ReturnType<typeof testSim>): SaveRecord {
  return {
    v: 1,
    savedAt: 1_700_000_000_000,
    snapshot: sim.snapshot(),
    settings: { ...DEFAULT_SETTINGS, zoom: 1.5, showPerf: true },
  };
}

describe("save store", () => {
  it("round-trips the snapshot and settings", () => {
    const sim = testSim([]);
    const storage = new MemoryStorage();
    const store = createSaveStore(storage);
    const rec = recordOf(sim);
    expect(store.save(rec)).toBe(true);
    expect(storage.items.has(SAVE_KEY)).toBe(true);
    const back = store.load(sim.loaded.contentHash);
    expect(back).toEqual(rec);
  });

  it("restores a sim that continues exactly like the original", () => {
    const sim = testSim([]);
    const rec = recordOf(sim);
    const restored = createSim(sim.loaded, { seed: 0, from: rec.snapshot });
    expect(restored.hash()).toBe(sim.hash());
  });

  it("ignores a save whose contentHash does not match", () => {
    const sim = testSim([]);
    const storage = new MemoryStorage();
    const store = createSaveStore(storage);
    store.save(recordOf(sim));
    expect(store.load("0000000000000000")).toBeNull();
  });

  it("treats corrupt or foreign text as no save", () => {
    const sim = testSim([]);
    expect(decodeSave("{not json", sim.loaded.contentHash)).toBeNull();
    expect(decodeSave("", sim.loaded.contentHash)).toBeNull();
    expect(decodeSave(JSON.stringify({ v: 2 }), sim.loaded.contentHash)).toBeNull();
    const storage = new MemoryStorage();
    storage.setItem(SAVE_KEY, "[]");
    expect(createSaveStore(storage).load(sim.loaded.contentHash)).toBeNull();
  });

  it("never throws when storage throws", () => {
    const sim = testSim([]);
    const broken: KeyValueStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("quota");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    const store = createSaveStore(broken);
    expect(store.load(sim.loaded.contentHash)).toBeNull();
    expect(store.save(recordOf(sim))).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });

  it("works as a no-op without storage", () => {
    const sim = testSim([]);
    const store = createSaveStore(null);
    expect(store.load(sim.loaded.contentHash)).toBeNull();
    expect(store.save(recordOf(sim))).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });

  it("clear removes the record", () => {
    const sim = testSim([]);
    const storage = new MemoryStorage();
    const store = createSaveStore(storage);
    store.save(recordOf(sim));
    store.clear();
    expect(storage.items.has(SAVE_KEY)).toBe(false);
    expect(store.load(sim.loaded.contentHash)).toBeNull();
  });
});

describe("settings sanitising", () => {
  it("keeps valid values and defaults the rest", () => {
    expect(sanitizeSettings({ zoom: 1.25, lighting: false })).toEqual({
      ...DEFAULT_SETTINGS,
      zoom: 1.25,
      lighting: false,
    });
  });

  it("clamps zoom and rejects non-boolean flags", () => {
    expect(sanitizeSettings({ zoom: 9, showMinimap: "yes" }).zoom).toBe(2);
    expect(sanitizeSettings({ zoom: 0.1 }).zoom).toBe(0.5);
    expect(sanitizeSettings({ showMinimap: "yes" }).showMinimap).toBe(true);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});

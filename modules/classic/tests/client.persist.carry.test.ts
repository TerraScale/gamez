/**
 * Save carry-over (docs/design/wave-A.md §11.3): a save of another content
 * version is restored when all its modules still exist, stepped 20 ticks as a
 * validation run, and dropped (fresh game) when that fails.
 */
import { createSim, loadMode, type SimSnapshot } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import { ACTION } from "../src/actions.ts";
import { CARRY_TOAST } from "../src/client/index.ts";
import {
  CARRY_TICKS,
  createSaveStore,
  DEFAULT_SETTINGS,
  decodeCarryable,
  LEGACY_MODULE_IDS,
  restoreCarried,
  SAVE_KEY,
  type KeyValueStorage,
  type SaveRecord,
} from "../src/client/persist.ts";

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

const OLD_HASH = "0123456789abcdef";

/** A real hero, a few ticks in, saved as if by an older build (other hash, the given module list). */
function oldBuildRecord(modulesOf: string[] | undefined) {
  const loaded = loadMode(mode, modules);
  const sim = createSim(loaded, { seed: 4242 });
  const r = sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Carry" }, "local");
  if (!r.ok) throw new Error(`newHero failed: ${r.error?.message}`);
  sim.step(5);
  const snap = sim.snapshot();
  const record: SaveRecord = {
    v: 1,
    savedAt: 1_700_000_000_000,
    snapshot: { ...snap, contentHash: OLD_HASH },
    settings: { ...DEFAULT_SETTINGS },
    ...(modulesOf !== undefined ? { modules: modulesOf } : {}),
  };
  return { loaded, snap, record };
}

describe("carry-over decode", () => {
  it("accepts a save of another version whose modules all still exist", () => {
    const { loaded, record } = oldBuildRecord(LEGACY_MODULE_IDS.slice());
    const got = decodeCarryable(
      JSON.stringify(record),
      loaded.contentHash,
      loaded.modules.map((m) => m.id),
    );
    expect(got?.snapshot.contentHash).toBe(OLD_HASH);
    expect(got?.modules).toEqual(LEGACY_MODULE_IDS);
  });

  it("treats a save without a module list as the pre-wave-A modules", () => {
    const { loaded, record } = oldBuildRecord(undefined);
    const got = decodeCarryable(
      JSON.stringify(record),
      loaded.contentHash,
      loaded.modules.map((m) => m.id),
    );
    expect(got?.modules).toEqual([...LEGACY_MODULE_IDS]);
  });

  it("refuses a save that used a module the current mode no longer has", () => {
    const { loaded, record } = oldBuildRecord([...LEGACY_MODULE_IDS, "classic.gone"]);
    expect(
      decodeCarryable(
        JSON.stringify(record),
        loaded.contentHash,
        loaded.modules.map((m) => m.id),
      ),
    ).toBeNull();
  });

  it("refuses a save that already matches the loaded hash, and malformed text", () => {
    const { loaded, record } = oldBuildRecord(LEGACY_MODULE_IDS.slice());
    const current = {
      ...record,
      snapshot: { ...record.snapshot, contentHash: loaded.contentHash },
    };
    const ids = loaded.modules.map((m) => m.id);
    expect(decodeCarryable(JSON.stringify(current), loaded.contentHash, ids)).toBeNull();
    expect(decodeCarryable("{nope", loaded.contentHash, ids)).toBeNull();
    expect(decodeCarryable(null, loaded.contentHash, ids)).toBeNull();
  });

  it("is reachable through the save store, which never loads it as a normal save", () => {
    const { loaded, record } = oldBuildRecord(LEGACY_MODULE_IDS.slice());
    const storage = new MemoryStorage();
    storage.setItem(SAVE_KEY, JSON.stringify(record));
    const store = createSaveStore(storage);
    expect(store.load(loaded.contentHash)).toBeNull();
    expect(
      store.loadCarryable(
        loaded.contentHash,
        loaded.modules.map((m) => m.id),
      )?.snapshot.contentHash,
    ).toBe(OLD_HASH);
  });
});

describe("carry-over restore", () => {
  it("restores under the loaded hash and steps the validation ticks", () => {
    const { loaded, snap, record } = oldBuildRecord(LEGACY_MODULE_IDS.slice());
    const sim = restoreCarried(loaded, record);
    expect(sim).not.toBeNull();
    expect(sim?.snapshot().contentHash).toBe(loaded.contentHash);
    expect(sim?.tick).toBe(snap.tick + CARRY_TICKS);
    const hero = sim?.world.getResource("classic.game") as { hero: number } | undefined;
    expect(hero?.hero).toBeGreaterThan(0);
  });

  it("returns null when the snapshot cannot be restored (the caller starts fresh)", () => {
    const { loaded, record } = oldBuildRecord(LEGACY_MODULE_IDS.slice());
    const broken: SaveRecord = {
      ...record,
      snapshot: { ...record.snapshot, world: "nope" as unknown as SimSnapshot["world"] },
    };
    expect(restoreCarried(loaded, broken)).toBeNull();
  });

  it("has a notice for the player", () => {
    expect(CARRY_TOAST.body).toBe("Your hero was carried over to the new version");
    expect(CARRY_TOAST.title).toBe("Save carried over");
  });
});

import { createSim, loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { MODES, MODULE_CATALOG } from "../../src/shared/catalog.ts";

/**
 * The catalog the Worker and the browser both load. Every mode must load from
 * it alone, and its contentHash must be a pure function of the content:
 * clients compare it with the server's to detect an outdated bundle.
 */
describe("shared catalog", () => {
  it("has the phase-1 instance modes", () => {
    expect(MODES.map((m) => m.id)).toEqual(expect.arrayContaining(["duel", "steps"]));
  });

  it("has unique module ids", () => {
    const ids = MODULE_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(MODES.map((m) => [m.id, m] as const))(
    "loads %s with the same contentHash every time",
    (_id, spec) => {
      const a = loadMode(spec, MODULE_CATALOG);
      const b = loadMode(spec, MODULE_CATALOG);
      expect(a.contentHash).toMatch(/^[0-9a-f]{16}$/);
      expect(b.contentHash).toBe(a.contentHash);
      // Catalog order must not matter either: the loader sorts what the mode selects.
      expect(loadMode(spec, [...MODULE_CATALOG].reverse()).contentHash).toBe(a.contentHash);
      // And the loaded mode must run: a fresh sim snapshots under that hash.
      expect(createSim(a, { seed: 1 }).snapshot().contentHash).toBe(a.contentHash);
    },
  );

  it("gives every mode a different contentHash", () => {
    const hashes = MODES.map((spec) => loadMode(spec, MODULE_CATALOG).contentHash);
    expect(new Set(hashes).size).toBe(MODES.length);
  });
});

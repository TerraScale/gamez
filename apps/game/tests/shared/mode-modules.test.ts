import { loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { MODE_PACKAGES, loadedMode } from "../../src/client/instance/modes.ts";
import { MODES, MODULE_CATALOG } from "../../src/shared/catalog.ts";

/**
 * The browser loads each mode from its own package only (client/instance/modes.ts).
 * That must give the same loaded mode as the server's full catalog, or the
 * client's contentHash would not match and every join would be refused.
 */
describe("per-mode client loading", () => {
  it("has a package loader for every catalog mode and nothing else", () => {
    expect([...MODE_PACKAGES.keys()].sort()).toEqual(MODES.map((m) => m.id).sort());
  });

  it.each(MODES.map((m) => [m.id] as const))(
    "loads %s with the server's contentHash from its own package",
    async (id) => {
      const server = loadMode(
        MODES.find((m) => m.id === id)!,
        MODULE_CATALOG,
      );
      const client = await loadedMode(id);
      expect(client?.contentHash).toBe(server.contentHash);
    },
  );

  it("returns null for an unknown mode and caches a loaded one", async () => {
    expect(await loadedMode("no-such-mode")).toBeNull();
    const a = await loadedMode("duel");
    expect(await loadedMode("duel")).toBe(a);
  });
});

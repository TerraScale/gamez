/**
 * The package entry points resolve by name (as apps/game will import them in
 * the next phase) and type-check through `vp check`: "@gamez/mode-classic"
 * (sim modules + mode) and "@gamez/mode-classic/client" (the ClientModeView).
 * A real browser bundle of the client is built from modules/classic/dev
 * (which imports "@gamez/mode-classic/client" too).
 */
import { loadMode } from "@gamez/kernel";
import { mode, modules } from "@gamez/mode-classic";
import { classicView } from "@gamez/mode-classic/client";
import type { ClientModeView } from "@gamez/ui-host";
import { describe, expect, it } from "vite-plus/test";

describe("@gamez/mode-classic package entry points", () => {
  it("exports the classic mode, its modules and the client view", () => {
    const view: ClientModeView = classicView;
    expect(typeof view.mount).toBe("function");
    expect(mode.id).toBe("classic");
    expect(mode.tick).toEqual({ kind: "fixed", hz: 20 });
    const loaded = loadMode(mode, modules);
    expect(loaded.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(modules.map((m) => m.id).sort()).toEqual([
      "classic.auto",
      "classic.combat",
      "classic.content",
      "classic.core",
      "classic.items",
      "classic.monsters",
      "classic.progression",
      "classic.world",
    ]);
  });
});

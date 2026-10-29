/**
 * Gallery coverage of wave A (docs/design/wave-A.md §11.2): every effect row
 * and the three telegraph shapes are cells that the real planner plays; gems
 * are tinted; the set rarity has a label sample; the rift stations have signs.
 */
import { createSim, loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import {
  buildGallerySections,
  cellReachable,
  classifyIcon,
  displayWorst,
  iconGlyphIds,
  tallyCells,
  type CellReport,
  type GalleryCell,
} from "../src/client/gallery.ts";
import { EFFECT_TABLE, planEvent, type EffectEnv, type Visual } from "../src/client/effects.ts";
import { RARITY_COLOR } from "../src/client/contract.ts";

const loaded = loadMode(mode, modules);
const sections = buildGallerySections(loaded.registry, []);
const section = (id: string) => {
  const s = sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
};
const cell = (sec: string, key: string): GalleryCell => {
  const c = section(sec).cells.find((x) => x.key === key);
  if (!c) throw new Error(`no cell ${key} in ${sec}`);
  return c;
};

function env(): EffectEnv {
  const sim = createSim(loaded, { seed: 1 });
  return {
    world: sim.world,
    registry: sim.loaded.registry,
    hero: 0,
    heroX: 0,
    heroY: 0,
    showDamageNumbers: true,
    manual: true,
  };
}

describe("gallery effects section", () => {
  it("has a cell for every effect row and for each telegraph shape", () => {
    const keys = new Set(section("effects").cells.map((c) => c.key));
    for (const [fx, row] of Object.entries(EFFECT_TABLE)) {
      if (row.kind === "telegraph") continue;
      expect(keys.has(`effect:${fx}`), fx).toBe(true);
    }
    for (const shape of ["circle", "cone", "line"]) {
      expect(keys.has(`telegraph:${shape}`), shape).toBe(true);
    }
  });

  it("plays every effect cell through the real planner with the row's kind", () => {
    const e = env();
    for (const c of section("effects").cells) {
      expect(c.event, c.key).toBeDefined();
      const out: Visual[] = planEvent(c.event!(0, 0) as never, e);
      const eff = out.find((v) => v.kind === "effect");
      expect(eff, c.key).toBeDefined();
      if (eff?.kind === "effect") {
        const fx = c.key.startsWith("effect:") ? c.key.slice("effect:".length) : "";
        if (fx !== "") expect(eff.spec.kind, c.key).toBe(EFFECT_TABLE[fx]?.kind);
        else expect(eff.spec.kind, c.key).toBe("telegraph");
      }
    }
  });

  it("reports the particle style in the caption of each effect cell", () => {
    for (const c of section("effects").cells) {
      if (!c.key.startsWith("effect:")) continue;
      const row = EFFECT_TABLE[c.ref];
      expect(c.title, c.key).toContain(row?.style ?? "");
    }
  });
});

describe("gallery loot and stations", () => {
  it("labels the set rarity with its own colour", () => {
    const set = cell("loot", "loot:set-sample");
    expect(set.entity?.labelColor).toBe(RARITY_COLOR.set);
  });

  it("tints every gem cell by its kind", () => {
    const gems = section("loot").cells.filter((c) => c.entity?.appearance === "loot.item.gem");
    expect(gems.length).toBeGreaterThan(0);
    for (const g of gems) expect(g.entity?.tint, g.key).toBeDefined();
    expect(gems.some((g) => g.entity?.tint !== 0xffffff)).toBe(true);
  });

  it("has signs for the rift obelisk and the rift exit", () => {
    const keys = new Set(section("props").cells.map((c) => c.key));
    expect(keys.has("props:station:riftObelisk")).toBe(true);
    expect(keys.has("props:station:riftExit")).toBe(true);
  });
});

describe("gallery icon coverage", () => {
  const glyphs = iconGlyphIds(loaded.registry);
  const iconIds = (sec: string) =>
    section(sec)
      .cells.map((c) => c.extra?.icon)
      .filter((x): x is string => typeof x === "string" && x !== "");

  it("finds glyph-backed item and skill icons in the gallery sections", () => {
    expect(iconIds("loot").some((id) => id.startsWith("icon.item."))).toBe(true);
    expect(iconIds("skills").some((id) => id.startsWith("icon.skill."))).toBe(true);
  });

  it("counts every glyph-backed icon as glyph, never missing (even with no art)", () => {
    for (const id of [...iconIds("loot"), ...iconIds("skills")]) {
      expect(glyphs.has(id), id).toBe(true);
      expect(classifyIcon(glyphs.has(id), false), id).toBe("glyph");
    }
  });

  it("counts an id with neither art nor glyph as missing", () => {
    const id = "icon.item.no-such-thing";
    expect(glyphs.has(id)).toBe(false);
    expect(classifyIcon(glyphs.has(id), false)).toBe("missing");
  });

  it("counts art-only icons as art and prefers the HUD glyph when both exist", () => {
    expect(classifyIcon(false, true)).toBe("art");
    expect(classifyIcon(true, true)).toBe("glyph");
    expect(classifyIcon(true, false)).toBe("glyph");
  });
});

describe("gallery static NPC cells", () => {
  const npcCells = () =>
    section("npcs").cells.filter((c) => c.kind === "unit" && c.entity?.kind === "npc");

  it("marks NPC walk, attack, cast, hit and death as unreachable and shows them as static", () => {
    const actions = new Set(npcCells().map((c) => c.action));
    expect(actions.has("walk")).toBe(true);
    for (const c of npcCells()) {
      if (c.action === "idle" || c.action === undefined) continue;
      expect(cellReachable(c), c.key).toBe(false);
      expect(displayWorst(cellReachable(c), "exact"), c.key).toBe("static");
    }
  });

  it("keeps NPC idle and every hero action reachable", () => {
    for (const c of npcCells()) if (c.action === "idle") expect(cellReachable(c), c.key).toBe(true);
    for (const c of section("heroes").cells) expect(cellReachable(c), c.key).toBe(true);
    expect(displayWorst(true, "exact")).toBe("exact");
  });

  it("does not count static cells as problems or action fallbacks", () => {
    const report = (over: Partial<CellReport>): CellReport => ({
      key: "npc:walk",
      section: "npcs",
      kind: "unit",
      title: "walk",
      ref: "unit.npc.smith",
      action: "walk",
      resolved: "unit.npc.smith.idle.s (action-fallback)",
      worst: "static",
      reachable: false,
      ...over,
    });
    const t = tallyCells([
      report({}),
      report({ key: "npc:attack", action: "attack" }),
      report({ key: "npc:hit", action: "hit" }),
    ]);
    expect(t.problems).toEqual([]);
    expect(t.actionFallbacks).toEqual([]);
    expect(t.byKind).toEqual({ static: 3 });
    expect(t.notPlayed).toBe(3);
  });
});

/**
 * Gallery coverage of wave A (docs/design/wave-A.md §11.2): every effect row
 * and the three telegraph shapes are cells that the real planner plays; gems
 * are tinted; the set rarity has a label sample; the rift stations have signs.
 */
import { createSim, loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import { buildGallerySections, type GalleryCell } from "../src/client/gallery.ts";
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

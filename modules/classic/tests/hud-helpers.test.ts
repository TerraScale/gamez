/** HUD helper tests (T9): pure formatting, sweep and grid maths, selector memo, slot table, minimap pixels. */
import { createSlotRegistry } from "@gamez/ui-host";
import { describe, expect, it } from "vite-plus/test";
import type { ClassicMap } from "../src/world/maps.ts";
import { riftDepth } from "../src/rules.ts";
import type { ItemView, MinimapData } from "../src/client/contract.ts";
import {
  BAG_CELL_PX,
  CATEGORY_LABEL,
  cooldownSweepDeg,
  DOT_COLOR,
  DOT_LABEL,
  fillPercent,
  fmtDuration,
  fmtInt,
  fmtPct,
  fmtRegen,
  fmtSigned,
  fraction,
  gridOccupancy,
  isBitSet,
  pickEquipSlot,
  pluralize,
  xpFraction,
  depthLabel,
} from "../src/client/hud/format.ts";
import { createSelectMemo, shallowEqual } from "../src/client/hud/hooks.ts";
import { bottomOrder, PANEL_IDS, panelSlot, SLOT } from "../src/client/hud/layout.ts";
import { DEFAULT_WIDGETS, PANEL_COMPONENTS, registerDefaultHud } from "../src/client/hud/index.tsx";
import { SKILL_GLYPHS, skillGlyphKey, skillGlyphTag } from "../src/client/hud/icons.tsx";
import { CLASSES } from "../src/content/classes.ts";
import { SKILLS } from "../src/content/skills.ts";
import { contrastRatio, GOLD_COLOR, MONSTER_COLOR, RARITY_COLOR } from "../src/client/contract.ts";
import { minimapPixels } from "../src/client/hud/widgets/Minimap.tsx";
import { compareHeading, findItem, itemKindLabel } from "../src/client/hud/widgets/Tooltip.tsx";
import { autoConfigLabels } from "../src/client/hud/panels/SettingsPanel.tsx";
import { ROLE_TEXT } from "../src/client/hud/panels/VendorPanel.tsx";
import { DOLL } from "../src/client/hud/panels/InventoryPanel.tsx";

describe("number formatting", () => {
  it("groups thousands and keeps the sign", () => {
    expect(fmtInt(1234567)).toBe("1,234,567");
    expect(fmtInt(-1234)).toBe("-1,234");
    expect(fmtInt(999)).toBe("999");
    expect(fmtInt(0)).toBe("0");
    expect(fmtInt(12.9)).toBe("12");
    expect(fmtInt(Number.NaN)).toBe("0");
  });

  it("signs deltas", () => {
    expect(fmtSigned(3)).toBe("+3");
    expect(fmtSigned(-2)).toBe("-2");
    expect(fmtSigned(0)).toBe("0");
  });

  it("rounds percentages and formats regeneration x10", () => {
    expect(fmtPct(34.6)).toBe("35%");
    expect(fmtPct(-10)).toBe("-10%");
    expect(fmtRegen(15)).toBe("1.5/s");
    expect(fmtRegen(0)).toBe("0.0/s");
  });

  it("formats ticks as seconds (20 Hz)", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(-5)).toBe("0s");
    expect(fmtDuration(45)).toBe("2.3s");
    expect(fmtDuration(200)).toBe("10s");
    expect(fmtDuration(205)).toBe("11s");
  });

  it("pluralizes", () => {
    expect(pluralize(1, "item")).toBe("1 item");
    expect(pluralize(3, "item")).toBe("3 items");
  });
});

describe("depth labels", () => {
  it("names town, dungeon depths and rift levels, never a raw rift depth", () => {
    expect(depthLabel(0)).toBe("Town");
    expect(depthLabel(7)).toBe("Depth 7");
    expect(depthLabel(riftDepth(3, 12))).toBe("Rift level 3");
    expect(depthLabel(riftDepth(1, 0))).toBe("Rift level 1");
  });
});

describe("bar fractions", () => {
  it("clamps value over max to 0..1", () => {
    expect(fraction(5, 10)).toBe(0.5);
    expect(fraction(20, 10)).toBe(1);
    expect(fraction(-1, 10)).toBe(0);
    expect(fraction(5, 0)).toBe(0);
    expect(fillPercent(25, 100)).toBe(25);
  });

  it("XP fraction runs from the level start to the next level", () => {
    expect(xpFraction(900, 700, 1100)).toBe(0.5);
    expect(xpFraction(1200, 700, 1100)).toBe(1);
    expect(xpFraction(650, 700, 1100)).toBe(0);
    expect(xpFraction(700, 1100, 1100)).toBe(1);
  });
});

describe("cooldown sweep", () => {
  it("returns the degrees still to cover, clockwise from the top", () => {
    expect(cooldownSweepDeg(0, 10)).toBe(0);
    expect(cooldownSweepDeg(5, 10)).toBe(180);
    expect(cooldownSweepDeg(10, 10)).toBe(360);
    expect(cooldownSweepDeg(25, 10)).toBe(360);
    expect(cooldownSweepDeg(5, 0)).toBe(0);
    expect(cooldownSweepDeg(-3, 10)).toBe(0);
  });
});

describe("grids and tiles", () => {
  it("marks every cell covered by an item footprint", () => {
    const cells = gridOccupancy(3, 2, [{ x: 1, y: 0, w: 2, h: 2 }]);
    expect(cells).toEqual([false, true, true, false, true, true]);
  });

  it("clips footprints that leave the grid", () => {
    const cells = gridOccupancy(3, 2, [{ x: 2, y: 1, w: 3, h: 3 }]);
    expect(cells.filter(Boolean).length).toBe(1);
    expect(cells[5]).toBe(true);
  });

  it("reads the explored bitset row-major, 32 tiles per word", () => {
    const bits = [0b101];
    expect(isBitSet(bits, 4, 0, 0)).toBe(true);
    expect(isBitSet(bits, 4, 1, 0)).toBe(false);
    expect(isBitSet(bits, 4, 2, 0)).toBe(true);
    // Tile index 33 lives in word 1, bit 1.
    expect(isBitSet([0, 0b10], 4, 1, 8)).toBe(true);
    expect(isBitSet([], 4, 0, 0)).toBe(false);
  });

  it("picks the free slot an item may use, else its first slot", () => {
    const item = { uid: 1 };
    expect(pickEquipSlot(["ring1", "ring2"], { ring1: item, ring2: null })).toBe("ring2");
    expect(pickEquipSlot(["ring1", "ring2"], { ring1: null, ring2: null })).toBe("ring1");
    expect(pickEquipSlot(["ring1", "ring2"], { ring1: item, ring2: item })).toBe("ring1");
    expect(pickEquipSlot([], {})).toBeNull();
  });

  it("keeps every bag cell at the 44 px touch target, also on a 375 px phone", () => {
    // The bag card scrolls sideways on compact screens; the cells never shrink.
    expect(BAG_CELL_PX).toBeGreaterThanOrEqual(44);
  });

  it("paper doll lists the nine equip slots once each", () => {
    const slots = DOLL.flat().filter((s): s is NonNullable<typeof s> => s !== null);
    expect(slots.length).toBe(9);
    expect(new Set(slots).size).toBe(9);
  });
});

describe("selectors", () => {
  it("shallowEqual compares one level deep", () => {
    const o = { a: 1 };
    expect(shallowEqual(o, o)).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(shallowEqual({ a: {} }, { a: {} })).toBe(false);
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
    expect(shallowEqual([1], [1, 2])).toBe(false);
    expect(shallowEqual(null, {})).toBe(false);
    expect(shallowEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  it("memo keeps the previous selection while it is shallow-equal", () => {
    const memo = createSelectMemo<{ a: number; b: number }, { a: number }>();
    const pick = (s: { a: number }) => ({ a: s.a });
    const v1 = memo({ a: 1, b: 1 }, pick);
    const v2 = memo({ a: 1, b: 2 }, pick);
    expect(v2).toBe(v1);
    const v3 = memo({ a: 2, b: 2 }, pick);
    expect(v3).not.toBe(v1);
    expect(v3).toEqual({ a: 2 });
  });

  it("memo does not run the selector twice for the same snapshot", () => {
    const memo = createSelectMemo<{ a: number }, number>();
    let calls = 0;
    const snap = { a: 3 };
    const pick = (s: { a: number }) => {
      calls++;
      return s.a;
    };
    expect(memo(snap, pick)).toBe(3);
    expect(memo(snap, pick)).toBe(3);
    expect(calls).toBe(1);
  });
});

describe("icons and labels", () => {
  it("picks the most specific skill tag", () => {
    expect(skillGlyphTag(["melee", "summon"])).toBe("summon");
    expect(skillGlyphTag(["basic"])).toBe("basic");
    expect(skillGlyphTag([])).toBe("none");
  });

  it("gives every hero skill of a class a distinct glyph", () => {
    for (const cls of Object.values(CLASSES)) {
      const keys = cls.skills.map((id) => skillGlyphKey(id, SKILLS[id]?.ai.tags ?? []));
      expect(new Set(keys).size, cls.name).toBe(keys.length);
      // Each key is a real per-skill glyph, not a shared tag fallback.
      for (const id of cls.skills) expect(Object.hasOwn(SKILL_GLYPHS, id), id).toBe(true);
    }
  });

  it("draws no two skills with the same shape", () => {
    const bodies = Object.values(SKILL_GLYPHS).map((g) => JSON.stringify(g));
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it("falls back to the tag glyph for skills without their own glyph", () => {
    expect(skillGlyphKey("classic.mskill.claw", ["melee"])).toBe("melee");
    expect(skillGlyphKey(null, ["summon"])).toBe("summon");
  });

  it("keeps rarity, gold and monster colours readable on dark and mid-grey floors", () => {
    // 3:1 is the WCAG non-text contrast minimum for labels drawn over the floor.
    const floors = [0x1a1a1a, 0x6b6b6b];
    const colours: [string, number][] = [
      ["normal", RARITY_COLOR.normal],
      ["magic", RARITY_COLOR.magic],
      ["rare", RARITY_COLOR.rare],
      ["unique", RARITY_COLOR.unique],
      ["gold", GOLD_COLOR],
      ["unique monster", MONSTER_COLOR.unique],
    ];
    for (const [name, c] of colours) {
      for (const floor of floors) {
        expect(contrastRatio(c, floor), `${name} on ${floor.toString(16)}`).toBeGreaterThanOrEqual(
          3,
        );
      }
    }
    // Rare (clear light yellow) and gold (saturated amber) stay apart: the
    // 3:1 floor caps how close gold can get to rare's luminance, so the test
    // only asks for a visible step, and the colours differ.
    expect(contrastRatio(RARITY_COLOR.rare, GOLD_COLOR)).toBeGreaterThan(1.3);
    expect(RARITY_COLOR.rare).not.toBe(GOLD_COLOR);
    expect(RARITY_COLOR.unique).not.toBe(RARITY_COLOR.rare);
  });

  it("gives every minimap dot kind a colour and a label", () => {
    expect(Object.keys(DOT_COLOR).sort()).toEqual(Object.keys(DOT_LABEL).sort());
    expect(Object.keys(DOT_LABEL).length).toBe(8);
  });

  it("lists the auto config editor fields", () => {
    const labels = autoConfigLabels();
    // 6 numbers + 10 toggles (wave A adds repair, craft, gamble and rift).
    expect(labels.length).toBe(16);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names every vendor role", () => {
    expect(ROLE_TEXT.smith).toBe("Smith");
    expect(ROLE_TEXT.junk).toBe("Junk buyer");
  });
});

describe("bottom bar order", () => {
  it("desktop: XP, life, skills, belt, mana, buttons", () => {
    expect(bottomOrder(false, "xp")).toBeLessThan(bottomOrder(false, "life"));
    expect(bottomOrder(false, "life")).toBeLessThan(bottomOrder(false, "skill"));
    expect(bottomOrder(false, "skill")).toBeLessThan(bottomOrder(false, "belt"));
    expect(bottomOrder(false, "belt")).toBeLessThan(bottomOrder(false, "mana"));
    expect(bottomOrder(false, "mana")).toBeLessThan(bottomOrder(false, "panel"));
  });

  it("compact: XP, belt row, skill row, orbs on one row, buttons last", () => {
    expect(bottomOrder(true, "xp")).toBeLessThan(bottomOrder(true, "belt"));
    expect(bottomOrder(true, "belt")).toBeLessThan(bottomOrder(true, "skill"));
    expect(bottomOrder(true, "skill")).toBeLessThan(bottomOrder(true, "life"));
    expect(bottomOrder(true, "life")).toBeLessThan(bottomOrder(true, "mana"));
    expect(bottomOrder(true, "mana")).toBeLessThan(bottomOrder(true, "panel"));
  });
});

describe("minimap pixels", () => {
  function data(walkable: number[], explored: number[] | null): MinimapData {
    const map = { width: 2, height: 2, walkable } as unknown as ClassicMap;
    return { map, explored, heroX: 0, heroY: 0, dots: [] };
  }

  it("shows fog for unexplored tiles, floor and wall for explored ones", () => {
    // Tiles 0 (floor) and 1 (wall) explored; 2 and 3 unexplored.
    const px = minimapPixels(data([1, 0, 1, 1], [0b0011]));
    expect([px[0], px[1], px[2], px[3]]).toEqual([74, 68, 56, 255]);
    expect([px[4], px[5], px[6]]).toEqual([30, 26, 21]);
    expect([px[8], px[9], px[10]]).toEqual([10, 9, 8]);
    expect(px[15]).toBe(255);
  });

  it("treats explored null as fully visible (town)", () => {
    const px = minimapPixels(data([1, 0, 1, 1], null));
    expect([px[8], px[9], px[10]]).toEqual([74, 68, 56]);
    expect([px[4], px[5], px[6]]).toEqual([30, 26, 21]);
  });
});

describe("tooltip helpers", () => {
  const sword = { uid: 1 } as ItemView;
  it("finds an item in the first list that has its uid", () => {
    expect(findItem(1, [[], [sword]])).toBe(sword);
    expect(findItem(2, [[sword], [null]])).toBeNull();
  });

  it("words the comparison in player terms, never as a score", () => {
    expect(compareHeading(11)).toBe("Better than equipped");
    expect(compareHeading(-2)).toBe("Worse than equipped");
    expect(compareHeading(0)).toBe("Same as equipped");
  });

  it("labels categories in one spelling", () => {
    expect(CATEGORY_LABEL.armor).toBe("Armor");
  });

  it("shows rarity and category under the name, with the base only when the name hides it", () => {
    const sandals = {
      name: "Sandals",
      baseName: "Sandals",
      category: "boots",
      rarity: "normal",
    } as const;
    expect(itemKindLabel(sandals)).toBe("Normal Boots");
    expect(itemKindLabel({ ...sandals, name: "Sturdy Sandals of the Fox", rarity: "magic" })).toBe(
      "Magic Boots · Sandals",
    );
    expect(itemKindLabel({ name: "Gloomweave", category: "armor", rarity: "unique" })).toBe(
      "Unique Armor",
    );
  });
});

describe("slot table", () => {
  it("registers every widget and panel with the classic.hud module", () => {
    const slots = createSlotRegistry();
    registerDefaultHud(slots);
    expect(slots.list(SLOT.top).map((e) => e.id)).toEqual([
      "classic.areaBanner",
      "classic.controlBar",
      "classic.perfOverlay",
    ]);
    expect(slots.list(SLOT.topRight).map((e) => e.id)).toEqual(["classic.minimap"]);
    expect(slots.list(SLOT.target).map((e) => e.id)).toEqual([
      "classic.statusBar",
      "classic.targetBar",
    ]);
    expect(slots.list(SLOT.left).map((e) => e.id)).toEqual([
      "classic.questTracker",
      "classic.combatLog",
    ]);
    expect(slots.list(SLOT.bottom).map((e) => e.id)).toEqual([
      "classic.xpBar",
      "classic.lifeOrb",
      "classic.skillBar",
      "classic.belt",
      "classic.manaOrb",
      "classic.panelButtons",
    ]);
    expect(slots.list(SLOT.overlay).map((e) => e.id)).toEqual([
      "classic.newHeroScreen",
      "classic.deathScreen",
      "classic.toasts",
      "classic.tips",
      "classic.tooltip",
      "classic.errorFlash",
    ]);
    for (const id of PANEL_IDS) {
      const entries = slots.list(panelSlot(id));
      expect(entries.map((e) => e.id)).toEqual([`classic.panel.${id}`]);
      expect(entries[0]?.moduleId).toBe("classic.hud");
      expect(entries[0]?.component).toBe(PANEL_COMPONENTS[id]);
    }
    expect(DEFAULT_WIDGETS.every((w) => w.id.startsWith("classic."))).toBe(true);
  });

  it("refuses a second registration into the same registry", () => {
    const slots = createSlotRegistry();
    registerDefaultHud(slots);
    expect(() => registerDefaultHud(slots)).toThrow();
  });

  it("has twenty panel ids (wave A adds six, wave B four), each unique", () => {
    expect(new Set(PANEL_IDS).size).toBe(20);
  });
});

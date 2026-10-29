import { describe, expect, it } from "vite-plus/test";
import {
  clampOffset,
  compareLabels,
  deoverlapLabels,
  estimateLabelWidth,
  insetRect,
  LABEL_MAX_STEPS,
  labelOffView,
  labelRank,
  underChrome,
  type LabelBox,
  type LabelRect,
} from "../../src/client/render/label-layout.ts";

function box(id: string, x: number, bottom: number, rank = 0, w = 40, h = 15): LabelBox {
  return { id, x, bottom, w, h, rank, dy: 0 };
}

function overlap(a: LabelBox, b: LabelBox): boolean {
  const aTop = a.bottom + a.dy - a.h;
  const bTop = b.bottom + b.dy - b.h;
  const v = !(a.bottom + a.dy <= bTop || b.bottom + b.dy <= aTop);
  return v && Math.abs(a.x - b.x) * 2 < a.w + b.w;
}

describe("deoverlapLabels", () => {
  it("leaves separate labels in place", () => {
    const boxes = [box("a", 0, 0), box("b", 100, 0), box("c", 0, 40)];
    deoverlapLabels(boxes, 3);
    expect(boxes.map((b) => b.dy)).toEqual([0, 0, 0]);
  });

  it("keeps the rarest label in place and pushes the others up until they fit", () => {
    const boxes = [box("gold", 0, 0, 0), box("unique", 4, 2, 5), box("rare", -3, 1, 4)];
    deoverlapLabels(boxes, 3);
    // Sorted: unique, rare, gold.
    expect(boxes.map((b) => b.id)).toEqual(["unique", "rare", "gold"]);
    expect(boxes[0]!.dy).toBe(0);
    expect(boxes[1]!.dy).toBeLessThan(0);
    expect(boxes[2]!.dy).toBeLessThan(boxes[1]!.dy);
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) expect(overlap(boxes[i]!, boxes[j]!)).toBe(false);
    }
  });

  it("stacks a dense pile into a column, giving up after LABEL_MAX_STEPS pushes", () => {
    const boxes: LabelBox[] = [];
    const n = LABEL_MAX_STEPS + 4;
    for (let i = 0; i < n; i++) boxes.push(box(`l${i}`, 0, 0, n - i));
    deoverlapLabels(boxes, n);
    for (const b of boxes) expect(b.dy).toBeGreaterThanOrEqual(-LABEL_MAX_STEPS * 16);
    // The first LABEL_MAX_STEPS + 1 labels all fit.
    for (let i = 0; i <= LABEL_MAX_STEPS; i++) {
      for (let j = i + 1; j <= LABEL_MAX_STEPS; j++) {
        expect(overlap(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
  });

  it("only lays out the first n boxes", () => {
    const boxes = [box("b", 0, 0, 1), box("a", 0, 0, 2), box("z", 0, 0, 9)];
    deoverlapLabels(boxes, 2);
    expect(boxes[0]!.id).toBe("a");
    expect(boxes[1]!.dy).toBeLessThan(0);
    expect(boxes[2]!.id).toBe("z");
    expect(boxes[2]!.dy).toBe(0);
  });

  it("orders by rank, then id", () => {
    expect(compareLabels(box("a", 0, 0, 2), box("b", 0, 0, 1))).toBeLessThan(0);
    expect(compareLabels(box("a", 0, 0, 1), box("b", 0, 0, 1))).toBeLessThan(0);
    expect(compareLabels(box("b", 0, 0, 1), box("a", 0, 0, 1))).toBeGreaterThan(0);
  });
});

describe("clampOffset", () => {
  it("is 0 inside the view and pushes labels back inside at the edges", () => {
    expect(clampOffset(50, 20, 0, 100, 4)).toBe(0);
    expect(clampOffset(2, 20, 0, 100, 4)).toBe(12);
    expect(clampOffset(99, 20, 0, 100, 4)).toBe(-13);
    // Wider than the view: centred.
    expect(clampOffset(10, 200, 0, 100, 4)).toBe(40);
  });
});

describe("estimateLabelWidth", () => {
  it("grows with the text and the font size", () => {
    expect(estimateLabelWidth("", 12)).toBe(0);
    expect(estimateLabelWidth("Short Sword", 12)).toBeGreaterThan(estimateLabelWidth("Bow", 12));
    expect(estimateLabelWidth("Bow", 14)).toBeGreaterThan(estimateLabelWidth("Bow", 10));
  });
});

describe("world label de-overlap (signs, nameplates, loot)", () => {
  it("keeps the hero nameplate in place and pushes a station sign with its hint up", () => {
    // 'Stairs up' + 'click to use' (two lines, 27 px) right over 'QA Rogue'.
    const hero: LabelBox = {
      ...box("hero", 640, 310, labelRank("unit", true, 0), 60, 15),
      group: "",
    };
    const sign: LabelBox = {
      ...box("stairs", 650, 318, labelRank("prop", false, 0), 70, 27),
      group: "",
    };
    const boxes = [sign, hero];
    deoverlapLabels(boxes, 2);
    expect(boxes[0]).toBe(hero);
    expect(hero.dy).toBe(0);
    expect(sign.dy).toBeLessThan(0);
    expect(overlap(hero, sign)).toBe(false);
  });

  it("ranks the hero over every unit, units over NPCs over signs over loot", () => {
    const self = labelRank("unit", true, 0);
    expect(self).toBe(Number.POSITIVE_INFINITY);
    expect(labelRank("unit", false, 0)).toBeGreaterThan(labelRank("npc", false, 5));
    expect(labelRank("npc", false, 0)).toBeGreaterThan(labelRank("prop", false, 5));
    expect(labelRank("prop", false, 0)).toBeGreaterThan(labelRank("loot", false, 5));
    expect(labelRank("unit", false, 3)).toBeGreaterThan(labelRank("unit", false, 1));
    // Two infinities still compare (no NaN from Infinity - Infinity).
    expect(compareLabels(box("a", 0, 0, self), box("b", 0, 0, self))).toBeLessThan(0);
  });

  it("never prints two different monster names over each other", () => {
    const a: LabelBox = { ...box("c10", 400, 120, labelRank("unit", false, 0), 90), group: "Husk" };
    const b: LabelBox = {
      ...box("c11", 430, 126, labelRank("unit", false, 0), 100),
      group: "Gnawling",
    };
    const boxes = [b, a];
    deoverlapLabels(boxes, 2);
    expect(a.hidden).toBe(false);
    expect(b.hidden).toBe(false);
    expect(overlap(a, b)).toBe(false);
  });

  it("shows one name for adjacent monsters of the same name (a pack standing together)", () => {
    // 'Mighty Gnawling' twice, 18 px apart at the same x: no overlap, but stacked duplicates.
    const a: LabelBox = { ...box("c20", 455, 200, 401, 100), group: "Mighty Gnawling" };
    const b: LabelBox = { ...box("c21", 455, 218, 401, 100), group: "Mighty Gnawling" };
    const far: LabelBox = { ...box("c22", 700, 218, 401, 100), group: "Mighty Gnawling" };
    const boxes = [b, far, a];
    deoverlapLabels(boxes, 3);
    expect(a.hidden).toBe(false);
    expect(b.hidden).toBe(true);
    expect(b.dy).toBe(0);
    // A pack member further away keeps its own name.
    expect(far.hidden).toBe(false);
  });

  it("does not let a hidden duplicate push other labels around", () => {
    const a: LabelBox = { ...box("c1", 0, 0, 401, 60), group: "Husk" };
    const dup: LabelBox = { ...box("c2", 0, 10, 401, 60), group: "Husk" };
    const loot: LabelBox = { ...box("c3", 0, 22, labelRank("loot", false, 0), 60), group: "" };
    deoverlapLabels([a, dup, loot], 3);
    expect(dup.hidden).toBe(true);
    // The loot label only had to clear `a` (bottom 0), not the hidden duplicate.
    expect(loot.dy).toBe(0);
  });

  it("re-sorts a nearly sorted list without Array.prototype.sort", () => {
    const boxes = [box("b", 0, 0, 1), box("a", 0, 0, 2), box("c", 100, 0, 0)];
    deoverlapLabels(boxes, 3);
    expect(boxes.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });
});

describe("HUD label insets", () => {
  const outer: LabelRect = { x0: -200, y0: -100, x1: 200, y1: 100 };

  it("shrinks the view rect by the screen insets, scaled by the zoom", () => {
    const out: LabelRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    const r = insetRect(outer, { top: 80, right: 0, bottom: 40, left: 0 }, 2, out);
    expect(r).toBe(out);
    expect(out).toEqual({ x0: -200, y0: -60, x1: 200, y1: 80 });
    insetRect(outer, { top: 0, right: 0, bottom: 0, left: 0 }, 1, out);
    expect(out).toEqual(outer);
    // Insets larger than the view collapse to a line instead of inverting.
    insetRect(outer, { top: 150, right: 0, bottom: 150, left: 0 }, 1, out);
    expect(out.y0).toBe(out.y1);
  });

  it("clamps labels below the top HUD bar and hides those whose entity is under it", () => {
    const inner: LabelRect = { x0: -200, y0: -20, x1: 200, y1: 100 };
    // Feet just below the bar: the label is clamped inside the inner rect.
    expect(underChrome(0, -10, outer, inner)).toBe(false);
    const top = -10 - 40; // stack top 40 px above the feet, under the bar
    const cy = top < inner.y0 + 4 ? inner.y0 + 4 - top : 0;
    expect(cy).toBe(34);
    // Feet under the bar: hidden, not dragged down far away from the entity.
    expect(underChrome(0, -50, outer, inner)).toBe(true);
    // Edges without an inset keep the plain view clamp.
    expect(underChrome(0, 150, outer, inner)).toBe(false);
    expect(underChrome(-300, 0, outer, inner)).toBe(false);
  });

  it("keeps a sign near the right edge inside a right inset (phone minimap column)", () => {
    const inner: LabelRect = { x0: -200, y0: -100, x1: 140, y1: 100 };
    expect(underChrome(150, 0, outer, inner)).toBe(true);
    expect(underChrome(120, 0, outer, inner)).toBe(false);
    // 'Smith' (50 px wide) centred at x 130 is pulled left inside the inner rect.
    expect(clampOffset(130, 50, inner.x0, inner.x1, 4)).toBe(-19);
  });
});

describe("labelOffView", () => {
  const view: LabelRect = { x0: 0, y0: 0, x1: 800, y1: 600 };
  it("hides a label whose entity is wholly off screen (it would only show clamped to the edge)", () => {
    // QA: off-screen party members' names piled at the bottom-right corner.
    expect(labelOffView(900, 60, 500, 515, view)).toBe(true);
    expect(labelOffView(-50, 60, 300, 315, view)).toBe(true);
    expect(labelOffView(400, 60, 640, 655, view)).toBe(true);
    expect(labelOffView(400, 60, -40, -25, view)).toBe(true);
  });
  it("keeps labels that are at least partly in view (they are clamped, not hidden)", () => {
    expect(labelOffView(400, 60, 300, 315, view)).toBe(false);
    expect(labelOffView(820, 60, 300, 315, view)).toBe(false);
    expect(labelOffView(400, 60, 590, 605, view)).toBe(false);
    // Feet below the view, name above them still visible.
    expect(labelOffView(400, 60, 560, 575, view)).toBe(false);
  });
});

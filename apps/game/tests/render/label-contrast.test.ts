import { describe, expect, it } from "vite-plus/test";
// The classic colours themselves (contract.ts only has type imports, so it is pure).
import { MONSTER_LABEL_COLOR } from "../../../../modules/classic/src/client/contract.ts";
import {
  compositeOver,
  contrastRatio,
  labelBacking,
  lightenTowardsWhite,
  MIN_LABEL_CONTRAST,
  PLATE_ALPHA,
  PLATE_COLOUR,
  readableLabelColour,
  relativeLuminance,
  SUBTITLE_COLOUR,
} from "../../src/client/render/label-contrast.ts";

// Ground colours the labels sit on (palette.ts groundFallbackColour and the tile art).
const GRASS = 0x4d7c3a;
const DIRT = 0x6b5b4b;
const STONE = 0x7d8491;
const CAVE = 0x3f3428;

describe("WCAG contrast helpers", () => {
  it("matches the WCAG extremes", () => {
    expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 5);
    expect(contrastRatio(0x123456, 0x123456)).toBe(1);
    expect(relativeLuminance(0xffffff)).toBeCloseTo(1, 6);
    expect(relativeLuminance(0x000000)).toBe(0);
  });

  it("composites a translucent colour over a ground colour", () => {
    expect(compositeOver(0x112233, 0x445566, 1)).toBe(0x112233);
    expect(compositeOver(0x112233, 0x445566, 0)).toBe(0x445566);
    expect(compositeOver(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });

  it("lightens a colour towards white", () => {
    expect(lightenTowardsWhite(0x102030, 0)).toBe(0x102030);
    expect(lightenTowardsWhite(0x102030, 1)).toBe(0xffffff);
  });
});

describe("readableLabelColour", () => {
  it("keeps a fill that already reaches the minimum contrast", () => {
    expect(readableLabelColour(0xffffff, 0x000000)).toBe(0xffffff);
    expect(readableLabelColour(0xffd166, 0x000000)).toBe(0xffd166);
  });

  it("lifts a dark tint until it reaches the minimum, keeping the hue direction", () => {
    const deepBlue = 0x1a3a7a;
    const deepRed = 0x6a1414;
    const blue = readableLabelColour(deepBlue, PLATE_COLOUR);
    const red = readableLabelColour(deepRed, PLATE_COLOUR);
    expect(contrastRatio(blue, PLATE_COLOUR)).toBeGreaterThanOrEqual(MIN_LABEL_CONTRAST);
    expect(contrastRatio(red, PLATE_COLOUR)).toBeGreaterThanOrEqual(MIN_LABEL_CONTRAST);
    expect(blue & 0xff).toBeGreaterThan((blue >> 16) & 0xff);
    expect((red >> 16) & 0xff).toBeGreaterThan(red & 0xff);
  });
});

describe("role subtitle contrast (NPC roles: 'Smith', 'Rag Buyer')", () => {
  it("is below 4.5:1 on bright grass without a plate (why the plate exists)", () => {
    expect(contrastRatio(SUBTITLE_COLOUR, GRASS)).toBeLessThan(MIN_LABEL_CONTRAST);
  });

  for (const [name, ground] of [
    ["grass", GRASS],
    ["dirt", DIRT],
    ["stone", STONE],
    ["cave", CAVE],
  ] as const) {
    it(`reaches 4.5:1 over the plate on ${name}`, () => {
      const backing = compositeOver(PLATE_COLOUR, ground, PLATE_ALPHA);
      expect(contrastRatio(SUBTITLE_COLOUR, backing)).toBeGreaterThanOrEqual(MIN_LABEL_CONTRAST);
    });
  }
});

describe("monster variant nameplates (champion, unique, boss)", () => {
  const variants = [
    ["champion", MONSTER_LABEL_COLOR.champion],
    ["unique", MONSTER_LABEL_COLOR.unique],
    ["boss", MONSTER_LABEL_COLOR.boss],
  ] as const;

  for (const [name, colour] of variants) {
    it(`${name} reads at 4.5:1 on its plate and on the bare stroke`, () => {
      const plated = readableLabelColour(colour, labelBacking(true));
      const bare = readableLabelColour(colour, labelBacking(false));
      expect(contrastRatio(plated, labelBacking(true))).toBeGreaterThanOrEqual(MIN_LABEL_CONTRAST);
      expect(contrastRatio(bare, labelBacking(false))).toBeGreaterThanOrEqual(MIN_LABEL_CONTRAST);
    });
  }

  it("keeps the three variant colours distinct", () => {
    const fills = variants.map(([, c]) => readableLabelColour(c, labelBacking(true)));
    expect(new Set(fills).size).toBe(3);
  });
});

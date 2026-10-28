import { describe, expect, it } from "vite-plus/test";
import { Container, Texture, type ColorMatrixFilter } from "pixi.js";
import type { ArpgRenderEntity } from "@gamez/ui-host";
import { EntityLayer, type EntityView } from "../../src/client/render/entity-view.ts";
import { buildPrimitives } from "../../src/client/render/primitives.ts";
import type { AnimVisual, Visuals } from "../../src/client/render/visuals.ts";
import {
  fadeToward,
  localRadius,
  OUTLINE_FADE_MS,
  OUTLINE_PX,
  OUTLINE_STYLE,
  OUTLINE_TAPS,
  outlineOffsets,
  outlineRim,
  outlineStyle,
  outlineTaps,
  resolveHighlight,
  RING_PERIOD_MS,
  ringAlpha,
  ringPulse,
  ringScale,
  solidMatrix,
  tapShown,
} from "../../src/client/render/outline-math.ts";

describe("outline maths", () => {
  it("resolves the identity outline: kinds win, true is hover, omitted follows isSelf", () => {
    expect(resolveHighlight("self", false)).toBe("self");
    expect(resolveHighlight("party", true)).toBe("party");
    expect(resolveHighlight("ally", false)).toBe("ally");
    expect(resolveHighlight(undefined, true)).toBe("self");
    expect(resolveHighlight(undefined, false)).toBeNull();
    expect(resolveHighlight(true, false)).toBeNull();
    expect(resolveHighlight(true, true)).toBeNull();
    expect(resolveHighlight(false, true)).toBeNull();
    expect(resolveHighlight(null, true)).toBeNull();
  });

  it("gives each kind its own colour, self the brightest and most opaque", () => {
    const self = outlineStyle("self");
    const party = outlineStyle("party");
    const ally = outlineStyle("ally");
    expect(new Set([self.colour, party.colour, ally.colour]).size).toBe(3);
    expect(self.alpha).toBeGreaterThan(party.alpha);
    expect(party.alpha).toBeGreaterThan(ally.alpha);
    expect(self.ringMax).toBeGreaterThan(party.ringMax);
    // Self is a warm gold-white: red and green high, blue lower.
    expect((self.colour >> 16) & 0xff).toBeGreaterThan(0xf0);
    expect((self.colour >> 8) & 0xff).toBeGreaterThan(0xc0);
    expect(self.colour & 0xff).toBeLessThan((self.colour >> 8) & 0xff);
    // Party is cyan-ish (blue dominant), ally green-ish (green dominant).
    expect(party.colour & 0xff).toBeGreaterThan((party.colour >> 16) & 0xff);
    expect((ally.colour >> 8) & 0xff).toBeGreaterThan((ally.colour >> 16) & 0xff);
    for (const s of Object.values(OUTLINE_STYLE)) expect(s.ringMin).toBeLessThan(s.ringMax);
  });

  it("uses 8 taps and a dark rim on medium and high, 4 cardinal taps on low", () => {
    expect(outlineTaps("high")).toBe(8);
    expect(outlineTaps("medium")).toBe(8);
    expect(outlineTaps("low")).toBe(4);
    expect(outlineRim("high")).toBe(true);
    expect(outlineRim("low")).toBe(false);
    const shown = (taps: number) =>
      Array.from({ length: OUTLINE_TAPS }, (_, i) => i).filter((i) => tapShown(i, taps));
    expect(shown(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(shown(4)).toEqual([0, 2, 4, 6]);
  });

  it("writes stamp offsets on a circle in place, cardinals on even indexes", () => {
    const out = new Float32Array(OUTLINE_TAPS * 2);
    outlineOffsets(2, out);
    expect([out[0], out[1]]).toEqual([2, 0]);
    expect([out[4], out[5]]).toEqual([0, 2]);
    expect([out[8], out[9]]).toEqual([-2, 0]);
    expect([out[12], out[13]]).toEqual([0, -2]);
    for (let i = 0; i < OUTLINE_TAPS; i++) {
      expect(Math.hypot(out[i * 2]!, out[i * 2 + 1]!)).toBeCloseTo(2, 5);
    }
    outlineOffsets(Number.NaN, out);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it("keeps the on-screen width under zoom and unit scale", () => {
    expect(localRadius(1.5, 1, 1)).toBe(1.5);
    expect(localRadius(1.5, 2, 1)).toBe(0.75);
    expect(localRadius(1.5, 0.5, 1)).toBe(3);
    expect(localRadius(1.5, 1, 1.5)).toBe(1);
    expect(localRadius(1.5, 0, Number.NaN)).toBe(1.5);
  });

  it("pulses the ring smoothly between its alpha and scale bounds", () => {
    expect(ringPulse(0)).toBeCloseTo(0, 9);
    expect(ringPulse(RING_PERIOD_MS / 2)).toBeCloseTo(1, 9);
    expect(ringPulse(RING_PERIOD_MS)).toBeCloseTo(0, 9);
    expect(ringPulse(Number.NaN)).toBeCloseTo(0, 9);
    const s = outlineStyle("self");
    expect(ringAlpha(s, 0)).toBe(s.ringMin);
    expect(ringAlpha(s, 1)).toBe(s.ringMax);
    expect(ringAlpha(s, 5)).toBe(s.ringMax);
    expect(ringScale(0)).toBeCloseTo(0.92, 9);
    expect(ringScale(1)).toBeCloseTo(1.08, 9);
  });

  it("fades linearly over OUTLINE_FADE_MS and never overshoots", () => {
    expect(fadeToward(1, 0, OUTLINE_FADE_MS / 2)).toBeCloseTo(0.5, 9);
    expect(fadeToward(0.2, 0, OUTLINE_FADE_MS)).toBe(0);
    expect(fadeToward(0.9, 1, OUTLINE_FADE_MS)).toBe(1);
    expect(fadeToward(0.5, 0.5, 100)).toBe(0.5);
    expect(fadeToward(0.5, 0, -10)).toBe(0.5);
  });

  it("paints solid colour at the given alpha", () => {
    const m = solidMatrix(0xff8000, 0.5);
    expect(m).toHaveLength(20);
    expect(m[4]).toBe(1);
    expect(m[9]).toBeCloseTo(128 / 255, 9);
    expect(m[14]).toBe(0);
    expect(m[18]).toBe(0.5);
    for (const i of [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 19]) expect(m[i]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EntityLayer: the outline follows the sprite.
// ---------------------------------------------------------------------------

/** Four distinct frames for every animation key in `anims`. */
function framedVisuals(anims: string[]): Visuals {
  const frames = [new Texture(), new Texture(), new Texture(), new Texture()];
  const cache = new Map<string, AnimVisual>();
  const anim = (key: string): AnimVisual | null => {
    if (!anims.includes(key)) return null;
    let v = cache.get(key);
    if (!v) {
      v = { frames, anchor: { x: 0.5, y: 0.9 }, fps: 10, loop: true };
      cache.set(key, v);
    }
    return v;
  };
  return {
    sprite: () => null,
    animation: anim,
    spriteExact: () => null,
    animationExact: anim,
    hasExactAnimation: (key: string) => anims.includes(key),
  };
}

class FakeFilter {
  matrix: number[] = [];
  destroy(): void {}
}

function hero(extra: Partial<ArpgRenderEntity> = {}): ArpgRenderEntity {
  return {
    id: "h",
    name: "Hero",
    appearance: "unit.hero",
    kind: "unit",
    x: 5,
    y: 5,
    facing: "se",
    moving: false,
    isSelf: true,
    ...extra,
  };
}

function setup() {
  const world = new Container();
  const layer = new EntityLayer(
    world,
    framedVisuals(["unit.hero.idle", "unit.hero.attack", "unit.hero.death"]),
    buildPrimitives(),
    new Container(),
  );
  const filters: FakeFilter[] = [];
  layer.makeOutlineFilter = () => {
    const f = new FakeFilter();
    filters.push(f);
    return f as unknown as ColorMatrixFilter;
  };
  const view = (id = "h"): EntityView => {
    for (const v of layer.all()) if (v.id === id) return v;
    throw new Error(`no view ${id}`);
  };
  return { layer, view, filters };
}

describe("EntityLayer identity outline", () => {
  it("outlines isSelf heroes by default, behind the body, with a ground ring", () => {
    const { layer, view, filters } = setup();
    layer.upsert(hero());
    const v = view();
    const o = v.outline!;
    expect(o).not.toBeNull();
    expect(o.kind).toBe("self");
    expect(v.body.getChildIndex(o.root)).toBe(0);
    expect(v.body.getChildIndex(v.anim!)).toBeGreaterThan(0);
    expect(o.fillStamps).toHaveLength(OUTLINE_TAPS);
    expect(o.rimStamps).toHaveLength(OUTLINE_TAPS);
    expect(o.ring.visible).toBe(true);
    expect(filters).toHaveLength(1);
    expect(filters[0]!.matrix).toEqual(solidMatrix(OUTLINE_STYLE.self.colour, 1));
    for (const s of o.rimStamps) expect(s.tint).toBe(0x000000);
    expect(layer.outlineCensus()).toEqual({ self: 1, party: 0, ally: 0 });
  });

  it("draws no outline for hover highlight, null, or plain monsters", () => {
    const { layer, view } = setup();
    layer.upsert(hero({ id: "a", isSelf: false, highlight: true }));
    layer.upsert(hero({ id: "b", isSelf: true, highlight: null }));
    layer.upsert(hero({ id: "c", isSelf: false }));
    layer.upsert(hero({ id: "d", kind: "npc", isSelf: false, highlight: "ally" }));
    for (const id of ["a", "b", "c", "d"]) expect(view(id).outline).toBeNull();
    expect(layer.outlineCensus()).toEqual({ self: 0, party: 0, ally: 0 });
  });

  it("colours party and ally outlines and switches kind in place", () => {
    const { layer, view, filters } = setup();
    layer.upsert(hero({ id: "p", isSelf: false, highlight: "party" }));
    layer.upsert(hero({ id: "q", isSelf: false, highlight: "ally" }));
    expect(filters[0]!.matrix).toEqual(solidMatrix(OUTLINE_STYLE.party.colour, 0.85));
    expect(filters[1]!.matrix).toEqual(solidMatrix(OUTLINE_STYLE.ally.colour, 0.7));
    expect(layer.outlineCensus()).toEqual({ self: 0, party: 1, ally: 1 });
    const ring = view("p").outline!.ring;
    layer.upsert(hero({ id: "p", isSelf: false, highlight: "ally" }));
    expect(view("p").outline!.ring).toBe(ring);
    expect(filters).toHaveLength(2);
    expect(filters[0]!.matrix).toEqual(solidMatrix(OUTLINE_STYLE.ally.colour, 0.7));
    // Turning it off hides it and keeps the containers for later.
    layer.upsert(hero({ id: "p", isSelf: false, highlight: null }));
    expect(view("p").outline!.root.visible).toBe(false);
    expect(view("p").outline!.ring.visible).toBe(false);
    expect(layer.outlineCensus().ally).toBe(1);
  });

  it("follows every frame of the clip, its anchor and the flip", () => {
    const { layer, view } = setup();
    layer.upsert(hero({ action: "attack", actionProgress: 0 }));
    const v = view();
    const o = v.outline!;
    expect(o.fillStamps[0]!.texture).toBe(v.anim!.texture);
    for (const p of [0.3, 0.6, 0.99]) {
      layer.upsert(hero({ action: "attack", actionProgress: p }));
      layer.tickPulse(100 * p);
      for (const s of o.fillStamps) expect(s.texture).toBe(v.anim!.texture);
      for (const s of o.rimStamps) expect(s.texture).toBe(v.anim!.texture);
    }
    expect(o.fillStamps[0]!.anchor.x).toBe(0.5);
    expect(o.fillStamps[0]!.anchor.y).toBe(0.9);
    // Autoplay frames (the renderer advances clips before tickPulse).
    layer.upsert(hero());
    v.anim!.gotoAndStop(2);
    layer.tickPulse(500);
    expect(o.fillStamps[3]!.texture).toBe(v.anim!.texture);
    // Inside the body: the flip (body.scale.x < 0) mirrors the stamps too.
    layer.upsert(hero({ facing: "w" }));
    expect(v.body.scale.x).toBeLessThan(0);
    expect(o.root.parent).toBe(v.body);
  });

  it("fades the outline and ring out on death and back on revive", () => {
    const { layer, view } = setup();
    layer.upsert(hero());
    layer.tickPulse(0);
    const o = view().outline!;
    layer.upsert(hero({ action: "death", dead: true }));
    layer.tickPulse(OUTLINE_FADE_MS / 2);
    expect(o.fade).toBeCloseTo(0.5, 5);
    expect(o.root.alpha).toBeCloseTo(0.5, 5);
    layer.tickPulse(OUTLINE_FADE_MS * 2);
    expect(o.fade).toBe(0);
    expect(o.root.visible).toBe(false);
    expect(o.ring.visible).toBe(false);
    expect(layer.outlineCensus().self).toBe(0);
    layer.upsert(hero());
    layer.tickPulse(OUTLINE_FADE_MS * 3);
    expect(o.fade).toBe(1);
    expect(o.root.visible).toBe(true);
    expect(o.ring.visible).toBe(true);
  });

  it("pulses the ring every frame and keeps the width under zoom", () => {
    const { layer, view } = setup();
    layer.upsert(hero());
    const o = view().outline!;
    layer.tickPulse(0);
    const a0 = o.ring.alpha;
    layer.tickPulse(RING_PERIOD_MS / 2);
    expect(o.ring.alpha).toBeGreaterThan(a0);
    expect(o.ring.scale.x).toBeCloseTo(1.08, 5);
    expect(o.fillStamps[0]!.x).toBe(OUTLINE_PX);
    layer.setOutlineZoom(2);
    layer.tickPulse(RING_PERIOD_MS);
    expect(o.fillStamps[0]!.x).toBe(OUTLINE_PX / 2);
  });

  it("drops to 4 taps and no rim on low quality, and back", () => {
    const { layer, view } = setup();
    layer.upsert(hero());
    const o = view().outline!;
    layer.setOutlineQuality("low");
    expect(o.fillStamps.filter((s) => s.visible)).toHaveLength(4);
    expect(o.rim.visible).toBe(false);
    layer.setOutlineQuality("high");
    expect(o.fillStamps.filter((s) => s.visible)).toHaveLength(8);
    expect(o.rim.visible).toBe(true);
  });

  it("tints the copies when no filter can be made, and cleans up on remove", () => {
    const { layer, view } = setup();
    layer.makeOutlineFilter = () => null;
    layer.upsert(hero());
    const o = view().outline!;
    expect(o.filter).toBeNull();
    for (const s of o.fillStamps) expect(s.tint).toBe(OUTLINE_STYLE.self.colour);
    layer.remove("h");
    expect(layer.outlineCensus().self).toBe(0);
    expect(() => layer.tickPulse(10)).not.toThrow();
  });
});

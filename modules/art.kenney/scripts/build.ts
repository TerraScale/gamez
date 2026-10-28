/**
 * Builds the Kenney art pack: crops and scales the PNGs in src-art/, derives
 * recoloured variants and draws the procedural sprites, packs everything into
 * one or more atlas pages and writes the asset manifest.
 *
 * Run with `node modules/art.kenney/scripts/build.ts` (or `pnpm build-art`).
 * Output goes to apps/game/public/art/kenney/: atlas-N.png + atlas-N.json
 * (TexturePacker hash format, pages of at most 2048x2048) and manifest.json
 * (AssetManifest). Every file is written to a temp name and renamed, so a
 * running dev server never reads a half-written file.
 *
 * Scales. Each Kenney pack has its own ground diamond width, so each pack keeps
 * its own scale and its walls and props stay on the 64x32 grid:
 *   Isometric Miniature Dungeon: 256px diamonds -> SCALE_DUNGEON (floors, walls, props)
 *   Isometric Landscape and Nature Kit: 132px diamonds -> SCALE_LANDSCAPE (town ground, trees, rocks)
 *   City Kit (Suburban) previews are 64px icons and keep their native size.
 * Character frames use SCALE_UNIT (the Phase-0 hero size). Kenney's Male_0..7
 * sets are one character in 8 directions, so every unit gets per-facing clips
 * (`<id>.<action>.<facing>`): idle and walk from Kenney's own frames, attack,
 * cast, hit and death posed from that facing's idle frame. Families differ by
 * recolour, scale, body shape (width bumps, squat, hunch, ghost fade) and drawn
 * silhouette cues (hoods, robes, horns, legs, crowns...); see UNITS.
 * Unit frames are trimmed (TexturePacker `trimmed` + `spriteSourceSize`), so
 * every frame of a unit shares one source box and anchor while the atlas only
 * stores opaque pixels; identical images are packed once.
 *
 * Determinism: the build has no randomness, so re-running it gives the same bytes.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { AnimationRef, AssetManifest, SpriteRef } from "@gamez/assets";

type Img = InstanceType<typeof PNG>;
type RGBA = [number, number, number, number];
interface Anchor {
  x: number;
  y: number;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Colour adjustments applied to Kenney pixels. Every field is optional. */
interface Look {
  /** Hue rotation in degrees. */
  hue?: number;
  /** Saturation multiplier. */
  sat?: number;
  /** Lightness offset, -1..1. */
  light?: number;
  /** Multiply tint 0xRRGGBB, mixed in by `tintMix` (0..1). */
  tint?: number;
  tintMix?: number;
  /** Alpha multiplier (ghosts). */
  alpha?: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src-art");
const OUT = join(here, "..", "..", "..", "apps", "game", "public", "art", "kenney");

const PACK = "art.kenney";
const ATLAS_SIDE = 2048;
const PAD = 1;
const TILE_W = 64;
const TILE_H = 32;
const SCALE_DUNGEON = 64 / 256;
const SCALE_LANDSCAPE = 64 / 132;
const SCALE_UNIT = 64 / 132;

const BOTTOM: Anchor = { x: 0.5, y: 1 };
const TOP: Anchor = { x: 0.5, y: 0 };
const CENTER: Anchor = { x: 0.5, y: 0.5 };
const LOOT: Anchor = { x: 0.5, y: 0.75 };

const DUNGEON = "kenney-dungeon/Isometric/";
const NATURE = "kenney-nature/";
const SUBURBAN = "kenney-city-suburban/";

// ---------------------------------------------------------------- pixels

function blank(width: number, height: number): Img {
  return new PNG({ width, height });
}

const cache = new Map<string, Img>();
/** Source PNGs are read once and never mutated; every transform returns a copy. */
function load(rel: string): Img {
  let img = cache.get(rel);
  if (!img) {
    img = PNG.sync.read(readFileSync(join(SRC, rel)));
    cache.set(rel, img);
  }
  return img;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function crop(src: Img, box: Box): Img {
  const out = blank(box.w, box.h);
  for (let row = 0; row < box.h; row++) {
    const from = ((box.y + row) * src.width + box.x) * 4;
    src.data.copy(out.data, row * box.w * 4, from, from + box.w * 4);
  }
  return out;
}

/** Smallest box that holds every pixel with alpha > 0. */
function alphaBox(img: Img): Box {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) throw new Error("source image is fully transparent");
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function union(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Area-averaged resize; colour is weighted by alpha so edges do not darken. */
function resize(src: Img, w: number, h: number): Img {
  const out = blank(w, h);
  const sx = src.width / w;
  const sy = src.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          const al = src.data[i + 3]!;
          r += src.data[i]! * al;
          g += src.data[i + 1]! * al;
          b += src.data[i + 2]! * al;
          a += al;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function scaleBy(img: Img, factor: number): Img {
  return resize(
    img,
    Math.max(1, Math.round(img.width * factor)),
    Math.max(1, Math.round(img.height * factor)),
  );
}

function fadeAlpha(img: Img, factor: number): Img {
  if (factor === 1) return img;
  const out = blank(img.width, img.height);
  img.data.copy(out.data);
  for (let i = 3; i < out.data.length; i += 4) {
    out.data[i] = Math.round(out.data[i]! * factor);
  }
  return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hueToRgb(p: number, q: number, t0: number): number {
  let t = t0;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

/** Returns a recoloured copy: hue, saturation and lightness, then a tint mix and alpha. */
function recolor(img: Img, look: Look): Img {
  const out = blank(img.width, img.height);
  const hue = (look.hue ?? 0) / 360;
  const sat = look.sat ?? 1;
  const light = look.light ?? 0;
  const alpha = look.alpha ?? 1;
  const mix = look.tintMix ?? 0;
  const tint = look.tint ?? 0xffffff;
  const tr = ((tint >> 16) & 255) / 255;
  const tg = ((tint >> 8) & 255) / 255;
  const tb = (tint & 255) / 255;
  const shift = hue !== 0 || sat !== 1 || light !== 0;
  const src = img.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]!;
    if (a === 0) continue;
    let r = src[i]! / 255;
    let g = src[i + 1]! / 255;
    let b = src[i + 2]! / 255;
    if (shift) {
      const [h0, s0, l0] = rgbToHsl(r, g, b);
      const [nr, ng, nb] = hslToRgb((h0 + hue + 1) % 1, clamp01(s0 * sat), clamp01(l0 + light));
      r = nr;
      g = ng;
      b = nb;
    }
    if (mix > 0) {
      r = r * (1 - mix) + r * tr * mix;
      g = g * (1 - mix) + g * tg * mix;
      b = b * (1 - mix) + b * tb * mix;
    }
    dst[i] = Math.round(clamp01(r) * 255);
    dst[i + 1] = Math.round(clamp01(g) * 255);
    dst[i + 2] = Math.round(clamp01(b) * 255);
    dst[i + 3] = Math.round(a * alpha);
  }
  return out;
}

/** Top face of an isometric block: keeps the diamond inside `box` and resizes it to 64x32. */
function diamond(img: Img, box: Box): Img {
  const h = Math.round(box.w / 2);
  const top = crop(img, { x: box.x, y: box.y, w: box.w, h });
  const hw = box.w / 2;
  const hh = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < box.w; x++) {
      const dx = Math.abs(x + 0.5 - hw) / hw;
      const dy = Math.abs(y + 0.5 - hh) / hh;
      if (dx + dy > 1) top.data[(y * box.w + x) * 4 + 3] = 0;
    }
  }
  return resize(top, TILE_W, TILE_H);
}

// ---------------------------------------------------------- procedural drawing

/** Tiny software canvas for the sprites Kenney does not provide. Anti-aliased shapes. */
function canvas(w: number, h: number) {
  return paintOn(blank(w, h));
}

/** The same drawing helpers on an existing image (used for the unit silhouette cues). */
function paintOn(img: Img) {
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const put = (x: number, y: number, c: RGBA, cov: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const sa = (c[3] / 255) * cov;
    if (sa <= 0) return;
    const i = (y * w + x) * 4;
    const da = d[i + 3]! / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    for (let k = 0; k < 3; k++) {
      d[i + k] = Math.round((c[k]! * sa + d[i + k]! * da * (1 - sa)) / oa);
    }
    d[i + 3] = Math.round(oa * 255);
  };
  const ellipse = (cx: number, cy: number, rx: number, ry: number, c: RGBA) => {
    const m = Math.min(rx, ry);
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y++) {
      for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        const dist = Math.sqrt(nx * nx + ny * ny);
        put(x, y, c, clamp01((1 - dist) * m + 0.5));
      }
    }
  };
  const erase = (cx: number, cy: number, rx: number, ry: number) => {
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y++) {
      for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1 && x >= 0 && y >= 0 && x < w && y < h) {
          d[(y * w + x) * 4 + 3] = 0;
        }
      }
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, width: number, c: RGBA) => {
    const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
    const pad = width / 2 + 1;
    for (let y = Math.floor(Math.min(y0, y1) - pad); y <= Math.ceil(Math.max(y0, y1) + pad); y++) {
      for (
        let x = Math.floor(Math.min(x0, x1) - pad);
        x <= Math.ceil(Math.max(x0, x1) + pad);
        x++
      ) {
        const px = x + 0.5;
        const py = y + 0.5;
        const t = clamp01(((px - x0) * (x1 - x0) + (py - y0) * (y1 - y0)) / len2);
        const dist = Math.hypot(px - (x0 + t * (x1 - x0)), py - (y0 + t * (y1 - y0)));
        put(x, y, c, clamp01(width / 2 - dist + 0.5));
      }
    }
  };
  const poly = (pts: [number, number][], c: RGBA) => {
    const ys = pts.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
          xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.floor(xs[k]!); x <= Math.ceil(xs[k + 1]!); x++) {
          if (x + 0.5 >= xs[k]! && x + 0.5 <= xs[k + 1]!) put(x, y, c, 1);
        }
      }
    }
  };
  const glow = (cx: number, cy: number, r: number, c: RGBA, power: number) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d < 1) put(x, y, c, (1 - d) ** power);
      }
    }
  };
  /** A rotated ellipse as a polygon (angle in radians). */
  const oval = (cx: number, cy: number, rx: number, ry: number, angle: number, c: RGBA) => {
    const pts: [number, number][] = [];
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    for (let k = 0; k < 20; k++) {
      const t = (k / 20) * Math.PI * 2;
      const x = rx * Math.cos(t);
      const y = ry * Math.sin(t);
      pts.push([cx + x * ca - y * sa, cy + x * sa + y * ca]);
    }
    poly(pts, c);
  };
  /** A polyline whose width tapers from w0 to w1. */
  const taper = (pts: [number, number][], w0: number, w1: number, c: RGBA) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const t = pts.length > 2 ? k / (pts.length - 2) : 0;
      const a = pts[k]!;
      const b = pts[k + 1]!;
      line(a[0], a[1], b[0], b[1], w0 + (w1 - w0) * t, c);
    }
  };
  return { img, w, h, put, ellipse, erase, line, poly, glow, oval, taper };
}
type Canvas = ReturnType<typeof canvas>;

function procedural(w: number, h: number, draw: (c: Canvas) => void): Img {
  const c = canvas(w, h);
  draw(c);
  return c.img;
}

const OUTLINE: RGBA = [24, 22, 30, 255];
const STEEL: RGBA = [201, 209, 218, 255];
const STEEL_DARK: RGBA = [112, 122, 134, 255];
const WOOD: RGBA = [139, 90, 43, 255];
const GOLD: RGBA = [217, 164, 65, 255];
const GOLD_BRIGHT: RGBA = [242, 194, 48, 255];
const GOLD_DARK: RGBA = [150, 102, 14, 255];
const LEATHER: RGBA = [107, 74, 46, 255];
const DARK: RGBA = [30, 30, 38, 255];
const GLASS: RGBA = [190, 205, 220, 210];
const WHITE: RGBA = [255, 255, 255, 255];

function missingTile(): Img {
  const img = blank(32, 32);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const magenta = ((x >> 3) + (y >> 3)) % 2 === 0;
      const o = (y * 32 + x) * 4;
      img.data[o] = magenta ? 255 : 0;
      img.data[o + 1] = 0;
      img.data[o + 2] = magenta ? 255 : 0;
      img.data[o + 3] = 255;
    }
  }
  return img;
}

function voidTile(): Img {
  return procedural(TILE_W, TILE_H, (c) => {
    c.poly(
      [
        [32, 0],
        [64, 16],
        [32, 32],
        [0, 16],
      ],
      [12, 10, 18, 255],
    );
    c.line(32, 1, 62, 16, 1.2, [44, 34, 64, 255]);
    c.line(62, 16, 32, 31, 1.2, [44, 34, 64, 255]);
    c.line(32, 31, 2, 16, 1.2, [44, 34, 64, 255]);
    c.line(2, 16, 32, 1, 1.2, [44, 34, 64, 255]);
  });
}

/**
 * A potion flask. Tier 1 is a small vial with a cork, tier 2 the round flask,
 * tier 3 a bigger bulb with a metal cap, and tier 4 a large ornate flask with a
 * gold collar and a gem. Tier 2 is also the fallback look of the untiered ids.
 */
function potion(liquid: RGBA, tier = 2): Img {
  if (tier === 1) {
    return procedural(10, 15, (c) => {
      c.ellipse(5, 10.5, 3.9, 3.8, OUTLINE);
      c.ellipse(5, 10.5, 3.1, 3, liquid);
      c.poly(
        [
          [4, 7],
          [6, 7],
          [6, 4],
          [4, 4],
        ],
        GLASS,
      );
      c.poly(
        [
          [3.5, 1.2],
          [6.5, 1.2],
          [6.5, 4.2],
          [3.5, 4.2],
        ],
        WOOD,
      );
      c.ellipse(3.5, 9.4, 0.9, 0.9, [255, 255, 255, 170]);
    });
  }
  if (tier === 3) {
    return procedural(16, 20, (c) => {
      c.ellipse(8, 13.5, 6.8, 6.5, OUTLINE);
      c.ellipse(8, 13.5, 5.8, 5.5, liquid);
      c.poly(
        [
          [6, 8],
          [10, 8],
          [10, 5],
          [6, 5],
        ],
        GLASS,
      );
      c.poly(
        [
          [5, 1.5],
          [11, 1.5],
          [11, 5.5],
          [5, 5.5],
        ],
        STEEL,
      );
      c.line(6, 2.5, 10, 2.5, 0.8, WHITE);
      c.ellipse(5.2, 11.5, 1.4, 1.4, [255, 255, 255, 170]);
    });
  }
  if (tier === 4) {
    return procedural(20, 24, (c) => {
      c.ellipse(10, 15.5, 9, 8.5, OUTLINE);
      c.ellipse(10, 15.5, 8.1, 7.6, GOLD);
      c.ellipse(10, 15.5, 6.9, 6.4, liquid);
      c.poly(
        [
          [7.5, 9],
          [12.5, 9],
          [12.5, 5],
          [7.5, 5],
        ],
        GLASS,
      );
      c.poly(
        [
          [5.5, 10.5],
          [14.5, 10.5],
          [13.5, 7.5],
          [6.5, 7.5],
        ],
        GOLD_DARK,
      );
      c.poly(
        [
          [6, 3],
          [14, 3],
          [14, 6],
          [6, 6],
        ],
        GOLD,
      );
      // Gem on the stopper.
      c.poly(
        [
          [10, 0.3],
          [12, 1.6],
          [10, 3],
          [8, 1.6],
        ],
        [220, 60, 90, 255],
      );
      c.ellipse(8.8, 12.5, 1.3, 1.3, [255, 255, 255, 190]);
    });
  }
  return procedural(14, 18, (c) => {
    c.ellipse(7, 12.5, 6.2, 6.1, OUTLINE);
    c.ellipse(7, 12.5, 5.2, 5.1, liquid);
    c.poly(
      [
        [5, 7],
        [9, 7],
        [9, 4],
        [5, 4],
      ],
      GLASS,
    );
    c.poly(
      [
        [4.5, 1.5],
        [9.5, 1.5],
        [9.5, 4.5],
        [4.5, 4.5],
      ],
      WOOD,
    );
    c.ellipse(5, 11.5, 1.2, 1.2, [255, 255, 255, 170]);
  });
}

function goldPile(): Img {
  return procedural(18, 14, (c) => {
    c.ellipse(9, 10.5, 7, 3.2, GOLD_DARK);
    c.ellipse(9, 8.5, 7, 3.2, GOLD);
    c.ellipse(9, 6.5, 6, 2.6, GOLD_BRIGHT);
    c.ellipse(7.5, 5.5, 2, 0.8, [255, 243, 160, 255]);
  });
}

/** Simple item icons, 24x24, drawn with the same few shapes so they read as one set. */
function itemIcon(kind: string): Img {
  return procedural(24, 24, (c) => {
    switch (kind) {
      case "sword":
        c.line(5, 19, 17, 7, 3, STEEL);
        c.line(5.5, 14.5, 9.5, 18.5, 2, GOLD);
        c.line(3, 21, 6, 18, 2.5, LEATHER);
        break;
      case "axe":
        c.line(7, 21, 15, 8, 2, WOOD);
        c.poly(
          [
            [12, 5],
            [20, 3],
            [21, 12],
            [15, 12],
          ],
          STEEL,
        );
        break;
      case "mace":
        c.line(6, 20, 13, 11, 2, WOOD);
        c.ellipse(15, 9, 4.5, 4.5, STEEL_DARK);
        c.ellipse(15, 9, 2.5, 2.5, STEEL);
        break;
      case "dagger":
        c.line(6, 18, 17, 6, 2.5, STEEL);
        c.line(4, 15, 9, 20, 2, GOLD);
        c.line(3, 21, 5, 19, 2.5, LEATHER);
        break;
      case "bow":
        for (let k = 0; k <= 16; k++) {
          const t = ((110 + (140 * k) / 16) * Math.PI) / 180;
          const x = 16 + 10 * Math.cos(t);
          const y = 12 + 10 * Math.sin(t);
          c.ellipse(x, y, 1.1, 1.1, WOOD);
        }
        c.line(12.6, 21.4, 12.6, 2.6, 0.8, WHITE);
        break;
      case "staff":
        c.line(7, 22, 16, 8, 2.5, WOOD);
        c.ellipse(17, 6, 4.5, 4.5, [120, 60, 200, 255]);
        c.ellipse(16, 5, 1.6, 1.6, [230, 200, 255, 255]);
        break;
      case "wand":
        c.line(5, 19, 15, 9, 2.5, WOOD);
        c.ellipse(17, 7, 2.6, 2.6, [60, 120, 230, 255]);
        break;
      case "shield":
        c.poly(
          [
            [5, 4],
            [19, 4],
            [19, 13],
            [12, 21],
            [5, 13],
          ],
          STEEL_DARK,
        );
        c.poly(
          [
            [7, 6],
            [17, 6],
            [17, 12],
            [12, 18],
            [7, 12],
          ],
          STEEL,
        );
        c.ellipse(12, 11, 2, 2, GOLD);
        break;
      case "helm":
        c.ellipse(12, 12, 8, 8, STEEL);
        c.poly(
          [
            [4, 12],
            [20, 12],
            [20, 18],
            [4, 18],
          ],
          STEEL_DARK,
        );
        c.line(6, 12, 18, 12, 1.6, DARK);
        break;
      case "armor":
        c.poly(
          [
            [7, 5],
            [17, 5],
            [19, 10],
            [18, 21],
            [6, 21],
            [5, 10],
          ],
          STEEL_DARK,
        );
        c.line(12, 5, 12, 21, 1.5, DARK);
        c.ellipse(4, 8, 2.5, 2.5, STEEL_DARK);
        c.ellipse(20, 8, 2.5, 2.5, STEEL_DARK);
        break;
      case "gloves":
        c.ellipse(8, 14, 4.5, 5.5, LEATHER);
        c.ellipse(16, 14, 4.5, 5.5, LEATHER);
        c.line(6, 9, 6, 6, 1.5, LEATHER);
        c.line(18, 9, 18, 6, 1.5, LEATHER);
        break;
      case "boots":
        c.poly(
          [
            [6, 4],
            [12, 4],
            [12, 15],
            [19, 15],
            [19, 21],
            [6, 21],
          ],
          LEATHER,
        );
        break;
      case "ring":
        c.ellipse(12, 12, 8, 8, GOLD_BRIGHT);
        c.erase(12, 12, 5, 5);
        c.ellipse(12, 4.5, 2.2, 2.2, [200, 40, 60, 255]);
        break;
      case "amulet":
        for (let k = 0; k <= 12; k++) {
          const t = k / 12;
          const x = 6 + 12 * t;
          const y = 4 + 8 * Math.sin(Math.PI * t);
          c.ellipse(x, y, 0.9, 0.9, GOLD);
        }
        c.ellipse(12, 15, 4.6, 4.6, GOLD);
        c.ellipse(12, 15, 3.2, 3.2, [160, 80, 220, 255]);
        break;
      default:
        throw new Error(`no item icon for ${kind}`);
    }
  });
}

function fxArrow(): Img {
  return procedural(24, 8, (c) => {
    c.line(2, 4, 18, 4, 1.4, WOOD);
    c.poly(
      [
        [17, 1],
        [23, 4],
        [17, 7],
      ],
      STEEL,
    );
    c.poly(
      [
        [2, 4],
        [0, 1],
        [5, 4],
        [0, 7],
      ],
      [230, 230, 236, 255],
    );
  });
}

function fxOrb(size: number, core: RGBA, halo: RGBA, power: number): Img {
  const r = size / 2;
  return procedural(size, size, (c) => {
    c.glow(r, r, r, halo, power);
    c.ellipse(r, r, r * 0.42, r * 0.42, core);
    c.ellipse(r - 1, r - 1, r * 0.16, r * 0.16, WHITE);
  });
}

function fxFirebolt(): Img {
  return procedural(24, 12, (c) => {
    c.ellipse(12, 6, 11, 4.5, [240, 110, 30, 200]);
    c.ellipse(13, 6, 7, 2.4, [255, 210, 90, 255]);
    c.ellipse(16, 6, 2.2, 1.3, WHITE);
  });
}

function fxSpark(): Img {
  return procedural(12, 12, (c) => {
    c.poly(
      [
        [6, 0],
        [7.4, 4.6],
        [12, 6],
        [7.4, 7.4],
        [6, 12],
        [4.6, 7.4],
        [0, 6],
        [4.6, 4.6],
      ],
      [255, 226, 80, 255],
    );
    c.ellipse(6, 6, 1.6, 1.6, WHITE);
  });
}

function fxVenom(): Img {
  return procedural(12, 12, (c) => {
    c.ellipse(6, 6.5, 5.2, 4.8, [70, 170, 60, 255]);
    c.ellipse(4.5, 4.5, 1.6, 1.2, [190, 255, 150, 255]);
  });
}

function fxPortal(): Img {
  return procedural(56, 40, (c) => {
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 56; x++) {
        const nx = (x + 0.5 - 28) / 26;
        const ny = (y + 0.5 - 20) / 18;
        const d = Math.sqrt(nx * nx + ny * ny);
        const band = Math.exp(-(((d - 0.7) / 0.14) ** 2));
        const swirl = 0.5 + 0.5 * Math.sin(3 * Math.atan2(ny, nx) + d * 6);
        const r = 110 + 90 * swirl;
        const g = 60 + 180 * swirl;
        const b = 230;
        if (band > 0.01) c.put(x, y, [r, g, b, 255], band);
      }
    }
    c.glow(28, 20, 10, [200, 240, 255, 255], 2);
  });
}

/** A dark, fiery boss arrow (fx.volley), pointing east like every projectile. */
function fxVolley(): Img {
  return procedural(28, 10, (c) => {
    c.glow(9, 5, 9, [230, 80, 20, 255], 1.6);
    c.line(1, 5, 21, 5, 1.8, [70, 30, 30, 255]);
    c.line(3, 5, 17, 5, 0.8, [255, 150, 60, 255]);
    c.poly(
      [
        [19, 1],
        [27.5, 5],
        [19, 9],
        [21, 5],
      ],
      [120, 36, 28, 255],
    );
    c.poly(
      [
        [21, 3.2],
        [26, 5],
        [21, 6.8],
      ],
      [255, 120, 40, 255],
    );
    c.poly(
      [
        [4, 5],
        [0, 1],
        [7, 5],
        [0, 9],
      ],
      [150, 30, 30, 255],
    );
  });
}

interface SentryLook {
  /** 0..1 glow strength. */
  glow: number;
  /** Crystal size multiplier. */
  size?: number;
  /** Crystal drop (px) and tilt (radians) when it collapses. */
  drop?: number;
  tilt?: number;
  /** Pole height multiplier (a broken pole is shorter). */
  pole?: number;
  alpha?: number;
  /** The totem has fallen: the pole lies along the ground and the crystal sits beside it. */
  lie?: boolean;
}

/** Hero-summoned totem: copper pole and a glowing crystal. Every frame shares one 36x62 canvas. */
function sentry(s: SentryLook): Img {
  const g = s.glow;
  const glowColor: RGBA = [
    Math.round(60 + 60 * g),
    Math.round(150 + 90 * g),
    Math.round(200 + 55 * g),
    255,
  ];
  const size = s.size ?? 1;
  const pole = s.pole ?? 1;
  const cy = 17 + (s.drop ?? 0);
  const tilt = s.tilt ?? 0;
  const img = procedural(36, 62, (c) => {
    c.ellipse(18, 59, 10, 3, [60, 60, 70, 255]);
    const top = 58 - 32 * pole;
    const copper: RGBA = [184, 115, 51, 255];
    if (s.lie) {
      // Fallen: a thick bar along the ground, with the broken crystal beside it.
      c.poly(
        [
          [4, 56],
          [30, 54],
          [30, 59],
          [4, 60],
        ],
        copper,
      );
      c.line(4, 57, 30, 55.5, 1, [120, 70, 30, 255]);
    } else {
      c.poly(
        [
          [14, 58],
          [22, 58],
          [21, top],
          [15, top],
        ],
        copper,
      );
    }
    if (g > 0.05) c.glow(s.lie ? 31 : 18, cy, 11 + 6 * g * size, glowColor, 2);
    const r = 6 * size;
    const pts: [number, number][] = [
      [0, -10 * size],
      [r, 0],
      [0, 9 * size],
      [-r, 0],
    ];
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    c.poly(
      pts.map(([x, y]) => [18 + x * ct - y * st, cy + x * st + y * ct] as [number, number]),
      glowColor,
    );
    if (g > 0.3) c.ellipse(18, cy, 2 * size, 2 * size, WHITE);
  });
  return fadeAlpha(img, s.alpha ?? 1);
}

function well(): Img {
  return procedural(40, 44, (c) => {
    c.ellipse(20, 36, 16, 8, [120, 120, 130, 255]);
    c.ellipse(20, 36, 11, 5, [30, 40, 60, 255]);
    c.line(10, 36, 10, 12, 2.5, WOOD);
    c.line(30, 36, 30, 12, 2.5, WOOD);
    c.poly(
      [
        [6, 14],
        [20, 4],
        [34, 14],
        [20, 10],
      ],
      [150, 60, 40, 255],
    );
  });
}

function cart(): Img {
  return procedural(44, 30, (c) => {
    c.poly(
      [
        [6, 12],
        [38, 12],
        [36, 22],
        [8, 22],
      ],
      WOOD,
    );
    c.line(6, 12, 38, 12, 1.5, LEATHER);
    c.ellipse(12, 26, 4, 4, DARK);
    c.ellipse(32, 26, 4, 4, DARK);
    c.line(38, 16, 44, 20, 2, WOOD);
  });
}

function tent(): Img {
  return procedural(40, 36, (c) => {
    c.poly(
      [
        [2, 34],
        [20, 2],
        [38, 34],
      ],
      [196, 180, 150, 255],
    );
    c.poly(
      [
        [16, 34],
        [20, 18],
        [24, 34],
      ],
      [70, 50, 40, 255],
    );
    c.line(20, 2, 20, 34, 1, [150, 130, 100, 255]);
  });
}

function bones(): Img {
  return procedural(24, 12, (c) => {
    const bone: RGBA = [226, 220, 200, 255];
    c.line(3, 9, 21, 4, 2, bone);
    c.line(3, 4, 21, 9, 2, bone);
    c.ellipse(3, 9, 2, 2, bone);
    c.ellipse(21, 4, 2, 2, bone);
    c.ellipse(3, 4, 2, 2, bone);
    c.ellipse(21, 9, 2, 2, bone);
  });
}

function torch(): Img {
  return procedural(12, 30, (c) => {
    c.line(6, 29, 6, 13, 3, WOOD);
    c.glow(6, 8, 7, [255, 140, 40, 255], 1.5);
    c.ellipse(6, 9, 3, 3.5, [255, 220, 90, 255]);
  });
}

// ----------------------------------------------------------------- characters

const FACINGS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
type FacingId = (typeof FACINGS)[number];
/**
 * Kenney's `Male_0..7` sets are ONE character seen from 8 directions (checked by
 * eye): Male_0 faces up-right and the sets turn clockwise. Facings are screen
 * directions like the renderer's: e = right, s = toward the camera (down-screen).
 */
const MALE_SET: Record<FacingId, number> = { ne: 0, e: 1, se: 2, s: 3, sw: 4, w: 5, nw: 6, n: 7 };
/** Screen-space direction of each facing: x right, y toward the camera (down). */
const FACING_VEC: Record<FacingId, [number, number]> = {
  n: [0, -1],
  ne: [0.71, -0.71],
  e: [1, 0],
  se: [0.71, 0.71],
  s: [0, 1],
  sw: [-0.71, 0.71],
  w: [-1, 0],
  nw: [-0.71, -0.71],
};
const MALE = "kenney-dungeon/Characters/Male/";
const RUN_FRAMES = 10;

interface MaleSource {
  idle: Img;
  run: Img[];
}
function maleSource(set: number): MaleSource {
  return {
    idle: load(`${MALE}Male_${set}_Idle0.png`),
    run: Array.from({ length: RUN_FRAMES }, (_, i) => load(`${MALE}Male_${set}_Run${i}.png`)),
  };
}

interface MaleFrame {
  /** Crop box shared by every Kenney frame, centred on the foot column. */
  box: Box;
  /** Ground point (source px): the shared foot column and the lowest idle sole. */
  footX: number;
  footY: number;
  /** Standing height above the ground (source px), the reference for body proportions. */
  height: number;
}
let maleFrameCache: MaleFrame | null = null;
function maleFrame(): MaleFrame {
  if (maleFrameCache) return maleFrameCache;
  const sources = FACINGS.map((f) => maleSource(MALE_SET[f]));
  const idleBoxes = sources.map((s) => alphaBox(s.idle));
  const all = union(sources.flatMap((s) => [s.idle, ...s.run]).map(alphaBox));
  const footX = sources[0]!.idle.width / 2;
  const footY = Math.max(...idleBoxes.map((b) => b.y + b.h));
  const half = Math.ceil(Math.max(footX - all.x, all.x + all.w - footX));
  maleFrameCache = {
    box: { x: footX - half, y: all.y, w: 2 * half, h: all.h },
    footX,
    footY,
    height: footY - Math.min(...idleBoxes.map((b) => b.y)),
  };
  return maleFrameCache;
}

/** Width bump along the body: t 0 = feet, 1 = top of the head. */
interface Bulge {
  t: number;
  /** Half-width of the bump in t. */
  w: number;
  /** Extra width at the centre (0.5 = 50 % wider). */
  amt: number;
}

/**
 * Silhouette cues drawn around the recoloured Kenney body so monster families
 * read by shape, not only by colour. Colours are 0xRRGGBB.
 */
type Cue =
  | { kind: "hood"; color: number }
  | { kind: "robe"; color: number; hem?: number; short?: number }
  | { kind: "hat"; color: number; tall?: number }
  | { kind: "crown"; color: number }
  | { kind: "horns"; color: number; size?: number }
  | { kind: "ears"; color: number }
  | { kind: "tail"; color: number; length?: number; tip?: boolean }
  | { kind: "legs"; color: number; spread?: number }
  | { kind: "spikes"; color: number }
  | { kind: "wings"; color: number }
  | { kind: "cap"; color: number }
  | { kind: "pustules"; color: number }
  | { kind: "bow"; color: number }
  | { kind: "abdomen"; color: number }
  | { kind: "glow"; color: number }
  | { kind: "apron"; color: number }
  | { kind: "pauldrons"; color: number }
  /** Long hanging arms that reach toward the ground (shambling corpses). */
  | { kind: "arms"; color: number }
  /** Torn cloth around the hips. */
  | { kind: "rags"; color: number }
  /** Dark rib lines across the chest. */
  | { kind: "ribs"; color: number }
  /** A quiver of arrows on the back. */
  | { kind: "quiver"; color: number }
  /** Boulders on the shoulders. */
  | { kind: "rocks"; color: number }
  /** A tapering ghost tail that replaces the legs. */
  | { kind: "wisp"; color: number }
  /** Icy shards that jut out from the body. */
  | { kind: "shards"; color: number }
  /** A long cloak falling from the shoulders, behind the body. */
  | { kind: "cloak"; color: number };

/** Silhouette plan. `humanoid` recolours and reshapes the Kenney figure; the others are drawn from scratch. */
type Plan = "humanoid" | "quadruped" | "spider";

interface UnitDef {
  /** Appearance id: `unit.hero.*`, `unit.npc.*` or `unit.monster.*`. */
  id: string;
  role: "hero" | "npc" | "monster";
  look?: Look;
  /** Size multiplier on top of SCALE_UNIT. */
  scale?: number;
  /** Width multiplier. */
  wide?: number;
  /** Height multiplier (low, quadruped-ish monsters < 1). */
  squat?: number;
  /** Forward hunch: the head moves this fraction of the height toward the facing. */
  hunch?: number;
  /** Sideways lean of the upper body (fraction of the height, +1 leans right). */
  tilt?: number;
  bulge?: Bulge[];
  cues?: Cue[];
  /** Silhouette plan (default humanoid). Non-humanoid plans use `fur`. */
  plan?: Plan;
  /** Body colour of a drawn (non-humanoid) creature. */
  fur?: number;
  /** Ghost: the legs fade out and the body floats. */
  ghost?: boolean;
  /** 1 px outline colour (bosses). */
  outline?: number;
  /** Rim colour of the cast glow. */
  castColor?: number;
  walkFps?: number;
}

const UNITS: UnitDef[] = [
  { id: "unit.hero", role: "hero", walkFps: 12 },
  {
    id: "unit.hero.warrior",
    role: "hero",
    look: { tint: 0xc8d4e8, tintMix: 0.15 },
    wide: 1.08,
    bulge: [{ t: 0.78, w: 0.1, amt: 0.12 }],
    cues: [{ kind: "pauldrons", color: 0xb8c4d4 }],
  },
  {
    id: "unit.hero.rogue",
    role: "hero",
    look: { hue: 100, sat: 0.9, light: -0.05 },
    wide: 0.94,
    cues: [{ kind: "hood", color: 0x2f4a2a }],
  },
  {
    id: "unit.hero.sorcerer",
    role: "hero",
    look: { hue: 230, sat: 1 },
    cues: [
      { kind: "robe", color: 0x34407a, hem: 1.35 },
      { kind: "hat", color: 0x22357a, tall: 1 },
    ],
    castColor: 0x9fd8ff,
  },
  {
    id: "unit.npc.healer",
    role: "npc",
    look: { sat: 0.3, light: 0.1, tint: 0xa8ffd0, tintMix: 0.2 },
    cues: [{ kind: "robe", color: 0xdfe8e0, hem: 1.4 }],
  },
  {
    id: "unit.npc.smith",
    role: "npc",
    look: { tint: 0xffa060, tintMix: 0.25 },
    wide: 1.12,
    cues: [{ kind: "apron", color: 0x5a3a22 }],
  },
  {
    id: "unit.npc.alchemist",
    role: "npc",
    look: { hue: 260, sat: 0.8 },
    cues: [{ kind: "hat", color: 0x5b2d7a, tall: 0.8 }],
  },
  {
    id: "unit.npc.junk",
    role: "npc",
    look: { hue: 20, sat: 0.4, light: -0.05 },
    hunch: 0.08,
    squat: 0.95,
  },
  {
    id: "unit.npc.quest",
    role: "npc",
    look: { hue: 190, sat: 0.9, light: 0.05 },
    cues: [{ kind: "hood", color: 0x2c5a6a }],
  },
  {
    // Shambling corpse: hunched, lopsided, with long arms that drag and torn rags.
    id: "unit.monster.husk",
    role: "monster",
    look: { hue: 70, sat: 0.3, light: 0.07 },
    wide: 1.12,
    hunch: 0.32,
    tilt: 0.1,
    squat: 0.88,
    cues: [
      { kind: "rags", color: 0x4a4a36 },
      { kind: "arms", color: 0x6f7a58 },
    ],
  },
  {
    // Rat-thing drawn as a quadruped: low body, big ears, long tail, trotting.
    id: "unit.monster.gnawling",
    role: "monster",
    plan: "quadruped",
    fur: 0x9a7a62,
    scale: 1.4,
    walkFps: 14,
  },
  {
    // Skeleton archer: thin, bone-white, with a quiver and a bow.
    id: "unit.monster.bonefletcher",
    role: "monster",
    look: { sat: 0.05, light: 0.3 },
    wide: 0.68,
    hunch: 0.06,
    cues: [
      { kind: "quiver", color: 0x5a3e24 },
      { kind: "ribs", color: 0x7a7468 },
      { kind: "bow", color: 0x6b4a2a },
    ],
  },
  {
    // Hooded caster in a short robe.
    id: "unit.monster.ash_seer",
    role: "monster",
    look: { hue: -10, sat: 0.25, light: 0.05, tint: 0xd0c0ff, tintMix: 0.25 },
    cues: [
      { kind: "robe", color: 0x4a4458, hem: 1.25 },
      { kind: "hood", color: 0x2a2433 },
    ],
    castColor: 0xd8b0ff,
  },
  {
    // Swollen, squat body with pustules.
    id: "unit.monster.blightbloat",
    role: "monster",
    look: { hue: 95, sat: 1.1 },
    scale: 0.95,
    wide: 1.15,
    squat: 0.86,
    bulge: [{ t: 0.5, w: 0.22, amt: 1.0 }],
    cues: [{ kind: "pustules", color: 0xd8f070 }],
  },
  {
    // Spiny back.
    id: "unit.monster.bristleback",
    role: "monster",
    look: { hue: -5, sat: 1.2 },
    scale: 1.05,
    wide: 1.15,
    hunch: 0.1,
    cues: [{ kind: "spikes", color: 0x3a2a22 }],
  },
  {
    // Hunched, broad stone brute with boulders for shoulders.
    id: "unit.monster.cairn_brute",
    role: "monster",
    look: { sat: 0.12, light: 0.02 },
    scale: 1.3,
    wide: 1.35,
    hunch: 0.2,
    squat: 0.92,
    bulge: [{ t: 0.74, w: 0.14, amt: 0.6 }],
    cues: [{ kind: "rocks", color: 0x7a7c82 }],
  },
  {
    // Spider: round abdomen, eight jointed legs.
    id: "unit.monster.webskitter",
    role: "monster",
    plan: "spider",
    fur: 0x4a4080,
    scale: 2.1,
    walkFps: 14,
  },
  {
    // Tall choir ghoul in a bell robe and a mitre.
    id: "unit.monster.hollow_cantor",
    role: "monster",
    look: { hue: 255, sat: 0.8, light: -0.08 },
    wide: 0.9,
    cues: [
      { kind: "robe", color: 0x3a2a5a, hem: 1.9 },
      { kind: "hat", color: 0x2a1f44, tall: 0.7 },
    ],
    castColor: 0xc0a0ff,
  },
  {
    // Small horned imp with a pointed tail.
    id: "unit.monster.cinder_imp",
    role: "monster",
    look: { hue: -15, sat: 1.6, light: 0.02 },
    scale: 0.8,
    hunch: 0.08,
    cues: [
      { kind: "horns", color: 0x2a1a14, size: 0.8 },
      { kind: "tail", color: 0xa8321e, length: 0.36, tip: true },
    ],
    castColor: 0xffb060,
    walkFps: 14,
  },
  {
    // Ghost: no legs, floats.
    id: "unit.monster.rime_wraith",
    role: "monster",
    look: { hue: 165, sat: 0.9, light: 0.12, alpha: 0.85 },
    wide: 0.95,
    ghost: true,
    cues: [
      { kind: "wisp", color: 0x6aa8b4 },
      { kind: "robe", color: 0x6aa8b4, hem: 1.35, short: 0.16 },
      { kind: "hood", color: 0x8ad0d8 },
      { kind: "shards", color: 0xbff4ff },
    ],
    castColor: 0xc0ffff,
  },
  {
    id: "unit.monster.boss_warden",
    role: "monster",
    look: { hue: 40, sat: 0.9, light: 0.05 },
    scale: 1.55,
    wide: 1.2,
    bulge: [{ t: 0.76, w: 0.12, amt: 0.3 }],
    cues: [
      { kind: "cloak", color: 0x5a1f2a },
      { kind: "pauldrons", color: 0xc89a40 },
      { kind: "crown", color: 0xf2c230 },
    ],
    outline: 0xffd060,
    walkFps: 8,
  },
  {
    // Brood queen: squat, eight legs and a big abdomen.
    id: "unit.monster.boss_tunnel_mother",
    role: "monster",
    look: { hue: 110, sat: 0.8 },
    scale: 1.4,
    wide: 1.3,
    squat: 0.7,
    cues: [
      { kind: "legs", color: 0x1f3a1a, spread: 1.1 },
      { kind: "abdomen", color: 0x3a6a2a },
      { kind: "crown", color: 0xa0e060 },
    ],
    outline: 0x90ff70,
    walkFps: 8,
  },
  {
    id: "unit.monster.boss_ninth_flame",
    role: "monster",
    look: { hue: -25, sat: 1.3, light: 0.05 },
    scale: 1.6,
    wide: 1.2,
    cues: [
      { kind: "horns", color: 0x2a1410, size: 1.2 },
      { kind: "tail", color: 0xb03018, length: 0.28, tip: true },
    ],
    outline: 0xff8030,
    castColor: 0xffa040,
    walkFps: 8,
  },
  {
    id: "unit.monster.boss_hollow_king",
    role: "monster",
    look: { hue: 180, sat: 0.4, light: 0.12, alpha: 0.92 },
    scale: 1.7,
    wide: 1.2,
    ghost: true,
    cues: [
      { kind: "robe", color: 0x2a4a50, hem: 1.2, short: 0.12 },
      { kind: "crown", color: 0xd8e8f0 },
    ],
    outline: 0x80fff0,
    castColor: 0xa0fff0,
    walkFps: 8,
  },
  // `steps` monsters.
  {
    // Mushroom creature.
    id: "unit.monster.gloomcap",
    role: "monster",
    look: { hue: 250, sat: 0.5, light: 0.02 },
    scale: 0.75,
    squat: 0.8,
    cues: [{ kind: "cap", color: 0x6a3a8a }],
  },
  {
    // Small fiery quadruped-ish pup.
    id: "unit.monster.cinderpup",
    role: "monster",
    look: { hue: -20, sat: 1.5, light: 0.04 },
    scale: 0.62,
    wide: 1.5,
    squat: 0.55,
    hunch: 0.14,
    cues: [
      { kind: "ears", color: 0xb03a18 },
      { kind: "tail", color: 0xff8a30, length: 0.5 },
    ],
    outline: 0xffa040,
    walkFps: 14,
  },
  {
    // Pale glowing moth.
    id: "unit.monster.lanternmoth",
    role: "monster",
    look: { sat: 0.25, light: 0.22, alpha: 0.95 },
    scale: 0.6,
    ghost: true,
    cues: [
      { kind: "wings", color: 0xf0e8c0 },
      { kind: "glow", color: 0xfff0a0 },
    ],
    walkFps: 12,
  },
];

// ------------------------------------------------------------ unit painting

function rgba(hex: number, a = 255): RGBA {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, a];
}
function shade(hex: number, f: number, a = 255): RGBA {
  const c = rgba(hex, a);
  return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f), a];
}

/** Writes a straight-alpha colour over dst pixel `i`. */
function blendOver(d: Buffer, i: number, r: number, g: number, b: number, sa: number): void {
  if (sa <= 0) return;
  const da = d[i + 3]! / 255;
  const oa = sa + da * (1 - sa);
  d[i] = Math.round((r * sa + d[i]! * da * (1 - sa)) / oa);
  d[i + 1] = Math.round((g * sa + d[i + 1]! * da * (1 - sa)) / oa);
  d[i + 2] = Math.round((b * sa + d[i + 2]! * da * (1 - sa)) / oa);
  d[i + 3] = Math.round(oa * 255);
}

/**
 * Composites `src` over `dst` through an inverse map: `inv(x, y, p)` gets a dst
 * pixel centre and writes the src position into p[0], p[1] and an alpha factor
 * into p[2]; it returns false to skip the pixel. Bilinear, premultiplied.
 */
function warpOver(
  dst: Img,
  src: Img,
  inv: (x: number, y: number, p: Float64Array) => boolean,
): void {
  const p = new Float64Array(3);
  const s = src.data;
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < dst.height; y++) {
    for (let x = 0; x < dst.width; x++) {
      p[2] = 1;
      if (!inv(x + 0.5, y + 0.5, p)) continue;
      const fx = p[0]! - 0.5;
      const fy = p[1]! - 0.5;
      if (fx < -1 || fy < -1 || fx > sw || fy > sh) continue;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < 4; k++) {
        const xx = x0 + (k & 1);
        const yy = y0 + (k >> 1);
        if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
        const wgt = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty);
        if (wgt === 0) continue;
        const i = (yy * sw + xx) * 4;
        const al = s[i + 3]! * wgt;
        r += s[i]! * al;
        g += s[i + 1]! * al;
        b += s[i + 2]! * al;
        a += al;
      }
      if (a <= 0) continue;
      blendOver(dst.data, (y * dst.width + x) * 4, r / a, g / a, b / a, (a / 255) * p[2]!);
    }
  }
}

/** Body landmarks of one upright figure, in its canvas pixels. */
interface Body {
  /** Ground point. */
  fx: number;
  fy: number;
  /** Standing height in px. */
  hf: number;
  /** Head centre and radius. */
  hx: number;
  hy: number;
  hr: number;
  /** Hip centre and the body width there. */
  hipX: number;
  hipY: number;
  hipW: number;
  /** Shoulder row and its left and right edges. */
  shY: number;
  shL: number;
  shR: number;
  vx: number;
  vy: number;
  /** Walk frame index (cues animate with it). */
  phase: number;
  /** The warped body, for contour lookups. */
  img: Img;
}

const SOLID = 64;
function rowSpan(img: Img, y: number): [number, number] | null {
  const row = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  let l = -1;
  let r = -1;
  for (let x = 0; x < img.width; x++) {
    if (img.data[(row * img.width + x) * 4 + 3]! < SOLID) continue;
    if (l < 0) l = x;
    r = x;
  }
  return l < 0 ? null : [l, r + 1];
}

function measureBody(
  img: Img,
  fx: number,
  fy: number,
  vx: number,
  vy: number,
  phase: number,
): Body {
  let top = -1;
  for (let y = 0; y < img.height && top < 0; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! >= SOLID) {
        top = y;
        break;
      }
    }
  }
  if (top < 0) throw new Error("unit frame is empty");
  const hf = Math.max(4, fy - top);
  const hr = Math.max(1.6, hf * 0.08);
  let sx = 0;
  let n = 0;
  for (let y = top; y < Math.min(fy, top + 2 * hr); y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! >= SOLID) {
        sx += x + 0.5;
        n++;
      }
    }
  }
  const hx = n > 0 ? sx / n : fx;
  const hipY = fy - hf * 0.5;
  const hip = rowSpan(img, hipY) ?? [fx - hr, fx + hr];
  const shY = fy - hf * 0.78;
  const sh = rowSpan(img, shY) ?? [hx - hr * 1.5, hx + hr * 1.5];
  return {
    fx,
    fy,
    hf,
    hx,
    hy: top + hr * 1.1,
    hr,
    hipX: (hip[0] + hip[1]) / 2,
    hipY,
    hipW: hip[1] - hip[0],
    shY,
    shL: sh[0],
    shR: sh[1],
    vx,
    vy,
    phase,
    img,
  };
}

/** Outermost solid x on one side (`side` -1 = left, +1 = right) of a row, or null. */
function contourX(img: Img, y: number, side: number): number | null {
  const span = rowSpan(img, y);
  if (!span) return null;
  return side < 0 ? span[0] : span[1];
}

/** True when a cue is drawn behind the body for this facing. */
function behind(cue: Cue, b: Body): boolean {
  switch (cue.kind) {
    case "legs":
    case "spikes":
    case "quiver":
    case "wisp":
    case "cloak":
      return true;
    case "tail":
    case "wings":
    case "abdomen":
      // Away from the camera when the unit faces it, toward the camera otherwise.
      return b.vy >= -0.1;
    case "bow":
      return b.vy < -0.1;
    default:
      return false;
  }
}

/** Draws one silhouette cue. Sizes scale with the head radius so they follow the unit scale. */
function drawCue(c: Canvas, cue: Cue, b: Body): void {
  const { hx, hy, hr, hipX, hipY, hipW, vx, vy, fy, hf, phase } = b;
  const col = rgba(cue.color);
  const dark = shade(cue.color, 0.62);
  const light = shade(cue.color, 1.35);
  const away = vy < -0.1;
  const backX = vx > 0.1 ? -1 : 1;
  const sideX = vx < -0.1 ? -1 : 1;
  switch (cue.kind) {
    case "hood": {
      c.ellipse(hx, hy + hr * 1.35, hr * 1.7, hr * 0.85, dark);
      c.ellipse(hx, hy - hr * 0.1, hr * 1.38, hr * 1.42, col);
      const tip = hx - vx * hr * 1.1;
      c.poly(
        [
          [hx - hr * 1.05, hy - hr * 0.55],
          [tip, hy - hr * 2.25],
          [hx + hr * 1.05, hy - hr * 0.55],
        ],
        col,
      );
      if (!away) {
        c.ellipse(
          hx + vx * hr * 0.5,
          hy + hr * 0.2,
          hr * 0.72 * (1 - 0.35 * Math.abs(vx)),
          hr * 0.78,
          shade(cue.color, 0.25),
        );
      }
      break;
    }
    case "robe": {
      const hem = cue.hem ?? 1.5;
      const top = hipY - hr * 0.6;
      // The hip row includes the hanging arms, so the waist is sized from the head.
      const half = Math.min(hipW / 2 + 0.5, hr * 1.3);
      const bottom = fy - 0.5 - hf * (cue.short ?? 0);
      const flare = half * hem * 1.25 + (phase % 2) * 0.5;
      const s = (phase % 4 < 2 ? 1 : -1) * hr * 0.15;
      c.poly(
        [
          [hipX - half, top],
          [hipX + half, top],
          [hipX + flare + s, bottom],
          [hipX - flare + s, bottom],
        ],
        col,
      );
      // Folds: a shaded side and a lit side, so the robe reads as cloth, not a block.
      c.poly(
        [
          [hipX - half, top],
          [hipX - half * 0.35, top],
          [hipX - flare * 0.4 + s, bottom],
          [hipX - flare + s, bottom],
        ],
        shade(cue.color, 0.7, 150),
      );
      c.poly(
        [
          [hipX + half * 0.3, top],
          [hipX + half * 0.6, top],
          [hipX + flare * 0.65 + s, bottom],
          [hipX + flare * 0.3 + s, bottom],
        ],
        shade(cue.color, 1.3, 110),
      );
      c.line(hipX, top + 1, hipX + s, bottom - 1, Math.max(1, hr * 0.3), dark);
      c.line(hipX - flare + s, bottom - 0.5, hipX + flare + s, bottom - 0.5, 1, dark);
      c.line(hipX - half, top, hipX + half, top, Math.max(1, hr * 0.35), light);
      break;
    }
    case "hat": {
      const tall = cue.tall ?? 1;
      const brim = hy - hr * 0.55;
      c.ellipse(hx, brim, hr * 1.7, hr * 0.5, dark);
      c.poly(
        [
          [hx - hr * 1.05, brim],
          [hx + hr * 1.05, brim],
          [hx - vx * hr * 0.9, brim - hr * (1.2 + 2.6 * tall)],
        ],
        col,
      );
      c.line(hx - hr, brim - hr * 0.2, hx + hr, brim - hr * 0.2, Math.max(1, hr * 0.3), light);
      break;
    }
    case "crown": {
      const base = hy - hr * 0.55;
      const w = hr * 1.15;
      const pts: [number, number][] = [
        [hx - w, base + hr * 0.4],
        [hx - w, base - hr * 0.9],
        [hx - w * 0.5, base - hr * 0.2],
        [hx, base - hr * 1.3],
        [hx + w * 0.5, base - hr * 0.2],
        [hx + w, base - hr * 0.9],
        [hx + w, base + hr * 0.4],
      ];
      c.poly(pts, col);
      c.line(hx - w, base + hr * 0.2, hx + w, base + hr * 0.2, Math.max(1, hr * 0.3), dark);
      c.ellipse(hx, base - hr * 0.1, hr * 0.28, hr * 0.28, [210, 40, 60, 255]);
      break;
    }
    case "horns": {
      const s = cue.size ?? 1;
      for (const side of [-1, 1]) {
        const x0 = hx + side * hr * 0.55;
        const y0 = hy - hr * 0.55;
        c.taper(
          [
            [x0, y0],
            [x0 + side * hr * 1.0 * s, y0 - hr * 0.7 * s],
            [x0 + side * hr * 1.5 * s, y0 - hr * 1.6 * s],
            [x0 + side * hr * 1.2 * s, y0 - hr * 2.4 * s],
          ],
          hr * 0.75,
          hr * 0.2,
          col,
        );
      }
      break;
    }
    case "ears": {
      for (const side of [-1, 1]) {
        c.poly(
          [
            [hx + side * hr * 0.2, hy - hr * 0.5],
            [hx + side * hr * 1.5, hy - hr * 1.9],
            [hx + side * hr * 1.15, hy - hr * 0.05],
          ],
          col,
        );
        c.poly(
          [
            [hx + side * hr * 0.5, hy - hr * 0.5],
            [hx + side * hr * 1.3, hy - hr * 1.45],
            [hx + side * hr * 1.05, hy - hr * 0.3],
          ],
          [230, 150, 150, 255],
        );
      }
      break;
    }
    case "tail": {
      const len = hf * (cue.length ?? 0.4);
      const x0 = hipX + backX * hipW * 0.2;
      const y0 = hipY + hr * 0.4;
      const wag = (phase % 4 < 2 ? 1 : -1) * hr * 0.4;
      const pts: [number, number][] = [
        [x0, y0],
        [x0 + backX * len * 0.45, y0 + hr * 0.5],
        [x0 + backX * len * 0.85, y0 - len * 0.25 + wag],
        [x0 + backX * len, y0 - len * 0.6 + wag],
      ];
      c.taper(pts, hr * 0.7, hr * 0.28, col);
      if (cue.tip) {
        const [tx, ty] = pts[3]!;
        c.poly(
          [
            [tx - hr * 0.6, ty + hr * 0.1],
            [tx + backX * hr * 0.3, ty - hr * 1.0],
            [tx + hr * 0.6, ty + hr * 0.1],
          ],
          dark,
        );
      }
      break;
    }
    case "legs": {
      const spread = cue.spread ?? 1;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const wig = ((i + phase + (side > 0 ? 1 : 0)) % 2 === 0 ? 1 : -1) * hr * 0.35;
          const rootX = hipX + side * hr * 0.5;
          const rootY = hipY - hr * 0.3 + i * hr * 0.35;
          const kneeX = hipX + side * (hr * 2.3 + i * hr * 0.55) * spread;
          const kneeY = hipY - hr * (2.0 - i * 0.45);
          const footX = hipX + side * (hr * 3.1 + i * hr * 0.9) * spread + wig;
          c.taper(
            [
              [rootX, rootY],
              [kneeX, kneeY],
              [footX, fy - (i % 2) * hr * 0.3],
            ],
            hr * 0.5,
            hr * 0.28,
            col,
          );
        }
      }
      break;
    }
    case "spikes": {
      const sides = Math.abs(vx) > 0.3 ? [backX] : [-1, 1];
      for (const side of sides) {
        for (let k = 0; k < 6; k++) {
          const y = fy - hf * (0.5 + k * 0.075);
          const x = contourX(b.img, y, side);
          if (x === null) continue;
          const len = hr * (1.1 + 0.25 * (k % 2));
          c.poly(
            [
              [x - side * hr * 0.4, y - hr * 0.45],
              [x + side * len, y - hr * 0.8],
              [x - side * hr * 0.4, y + hr * 0.45],
            ],
            k % 2 === 0 ? col : light,
          );
        }
      }
      // A ridge of spikes over the shoulders reads from every facing.
      for (let k = -2; k <= 2; k++) {
        const x = hipX + k * hr * 0.75;
        const y = b.shY - hr * 0.3;
        c.poly(
          [
            [x - hr * 0.4, y + hr * 0.5],
            [x + backX * hr * 0.2, y - hr * 1.3],
            [x + hr * 0.4, y + hr * 0.5],
          ],
          col,
        );
      }
      break;
    }
    case "wings": {
      const flap = phase % 2 === 0 ? 1 : 0.65;
      const wy = b.shY;
      const wing = rgba(cue.color, 175);
      for (const side of [-1, 1]) {
        c.oval(
          hipX + side * hr * 2.0,
          wy - hr * 0.9 * flap,
          hr * 2.3,
          hr * 1.3 * flap,
          side * -0.5,
          wing,
        );
        c.oval(
          hipX + side * hr * 1.5,
          wy + hr * 1.0,
          hr * 1.4,
          hr * 0.8 * flap,
          side * 0.4,
          rgba(cue.color, 140),
        );
        c.ellipse(hipX + side * hr * 2.2, wy - hr * 1.0 * flap, hr * 0.5, hr * 0.5, dark);
      }
      break;
    }
    case "cap": {
      const cy = hy - hr * 0.3;
      c.ellipse(hx, cy + hr * 0.8, hr * 2.7, hr * 0.7, shade(cue.color, 0.45));
      c.ellipse(hx, cy, hr * 2.9, hr * 1.6, col);
      c.ellipse(hx - hr * 0.6, cy - hr * 0.5, hr * 0.9, hr * 0.4, light);
      for (const [dx, dy, r] of [
        [-1.4, 0.1, 0.35],
        [0.9, -0.6, 0.4],
        [1.6, 0.3, 0.3],
        [-0.3, -0.9, 0.3],
      ] as const) {
        c.ellipse(hx + dx * hr, cy + dy * hr, r * hr, r * hr * 0.8, [240, 235, 220, 255]);
      }
      break;
    }
    case "pustules": {
      if (away) break;
      for (const [dx, dy, r] of [
        [-0.35, -0.05, 0.4],
        [0.25, 0.08, 0.5],
        [0.05, -0.18, 0.35],
        [-0.15, 0.16, 0.3],
        [0.38, -0.14, 0.32],
      ] as const) {
        const x = hipX + dx * hipW;
        const y = hipY + dy * hf;
        c.ellipse(x, y, r * hr, r * hr, col);
        c.ellipse(x - r * hr * 0.3, y - r * hr * 0.3, r * hr * 0.35, r * hr * 0.35, WHITE);
      }
      break;
    }
    case "bow": {
      const cx = hipX + sideX * hr * 1.4;
      const cy = hipY - hf * 0.18;
      const r = hr * 2.6;
      const pts: [number, number][] = [];
      for (let k = 0; k <= 10; k++) {
        const a = (-60 + (120 * k) / 10) * (Math.PI / 180);
        pts.push([cx + sideX * r * Math.cos(a) * 0.45, cy + r * Math.sin(a)]);
      }
      c.taper(pts, Math.max(1, hr * 0.4), Math.max(1, hr * 0.4), col);
      c.line(pts[0]![0], pts[0]![1], pts[10]![0], pts[10]![1], 0.7, [230, 230, 230, 220]);
      break;
    }
    case "abdomen": {
      const ax = hipX + backX * hipW * 0.55;
      const ay = hipY - hr * 0.2 + (away ? hr * 0.6 : -hr * 0.6);
      const rx = Math.max(hipW * 0.5, hr * 1.6);
      const ry = hr * 1.45;
      c.ellipse(ax, ay, rx, ry, col);
      c.line(ax - rx * 0.7, ay - ry * 0.2, ax + rx * 0.7, ay - ry * 0.2, hr * 0.3, dark);
      c.line(ax - rx * 0.6, ay + ry * 0.35, ax + rx * 0.6, ay + ry * 0.35, hr * 0.3, dark);
      c.ellipse(ax - rx * 0.3, ay - ry * 0.5, rx * 0.25, ry * 0.18, light);
      break;
    }
    case "glow": {
      const gx = hipX + vx * hr * 0.6;
      const gy = hipY - hf * 0.15;
      c.glow(gx, gy, hr * 3, rgba(cue.color, 200), 1.8);
      c.ellipse(gx, gy, hr * 0.6, hr * 0.6, WHITE);
      break;
    }
    case "apron": {
      if (away) break;
      const top = b.shY + hr * 0.9;
      const bottom = hipY + hf * 0.24;
      const w = Math.min(hipW * 0.42, hr * 1.1) * (1 - 0.3 * Math.abs(vx));
      c.poly(
        [
          [hipX - w + vx * hr * 0.4, top],
          [hipX + w + vx * hr * 0.4, top],
          [hipX + w * 1.1 + vx * hr * 0.6, bottom],
          [hipX - w * 1.1 + vx * hr * 0.6, bottom],
        ],
        col,
      );
      c.line(hipX - w, top + 0.5, hipX + w, top + 0.5, 1, dark);
      break;
    }
    case "pauldrons": {
      for (const x of [b.shL + hr * 0.4, b.shR - hr * 0.4]) {
        c.ellipse(x, b.shY - hr * 0.05, hr * 0.72, hr * 0.48, dark);
        c.ellipse(x, b.shY - hr * 0.15, hr * 0.6, hr * 0.38, col);
      }
      break;
    }
    case "arms": {
      // Long arms that hang past the hips and drag: the hands reach low, outside the body.
      for (const side of [-1, 1]) {
        const sx0 = side < 0 ? b.shL + hr * 0.2 : b.shR - hr * 0.2;
        const hx0 = sx0 + side * hr * 0.9;
        const hy0 = fy - hf * 0.1;
        c.taper(
          [
            [sx0, b.shY],
            [sx0 + side * hr * 0.5, hipY],
            [hx0, hy0],
          ],
          hr * 0.75,
          hr * 0.5,
          col,
        );
        c.ellipse(hx0, hy0, hr * 0.5, hr * 0.4, dark);
      }
      break;
    }
    case "rags": {
      // Torn hem across the hips: a jagged strip with a few loose ends.
      const top = hipY - hr * 0.1;
      const bottom = hipY + hf * 0.22;
      const w = hipW * 0.62;
      c.poly(
        [
          [hipX - w, top],
          [hipX + w, top],
          [hipX + w * 1.05, bottom - hr * 0.4],
          [hipX + w * 0.55, bottom + hr * 0.3],
          [hipX + w * 0.1, bottom - hr * 0.5],
          [hipX - w * 0.35, bottom + hr * 0.5],
          [hipX - w * 0.9, bottom - hr * 0.2],
        ],
        col,
      );
      c.line(hipX - w, top + 0.5, hipX + w, top + 0.5, Math.max(1, hr * 0.3), dark);
      break;
    }
    case "ribs": {
      for (let k = 0; k < 3; k++) {
        const y = b.shY + hr * (0.85 + k * 0.85);
        const l = contourX(b.img, y, -1) ?? hipX - hr;
        const r = contourX(b.img, y, 1) ?? hipX + hr;
        c.line(l + hr * 0.3, y, r - hr * 0.3, y + hr * 0.2, Math.max(1, hr * 0.28), col);
      }
      break;
    }
    case "quiver": {
      // Behind the far shoulder: a leather case with fletched shafts poking out.
      const qx = hipX - sideX * hr * 1.5;
      const top = b.shY - hr * 0.6;
      const bottom = b.shY + hr * 2.6;
      c.poly(
        [
          [qx - hr * 0.45, top],
          [qx + hr * 0.45, top],
          [qx + hr * 0.6, bottom],
          [qx - hr * 0.6, bottom],
        ],
        col,
      );
      for (const dx of [-0.25, 0.2]) {
        c.line(qx + dx * hr, top + hr * 0.2, qx + dx * hr * 1.4, top - hr * 1.2, hr * 0.22, WHITE);
        c.poly(
          [
            [qx + dx * hr * 1.4 - hr * 0.25, top - hr * 0.9],
            [qx + dx * hr * 1.4, top - hr * 1.6],
            [qx + dx * hr * 1.4 + hr * 0.25, top - hr * 0.9],
          ],
          dark,
        );
      }
      break;
    }
    case "rocks": {
      // Two boulders on the shoulders, with a crack and a lit top edge.
      for (const x of [b.shL - hr * 0.1, b.shR + hr * 0.1]) {
        c.ellipse(x, b.shY - hr * 0.35, hr * 1.1, hr * 0.85, dark);
        c.ellipse(x, b.shY - hr * 0.5, hr * 0.95, hr * 0.7, col);
        c.ellipse(x - hr * 0.3, b.shY - hr * 0.85, hr * 0.45, hr * 0.25, light);
        c.line(x - hr * 0.2, b.shY - hr * 0.5, x + hr * 0.35, b.shY - hr * 0.1, hr * 0.2, dark);
      }
      break;
    }
    case "wisp": {
      // Ghost tail: a long tapering wisp from the hips down to a point above the ground.
      const top = hipY;
      const tip = fy - 1;
      const w = hipW * 0.5;
      c.poly(
        [
          [hipX - w, top],
          [hipX + w, top],
          [hipX + backX * hr * 0.6, tip - hf * 0.1],
          [hipX + backX * hr * 0.2, tip],
        ],
        rgba(cue.color, 150),
      );
      c.line(hipX, top, hipX + backX * hr * 0.4, tip, Math.max(1, hr * 0.3), light);
      break;
    }
    case "shards": {
      // Icy spikes jutting out at shoulder and hip height, both sides.
      for (const [side, dy, len] of [
        [-1, 0.1, 1.5],
        [1, 0.1, 1.5],
        [-1, 0.45, 1.1],
        [1, 0.45, 1.2],
        [-1, 0.75, 0.9],
        [1, 0.8, 1.0],
      ] as const) {
        const y = b.shY + (hipY - b.shY) * dy;
        const x = contourX(b.img, y, side) ?? hipX + side * hr;
        c.poly(
          [
            [x - side * hr * 0.2, y - hr * 0.45],
            [x + side * hr * len, y - hr * 0.1],
            [x - side * hr * 0.2, y + hr * 0.45],
          ],
          col,
        );
        c.line(x, y, x + side * hr * len * 0.7, y - hr * 0.1, 0.6, WHITE);
      }
      break;
    }
    case "cloak": {
      // Falls behind the body from the shoulders to just above the ground, flaring at the hem.
      const hem = fy - hf * 0.04;
      const flare = hipW * 0.95 + hr * 0.4;
      c.poly(
        [
          [b.shL - hr * 0.2, b.shY - hr * 0.2],
          [b.shR + hr * 0.2, b.shY - hr * 0.2],
          [hipX + flare, hem],
          [hipX - flare, hem],
        ],
        col,
      );
      c.line(hipX - flare * 0.6, hem - 1, hipX + flare * 0.6, hem - 1, 1, light);
      c.line(hipX, b.shY, hipX + s0(vx) * hr * 0.2, hem - 2, Math.max(1, hr * 0.25), dark);
      break;
    }
  }
}

/** Sign of a facing component, with 0 treated as +1 (a cue's fold direction). */
function s0(v: number): number {
  return v < 0 ? -1 : 1;
}

/** Adds a 1 px outline behind the figure (bosses). */
function outlined(img: Img, hex: number): Img {
  const out = blank(img.width, img.height);
  const c = rgba(hex);
  const w = img.width;
  const h = img.height;
  const a = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : img.data[(y * w + x) * 4 + 3]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const near = Math.max(a(x - 1, y), a(x + 1, y), a(x, y - 1), a(x, y + 1));
      if (near >= 128) out.data.set(c, (y * w + x) * 4);
    }
  }
  for (let i = 0; i < img.data.length; i += 4) {
    const al = img.data[i + 3]!;
    if (al > 0) blendOver(out.data, i, img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, al / 255);
  }
  return out;
}

/** An upright, recoloured, reshaped figure with its cues, plus its ground point. */
interface Upright {
  img: Img;
  fx: number;
  fy: number;
  hf: number;
}

function bulgeAt(def: UnitDef, t: number): number {
  let f = 1;
  for (const b of def.bulge ?? []) f += b.amt * Math.exp(-(((t - b.t) / b.w) ** 2));
  return f;
}

function upright(def: UnitDef, facing: FacingId, src: Img, phase: number): Upright {
  const m = maleFrame();
  const k = SCALE_UNIT * (def.scale ?? 1);
  const squat = def.squat ?? 1;
  const [vx, vy] = FACING_VEC[facing];
  const bw = Math.max(1, Math.round(m.box.w * k * (def.wide ?? 1)));
  const bh = Math.max(1, Math.round(m.box.h * k * squat));
  const base = resize(recolor(crop(src, m.box), def.look ?? {}), bw, bh);
  const bfx = ((m.footX - m.box.x) / m.box.w) * bw;
  const bfy = ((m.footY - m.box.y) / m.box.h) * bh;
  const hn = m.height * k * squat;
  let maxBulge = 1;
  for (let t = 0; t <= 1; t += 0.05) maxBulge = Math.max(maxBulge, bulgeAt(def, t));
  const hunch = def.hunch ?? 0;
  const tilt = def.tilt ?? 0;
  // Facing the camera, a hunch shortens the body instead of leaning it.
  const vscale = 1 - hunch * 0.8 * Math.abs(vy);
  const float = def.ghost ? hn * 0.1 : 0;
  const mx = Math.ceil(hn * 0.75);
  const top = Math.ceil(hn * 0.5 + float);
  const bottom = Math.ceil(hn * 0.15) + 2;
  const W = Math.ceil(bw * maxBulge + 2 * hunch * hn + 2 * Math.abs(tilt) * hn) + 2 * mx;
  const H = bh + top + bottom;
  const fx = Math.round(W / 2);
  const fy = H - bottom;
  const body = blank(W, H);
  warpOver(body, base, (x, y, p) => {
    const v = (fy - y) / vscale - float;
    const t = v / hn;
    const shift = hunch * hn * Math.max(0, t) ** 2 * vx + tilt * hn * Math.max(0, t) ** 2;
    p[0] = bfx + (x - fx - shift) / bulgeAt(def, t);
    p[1] = bfy - v;
    // Ghosts lose their legs: everything below about a fifth of the height fades out.
    if (def.ghost) p[2] = clamp01((t - 0.12) / 0.3);
    return true;
  });
  const b = measureBody(body, fx, fy, vx, vy, phase);
  const img = blank(W, H);
  const c = paintOn(img);
  const cues = def.cues ?? [];
  for (const cue of cues) if (behind(cue, b)) drawCue(c, cue, b);
  for (let i = 0; i < body.data.length; i += 4) {
    const al = body.data[i + 3]!;
    if (al > 0)
      blendOver(img.data, i, body.data[i]!, body.data[i + 1]!, body.data[i + 2]!, al / 255);
  }
  for (const cue of cues) if (!behind(cue, b)) drawCue(c, cue, b);
  return { img: finishUnit(def, img), fx, fy, hf: b.hf };
}

/** Light 1 px rim on the transparent pixels beside a monster, so dark families read on dark floors. */
const HALO: RGBA = [206, 214, 204, 120];
const OUTLINE_RIM = 0x18161e;
function halo(img: Img): Img {
  const out = blank(img.width, img.height);
  img.data.copy(out.data);
  const w = img.width;
  const h = img.height;
  const a = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : img.data[(y * w + x) * 4 + 3]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a(x, y) > 0) continue;
      if (Math.max(a(x - 1, y), a(x + 1, y), a(x, y - 1), a(x, y + 1)) >= 128) {
        out.data.set(HALO, (y * w + x) * 4);
      }
    }
  }
  return out;
}

/** The last step for any unit image: a dark outline for bosses, the light rim for other monsters. */
function finishUnit(def: UnitDef, img: Img): Img {
  if (def.outline !== undefined) return outlined(img, def.outline);
  return def.role === "monster" ? halo(img) : img;
}

// ------------------------------------------------------------ drawn creatures

/**
 * Creatures the Kenney figure cannot show (a rat, a spider) are drawn from
 * scratch in design units scaled by `def.scale`. The projection maps a distance
 * `fwd` along the facing to screen space, so one drawing covers all eight
 * facings: side views show the body length, facing the camera stacks it down
 * the screen, and `side` moves a part to the near (+1) or far (-1) side.
 */
function projector(facing: FacingId, K: number, fx: number, fy: number) {
  const [vx, vy] = FACING_VEC[facing];
  const L = Math.abs(vx);
  return (fwd: number, side: number, up: number, spread = 4): [number, number] => [
    fx + (vx * fwd + (1 - L) * side * spread) * K,
    fy + (vy * fwd * 0.45 - up + L * side * 1.2) * K,
  ];
}

/** A quadruped with a long tail, big ears and a snout, in a trot cycle over `step`. */
function quadruped(def: UnitDef, facing: FacingId, step: number): Upright {
  const [vx, vy] = FACING_VEC[facing];
  const L = Math.abs(vx);
  const K = def.scale ?? 1;
  const W = Math.ceil(90 * K);
  const H = Math.ceil(60 * K);
  const fx = W / 2;
  const fy = H - 8 * K;
  const P = projector(facing, K, fx, fy);
  const img = blank(W, H);
  const c = paintOn(img);
  const fur = def.fur ?? 0x8a6a5a;
  const col = rgba(fur);
  const dark = shade(fur, 0.6);
  const light = shade(fur, 1.3);
  const bounce = (step % 2) * 0.5;
  const up0 = 13.5 + bounce;
  const rx = (7 + 6 * L) * K;
  const ry = 6.5 * K;
  // Diagonal pairs swing together: group 0 is near-front and far-back.
  const legs = [
    { fwd: 7, side: 1, group: 0 },
    { fwd: -7, side: 1, group: 1 },
    { fwd: 7, side: -1, group: 1 },
    { fwd: -7, side: -1, group: 0 },
  ];
  const drawLegs = (side: number) => {
    for (const leg of legs.filter((l) => l.side === side)) {
      const swing = leg.group === step % 2 ? 2.5 : -2.5;
      const lift = swing > 0 ? 1.5 : 0;
      const root = P(leg.fwd, side, up0 - 3, 4);
      const foot = P(leg.fwd + swing, side, lift, 4);
      const colr = side < 0 ? dark : col;
      c.line(root[0], root[1], foot[0], foot[1], 2.6 * K, colr);
      c.ellipse(foot[0], foot[1] - 0.4 * K, 1.5 * K, 1.1 * K, colr);
    }
  };
  drawLegs(-1);
  // Tail: behind the body, rising and wagging.
  const wag = (step % 2 === 0 ? 1 : -1) * 1.2;
  const tail: [number, number][] = [
    P(-10, 0, up0 + 1),
    P(-16, 0, up0 + 2),
    P(-21, 0, up0 + 6 + wag),
  ];
  c.taper(tail, 2.4 * K, 0.7 * K, col);
  const [cx, cy] = P(0, 0, up0);
  c.ellipse(cx, cy, rx, ry, col);
  c.ellipse(cx, cy + ry * 0.35, rx * 0.7, ry * 0.45, light);
  drawLegs(1);
  // Head, ears and snout.
  const [hx, hy] = P(12, 0, up0 + 2.5, 0);
  for (const side of [-1, 1]) {
    const [bx, by] = P(12, side, up0 + 5.5, 2.5);
    const [tx, ty] = P(12 + side * 0.4, side, up0 + 10, 2.5);
    c.poly(
      [
        [bx - 2.2 * K, by],
        [tx, ty],
        [bx + 2.2 * K, by],
      ],
      col,
    );
    c.poly(
      [
        [bx - 1.1 * K, by],
        [tx, ty + 1.5 * K],
        [bx + 1.1 * K, by],
      ],
      [230, 150, 150, 255],
    );
  }
  c.ellipse(hx, hy, 5.2 * K, 5.2 * K, col);
  c.taper([P(12, 0, up0 + 2.2), P(18, 0, up0 + 1.5)], 4 * K, 2.4 * K, col);
  c.ellipse(P(18.5, 0, up0 + 1.5)[0], P(18.5, 0, up0 + 1.5)[1], 0.9 * K, 0.9 * K, dark);
  if (vy > -0.5) {
    for (const side of [-1, 1]) {
      const [ex, ey] = P(14.5, side, up0 + 3.6, 2);
      c.ellipse(ex, ey, 1.1 * K, 1.1 * K, [255, 214, 80, 255]);
    }
  }
  const hf = (up0 + ry / K) * K;
  return { img: finishUnit(def, img), fx, fy, hf };
}

/** A spider: a round abdomen, a small thorax and eight jointed legs, in a gait over `step`. */
function spider(def: UnitDef, facing: FacingId, step: number): Upright {
  const K = def.scale ?? 1;
  const W = Math.ceil(90 * K);
  const H = Math.ceil(60 * K);
  const fx = W / 2;
  const fy = H - 8 * K;
  const P = projector(facing, K, fx, fy);
  const img = blank(W, H);
  const c = paintOn(img);
  const fur = def.fur ?? 0x4a4080;
  const col = rgba(fur);
  const dark = shade(fur, 0.6);
  const light = shade(fur, 1.35);
  const bounce = (step % 2) * 0.5;
  const drawLegs = (side: number) => {
    for (let i = 0; i < 4; i++) {
      const footFwd = (i - 1.5) * 9;
      const swing = i % 2 === step % 2 ? 2 : -2;
      const root = P(3 + (i - 1.5) * 1.2, side, 9 + bounce, 2.5);
      const knee = P(footFwd * 0.55 + 1.4, side, 13.5 + bounce, 7);
      const foot = P(footFwd + swing, side, 0, 9);
      const colr = side < 0 ? dark : col;
      c.taper([root, knee, foot], 2 * K, 0.9 * K, colr);
    }
  };
  drawLegs(-1);
  const [ax, ay] = P(-7, 0, 9 + bounce, 0);
  c.ellipse(ax, ay, 6 * K, 5.5 * K, col);
  c.ellipse(ax, ay - 2 * K, 2.7 * K, 1.8 * K, light);
  drawLegs(1);
  const [tx, ty] = P(4, 0, 9 + bounce, 0);
  c.ellipse(tx, ty, 4.2 * K, 3.8 * K, dark);
  c.ellipse(tx + 0.5 * K, ty - 0.6 * K, 3 * K, 2.6 * K, col);
  if (vyOf(facing) > -0.5) {
    for (const [fwd, side] of [
      [6.5, -0.9],
      [6.5, 0.9],
      [7.5, -2.2],
      [7.5, 2.2],
    ] as const) {
      const [ex, ey] = P(fwd, side, 10.5 + bounce, 1.5);
      c.ellipse(ex, ey, 0.7 * K, 0.7 * K, [255, 70, 70, 255]);
    }
  }
  const hf = (9 + 5.5) * K;
  return { img: finishUnit(def, img), fx, fy, hf };
}

function vyOf(facing: FacingId): number {
  return FACING_VEC[facing][1];
}

/** The upright figure for one frame: the Kenney figure, or a drawn creature (`step` = walk index). */
function figure(def: UnitDef, facing: FacingId, src: Img, phase: number, step: number): Upright {
  if (def.plan === "quadruped") return quadruped(def, facing, step);
  if (def.plan === "spider") return spider(def, facing, step);
  return upright(def, facing, src, phase);
}

/** A pose of an upright figure plus colour effects. Lean and lunge are px per 100 px of height. */
interface Pose {
  sx?: number;
  sy?: number;
  /** Moves the top of the body toward the facing (negative: away). */
  lunge?: number;
  /** Rotation about the feet, degrees (positive: clockwise on screen). */
  rot?: number;
  /** Vertical squash applied after the rotation (a lying body is foreshortened). */
  ky?: number;
  /** Lying body: picks `ky` so the rotated body is this fraction of the standing height tall. */
  flat?: number;
  dx?: number;
  dy?: number;
  alpha?: number;
  /** Mix toward `mixColor`. */
  mix?: number;
  mixColor?: number;
  /** Mix toward white. */
  bright?: number;
  /** Darken (multiply by 1 - dark). */
  dark?: number;
  /** Edge glow toward `rimColor`. */
  rim?: number;
  rimColor?: number;
  /** A dark 1 px outline around the pose, so a corpse reads on a dark floor. */
  outline?: boolean;
}

interface Posed {
  img: Img;
  /** Trimmed image offset from the ground point. */
  ox: number;
  oy: number;
}

function posed(u: Upright, facing: FacingId, p: Pose): Posed {
  const [vx, vy] = FACING_VEC[facing];
  const lunge = p.lunge ?? 0;
  const lean = lunge * vx;
  // Toward the camera, a lunge grows and drops a little; away, it shrinks and rises.
  const grow = 1 + lunge * vy * 0.004;
  const sx = (p.sx ?? 1) * grow;
  const sy = (p.sy ?? 1) * grow;
  const th = ((p.rot ?? 0) * Math.PI) / 180;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  let ky = p.ky ?? 1;
  if (p.flat !== undefined) {
    // A side view is much thinner than a front view; size every corpse alike.
    const across = Math.max(1, alphaBox(u.img).w * sx);
    ky = Math.max(0.5, Math.min(2.5, (p.flat * u.hf) / across));
  }
  const dx = p.dx ?? 0;
  const dy = (p.dy ?? 0) + (lunge * vy * u.hf) / 400;
  const fwd = (x: number, y: number): [number, number] => {
    const x1 = x * sx;
    const y1 = y * sy;
    const x2 = x1 - (lean / 100) * y1;
    return [x2 * ct - y1 * st + dx, (x2 * st + y1 * ct) * ky + dy];
  };
  const corners = [
    fwd(-u.fx, -u.fy),
    fwd(u.img.width - u.fx, -u.fy),
    fwd(-u.fx, u.img.height - u.fy),
    fwd(u.img.width - u.fx, u.img.height - u.fy),
  ];
  const x0 = Math.floor(Math.min(...corners.map((q) => q[0]))) - 1;
  const y0 = Math.floor(Math.min(...corners.map((q) => q[1]))) - 1;
  const x1 = Math.ceil(Math.max(...corners.map((q) => q[0]))) + 1;
  const y1 = Math.ceil(Math.max(...corners.map((q) => q[1]))) + 1;
  const out = blank(x1 - x0, y1 - y0);
  warpOver(out, u.img, (x, y, q) => {
    const x4 = x + x0 - dx;
    const y3 = (y + y0 - dy) / ky;
    const x2 = x4 * ct + y3 * st;
    const y1b = -x4 * st + y3 * ct;
    const x1b = x2 + (lean / 100) * y1b;
    q[0] = x1b / sx + u.fx;
    q[1] = y1b / sy + u.fy;
    return true;
  });
  effects(out, p);
  // The canvas has a 1 px margin on every side, so the outline fits inside it.
  const drawn = p.outline ? outlined(out, OUTLINE_RIM) : out;
  const box = alphaBox(drawn);
  return { img: crop(drawn, box), ox: box.x + x0, oy: box.y + y0 };
}

function effects(img: Img, p: Pose): void {
  const d = img.data;
  const w = img.width;
  const h = img.height;
  const rim = p.rim ?? 0;
  let edge: Uint8Array | null = null;
  if (rim > 0) {
    edge = new Uint8Array(w * h);
    const a = (x: number, y: number) =>
      x < 0 || y < 0 || x >= w || y >= h ? 0 : d[(y * w + x) * 4 + 3]!;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (a(x, y) < 40) continue;
        const near = Math.min(a(x - 1, y), a(x + 1, y), a(x, y - 1), a(x, y + 1));
        const far = Math.min(a(x - 2, y), a(x + 2, y), a(x, y - 2), a(x, y + 2));
        edge[y * w + x] = near < 40 ? 2 : far < 40 ? 1 : 0;
      }
    }
  }
  const mix = p.mix ?? 0;
  const mc = rgba(p.mixColor ?? 0xffffff);
  const bright = p.bright ?? 0;
  const dark = p.dark ?? 0;
  const alpha = p.alpha ?? 1;
  const rc = rgba(p.rimColor ?? 0xffe9a0);
  for (let i = 0, n = 0; i < d.length; i += 4, n++) {
    if (d[i + 3] === 0) continue;
    for (let ch = 0; ch < 3; ch++) {
      let v = d[i + ch]!;
      if (mix > 0) v += (mc[ch]! - v) * mix;
      if (bright > 0) v += (255 - v) * bright;
      if (edge) {
        const e = edge[n]!;
        const r = e === 2 ? rim : e === 1 ? rim * 0.55 : rim * 0.12;
        v += (rc[ch]! - v) * r;
      }
      if (dark > 0) v *= 1 - dark;
      d[i + ch] = Math.round(Math.max(0, Math.min(255, v)));
    }
    if (alpha !== 1) d[i + 3] = Math.round(d[i + 3]! * alpha);
  }
}

// --------------------------------------------------------------- frame table

interface Frame {
  img: Img;
  anchor: Anchor;
  /** Trimmed frames: offset inside the untrimmed source size (TexturePacker `spriteSourceSize`). */
  trim?: { x: number; y: number; w: number; h: number };
}
/** Atlas frames by name (name = sprite id for drawn sprites) and sprite ids. */
const frames = new Map<string, Frame>();
const sprites: Record<string, { frame: string; anchor: Anchor }> = {};
const animations: Record<string, AnimationRef> = {};

function addFrame(id: string, img: Img, anchor: Anchor, trim?: Frame["trim"]): void {
  if (frames.has(id) || sprites[id]) throw new Error(`duplicate sprite id ${id}`);
  frames.set(id, { img, anchor, trim });
  sprites[id] = { frame: id, anchor };
}

/** A sprite id that points at an existing frame (used for base ids such as `prop.barrel`). */
function alias(id: string, frame: string, anchor: Anchor): void {
  if (sprites[id]) throw new Error(`duplicate sprite id ${id}`);
  if (!frames.has(frame)) throw new Error(`alias ${id} points at missing frame ${frame}`);
  sprites[id] = { frame, anchor };
}

function addAnimation(id: string, frameIds: string[], fps: number, loop = true): void {
  if (animations[id]) throw new Error(`duplicate animation ${id}`);
  animations[id] = { frames: frameIds, fps, loop };
}

/** Kenney run frames kept per facing (of 10); fewer frames keep the atlas within budget. */
const WALK_KEEP = [0, 1, 3, 4, 5, 6, 8, 9];
const HIT_RED = 0xff3a20;

/**
 * Per-facing clips for one unit, from that facing's Kenney idle and run frames:
 * idle (breathing), walk, and for fighters attack, cast, hit and death. Every
 * frame of a unit shares one untrimmed source box and anchor (the ground
 * point), so clips line up and the label height stays put; the atlas only
 * stores the trimmed pixels. The unsuffixed clips (`<id>.idle`, ...) are the
 * south-facing ones, for lookups without a facing.
 */
function buildUnit(def: UnitDef): void {
  const id = def.id;
  const fighter = def.role !== "npc";
  const cast = def.castColor ?? 0xffe9a0;
  const pending: { name: string; p: Posed }[] = [];
  const clips: { name: string; frames: string[]; fps: number; loop: boolean }[] = [];
  const clip = (
    action: string,
    facing: FacingId,
    u: (i: number) => Upright,
    poses: Pose[],
    fps: number,
    loop: boolean,
  ) => {
    const names = poses.map((p, i) => {
      const name = `${id}.${action}.${facing}.${i}`;
      pending.push({ name, p: posed(u(i), facing, p) });
      return name;
    });
    clips.push({ name: `${id}.${action}.${facing}`, frames: names, fps, loop });
  };
  for (const facing of FACINGS) {
    const src = maleSource(MALE_SET[facing]);
    const idle = figure(def, facing, src.idle, 0, 0);
    const still = () => idle;
    const [vx, vy] = FACING_VEC[facing];
    clip(
      "idle",
      facing,
      still,
      [{}, { sy: 1.015, sx: 0.995 }, { sy: 1.03, sx: 0.99 }, { sy: 1.015, sx: 0.995 }],
      4,
      true,
    );
    const runs = WALK_KEEP.map((i, j) => figure(def, facing, src.run[i]!, i, j));
    clip(
      "walk",
      facing,
      (i) => runs[i]!,
      runs.map(() => ({})),
      Math.round(((def.walkFps ?? 10) * WALK_KEEP.length) / RUN_FRAMES),
      true,
    );
    if (!fighter) continue;
    clip(
      "attack",
      facing,
      still,
      [{ lunge: -6, sy: 1.03 }, { lunge: 7 }, { lunge: 16, sx: 1.06, sy: 0.95 }, { lunge: 5 }],
      12,
      false,
    );
    clip(
      "cast",
      facing,
      still,
      [
        // Gather: lean back and crouch, the body squashes wide.
        { lunge: -8, sx: 1.06, sy: 0.92, bright: 0.04 },
        // Channel: the deepest lean back, a tall stretch, the aura starts.
        { lunge: -12, sx: 0.92, sy: 1.1, bright: 0.1, rim: 0.7, rimColor: cast },
        // Release: a big thrust forward, stretched thin, full glow at the edge.
        { lunge: 16, sx: 0.9, sy: 1.12, bright: 0.2, rim: 1, rimColor: cast },
        // Recover: back toward idle while the glow fades.
        { lunge: 5, sx: 1, sy: 0.98, bright: 0.06, rim: 0.3, rimColor: cast },
      ],
      10,
      false,
    );
    clip(
      "hit",
      facing,
      still,
      [
        { lunge: -11, sy: 0.96, mix: 0.5, mixColor: HIT_RED, bright: 0.15 },
        { lunge: -5, mix: 0.22, mixColor: HIT_RED },
      ],
      12,
      false,
    );
    // Falls backward (away from the facing) and ends lying flat, darkened but readable.
    const fall = vx > 0.1 ? -1 : vx < -0.1 ? 1 : vy >= 0 ? 1 : -1;
    clip(
      "death",
      facing,
      still,
      [
        { lunge: -9, mix: 0.35, mixColor: HIT_RED },
        { rot: 32 * fall, dark: 0.05 },
        { rot: 64 * fall, ky: 0.9, dark: 0.08, dy: -idle.hf * 0.08, outline: true },
        {
          rot: 90 * fall,
          flat: 0.34,
          sy: 0.9,
          dark: 0.12,
          dx: -fall * idle.hf * 0.42,
          dy: -idle.hf * 0.17,
          outline: true,
        },
      ],
      8,
      false,
    );
  }
  // One untrimmed box per unit: the union of every trimmed frame around the ground point.
  const minX = Math.min(...pending.map((f) => f.p.ox));
  const minY = Math.min(...pending.map((f) => f.p.oy));
  const maxX = Math.max(...pending.map((f) => f.p.ox + f.p.img.width));
  const maxY = Math.max(...pending.map((f) => f.p.oy + f.p.img.height));
  const w = maxX - minX;
  const h = maxY - minY;
  const anchor = { x: round4(-minX / w), y: round4(-minY / h) };
  for (const f of pending) {
    addFrame(f.name, f.p.img, anchor, { x: f.p.ox - minX, y: f.p.oy - minY, w, h });
  }
  for (const c of clips) addAnimation(c.name, c.frames, c.fps, c.loop);
  alias(id, `${id}.idle.s.0`, anchor);
  for (const action of fighter
    ? ["idle", "walk", "attack", "cast", "hit", "death"]
    : ["idle", "walk"]) {
    const south = animations[`${id}.${action}.s`]!;
    addAnimation(`${id}.${action}`, south.frames, south.fps, south.loop ?? true);
  }
}

/** Anchors are stored rounded; trim offsets are integers, so a 4-decimal anchor stays sub-pixel exact. */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ------------------------------------------------------------------- content

function buildGround(): void {
  const landscape = (file: string) => {
    const img = load(file);
    return diamond(img, { x: 0, y: 0, w: img.width, h: img.height });
  };
  const dungeonFloor = (file: string, look: Look) => {
    const img = load(`kenney-dungeon/Isometric/${file}.png`);
    const box = alphaBox(img);
    return recolor(diamond(img, box), look);
  };
  addFrame("tile.grass", landscape("grass-block.png"), TOP);
  addFrame("tile.stone", landscape("stone-plaza.png"), TOP);
  addFrame(
    "tile.grass.dark",
    recolor(landscape("grass-block.png"), { light: -0.14, sat: 1.05 }),
    TOP,
  );
  addFrame("tile.dirt", landscape("kenney-landscape/landscapeTiles_083.png"), TOP);
  addFrame("tile.void", voidTile(), TOP);

  const floors: [string, string[], Look][] = [
    ["crypt", ["stone_N", "stoneTile_N", "stoneMissingTiles_N"], { sat: 0.45, light: -0.02 }],
    ["cave", ["dirt_N", "dirtTiles_N", "stoneUneven_N"], { hue: -8, sat: 0.9, light: -0.08 }],
    [
      "forge",
      ["planks_N", "planksBroken_N", "stoneTile_N"],
      { tint: 0xff9a4a, tintMix: 0.25, light: -0.05 },
    ],
    [
      "abyss",
      ["stone_N", "stoneMissingTiles_N", "stoneUneven_N"],
      { hue: 255, sat: 0.45, light: -0.3 },
    ],
  ];
  for (const [theme, files, look] of floors) {
    files.forEach((file, i) => {
      addFrame(`tile.${theme}.floor.${i + 1}`, dungeonFloor(file, look), TOP);
    });
    alias(`tile.${theme}.floor`, `tile.${theme}.floor.1`, TOP);
  }
  // Generic dungeon floor, used by content as a fallback.
  alias("tile.dungeon.floor", "tile.crypt.floor.1", TOP);
}

/** Crops a Kenney object to its alpha box, recolours it and scales it by `scale`. */
function objectSprite(file: string, scale: number, look: Look = {}): Img {
  const img = load(file);
  return scaleBy(recolor(crop(img, alphaBox(img)), look), scale);
}

function buildProps(): void {
  const dungeon: [string, string, Look?][] = [
    ["wall.crypt", `${DUNGEON}stoneWall_E.png`, { sat: 0.5, light: -0.02 }],
    ["wall.cave", `${DUNGEON}stoneWallAged_E.png`, { hue: -8, sat: 0.9, light: -0.1 }],
    ["wall.forge", `${DUNGEON}stoneWall_N.png`, { tint: 0xff9a4a, tintMix: 0.3, light: -0.05 }],
    ["wall.abyss", `${DUNGEON}stoneWall_N.png`, { hue: 255, sat: 0.45, light: -0.3 }],
    ["wall.dungeon", `${DUNGEON}stoneWall_E.png`],
    ["prop.door", `${DUNGEON}stoneWallDoor_E.png`],
    ["prop.stairs.down", `${DUNGEON}stairs_E.png`],
    ["prop.stairs.up", `${DUNGEON}stairs_W.png`],
    ["prop.barrel", `${DUNGEON}barrel_E.png`],
    ["prop.crate", `${DUNGEON}woodenCrate_E.png`],
    ["prop.pillar", `${DUNGEON}stoneColumn_E.png`],
    ["prop.stash", `${DUNGEON}chestClosed_E.png`],
  ];
  for (const [id, file, look] of dungeon) {
    addFrame(id, objectSprite(file, SCALE_DUNGEON, look), BOTTOM);
  }
  // `steps` asks for plain stairs.
  alias("prop.stairs", "prop.stairs.down", BOTTOM);

  addFrame("prop.tree", objectSprite("tree-default-sw.png", SCALE_LANDSCAPE), BOTTOM);
  const nature: [string, string, Look?][] = [
    ["prop.tree.pine", `${NATURE}tree_pineDefaultA_SW.png`],
    ["prop.rock", `${NATURE}rock_largeA_SW.png`],
    ["prop.statue", `${NATURE}statue_column_SE.png`],
    ["prop.waypoint", `${NATURE}statue_obelisk_SE.png`, { hue: 170, sat: 1.1, light: 0.1 }],
    ["prop.fence", `${NATURE}fence_planks_SE.png`],
    ["prop.brazier", `${NATURE}campfire_stones_SE.png`],
  ];
  for (const [id, file, look] of nature) {
    addFrame(id, objectSprite(file, SCALE_LANDSCAPE, look), BOTTOM);
  }

  addFrame("prop.house", objectSprite(`${SUBURBAN}building-type-a.png`, 1), BOTTOM);
  addFrame("prop.house.large", objectSprite(`${SUBURBAN}building-type-e.png`, 1.25), BOTTOM);

  addFrame("prop.bones", bones(), BOTTOM);
  addFrame("prop.torch", torch(), BOTTOM);
  addFrame("prop.well", well(), BOTTOM);
  addFrame("prop.cart", cart(), BOTTOM);
  addFrame("prop.tent", tent(), BOTTOM);
}

function buildLoot(): void {
  addFrame("loot.gold", goldPile(), LOOT);
  addFrame("loot.potion.life", potion([214, 40, 58, 255]), LOOT);
  addFrame("loot.potion.mana", potion([47, 111, 224, 255]), LOOT);
  addFrame("loot.potion.rejuv", potion([166, 75, 216, 255]), LOOT);
  // The one rejuvenation potion is tier 3 (classic content), so it gets its flask size.
  addFrame("loot.potion.rejuv.3", potion([166, 75, 216, 255], 3), LOOT);
  // Tiered potions: small vial (1) to large ornate flask (4).
  for (const tier of [1, 2, 3, 4]) {
    addFrame(`loot.potion.life.${tier}`, potion([214, 40, 58, 255], tier), LOOT);
    addFrame(`loot.potion.mana.${tier}`, potion([47, 111, 224, 255], tier), LOOT);
  }
  for (const kind of [
    "sword",
    "axe",
    "mace",
    "dagger",
    "bow",
    "staff",
    "wand",
    "shield",
    "helm",
    "armor",
    "gloves",
    "boots",
    "ring",
    "amulet",
  ]) {
    addFrame(`loot.item.${kind}`, itemIcon(kind), LOOT);
  }
}

function buildFx(): void {
  addFrame("fx.arrow", fxArrow(), CENTER);
  addFrame("fx.ember_bolt", fxOrb(16, [255, 220, 120, 255], [240, 110, 30, 255], 2), CENTER);
  addFrame("fx.cinder_orb", fxOrb(28, [255, 150, 60, 255], [200, 50, 20, 255], 1.5), CENTER);
  addFrame("fx.frostbolt", fxOrb(16, [200, 245, 255, 255], [60, 170, 230, 255], 2), CENTER);
  addFrame("fx.firebolt", fxFirebolt(), CENTER);
  addFrame("fx.shadebolt", fxOrb(16, [60, 30, 80, 255], [130, 60, 200, 255], 2), CENTER);
  addFrame("fx.spark", fxSpark(), CENTER);
  addFrame("fx.venom", fxVenom(), CENTER);
  addFrame("fx.volley", fxVolley(), CENTER);
  addFrame("fx.portal", fxPortal(), BOTTOM);
}

function buildUnits(): void {
  for (const def of UNITS) buildUnit(def);
  // Sentry: a hero-summoned totem, drawn rather than recoloured. It has no
  // facing, so every facing points at the same frames.
  const S = "unit.monster.sentry";
  const sentryClips: [string, SentryLook[], number, boolean][] = [
    ["idle", [{ glow: 1 }, { glow: 0.55 }], 4, true],
    // Charge and discharge: the crystal swells and flares.
    [
      "attack",
      [{ glow: 0.8 }, { glow: 1, size: 1.12 }, { glow: 1, size: 1.25 }, { glow: 0.7, size: 1.05 }],
      12,
      false,
    ],
    // Collapse: the crystal dims, drops and lands broken.
    [
      "death",
      [
        { glow: 0.4, drop: 4, tilt: 0.3 },
        { glow: 0.15, drop: 14, tilt: 0.8, pole: 0.8 },
        { glow: 0, drop: 28, tilt: 1.3, pole: 0.55, alpha: 0.85 },
        { glow: 0, drop: 36, tilt: 1.57, pole: 0.4, alpha: 0.75, lie: true },
      ],
      8,
      false,
    ],
  ];
  for (const [action, looks, fps, loop] of sentryClips) {
    const ids = looks.map((look, i) => {
      const frameId = `${S}.${action}.${i}`;
      addFrame(frameId, sentry(look), BOTTOM);
      return frameId;
    });
    addAnimation(`${S}.${action}`, ids, fps, loop);
    for (const f of FACINGS) addAnimation(`${S}.${action}.${f}`, ids, fps, loop);
  }
  alias(S, `${S}.idle.0`, BOTTOM);
  for (const [action, from] of [
    ["walk", "idle"],
    ["cast", "attack"],
    ["hit", "attack"],
  ] as const) {
    const a = animations[`${S}.${from}`]!;
    addAnimation(`${S}.${action}`, a.frames, a.fps, a.loop ?? true);
    for (const f of FACINGS) addAnimation(`${S}.${action}.${f}`, a.frames, a.fps, a.loop ?? true);
  }
}

// ------------------------------------------------------------------ atlases

interface Placed {
  name: string;
  img: Img;
  x: number;
  y: number;
}
interface Page {
  width: number;
  height: number;
  placed: Placed[];
}

/** Shelf packer: rows of similar height, filling each page up to ATLAS_SIDE, then a new page. */
function packPages(items: { name: string; img: Img }[]): Page[] {
  const sorted = [...items].sort(
    (a, b) => b.img.height - a.img.height || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const pages: Page[] = [];
  let page: Page = { width: 0, height: 0, placed: [] };
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const it of sorted) {
    const w = it.img.width;
    const h = it.img.height;
    if (w > ATLAS_SIDE || h > ATLAS_SIDE) throw new Error(`${it.name} is larger than an atlas`);
    if (x + w > ATLAS_SIDE && x > 0) {
      x = 0;
      y += rowH + PAD;
      rowH = 0;
    }
    if (y + h > ATLAS_SIDE) {
      pages.push(page);
      page = { width: 0, height: 0, placed: [] };
      x = 0;
      y = 0;
      rowH = 0;
    }
    page.placed.push({ name: it.name, img: it.img, x, y });
    x += w + PAD;
    rowH = Math.max(rowH, h);
    page.width = Math.max(page.width, x - PAD);
    page.height = Math.max(page.height, y + h);
  }
  if (page.placed.length > 0) pages.push(page);
  return pages;
}

function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// ------------------------------------------------------------------- build

buildGround();
buildProps();
buildLoot();
buildFx();
buildUnits();
addFrame("missing", missingTile(), BOTTOM);

// Identical pixels (for example a breathing frame that repeats) are packed once
// and shared by every frame name that uses them.
const pixelKey = (img: Img) =>
  createHash("sha1").update(`${img.width}x${img.height}:`).update(img.data).digest("hex");
const uniquePixels = new Map<string, Img>();
const frameKey = new Map<string, string>();
for (const [name, f] of frames) {
  const key = pixelKey(f.img);
  if (!uniquePixels.has(key)) uniquePixels.set(key, f.img);
  frameKey.set(name, key);
}
const pages = packPages([...uniquePixels].map(([name, img]) => ({ name, img })));
const atlasId = (n: number) => `${PACK}.atlas-${n}`;
const placement = new Map<string, { page: number; x: number; y: number }>();
const frameAtlas = new Map<string, number>();
const atlasFiles: { png: Buffer; json: string; name: string }[] = [];

pages.forEach((page, n) => {
  const png = blank(page.width, page.height);
  for (const p of page.placed) {
    const { img } = p;
    for (let row = 0; row < img.height; row++) {
      const from = row * img.width * 4;
      img.data.copy(png.data, ((p.y + row) * page.width + p.x) * 4, from, from + img.width * 4);
    }
    placement.set(p.name, { page: n, x: p.x, y: p.y });
  }
  atlasFiles.push({ name: `atlas-${n}`, png: PNG.sync.write(png), json: "" });
});

const frameJson: Record<string, unknown>[] = pages.map(() => ({}));
for (const [name, f] of [...frames].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
  const at = placement.get(frameKey.get(name)!)!;
  const { img, trim } = f;
  frameAtlas.set(name, at.page);
  frameJson[at.page]![name] = {
    frame: { x: at.x, y: at.y, w: img.width, h: img.height },
    rotated: false,
    trimmed: !!trim,
    spriteSourceSize: trim
      ? { x: trim.x, y: trim.y, w: img.width, h: img.height }
      : { x: 0, y: 0, w: img.width, h: img.height },
    sourceSize: trim ? { w: trim.w, h: trim.h } : { w: img.width, h: img.height },
  };
}
pages.forEach((page, n) => {
  const json = {
    frames: frameJson[n],
    meta: {
      image: `atlas-${n}.png`,
      size: { w: page.width, h: page.height },
      scale: "1",
    },
  };
  atlasFiles[n]!.json = `${JSON.stringify(json, null, 2)}\n`;
});

const spriteRefs: Record<string, SpriteRef> = {};
for (const [id, s] of Object.entries(sprites)) {
  const n = frameAtlas.get(s.frame);
  if (n === undefined) throw new Error(`sprite ${id} has no atlas frame ${s.frame}`);
  spriteRefs[id] = { atlas: atlasId(n), frame: s.frame, anchor: s.anchor };
}

const manifest: AssetManifest = {
  version: "1.1.0",
  pack: PACK,
  atlases: pages.map((_, n) => ({ id: atlasId(n), url: `atlas-${n}.json` })),
  sprites: spriteRefs,
  animations,
  licenses: [
    {
      source: "Isometric Miniature Dungeon (Kenney)",
      license: "CC0-1.0",
      url: "https://kenney.nl/assets/isometric-miniature-dungeon",
      author: "Kenney",
    },
    {
      source: "Isometric Landscape (Kenney)",
      license: "CC0-1.0",
      url: "https://kenney.nl/assets/isometric-tiles-landscape",
      author: "Kenney",
    },
    {
      source: "Nature Kit (Kenney)",
      license: "CC0-1.0",
      url: "https://kenney.nl/assets/nature-kit",
      author: "Kenney",
    },
    {
      source: "City Kit Suburban (Kenney)",
      license: "CC0-1.0",
      url: "https://kenney.nl/assets/city-kit-suburban",
      author: "Kenney",
    },
    {
      source:
        "gamez procedural (recoloured and rescaled Kenney Isometric Miniature Dungeon frames)",
      license: "CC0-1.0",
      url: "https://kenney.nl/assets/isometric-miniature-dungeon",
      author: "Kenney",
    },
    {
      source: "gamez procedural (drawn by scripts/build.ts)",
      license: "CC0-1.0",
    },
  ],
};

mkdirSync(OUT, { recursive: true });
const wanted = new Set<string>(["manifest.json"]);
for (const file of atlasFiles) {
  writeAtomic(join(OUT, `${file.name}.png`), file.png);
  writeAtomic(join(OUT, `${file.name}.json`), file.json);
  wanted.add(`${file.name}.png`);
  wanted.add(`${file.name}.json`);
}
writeAtomic(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// Remove the single-page output of earlier builds once the manifest no longer lists it.
for (const file of readdirSync(OUT)) {
  if (/^atlas(-\d+)?\.(json|png)$/.test(file) && !wanted.has(file)) unlinkSync(join(OUT, file));
}
if (existsSync(join(OUT, "atlas.json"))) unlinkSync(join(OUT, "atlas.json"));
// Run the repo formatter on the manifest so `vp check` stays green after a rebuild
// (JSON.stringify expands short arrays that the formatter keeps on one line).
const vpBin = join(here, "..", "..", "..", "node_modules", ".bin", "vp");
if (existsSync(vpBin)) {
  try {
    execFileSync(vpBin, ["fmt", join(OUT, "manifest.json")], { stdio: "ignore" });
  } catch {
    console.warn("vp fmt failed: run `node_modules/.bin/vp check --fix` after the build");
  }
}

const sizes = pages.map((p) => `${p.width}x${p.height}`).join(", ");
console.log(
  `${frames.size} frames (${uniquePixels.size} unique images), ${Object.keys(sprites).length} sprite ids, ${Object.keys(animations).length} animations, ${pages.length} atlas page(s) [${sizes}] -> ${OUT}`,
);

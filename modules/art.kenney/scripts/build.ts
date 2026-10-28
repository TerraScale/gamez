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
 * Character frames use SCALE_UNIT (the Phase-0 hero size) and every family is a
 * recolour, rescale or lean of a Kenney character frame.
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

/**
 * Leans a sprite: each row moves by `lean` px per 100 px of height, measured from
 * the feet. The feet stay put; the top leans right for a positive value.
 */
function shear(img: Img, lean: number): Img {
  if (lean === 0) return img;
  const offset = (y: number) => Math.round((lean / 100) * (img.height - 1 - y));
  let minO = 0;
  let maxO = 0;
  for (let y = 0; y < img.height; y++) {
    minO = Math.min(minO, offset(y));
    maxO = Math.max(maxO, offset(y));
  }
  const out = blank(img.width + (maxO - minO), img.height);
  for (let y = 0; y < img.height; y++) {
    const shift = offset(y) - minO;
    for (let x = 0; x < img.width; x++) {
      const from = (y * img.width + x) * 4;
      if (img.data[from + 3] === 0) continue;
      const to = (y * out.width + x + shift) * 4;
      img.data.copy(out.data, to, from, from + 4);
    }
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
  const img = blank(w, h);
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
  return { img, w, h, put, ellipse, erase, line, poly, glow };
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

function potion(liquid: RGBA): Img {
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

function sentry(bright: boolean): Img {
  const glowColor: RGBA = bright ? [90, 230, 255, 255] : [60, 150, 200, 255];
  return procedural(28, 56, (c) => {
    c.ellipse(14, 53, 10, 3, [60, 60, 70, 255]);
    c.poly(
      [
        [10, 52],
        [18, 52],
        [17, 20],
        [11, 20],
      ],
      [184, 115, 51, 255],
    );
    c.glow(14, 13, 12, glowColor, 2);
    c.poly(
      [
        [14, 4],
        [20, 14],
        [14, 22],
        [8, 14],
      ],
      glowColor,
    );
    c.ellipse(14, 13, 2, 2, WHITE);
  });
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

interface Base {
  idle: Img;
  run: Img[];
}
const maleCache = new Map<number, Base>();

/**
 * Kenney Male frames cropped to one shared box (idle plus run), so every family
 * built from the same base keeps its feet and its size. Base 0 uses the
 * Phase-0 hero files so the existing hero frames stay unchanged.
 */
function maleBase(index: number): Base {
  const hit = maleCache.get(index);
  if (hit) return hit;
  const idleSrc = load(
    index === 0 ? "hero-idle-0.png" : `kenney-dungeon/Characters/Male/Male_${index}_Idle0.png`,
  );
  const runSrc = Array.from({ length: 10 }, (_, i) =>
    load(
      index === 0
        ? `hero-walk-${i}.png`
        : `kenney-dungeon/Characters/Male/Male_${index}_Run${i}.png`,
    ),
  );
  const box = union([idleSrc, ...runSrc].map(alphaBox));
  const base = { idle: crop(idleSrc, box), run: runSrc.map((f) => crop(f, box)) };
  maleCache.set(index, base);
  return base;
}

interface UnitDef {
  /** Appearance id: `unit.hero.*`, `unit.npc.*` or `unit.monster.*`. */
  id: string;
  /** Kenney Male set 0..7 the frames come from. */
  base: number;
  role: "hero" | "npc" | "monster";
  look?: Look;
  /** Size multiplier on top of SCALE_UNIT. */
  scale?: number;
  /** Width multiplier. */
  wide?: number;
  /** Lean of the whole body (attack pose), px per 100 px of height. */
  lean?: number;
  walkFps?: number;
}

const UNITS: UnitDef[] = [
  { id: "unit.hero", base: 0, role: "hero", walkFps: 12 },
  { id: "unit.hero.warrior", base: 0, role: "hero", look: { tint: 0xc8d4e8, tintMix: 0.15 } },
  { id: "unit.hero.rogue", base: 2, role: "hero", look: { hue: 100, sat: 0.9, light: -0.05 } },
  { id: "unit.hero.sorcerer", base: 4, role: "hero", look: { hue: 230, sat: 1 } },
  {
    id: "unit.npc.healer",
    base: 5,
    role: "npc",
    look: { sat: 0.3, light: 0.1, tint: 0xa8ffd0, tintMix: 0.2 },
  },
  { id: "unit.npc.smith", base: 6, role: "npc", look: { tint: 0xffa060, tintMix: 0.25 } },
  { id: "unit.npc.alchemist", base: 3, role: "npc", look: { hue: 260, sat: 0.8 } },
  { id: "unit.npc.junk", base: 7, role: "npc", look: { hue: 20, sat: 0.4, light: -0.05 } },
  { id: "unit.npc.quest", base: 1, role: "npc", look: { hue: 190, sat: 0.9, light: 0.05 } },
  {
    id: "unit.monster.husk",
    base: 1,
    role: "monster",
    look: { hue: 65, sat: 0.35, light: -0.02 },
    lean: 8,
  },
  {
    id: "unit.monster.gnawling",
    base: 3,
    role: "monster",
    look: { sat: 0.6 },
    scale: 0.66,
    wide: 1.1,
    walkFps: 14,
  },
  {
    id: "unit.monster.bonefletcher",
    base: 5,
    role: "monster",
    look: { sat: 0.15, light: 0.18 },
  },
  {
    id: "unit.monster.ash_seer",
    base: 6,
    role: "monster",
    look: { hue: -10, sat: 0.25, light: 0.05, tint: 0xd0c0ff, tintMix: 0.25 },
  },
  {
    id: "unit.monster.blightbloat",
    base: 7,
    role: "monster",
    look: { hue: 95, sat: 1.1 },
    scale: 0.95,
    wide: 1.35,
  },
  {
    id: "unit.monster.bristleback",
    base: 2,
    role: "monster",
    look: { hue: -5, sat: 1.2 },
    scale: 1.05,
    wide: 1.15,
    lean: -6,
  },
  {
    id: "unit.monster.cairn_brute",
    base: 0,
    role: "monster",
    look: { sat: 0.15, light: -0.05 },
    scale: 1.3,
    wide: 1.3,
  },
  {
    id: "unit.monster.webskitter",
    base: 4,
    role: "monster",
    look: { hue: 230, sat: 0.9, light: -0.1 },
    scale: 0.62,
    wide: 1.2,
    walkFps: 14,
  },
  {
    id: "unit.monster.hollow_cantor",
    base: 1,
    role: "monster",
    look: { hue: 255, sat: 0.8, light: -0.08 },
  },
  {
    id: "unit.monster.cinder_imp",
    base: 6,
    role: "monster",
    look: { hue: -15, sat: 1.6, light: 0.02 },
    scale: 0.88,
    lean: 4,
    walkFps: 14,
  },
  {
    id: "unit.monster.rime_wraith",
    base: 5,
    role: "monster",
    look: { hue: 165, sat: 0.9, light: 0.12, alpha: 0.82 },
    wide: 0.9,
  },
  {
    id: "unit.monster.boss_warden",
    base: 0,
    role: "monster",
    look: { hue: 40, sat: 0.9, light: 0.05 },
    scale: 1.55,
    wide: 1.25,
    walkFps: 8,
  },
  {
    id: "unit.monster.boss_tunnel_mother",
    base: 2,
    role: "monster",
    look: { hue: 110, sat: 0.8 },
    scale: 1.7,
    wide: 1.5,
    lean: 4,
    walkFps: 8,
  },
  {
    id: "unit.monster.boss_ninth_flame",
    base: 4,
    role: "monster",
    look: { hue: -25, sat: 1.3, light: 0.05 },
    scale: 1.6,
    wide: 1.2,
    walkFps: 8,
  },
  {
    id: "unit.monster.boss_hollow_king",
    base: 1,
    role: "monster",
    look: { hue: 180, sat: 0.4, light: 0.12 },
    scale: 1.7,
    wide: 1.3,
    walkFps: 8,
  },
];

// --------------------------------------------------------------- frame table

interface Frame {
  img: Img;
  anchor: Anchor;
}
/** Atlas frames by name (name = sprite id for drawn sprites) and sprite ids. */
const frames = new Map<string, Frame>();
const sprites: Record<string, { frame: string; anchor: Anchor }> = {};
const animations: Record<string, AnimationRef> = {};

function addFrame(id: string, img: Img, anchor: Anchor): void {
  if (frames.has(id) || sprites[id]) throw new Error(`duplicate sprite id ${id}`);
  frames.set(id, { img, anchor });
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

/** Frame set for one character: idle, walk (Kenney run), and for fighters attack and death. */
function buildUnit(def: UnitDef): void {
  const base = maleBase(def.base);
  const k = SCALE_UNIT * (def.scale ?? 1);
  const wide = def.wide ?? 1;
  const look = def.look ?? {};
  const prep = (img: Img, sx: number, sy: number, lean = 0, fade = 1): Img => {
    const tinted = recolor(img, look);
    const w = Math.max(1, Math.round(img.width * k * wide * sx));
    const h = Math.max(1, Math.round(img.height * k * sy));
    return fadeAlpha(shear(resize(tinted, w, h), lean), fade);
  };
  const id = def.id;
  const idleId = `${id}.idle.0`;
  addFrame(idleId, prep(base.idle, 1, 1), BOTTOM);
  const walkIds = base.run.map((f, i) => {
    const frameId = `${id}.walk.${i}`;
    addFrame(frameId, prep(f, 1, 1), BOTTOM);
    return frameId;
  });
  alias(id, idleId, BOTTOM);
  addAnimation(`${id}.idle`, [idleId], 1);
  addAnimation(`${id}.walk`, walkIds, def.walkFps ?? 10);
  if (def.role === "npc") return;
  const attackIds = [0, 6, 12, 4].map((lean, i) => {
    const frameId = `${id}.attack.${i}`;
    addFrame(frameId, prep(base.idle, 1, 1, lean), BOTTOM);
    return frameId;
  });
  const deathIds = [
    [1, 1, 1],
    [0.85, 1.08, 0.95],
    [0.6, 1.18, 0.8],
    [0.35, 1.25, 0.55],
    [0.12, 1.3, 0.3],
  ].map(([sy, sx, fade], i) => {
    const frameId = `${id}.death.${i}`;
    addFrame(frameId, prep(base.idle, sx!, sy!, 0, fade!), BOTTOM);
    return frameId;
  });
  addAnimation(`${id}.attack`, attackIds, 12, false);
  addAnimation(`${id}.death`, deathIds, 8, false);
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
  addFrame("fx.portal", fxPortal(), BOTTOM);
}

function buildUnits(): void {
  for (const def of UNITS) buildUnit(def);
  // Sentry: a hero-summoned totem, drawn rather than recoloured.
  const idle = ["unit.monster.sentry.idle.0", "unit.monster.sentry.idle.1"];
  addFrame(idle[0]!, sentry(true), BOTTOM);
  addFrame(idle[1]!, sentry(false), BOTTOM);
  alias("unit.monster.sentry", idle[0]!, BOTTOM);
  addAnimation("unit.monster.sentry.idle", idle, 4);
  addAnimation("unit.monster.sentry.walk", idle, 4);
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

const pages = packPages([...frames].map(([name, f]) => ({ name, img: f.img })));
const atlasId = (n: number) => `${PACK}.atlas-${n}`;
const frameAtlas = new Map<string, number>();
const atlasFiles: { png: Buffer; json: string; name: string }[] = [];

pages.forEach((page, n) => {
  const png = blank(page.width, page.height);
  const frameJson: Record<string, unknown> = {};
  for (const p of page.placed) {
    const { img } = p;
    for (let row = 0; row < img.height; row++) {
      const from = row * img.width * 4;
      img.data.copy(png.data, ((p.y + row) * page.width + p.x) * 4, from, from + img.width * 4);
    }
    frameAtlas.set(p.name, n);
    frameJson[p.name] = {
      frame: { x: p.x, y: p.y, w: img.width, h: img.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: img.width, h: img.height },
      sourceSize: { w: img.width, h: img.height },
    };
  }
  const json = {
    frames: frameJson,
    meta: {
      image: `atlas-${n}.png`,
      size: { w: page.width, h: page.height },
      scale: "1",
    },
  };
  atlasFiles.push({
    name: `atlas-${n}`,
    png: PNG.sync.write(png),
    json: `${JSON.stringify(json, null, 2)}\n`,
  });
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
  `${frames.size} frames, ${Object.keys(sprites).length} sprite ids, ${Object.keys(animations).length} animations, ${pages.length} atlas page(s) [${sizes}] -> ${OUT}`,
);

/**
 * Generates the PWA icons (wave-C.md §11) as PNG files with node:zlib only.
 *
 *   node tools/pwa/make-icons.ts
 *
 * Original procedural art: a faceted ember-gold crystal on a dark gradient with a warm glow.
 * No third-party art. The output is deterministic (same bytes on every run), so the PNGs are
 * committed in apps/game/public/icons and regenerating them only diffs when the design changes.
 *
 * Outputs (apps/game/public/icons/):
 *   icon-192.png            manifest, purpose "any"
 *   icon-512.png            manifest, purpose "any"
 *   icon-maskable-512.png   manifest, purpose "maskable" (glyph inside the 80 % safe zone)
 *   apple-touch-icon.png    180, iOS home screen (opaque, no alpha)
 *   favicon-32.png          browser tab
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];

interface IconSpec {
  file: string;
  size: number;
  /** Maskable icons keep the glyph inside the circle of radius 0.8 (80 % of the width). */
  maskable: boolean;
}

const SPECS: readonly IconSpec[] = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
  { file: "apple-touch-icon.png", size: 180, maskable: false },
  { file: "favicon-32.png", size: 32, maskable: false },
];

// Palette: the app shell (#10131a background) with an ember accent (#ffd166 is the app accent).
const BG_TOP: Rgb = [0x26, 0x2e, 0x42];
const BG_BOTTOM: Rgb = [0x0a, 0x0c, 0x12];
const EMBER: Rgb = [0xff, 0x8c, 0x42];
const CROWN_LEFT: Rgb = [0xff, 0xe3, 0x9a];
const CROWN_RIGHT: Rgb = [0xff, 0xc4, 0x6b];
const PAVILION_LEFT: Rgb = [0xff, 0x9d, 0x3a];
const PAVILION_RIGHT: Rgb = [0xd9, 0x58, 0x0f];

/** Gem silhouette in normalised coordinates (-1..1, y down), counter-clockwise on screen. */
const GEM: readonly (readonly [number, number])[] = [
  [-0.36, -0.56],
  [0.36, -0.56],
  [0.62, -0.2],
  [0, 0.7],
  [-0.62, -0.2],
];
const GIRDLE_Y = -0.2;
const SAMPLES = 4;

function mix(a: Rgb, b: Rgb, t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function insideConvex(u: number, v: number, poly: readonly (readonly [number, number])[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b[0] - a[0]) * (v - a[1]) - (b[1] - a[1]) * (u - a[0]);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Colour of one point in normalised coordinates, before anti-aliasing. */
function shade(u: number, v: number, maskable: boolean): [number, number, number] {
  // Background: vertical gradient, then a warm glow behind the gem.
  let c = mix(BG_TOP, BG_BOTTOM, (v + 1) / 2);
  const r = Math.hypot(u, v);
  const glow = Math.max(0, 1 - r / 1.05) ** 2 * 0.42;
  c = mix(c, EMBER, glow);

  const gu = u / (maskable ? 0.9 : 1);
  const gv = v / (maskable ? 0.9 : 1);
  if (insideConvex(gu, gv, GEM)) {
    const left = gu < 0;
    if (gv < GIRDLE_Y) {
      // Crown: the flat table is the lightest facet; the shoulders take the side colours.
      const table = gv < -0.42 ? 0.28 : 0;
      c = mix(left ? CROWN_LEFT : CROWN_RIGHT, [255, 255, 255], table);
    } else {
      // Pavilion: converges to the point at the bottom, darkening with depth.
      const depth = Math.min(1, (gv - GIRDLE_Y) / 0.9);
      c = mix(left ? PAVILION_LEFT : PAVILION_RIGHT, [0x6b, 0x23, 0x06], depth * 0.45);
    }
    // Specular glint in the upper left crown.
    const gl = Math.hypot(gu + 0.26, gv + 0.42);
    if (gl < 0.12) c = mix(c, [255, 255, 255], (1 - gl / 0.12) * 0.75);
  }
  return c;
}

function renderRgb(size: number, maskable: boolean): Buffer {
  const rowBytes = size * 3 + 1;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < SAMPLES; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          const px = x + (i + 0.5) / SAMPLES;
          const py = y + (j + 0.5) / SAMPLES;
          const u = (px / size) * 2 - 1;
          const v = (py / size) * 2 - 1;
          const [sr, sg, sb] = shade(u, v, maskable);
          r += sr;
          g += sg;
          b += sb;
        }
      }
      const n = SAMPLES * SAMPLES;
      const o = y * rowBytes + 1 + x * 3;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
    }
  }
  return encodePng(size, size, raw);
}

// ---- PNG encoding (RGB, 8 bit, no interlace) ------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(width: number, height: number, rawScanlines: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rawScanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- main -----------------------------------------------------------------------------------

const outDir = resolve(import.meta.dirname, "../../apps/game/public/icons");
mkdirSync(outDir, { recursive: true });
for (const spec of SPECS) {
  const bytes = renderRgb(spec.size, spec.maskable);
  writeFileSync(join(outDir, spec.file), bytes);
  console.log(`${spec.file}\t${spec.size}px\t${bytes.length} bytes`);
}

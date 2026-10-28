/**
 * Builds the Kenney starter art: packs the PNGs in src-art/ into one atlas and
 * writes the asset manifest. Run with `node scripts/build.ts` (or `pnpm build-art`).
 *
 * Output goes to apps/game/public/art/kenney/: atlas.png, atlas.json (TexturePacker
 * hash format) and manifest.json (AssetManifest). Every source is scaled by the
 * same factor, so the 132px-wide Kenney ground diamond becomes a 64x32 tile and
 * units and props keep their size relative to it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { AssetManifest } from "@gamez/assets";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src-art");
const OUT = join(here, "..", "..", "..", "apps", "game", "public", "art", "kenney");

const ATLAS_MAX = 2048;
const ATLAS_SHELF = 512;
const PAD = 1;
/** Kenney's isometric ground diamonds are 132px wide; we want a 64px-wide footprint. */
const SCALE = 64 / 132;
const ANCHOR_BOTTOM = { x: 0.5, y: 1 };
const ANCHOR_TOP = { x: 0.5, y: 0 };

type Img = InstanceType<typeof PNG>;

function blank(width: number, height: number): Img {
  return new PNG({ width, height });
}

function load(file: string): Img {
  return PNG.sync.read(readFileSync(join(SRC, file)));
}

function crop(src: Img, x: number, y: number, w: number, h: number): Img {
  const out = blank(w, h);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * src.width + x) * 4;
    src.data.copy(out.data, row * w * 4, from, from + w * 4);
  }
  return out;
}

/** Smallest box that holds every pixel with alpha > 0. */
function alphaBox(img: Img): { x: number; y: number; w: number; h: number } {
  let x0 = img.width,
    y0 = img.height,
    x1 = -1,
    y1 = -1;
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

function union(boxes: { x: number; y: number; w: number; h: number }[]) {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Area-averaged downscale; colour is weighted by alpha so edges do not darken. */
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
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
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

/**
 * Kenney ground blocks have a dirt side under the grass top. Keep only the top
 * diamond (top corner at y=0), then scale it to the 64px footprint.
 */
function groundTile(file: string): Img {
  const img = load(file);
  const h = Math.round(img.width / 2);
  const top = crop(img, 0, 0, img.width, h);
  const hw = img.width / 2;
  const hh = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < img.width; x++) {
      const dx = Math.abs(x + 0.5 - hw) / hw;
      const dy = Math.abs(y + 0.5 - hh) / hh;
      if (dx + dy > 1) top.data[(y * img.width + x) * 4 + 3] = 0;
    }
  }
  return resize(top, Math.round(64), Math.round(h * SCALE));
}

function scaled(img: Img): Img {
  return resize(img, Math.round(img.width * SCALE), Math.round(img.height * SCALE));
}

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

interface Packed {
  name: string;
  img: Img;
  x: number;
  y: number;
}

/** Shelf packer: rows of equal height, left to right, wrapping at ATLAS_SHELF. */
function pack(items: { name: string; img: Img }[]): {
  packed: Packed[];
  width: number;
  height: number;
} {
  const sorted = [...items].sort((a, b) => b.img.height - a.img.height);
  const packed: Packed[] = [];
  let x = 0,
    y = 0,
    rowH = 0,
    maxX = 0;
  for (const it of sorted) {
    if (x + it.img.width > ATLAS_SHELF && x > 0) {
      x = 0;
      y += rowH + PAD;
      rowH = 0;
    }
    packed.push({ name: it.name, img: it.img, x, y });
    x += it.img.width + PAD;
    rowH = Math.max(rowH, it.img.height);
    maxX = Math.max(maxX, x - PAD);
  }
  const width = maxX;
  const height = y + rowH;
  if (width > ATLAS_MAX || height > ATLAS_MAX)
    throw new Error(`atlas ${width}x${height} exceeds ${ATLAS_MAX}`);
  return { packed, width, height };
}

// Sources. Each entry is the frame name in the atlas, which is also the sprite id.
const heroIdle = ["hero-idle-0.png"];
const heroWalk = Array.from({ length: 10 }, (_, i) => `hero-walk-${i}.png`);
const heroSources = [...heroIdle, ...heroWalk].map(load);
const heroBox = union(heroSources.map(alphaBox));
const heroFrame = (file: string) =>
  scaled(crop(load(file), heroBox.x, heroBox.y, heroBox.w, heroBox.h));

const treeImg = load("tree-default-sw.png");
const treeBox = alphaBox(treeImg);

const images: { name: string; img: Img }[] = [
  { name: "tile.grass", img: groundTile("grass-block.png") },
  { name: "tile.stone", img: groundTile("stone-plaza.png") },
  { name: "prop.tree", img: scaled(crop(treeImg, treeBox.x, treeBox.y, treeBox.w, treeBox.h)) },
  { name: "missing", img: missingTile() },
  ...heroIdle.map((file, i) => ({ name: `unit.hero.idle.${i}`, img: heroFrame(file) })),
  ...heroWalk.map((file, i) => ({ name: `unit.hero.walk.${i}`, img: heroFrame(file) })),
];

const { packed, width, height } = pack(images);
const atlasPng = blank(width, height);
const frames: Record<string, unknown> = {};
for (const p of packed) {
  for (let row = 0; row < p.img.height; row++) {
    const from = row * p.img.width * 4;
    p.img.data.copy(atlasPng.data, ((p.y + row) * width + p.x) * 4, from, from + p.img.width * 4);
  }
  frames[p.name] = {
    frame: { x: p.x, y: p.y, w: p.img.width, h: p.img.height },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: p.img.width, h: p.img.height },
    sourceSize: { w: p.img.width, h: p.img.height },
  };
}

const sprite = (frame: string, anchor: { x: number; y: number }) => ({
  atlas: "art.kenney.atlas",
  frame,
  anchor,
});

const heroIdleIds = heroIdle.map((_, i) => `unit.hero.idle.${i}`);
const heroWalkIds = heroWalk.map((_, i) => `unit.hero.walk.${i}`);

const manifest: AssetManifest = {
  version: "1.0.0",
  pack: "art.kenney",
  atlases: [{ id: "art.kenney.atlas", url: "atlas.json" }],
  sprites: {
    "tile.grass": sprite("tile.grass", ANCHOR_TOP),
    "tile.stone": sprite("tile.stone", ANCHOR_TOP),
    "prop.tree": sprite("prop.tree", ANCHOR_BOTTOM),
    missing: sprite("missing", ANCHOR_BOTTOM),
    ...Object.fromEntries(
      [...heroIdleIds, ...heroWalkIds].map((id) => [id, sprite(id, ANCHOR_BOTTOM)]),
    ),
  },
  animations: {
    "unit.hero.idle": { frames: heroIdleIds, fps: 1, loop: true },
    "unit.hero.walk": { frames: heroWalkIds, fps: 12, loop: true },
  },
  licenses: [
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
      source: "Isometric Miniature Dungeon (Kenney)",
      license: "CC0-1.0",
      url: "https://kenney.nl/assets/isometric-miniature-dungeon",
      author: "Kenney",
    },
  ],
};

const atlasJson = {
  frames,
  meta: { image: "atlas.png", size: { w: width, h: height }, scale: "1" },
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "atlas.png"), PNG.sync.write(atlasPng));
writeFileSync(join(OUT, "atlas.json"), `${JSON.stringify(atlasJson, null, 2)}\n`);
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`atlas ${width}x${height}, ${packed.length} frames -> ${OUT}`);

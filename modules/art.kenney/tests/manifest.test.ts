import { existsSync, readFileSync, readdirSync } from "node:fs";
import { PNG } from "pngjs";
import type { AssetManifest } from "@gamez/assets";
import { resolveId } from "@gamez/assets";
import { describe, expect, it } from "vite-plus/test";
import { KENNEY_MANIFEST_URL } from "../src/index.ts";

const dir = new URL("../../../apps/game/public/art/kenney/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

const manifest: AssetManifest = read("manifest.json");
const atlases = new Map<
  string,
  {
    frames: Record<
      string,
      {
        frame: { x: number; y: number; w: number; h: number };
        trimmed: boolean;
        spriteSourceSize: { x: number; y: number; w: number; h: number };
        sourceSize: { w: number; h: number };
      }
    >;
    meta: { size: { w: number; h: number }; image: string };
  }
>(manifest.atlases.map((a) => [a.id, read(a.url)]));

const ground = ["tile.grass", "tile.grass.dark", "tile.dirt", "tile.stone", "tile.void"];
const floors = ["crypt", "cave", "forge", "abyss"].flatMap((t) =>
  [1, 2, 3].map((i) => `tile.${t}.floor.${i}`),
);
const walls = ["wall.crypt", "wall.cave", "wall.forge", "wall.abyss", "wall.dungeon"];
const props = [
  "prop.door",
  "prop.stairs.down",
  "prop.stairs.up",
  "prop.waypoint",
  "prop.stash",
  "prop.barrel",
  "prop.crate",
  "prop.pillar",
  "prop.bones",
  "prop.torch",
  "prop.brazier",
  "prop.house",
  "prop.house.large",
  "prop.well",
  "prop.fence",
  "prop.tree",
  "prop.tree.pine",
  "prop.rock",
  "prop.cart",
  "prop.tent",
  "prop.statue",
];
const heroes = ["unit.hero", "unit.hero.warrior", "unit.hero.rogue", "unit.hero.sorcerer"];
const npcs = [
  "unit.npc.healer",
  "unit.npc.smith",
  "unit.npc.alchemist",
  "unit.npc.junk",
  "unit.npc.quest",
];
const monsters = [
  "husk",
  "gnawling",
  "bonefletcher",
  "ash_seer",
  "blightbloat",
  "bristleback",
  "cairn_brute",
  "webskitter",
  "hollow_cantor",
  "cinder_imp",
  "rime_wraith",
  "sentry",
  "boss_warden",
  "boss_tunnel_mother",
  "boss_ninth_flame",
  "boss_hollow_king",
].map((m) => `unit.monster.${m}`);
const loot = [
  "loot.gold",
  "loot.potion.life",
  "loot.potion.mana",
  "loot.potion.rejuv",
  "loot.potion.rejuv.3",
  ...[1, 2, 3, 4].flatMap((t) => [`loot.potion.life.${t}`, `loot.potion.mana.${t}`]),
  ...[
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
  ].map((k) => `loot.item.${k}`),
];
const fx = [
  "fx.arrow",
  "fx.ember_bolt",
  "fx.cinder_orb",
  "fx.frostbolt",
  "fx.firebolt",
  "fx.shadebolt",
  "fx.spark",
  "fx.venom",
  "fx.portal",
  "fx.volley",
];
const facings = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const fighterActions = ["idle", "walk", "attack", "cast", "hit", "death"];
const stepsIds = [
  "prop.stairs",
  "unit.monster.gloomcap",
  "unit.monster.cinderpup",
  "unit.monster.lanternmoth",
];
const fighters = [...heroes, ...monsters, ...stepsIds.filter((id) => id.startsWith("unit."))];
const units = [...fighters, ...npcs];
/** Atlas frame record behind a sprite id. */
const frameOf = (id: string) => {
  const ref = manifest.sprites[id]!;
  return atlases.get(ref.atlas)!.frames[ref.frame]!;
};
const section14 = [
  ...ground,
  ...floors,
  ...walls,
  ...props,
  ...heroes,
  ...npcs,
  ...monsters,
  ...loot,
  ...fx,
  ...stepsIds,
  "tile.dungeon.floor",
];

describe("art.kenney manifest", () => {
  it("is served at the exported URL", () => {
    expect(KENNEY_MANIFEST_URL).toBe("/art/kenney/manifest.json");
  });

  it("lists atlas pages and removes the single-page output", () => {
    expect(manifest.atlases.length).toBeGreaterThan(0);
    expect(manifest.atlases.map((a) => a.url)).toEqual(
      manifest.atlases.map((_, n) => `atlas-${n}.json`),
    );
    expect(existsSync(new URL("atlas.json", dir))).toBe(false);
    const files = readdirSync(dir);
    for (const a of manifest.atlases) {
      expect(files, a.url).toContain(a.url);
      expect(files, atlases.get(a.id)!.meta.image).toContain(atlases.get(a.id)!.meta.image);
    }
  });

  it("stays within the atlas budget: at most 4 pages", () => {
    expect(manifest.atlases.length).toBeLessThanOrEqual(4);
  });

  it("keeps every atlas page within 2048x2048", () => {
    for (const [id, atlas] of atlases) {
      const { w, h } = atlas.meta.size;
      expect(w, `${id} width`).toBeLessThanOrEqual(2048);
      expect(h, `${id} height`).toBeLessThanOrEqual(2048);
    }
  });

  it("has every sprite frame in its atlas", () => {
    for (const [id, ref] of Object.entries(manifest.sprites)) {
      const atlas = atlases.get(ref.atlas);
      expect(atlas, `sprite ${id} atlas ${ref.atlas}`).toBeDefined();
      expect(atlas!.frames, `sprite ${id}`).toHaveProperty([ref.frame]);
    }
  });

  it("references known sprite ids from every animation", () => {
    for (const [id, anim] of Object.entries(manifest.animations)) {
      expect(anim.frames.length, `animation ${id}`).toBeGreaterThan(0);
      for (const frame of anim.frames) {
        expect(manifest.sprites, `animation ${id} frame ${frame}`).toHaveProperty([frame]);
      }
    }
  });

  it("resolves every section 14 id to a sprite or animation, not missing", () => {
    const table = { ...manifest.sprites, ...manifest.animations };
    for (const id of section14) {
      expect(resolveId(table, id), id).toBe(id);
    }
    expect(manifest.sprites).toHaveProperty(["missing"]);
  });

  it("has idle and walk animations for every unit family", () => {
    for (const id of [...heroes, ...npcs, ...monsters]) {
      expect(manifest.animations, `${id}.idle`).toHaveProperty([`${id}.idle`]);
      expect(manifest.animations, `${id}.walk`).toHaveProperty([`${id}.walk`]);
    }
    for (const id of [...heroes.slice(1), ...monsters.filter((m) => !m.endsWith("sentry"))]) {
      expect(manifest.animations, `${id}.attack`).toHaveProperty([`${id}.attack`]);
      expect(manifest.animations, `${id}.death`).toHaveProperty([`${id}.death`]);
    }
  });

  it("has every action for every fighter, and the unsuffixed clip is the south one", () => {
    for (const id of fighters) {
      for (const action of fighterActions) {
        const anim = manifest.animations[`${id}.${action}`];
        expect(anim, `${id}.${action}`).toBeDefined();
        expect(anim!.frames, `${id}.${action}`).toEqual(
          manifest.animations[`${id}.${action}.s`]!.frames,
        );
      }
    }
  });

  it("has idle and walk for all 8 facings of every unit, and fighter actions per facing", () => {
    for (const id of units) {
      for (const f of facings) {
        expect(manifest.animations, `${id}.idle.${f}`).toHaveProperty([`${id}.idle.${f}`]);
        expect(manifest.animations, `${id}.walk.${f}`).toHaveProperty([`${id}.walk.${f}`]);
      }
    }
    for (const id of fighters) {
      for (const f of facings) {
        for (const action of fighterActions) {
          expect(manifest.animations, `${id}.${action}.${f}`).toHaveProperty([
            `${id}.${action}.${f}`,
          ]);
        }
      }
    }
  });

  it("draws each facing differently", () => {
    for (const id of units.filter((u) => !u.endsWith("sentry"))) {
      const seen = new Set(
        facings.map((f) => {
          const fr = frameOf(manifest.animations[`${id}.idle.${f}`]!.frames[0]!).frame;
          return `${fr.x},${fr.y}`;
        }),
      );
      expect(seen.size, id).toBe(8);
    }
  });

  it("breathes when idle and plays one-shot clips once", () => {
    for (const id of units) {
      expect(manifest.animations[`${id}.idle`]!.frames.length, id).toBeGreaterThanOrEqual(2);
      expect(manifest.animations[`${id}.idle`]!.loop, id).not.toBe(false);
    }
    for (const id of fighters) {
      for (const action of ["attack", "cast", "hit", "death"]) {
        const anim = manifest.animations[`${id}.${action}`]!;
        expect(anim.loop, `${id}.${action}`).toBe(false);
        expect(anim.frames.length, `${id}.${action}`).toBeGreaterThanOrEqual(2);
      }
      // Attack is 4 frames with the impact on frame index 2 (the renderer syncs it to the cast).
      expect(manifest.animations[`${id}.attack`]!.frames, id).toHaveLength(4);
    }
  });

  it("keeps every frame of a unit on one source box and anchor, so clips line up", () => {
    for (const id of units) {
      const ids = Object.entries(manifest.animations)
        // `unit.hero.` also prefixes `unit.hero.warrior.*`: keep only `<id>.<action>[.<facing>]`.
        .filter(
          ([key]) =>
            key.startsWith(`${id}.`) &&
            fighterActions.includes(key.slice(id.length + 1).split(".")[0]!),
        )
        .flatMap(([, a]) => a.frames);
      const boxes = new Set(
        ids.map((f) => {
          const fr = frameOf(f);
          const a = manifest.sprites[f]!.anchor;
          return `${fr.sourceSize.w}x${fr.sourceSize.h}@${a?.x},${a?.y}`;
        }),
      );
      expect(boxes.size, id).toBe(1);
      for (const f of ids) {
        const fr = frameOf(f);
        expect(fr.spriteSourceSize.x + fr.frame.w, f).toBeLessThanOrEqual(fr.sourceSize.w);
        expect(fr.spriteSourceSize.y + fr.frame.h, f).toBeLessThanOrEqual(fr.sourceSize.h);
        expect(Math.min(fr.spriteSourceSize.x, fr.spriteSourceSize.y), f).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("ends death on a readable corpse, not a faded blob", () => {
    const pngs = new Map<string, InstanceType<typeof PNG>>();
    const page = (atlas: string) => {
      let png = pngs.get(atlas);
      if (!png) {
        png = PNG.sync.read(readFileSync(new URL(atlases.get(atlas)!.meta.image, dir)));
        pngs.set(atlas, png);
      }
      return png;
    };
    for (const id of fighters) {
      const frames = manifest.animations[`${id}.death`]!.frames;
      const last = frames[frames.length - 1]!;
      const ref = manifest.sprites[last]!;
      const png = page(ref.atlas);
      const { x, y, w, h } = frameOf(last).frame;
      let solid = 0;
      let maxA = 0;
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const a = png.data[(yy * png.width + xx) * 4 + 3]!;
          maxA = Math.max(maxA, a);
          if (a >= 150) solid++;
        }
      }
      expect(maxA, `${last} alpha`).toBeGreaterThanOrEqual(0.6 * 255);
      expect(solid, `${last} solid pixels`).toBeGreaterThan(40);
    }
  });

  it("draws four potion tiers per colour, and the untiered ids stay as fallbacks", () => {
    for (const colour of ["life", "mana"]) {
      expect(manifest.sprites, `loot.potion.${colour}`).toHaveProperty([`loot.potion.${colour}`]);
      const sizes = [1, 2, 3, 4].map((t) => {
        const id = `loot.potion.${colour}.${t}`;
        expect(manifest.sprites, id).toHaveProperty([id]);
        const { w, h } = frameOf(id).frame;
        return `${w}x${h}`;
      });
      // Each tier is a different size, so the tiers never read as one sprite.
      expect(new Set(sizes).size, `${colour} tiers ${sizes.join(",")}`).toBe(4);
    }
  });

  it("makes the smallest families tall enough to read at 1x", () => {
    // Trimmed idle frames: the drawn quadruped and spider replace the small Kenney figure.
    for (const id of ["unit.monster.gnawling", "unit.monster.webskitter"]) {
      const frame = frameOf(`${id}.idle.s.0`).frame;
      expect(frame.h, `${id} idle height`).toBeGreaterThanOrEqual(28);
    }
  });

  it("keeps small corpses a readable footprint", () => {
    for (const id of [
      "unit.monster.gnawling",
      "unit.monster.webskitter",
      "unit.monster.cinder_imp",
    ]) {
      const last = manifest.animations[`${id}.death`]!.frames.at(-1)!;
      const { w, h } = frameOf(last).frame;
      expect(Math.max(w, h), `${id} corpse footprint ${w}x${h}`).toBeGreaterThanOrEqual(20);
    }
  });

  it("keeps the ground diamonds at the 64x32 footprint", () => {
    const tileIds = Object.keys(manifest.sprites).filter((id) => id.startsWith("tile."));
    expect(tileIds.length).toBeGreaterThanOrEqual(ground.length + floors.length);
    for (const id of tileIds) {
      const ref = manifest.sprites[id]!;
      const { w, h } = atlases.get(ref.atlas)!.frames[ref.frame]!.frame;
      expect([w, h], id).toEqual([64, 32]);
    }
  });

  it("lists a licence for every source, with Kenney credited where used", () => {
    expect(manifest.licenses.length).toBeGreaterThan(0);
    for (const lic of manifest.licenses) {
      expect(lic.license, lic.source).toBe("CC0-1.0");
      if (lic.source.includes("Kenney")) expect(lic.author, lic.source).toBe("Kenney");
    }
    for (const pack of [
      "Isometric Miniature Dungeon",
      "Isometric Landscape",
      "Nature Kit",
      "City Kit Suburban",
    ]) {
      expect(manifest.licenses.map((l) => l.source).join("|"), pack).toContain(pack);
    }
  });
});

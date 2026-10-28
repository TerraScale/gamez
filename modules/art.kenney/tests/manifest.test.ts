import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    frames: Record<string, { frame: { w: number; h: number } }>;
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
];
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

  it("keeps the existing hero animations", () => {
    expect(manifest.animations).toHaveProperty(["unit.hero.idle"]);
    expect(manifest.animations).toHaveProperty(["unit.hero.walk"]);
    expect(manifest.animations["unit.hero.walk"]!.frames).toHaveLength(10);
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

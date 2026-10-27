import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { AssetManifest } from "@gamez/assets";
import { KENNEY_MANIFEST_URL } from "../src/index.ts";

const dir = new URL("../../../apps/game/public/art/kenney/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

const manifest: AssetManifest = read("manifest.json");
const atlas = read("atlas.json");

describe("art.kenney manifest", () => {
  it("is served at the exported URL", () => {
    expect(KENNEY_MANIFEST_URL).toBe("/art/kenney/manifest.json");
  });

  it("has every sprite frame in atlas.json", () => {
    for (const [id, ref] of Object.entries(manifest.sprites)) {
      expect(atlas.frames, `sprite ${id}`).toHaveProperty([ref.frame]);
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

  it("contains the required ids", () => {
    for (const id of ["tile.grass", "tile.stone", "prop.tree", "missing"]) {
      expect(manifest.sprites, id).toHaveProperty([id]);
    }
    for (const anim of ["unit.hero.idle", "unit.hero.walk"]) {
      expect(manifest.animations, anim).toHaveProperty([anim]);
    }
  });

  it("points at an atlas that fits 2048x2048", () => {
    const { w, h } = atlas.meta.size;
    expect(w).toBeLessThanOrEqual(2048);
    expect(h).toBeLessThanOrEqual(2048);
    expect(manifest.atlases.map((a) => a.url)).toEqual(["atlas.json"]);
    expect(atlas.meta.image).toBe("atlas.png");
  });

  it("keeps the ground diamonds at the 64x32 footprint", () => {
    for (const id of ["tile.grass", "tile.stone"]) {
      const { w, h } = atlas.frames[manifest.sprites[id]!.frame]!.frame;
      expect([w, h], id).toEqual([64, 32]);
    }
  });

  it("lists a non-empty licence for every source", () => {
    expect(manifest.licenses.length).toBeGreaterThan(0);
    for (const lic of manifest.licenses) {
      expect(lic.license, lic.source).toBe("CC0-1.0");
      expect(lic.author, lic.source).toBe("Kenney");
    }
  });
});

import { readFileSync } from "node:fs";
import type { AssetManifest } from "@gamez/assets";
import { townMap } from "@gamez/classic.town";
import { describe, expect, it } from "vite-plus/test";

const manifest = JSON.parse(
  readFileSync(new URL("../../public/art/kenney/manifest.json", import.meta.url), "utf8"),
) as AssetManifest;

describe("art pack <-> town map", () => {
  it("has a sprite for every id the town uses", () => {
    const ids = new Set([...townMap.ground, ...townMap.objects].filter((id) => id !== null));
    for (const id of ids) expect(manifest.sprites, id).toHaveProperty([id]);
  });

  it("has idle and walk animations for the hero the server assigns", () => {
    expect(manifest.animations).toHaveProperty(["unit.hero.idle"]);
    expect(manifest.animations).toHaveProperty(["unit.hero.walk"]);
  });
});

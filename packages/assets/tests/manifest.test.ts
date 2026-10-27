import { describe, expect, it } from "vite-plus/test";
import { mergeManifests, resolveId, type AssetManifest } from "../src/index.ts";

function pack(id: string, sprites: Record<string, string>, atlasUrl = `${id}.json`): AssetManifest {
  return {
    version: "1",
    pack: id,
    atlases: [{ id: `${id}.atlas`, url: atlasUrl }],
    sprites: Object.fromEntries(
      Object.entries(sprites).map(([k, frame]) => [k, { atlas: `${id}.atlas`, frame }]),
    ),
    animations: {},
    licenses: [{ source: id, license: "CC0-1.0" }],
  };
}

describe("resolveId", () => {
  const table = { "unit.hero.walk": 1, "unit.hero": 1, missing: 1 };

  it("returns an exact match", () => {
    expect(resolveId(table, "unit.hero.walk")).toBe("unit.hero.walk");
  });

  it("drops trailing segments until something matches", () => {
    expect(resolveId(table, "unit.hero.walk.ne")).toBe("unit.hero.walk");
    expect(resolveId(table, "unit.hero.idle.sw")).toBe("unit.hero");
  });

  it("falls back to the missing id", () => {
    expect(resolveId(table, "prop.rock")).toBe("missing");
    expect(resolveId({}, "prop.rock", "none")).toBe("none");
  });
});

describe("mergeManifests", () => {
  it("lets later packs override sprite ids and keeps the rest", () => {
    const base = pack("base", { "tile.grass": "g", "prop.tree": "t" });
    const skin = pack("skin", { "prop.tree": "t2" });
    const out = mergeManifests(base, skin);
    expect(out.sprites["tile.grass"]).toEqual({ atlas: "base.atlas", frame: "g" });
    expect(out.sprites["prop.tree"]).toEqual({ atlas: "skin.atlas", frame: "t2" });
    expect(out.atlases.map((a) => a.id)).toEqual(["base.atlas", "skin.atlas"]);
    expect(out.licenses.map((l) => l.source)).toEqual(["base", "skin"]);
    expect(out.pack).toBe("base+skin");
  });

  it("lets a later pack replace an atlas with the same id", () => {
    const out = mergeManifests(pack("a", {}, "old.json"), pack("a", {}, "new.json"));
    expect(out.atlases).toEqual([{ id: "a.atlas", url: "new.json" }]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { createRegistry, loadMode, stableHash } from "../src/index.ts";
import { mod, modeOf } from "./fixtures.ts";

describe("registry", () => {
  it("defines, gets and lists sorted by id", () => {
    const reg = createRegistry();
    reg.define("item", "sword", { dmg: 3 });
    reg.define("item", "axe", { dmg: 4 });
    reg.define("item", "bow", { dmg: 2 });
    expect(reg.has("item", "axe")).toBe(true);
    expect(reg.has("item", "nope")).toBe(false);
    expect(reg.get("item", "sword")).toEqual({ dmg: 3 });
    expect(reg.all("item").map(([id]) => id)).toEqual(["axe", "bow", "sword"]);
    expect(reg.all("spell")).toEqual([]);
  });

  it("rejects duplicate defines and patches of missing prototypes", () => {
    const reg = createRegistry();
    reg.define("item", "sword", { dmg: 3 });
    expect(() => reg.define("item", "sword", { dmg: 9 })).toThrow(/already defined/);
    expect(() => reg.patch("item", "shield", () => {})).toThrow(/not defined/);
  });

  it("patches by mutation or replacement, and removes", () => {
    const reg = createRegistry();
    reg.define("item", "sword", { dmg: 3, tags: ["melee"] });
    reg.patch<{ dmg: number; tags: string[] }>("item", "sword", (p) => {
      p.dmg = 5;
      p.tags.push("sharp");
    });
    expect(reg.get("item", "sword")).toEqual({ dmg: 5, tags: ["melee", "sharp"] });
    reg.patch("item", "sword", () => ({ dmg: 1 }));
    expect(reg.get("item", "sword")).toEqual({ dmg: 1 });
    reg.remove("item", "sword");
    reg.remove("item", "sword");
    expect(reg.has("item", "sword")).toBe(false);
    reg.define("item", "sword", { dmg: 7 });
    expect(reg.get("item", "sword")).toEqual({ dmg: 7 });
  });

  it("copies prototypes so callers cannot alias them", () => {
    const reg = createRegistry();
    const proto = { dmg: 3 };
    reg.define("item", "sword", proto);
    proto.dmg = 99;
    expect(reg.get("item", "sword")).toEqual({ dmg: 3 });
  });

  it("rejects non-JSON prototypes", () => {
    const reg = createRegistry();
    expect(() => reg.define("item", "f", { fn: () => 1 })).toThrow(/Not plain JSON/);
    expect(() => reg.define("item", "m", { m: new Map() })).toThrow(/Map/);
    expect(() => reg.define("item", "n", { n: Number.NaN })).toThrow(/NaN/);
  });

  it("freezes deeply, exposes require() and rejects writes afterwards", () => {
    const reg = createRegistry();
    reg.define("item", "sword", { dmg: 3, tags: ["melee"] });
    reg.define("spell", "spark", { mana: 1 });
    const frozen = reg.freeze();
    const sword = frozen.require<{ dmg: number; tags: string[] }>("item", "sword");
    expect(Object.isFrozen(sword)).toBe(true);
    expect(Object.isFrozen(sword.tags)).toBe(true);
    expect(() => {
      (sword as { dmg: number }).dmg = 1;
    }).toThrow(TypeError);
    expect(Object.isFrozen(frozen.all("item"))).toBe(true);
    expect(frozen.kinds()).toEqual(["item", "spell"]);
    expect(() => frozen.require("item", "axe")).toThrow(/missing item "axe"/);
    expect(() => frozen.require("loot", "x")).toThrow(/no "loot" prototypes/);
    expect(() => reg.define("item", "axe", {})).toThrow(/after freeze/);
    expect(() => reg.patch("item", "sword", () => {})).toThrow(/after freeze/);
  });

  it("hashes independently of definition and key order", () => {
    const a = createRegistry();
    a.define("item", "sword", { dmg: 3, name: "Sword" });
    a.define("item", "axe", { dmg: 4 });
    const b = createRegistry();
    b.define("item", "axe", { dmg: 4 });
    b.define("item", "sword", { name: "Sword", dmg: 3 });
    const c = createRegistry();
    c.define("item", "axe", { dmg: 5 });
    c.define("item", "sword", { name: "Sword", dmg: 3 });
    const ha = a.freeze().hash;
    expect(ha).toMatch(/^[0-9a-f]{16}$/);
    expect(b.freeze().hash).toBe(ha);
    expect(c.freeze().hash).not.toBe(ha);
  });

  it("runs data stages per stage across all modules in load order", () => {
    const log: string[] = [];
    const stages = (id: string) =>
      mod(id, {
        data: (reg) => {
          log.push(`${id}:data`);
          reg.define("item", id, { by: [id] });
        },
        dataUpdates: (reg) => {
          log.push(`${id}:updates`);
          // b patches a's item; a's update sees b's data already defined.
          const other = id === "t.a" ? "t.b" : "t.a";
          reg.patch<{ by: string[] }>("item", other, (p) => {
            p.by.push(`${id}@updates`);
          });
        },
        dataFinal: (reg) => {
          log.push(`${id}:final`);
          if (id === "t.b") reg.remove("item", "t.a");
        },
      });
    const loaded = loadMode(modeOf(["t.*"]), [stages("t.b"), stages("t.a")]);
    expect(log).toEqual([
      "t.a:data",
      "t.b:data",
      "t.a:updates",
      "t.b:updates",
      "t.a:final",
      "t.b:final",
    ]);
    expect(loaded.registry.has("item", "t.a")).toBe(false);
    expect(loaded.registry.get("item", "t.b")).toEqual({ by: ["t.b", "t.a@updates"] });
  });

  it("names the module that failed in a data stage", () => {
    const a = mod("t.a", { data: (reg) => reg.define("item", "x", {}) });
    const b = mod("t.b", { data: (reg) => reg.define("item", "x", {}) });
    expect(() => loadMode(modeOf(["t.*"]), [a, b])).toThrow(
      /Module "t.b" failed in data: .*already defined by module "t.a"/,
    );
  });
});

describe("stableHash", () => {
  it("is key-order independent, order sensitive for arrays and strict about JSON", () => {
    expect(stableHash({ a: 1, b: [1, 2] })).toBe(stableHash({ b: [1, 2], a: 1 }));
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
    expect(stableHash("1")).not.toBe(stableHash(1));
    expect(() => stableHash({ a: undefined })).toThrow(/undefined/);
    expect(() => stableHash(() => 1)).toThrow(/function/);
    expect(() => stableHash(Number.POSITIVE_INFINITY)).toThrow(/Infinity/);
    expect(() => stableHash(new Set())).toThrow(/Set/);
    expect(() => stableHash(new (class Foo {})())).toThrow(/Foo/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableHash(cyclic)).toThrow(/circular/);
  });

  it("is pinned so changes to the hash function are deliberate", () => {
    expect(stableHash({ a: 1, b: "x" })).toBe(PINNED_HASH);
  });
});

const PINNED_HASH = "2375b4fd987cfe90";

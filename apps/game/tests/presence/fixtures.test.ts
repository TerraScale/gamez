import type { EntityState } from "@gamez/protocol";
import { binaryCodec, jsonCodec } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import type { SqlStore } from "../../src/server/contracts.ts";
import {
  FixtureError,
  FixtureStore,
  MAX_FIXTURES_PER_GROUP,
  validateFixtures,
} from "../../src/server/presence/fixtures.ts";
import { shopFixtureId } from "../../src/shared/plots.ts";
import { PRESENCE_WORLDS } from "../../src/shared/worlds.ts";
import { FakeSqlStorage } from "../support/fake-sql.ts";

const town = PRESENCE_WORLDS["classic-town"]!;

function storeOf(fake: FakeSqlStorage): SqlStore {
  return { sql: fake.asSql(), transactionSync: (fn) => fake.transactionSync(fn) };
}

function keeper(plot: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: shopFixtureId(plot),
    kind: "shopkeeper",
    name: `Shop ${plot}`,
    appearance: "unit.hero.merchant",
    pos: { x: 50, y: 30 },
    path: [],
    pathStartedAt: 123,
    speed: 0,
    tag: "Ann · Open",
    ...over,
  };
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof FixtureError ? err.code : `other: ${String(err)}`;
  }
}

describe("validateFixtures", () => {
  it("accepts shopkeepers with group ids and normalises them to standing still", () => {
    const [f] = validateFixtures(
      "shops",
      [keeper("p1", { path: [{ x: 1, y: 1 }], speed: 4 })],
      town,
    );
    expect(f).toEqual({
      id: "shops:p1",
      kind: "shopkeeper",
      name: "Shop p1",
      appearance: "unit.hero.merchant",
      pos: { x: 50, y: 30 },
      path: [],
      pathStartedAt: 0,
      speed: 0,
      tag: "Ann · Open",
    });
  });

  it("rejects bad groups, ids, kinds, positions, duplicates and oversize sets", () => {
    expect(codeOf(() => validateFixtures("Shops", [], town))).toBe("bad-group");
    expect(codeOf(() => validateFixtures("", [], town))).toBe("bad-group");
    expect(codeOf(() => validateFixtures(7, [], town))).toBe("bad-group");
    expect(codeOf(() => validateFixtures("shops", "nope", town))).toBe("bad-fixtures");
    expect(codeOf(() => validateFixtures("shops", [null], town))).toBe("bad-fixtures");
    expect(codeOf(() => validateFixtures("shops", [keeper("p1", { id: "p1" })], town))).toBe(
      "bad-id",
    );
    expect(codeOf(() => validateFixtures("shops", [keeper("p1", { id: "shops:" })], town))).toBe(
      "bad-id",
    );
    expect(codeOf(() => validateFixtures("shops", [keeper("p1", { id: "shops:p 1" })], town))).toBe(
      "bad-id",
    );
    expect(codeOf(() => validateFixtures("shops", [keeper("p1", { id: "other:p1" })], town))).toBe(
      "bad-id",
    );
    expect(codeOf(() => validateFixtures("shops", [keeper("p1"), keeper("p1")], town))).toBe(
      "duplicate-id",
    );
    for (const kind of ["player", "ghost", "dragon", undefined]) {
      expect(codeOf(() => validateFixtures("shops", [keeper("p1", { kind })], town))).toBe(
        "bad-kind",
      );
    }
    for (const pos of [
      { x: -1, y: 0 },
      { x: 72, y: 0 },
      { x: 0, y: 72 },
      { x: 1.5, y: 2 },
      { x: "1", y: 2 },
      null,
    ]) {
      expect(codeOf(() => validateFixtures("shops", [keeper("p1", { pos })], town))).toBe(
        "out-of-bounds",
      );
    }
    const many = Array.from({ length: MAX_FIXTURES_PER_GROUP + 1 }, (_, i) => keeper(`p${i}`));
    expect(codeOf(() => validateFixtures("shops", many, town))).toBe("too-many");
    expect(validateFixtures("shops", many.slice(0, MAX_FIXTURES_PER_GROUP), town)).toHaveLength(
      MAX_FIXTURES_PER_GROUP,
    );
  });

  it("sanitises names, tags and appearance like poses instead of rejecting", () => {
    const [f] = validateFixtures(
      "shops",
      [
        keeper("p1", {
          name: "\u0000Bad\u0007 Shop\u009f with a name that is far too long to show",
          tag: "\u001b[31mred",
          appearance: "monster.dragon",
        }),
      ],
      town,
    );
    expect(f!.name).toBe("Bad Shop with a name that is far");
    expect(f!.name.length).toBeLessThanOrEqual(32);
    expect(f!.tag).toBe("[31mred");
    expect(f!.appearance).toBe("unit.hero");
    const [g] = validateFixtures("shops", [keeper("p2", { name: "\u0000 ", tag: "" })], town);
    expect(g!.name).toBe("Shopkeeper");
    expect("tag" in g!).toBe(false);
  });
});

describe("FixtureStore", () => {
  const set = (store: FixtureStore, group: string, raw: unknown[]) =>
    store.replace(group, validateFixtures(group, raw, town));

  it("replaces a group, reporting only what changed", () => {
    const store = new FixtureStore(storeOf(new FakeSqlStorage()));
    let change = set(store, "shops", [keeper("p1"), keeper("p2")]);
    expect(change.upserts.map((f) => f.id)).toEqual(["shops:p1", "shops:p2"]);
    expect(change.removes).toEqual([]);

    // Same set again: nothing to broadcast.
    change = set(store, "shops", [keeper("p1"), keeper("p2")]);
    expect(change).toEqual({ upserts: [], removes: [] });

    // p1 renamed, p2 gone, p3 new.
    change = set(store, "shops", [keeper("p1", { name: "New" }), keeper("p3")]);
    expect(change.upserts.map((f) => [f.id, f.name])).toEqual([
      ["shops:p1", "New"],
      ["shops:p3", "Shop p3"],
    ]);
    expect(change.removes).toEqual(["shops:p2"]);
    expect(store.all().map((f) => f.id)).toEqual(["shops:p1", "shops:p3"]);

    change = set(store, "shops", []);
    expect(change.removes).toEqual(["shops:p1", "shops:p3"]);
    expect(store.size).toBe(0);
  });

  it("keeps groups apart", () => {
    const store = new FixtureStore(storeOf(new FakeSqlStorage()));
    set(store, "shops", [keeper("p1")]);
    set(store, "stalls", [keeper("p1", { id: "stalls:a" })]);
    expect(store.group("shops").map((f) => f.id)).toEqual(["shops:p1"]);
    expect(store.group("stalls").map((f) => f.id)).toEqual(["stalls:a"]);
    const change = set(store, "stalls", []);
    expect(change.removes).toEqual(["stalls:a"]);
    expect(store.all().map((f) => f.id)).toEqual(["shops:p1"]);
  });

  it("survives a restart (a new store on the same SQLite)", () => {
    const fake = new FakeSqlStorage();
    const before = new FixtureStore(storeOf(fake));
    set(before, "shops", [keeper("p2"), keeper("p1", { tag: "Bo · Closed" })]);
    const after = new FixtureStore(storeOf(fake));
    expect(after.all()).toEqual(before.all());
    expect(after.get("shops:p1")?.tag).toBe("Bo · Closed");
    expect(after.has("shops:p2")).toBe(true);
    // And a change after the restart diffs against the persisted state.
    expect(set(after, "shops", [keeper("p2")]).removes).toEqual(["shops:p1"]);
    expect(new FixtureStore(storeOf(fake)).all().map((f) => f.id)).toEqual(["shops:p2"]);
  });

  it("is atomic: a failing write leaves memory and SQLite as they were", () => {
    const fake = new FakeSqlStorage();
    const base = storeOf(fake);
    const store = new FixtureStore(base);
    set(store, "shops", [keeper("p1")]);
    let writes = 0;
    const flaky: SqlStore = {
      sql: new Proxy(base.sql, {
        get(target, prop, receiver) {
          if (prop !== "exec") return Reflect.get(target, prop, receiver) as unknown;
          return (query: string, ...args: unknown[]) => {
            if (query.startsWith("INSERT") && ++writes === 2) throw new Error("disk full");
            return (target.exec as (q: string, ...a: unknown[]) => unknown)(query, ...args);
          };
        },
      }),
      transactionSync: (fn) => base.transactionSync(fn),
    };
    const shaky = new FixtureStore(flaky);
    expect(() => set(shaky, "shops", [keeper("p2"), keeper("p3")])).toThrow("disk full");
    expect(shaky.all().map((f) => f.id)).toEqual(["shops:p1"]);
    expect(new FixtureStore(base).all().map((f) => f.id)).toEqual(["shops:p1"]);
  });

  it("refuses ids held by live avatars or by another group", () => {
    const store = new FixtureStore(storeOf(new FakeSqlStorage()));
    const clean = validateFixtures("shops", [keeper("p1")], town);
    expect(() => store.replace("shops", clean, (id) => id === "shops:p1")).toThrow(FixtureError);
    expect(store.size).toBe(0);
    store.replace("shops", clean);
    expect(() => store.replace("shop", [{ ...clean[0]! }])).toThrow(/belongs to group shops/);
  });
});

describe("fixtures on the wire", () => {
  it("both codecs round-trip a shopkeeper in welcomes and deltas", () => {
    const [f] = validateFixtures("shops", [keeper("p1")], town) as [EntityState];
    for (const codec of [jsonCodec, binaryCodec]) {
      const welcome = {
        t: "welcome" as const,
        selfId: "acc:classic-town",
        chunkId: town.chunk,
        seq: 3,
        serverTime: 10,
        entities: [f],
      };
      expect(codec.decodeServer(codec.encodeServer(welcome))).toEqual(welcome);
      const delta = { t: "delta" as const, chunkId: town.chunk, seq: 4, upserts: [f], removes: [] };
      expect(codec.decodeServer(codec.encodeServer(delta))).toEqual(delta);
    }
  });
});

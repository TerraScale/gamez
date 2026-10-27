import { describe, expect, it } from "vite-plus/test";
import { loadMode, matchGlob } from "../src/index.ts";
import type { SystemDef } from "../src/index.ts";
import { mod, modeOf } from "./fixtures.ts";

const sys = (id: string, extra: Partial<SystemDef> = {}): SystemDef => ({
  id,
  run: () => {},
  ...extra,
});
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe("matchGlob", () => {
  it("matches namespaces, exact ids and everything", () => {
    expect(matchGlob("steps.*", "steps.combat")).toBe(true);
    expect(matchGlob("steps.*", "steps.ai.basic")).toBe(true);
    expect(matchGlob("steps.*", "steps")).toBe(false);
    expect(matchGlob("steps.*", "stepsx.combat")).toBe(false);
    expect(matchGlob("steps.*", "duel.steps.x")).toBe(false);
    expect(matchGlob("*", "anything.at.all")).toBe(true);
    expect(matchGlob("base.stats", "base.stats")).toBe(true);
    expect(matchGlob("base.stats", "base.statsx")).toBe(false);
    expect(matchGlob("*.ai.*", "steps.ai.basic")).toBe(true);
    expect(matchGlob("a*a", "a")).toBe(false);
  });
});

describe("loadMode ordering", () => {
  it("resolves globs and orders deps first, ties by id", () => {
    const catalog = [
      mod("m.z"),
      mod("m.app", { deps: ["m.b"] }),
      mod("m.b", { deps: ["m.a"] }),
      mod("m.a"),
      mod("other.x"),
    ];
    const loaded = loadMode(modeOf(["m.*"]), catalog);
    expect(ids(loaded.modules)).toEqual(["m.a", "m.b", "m.app", "m.z"]);
  });

  it("uses optionalDeps for order only when present", () => {
    const catalog = [mod("m.a", { optionalDeps: ["m.b", "m.missing"] }), mod("m.b"), mod("x.c")];
    expect(ids(loadMode(modeOf(["m.*"]), catalog).modules)).toEqual(["m.b", "m.a"]);
    expect(ids(loadMode(modeOf(["m.a"]), catalog).modules)).toEqual(["m.a"]);
  });

  it("is independent of catalog and pattern order", () => {
    const catalog = [
      mod("a.x", { deps: ["a.y"] }),
      mod("a.y"),
      mod("b.q"),
      mod("b.p", { optionalDeps: ["a.x"] }),
    ];
    const one = loadMode(modeOf(["a.*", "b.*"]), catalog);
    const two = loadMode(modeOf(["b.p", "b.*", "a.*"]), [...catalog].reverse());
    expect(ids(one.modules)).toEqual(["a.y", "a.x", "b.p", "b.q"]);
    expect(ids(two.modules)).toEqual(ids(one.modules));
    expect(two.contentHash).toBe(one.contentHash);
  });

  it("orders systems by stage, order, module load index, then id", () => {
    const catalog = [
      mod("m.b", {
        deps: ["m.a"],
        systems: [
          sys("b.update"),
          sys("b.pre", { stage: "pre" }),
          sys("b.early", { order: -1 }),
          sys("a.zz"),
        ],
      }),
      mod("m.a", {
        systems: [
          sys("a.post", { stage: "post" }),
          sys("a.update2"),
          sys("a.update1"),
          sys("a.late", { order: 5 }),
        ],
      }),
    ];
    const loaded = loadMode(modeOf(["m.*"]), catalog);
    expect(ids(loaded.systems)).toEqual([
      "b.pre",
      "b.early",
      "a.update1",
      "a.update2",
      "a.zz",
      "b.update",
      "a.late",
      "a.post",
    ]);
    expect(loaded.systems[0]).toMatchObject({ stage: "pre", order: 0 });
  });

  it("computes a contentHash from mode, module ids+versions and registry", () => {
    const catalog = [mod("m.a", { data: (r) => r.define("item", "x", { v: 1 }) })];
    const base = loadMode(modeOf(["m.*"]), catalog).contentHash;
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(loadMode(modeOf(["m.*"]), catalog).contentHash).toBe(base);
    expect(loadMode(modeOf(["m.*"]), [{ ...catalog[0]!, version: "1.0.1" }]).contentHash).not.toBe(
      base,
    );
    expect(
      loadMode(modeOf(["m.*"]), [mod("m.a", { data: (r) => r.define("item", "x", { v: 2 }) })])
        .contentHash,
    ).not.toBe(base);
    expect(loadMode({ ...modeOf(["m.*"]), id: "other" }, catalog).contentHash).not.toBe(base);
  });
});

describe("loadMode errors", () => {
  it("rejects a pattern that matches nothing", () => {
    expect(() => loadMode(modeOf(["m.*", "nope.*"]), [mod("m.a")])).toThrow(
      /pattern "nope\.\*" matches no module/,
    );
  });

  it("rejects duplicate catalog ids", () => {
    expect(() => loadMode(modeOf(["m.*"]), [mod("m.a"), mod("m.a")])).toThrow(
      /duplicate module id "m\.a"/,
    );
  });

  it("rejects a missing required dep, naming both modules", () => {
    const catalog = [mod("m.a", { deps: ["x.base"] }), mod("x.base")];
    expect(() => loadMode(modeOf(["m.*"]), catalog)).toThrow(
      /Module "m\.a" requires module "x\.base", which is in the catalog but not in mode "test"/,
    );
    expect(() => loadMode(modeOf(["m.*"]), [mod("m.a", { deps: ["ghost"] })])).toThrow(
      /Module "m\.a" requires module "ghost", which is not in the catalog/,
    );
  });

  it("rejects dependency cycles, naming the cycle", () => {
    const catalog = [
      mod("m.a", { deps: ["m.b"] }),
      mod("m.b", { deps: ["m.c"] }),
      mod("m.c", { optionalDeps: ["m.a"] }),
      mod("m.d"),
    ];
    expect(() => loadMode(modeOf(["m.*"]), catalog)).toThrow(
      "Module dependency cycle: m.a -> m.b -> m.c -> m.a",
    );
    expect(() => loadMode(modeOf(["m.*"]), [mod("m.s", { deps: ["m.s"] })])).toThrow(
      "Module dependency cycle: m.s -> m.s",
    );
  });

  it("rejects duplicate system ids and action names", () => {
    const action = { name: "m.act", parse: () => null, apply: () => {} };
    expect(() =>
      loadMode(modeOf(["m.*"]), [
        mod("m.a", { systems: [sys("s")] }),
        mod("m.b", { systems: [sys("s")] }),
      ]),
    ).toThrow(/Duplicate system id "s" in modules "m\.a" and "m\.b"/);
    expect(() =>
      loadMode(modeOf(["m.*"]), [
        mod("m.a", { actions: [action] }),
        mod("m.b", { actions: [action] }),
      ]),
    ).toThrow(/Duplicate action name "m\.act"/);
  });

  it("rejects overrides of unknown targets", () => {
    expect(() =>
      loadMode(modeOf(["m.*"]), [
        mod("m.a", { overrides: [{ kind: "system", target: "nope", op: "disable" }] }),
      ]),
    ).toThrow(/Module "m\.a" disables system "nope", but no system with that id is loaded/);
    expect(() =>
      loadMode(modeOf(["m.*"]), [
        mod("m.a", { overrides: [{ kind: "action", target: "nope", op: "wrap", with: () => {} }] }),
      ]),
    ).toThrow(/no action with that name/);
  });

  it("rejects bad system stages and fixed modes without a valid hz", () => {
    expect(() =>
      loadMode(modeOf(["m.*"]), [mod("m.a", { systems: [sys("s", { stage: "late" as never })] })]),
    ).toThrow(/unknown stage "late"/);
    expect(() =>
      loadMode({ ...modeOf(["m.*"]), tick: { kind: "fixed", hz: 0 } }, [mod("m.a")]),
    ).toThrow(/hz/);
  });
});

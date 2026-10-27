import { describe, expect, it } from "vite-plus/test";
import { createSim, loadMode } from "../src/index.ts";
import type { ActionDef, ModuleSpec, Override } from "../src/index.ts";
import { mod, modeOf } from "./fixtures.ts";

/** Base module whose system and action log into the "log" resource. */
function logOf(
  w: { getResource<T>(k: string): T | undefined; setResource<T>(k: string, v: T): void },
  s: string,
) {
  w.setResource("log", [...(w.getResource<string[]>("log") ?? []), s]);
}

const base: ModuleSpec = mod("o.base", {
  systems: [
    { id: "o.sys", run: (w) => logOf(w, "sys") },
    { id: "o.other", order: 1, run: (w) => logOf(w, "other") },
  ],
  actions: [
    {
      name: "o.act",
      parse: (_w, p) => p as number,
      apply: (w, p: number) => logOf(w, `act:${p}`),
    } satisfies ActionDef<number>,
  ],
});

function run(...layers: Override[][]): string[] {
  const modules = layers.map((overrides, i) =>
    mod(`o.l${i}`, { deps: i === 0 ? ["o.base"] : [`o.l${i - 1}`], overrides }),
  );
  const loaded = loadMode(modeOf(["o.*"]), [base, ...modules]);
  const sim = createSim(loaded, { seed: 1 });
  const res = sim.dispatch("o.act", 1, null);
  if (!res.ok) return [`error:${res.error!.code}:${res.error!.message}`];
  return sim.world.getResource<string[]>("log") ?? [];
}

describe("system overrides", () => {
  it("runs the base behaviour with no overrides", () => {
    expect(run()).toEqual(["act:1", "sys", "other"]);
  });

  it("disables a system", () => {
    expect(run([{ kind: "system", target: "o.sys", op: "disable" }])).toEqual(["act:1", "other"]);
  });

  it("replaces a system", () => {
    expect(
      run([{ kind: "system", target: "o.sys", op: "replace", with: (w) => logOf(w, "new") }]),
    ).toEqual(["act:1", "new", "other"]);
  });

  it("stacks wraps in load order (later wraps the earlier wrap)", () => {
    const wrap = (tag: string): Override => ({
      kind: "system",
      target: "o.sys",
      op: "wrap",
      with: (w, _ctx, next) => {
        logOf(w, `${tag}>`);
        next();
        logOf(w, `<${tag}`);
      },
    });
    expect(run([wrap("A")], [wrap("B")])).toEqual([
      "act:1",
      "B>",
      "A>",
      "sys",
      "<A",
      "<B",
      "other",
    ]);
  });

  it("wraps a replacement, and a wrap may skip next()", () => {
    expect(
      run(
        [{ kind: "system", target: "o.sys", op: "replace", with: (w) => logOf(w, "new") }],
        [
          {
            kind: "system",
            target: "o.sys",
            op: "wrap",
            with: (w, _c, next) => {
              next();
              logOf(w, "after");
            },
          },
        ],
        [{ kind: "system", target: "o.other", op: "wrap", with: () => {} }],
      ),
    ).toEqual(["act:1", "new", "after"]);
  });

  it("rejects wrapping or replacing a disabled system, naming who disabled it", () => {
    expect(() =>
      run(
        [{ kind: "system", target: "o.sys", op: "disable" }],
        [{ kind: "system", target: "o.sys", op: "replace", with: () => {} }],
      ),
    ).toThrow(
      /Module "o\.l1" replaces system "o\.sys", but it was already disabled by module "o\.l0"/,
    );
    expect(
      run(
        [{ kind: "system", target: "o.sys", op: "disable" }],
        [{ kind: "system", target: "o.sys", op: "disable" }],
      ),
    ).toEqual(["act:1", "other"]);
  });
});

describe("action overrides", () => {
  it("disables an action", () => {
    expect(run([{ kind: "action", target: "o.act", op: "disable" }])[0]).toMatch(
      /^error:unknown_action/,
    );
  });

  it("replaces an action (parse and apply)", () => {
    const replacement: ActionDef<string> = {
      name: "o.act",
      parse: (_w, p) => `#${String(p)}`,
      apply: (w, p) => logOf(w, `replaced:${p}`),
    };
    expect(run([{ kind: "action", target: "o.act", op: "replace", with: replacement }])).toEqual([
      "replaced:#1",
      "sys",
      "other",
    ]);
  });

  it("rejects a replacement with a different name", () => {
    const wrong: ActionDef<null> = { name: "o.other", parse: () => null, apply: () => {} };
    expect(() => run([{ kind: "action", target: "o.act", op: "replace", with: wrong }])).toThrow(
      /names must match/,
    );
  });

  it("stacks apply() wraps that can change the payload", () => {
    const wrap = (tag: string, delta: number): Override => ({
      kind: "action",
      target: "o.act",
      op: "wrap",
      with: (w, p: number, _ctx, next) => {
        logOf(w, `${tag}>${p}`);
        next(p + delta);
      },
    });
    expect(run([wrap("A", 10)], [wrap("B", 100)])).toEqual([
      "B>1",
      "A>101",
      "act:111",
      "sys",
      "other",
    ]);
  });
});

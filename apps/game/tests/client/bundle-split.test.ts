/**
 * Entry bundle guards (docs/ship.md §1.9). A dynamic import of a module the app
 * also imports statically does not split anything: the bundler keeps it (and
 * what it reaches) in the entry graph. Shell sheets must load views from the
 * ui-host subpaths, and the ui-host root must not re-export the views as values.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("entry bundle split", () => {
  it("shell sheets never dynamically import the ui-host root", () => {
    const src = read("../../src/client/app/ShellSheets.tsx");
    expect(src).not.toMatch(/import\(\s*["']@gamez\/ui-host["']\s*\)/);
    expect(src).toMatch(/import\(\s*["']@gamez\/ui-host\/economy["']\s*\)/);
    expect(src).toMatch(/import\(\s*["']@gamez\/ui-host\/play["']\s*\)/);
  });

  it("the ui-host root re-exports the economy and play views as types only", () => {
    const src = read("../../../../packages/ui-host/src/index.ts");
    expect(src).not.toMatch(/^export \* from "\.\/(economy|play)\/index\.ts";/m);
    expect(src).toMatch(/^export type \* from "\.\/economy\/index\.ts";/m);
    expect(src).toMatch(/^export type \* from "\.\/play\/index\.ts";/m);
  });
});

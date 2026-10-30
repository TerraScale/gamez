import { describe, expect, it } from "vite-plus/test";
import { MODES } from "../../src/shared/catalog.ts";
import { MODE_META } from "../../src/shared/mode-meta.ts";

/** The browser's picker metadata must equal the server's mode specs. */
describe("mode picker metadata", () => {
  it("matches every catalog mode, in order", () => {
    const fromCatalog = MODES.map(({ id, name, description, world }) => ({
      id,
      name,
      description,
      world,
    }));
    expect(MODE_META.map((m) => ({ ...m }))).toEqual(fromCatalog);
  });
});

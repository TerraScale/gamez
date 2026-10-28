import { describe, expect, it } from "vite-plus/test";
import type { SimSnapshot } from "@gamez/kernel";
import { PACK_GZIP_ABOVE, packSnapshot, unpackSnapshot } from "../src/index.ts";

const snap = (size: number): SimSnapshot => ({
  modeId: "m",
  contentHash: "abc",
  tick: 7,
  rng: [1, 2, 3, 4],
  world: {
    nextEntity: 2,
    components: { "m.blob": { 1: { text: "x".repeat(size) } } },
    resources: {},
  } as unknown as SimSnapshot["world"],
});

describe("packSnapshot", () => {
  it("keeps small snapshots as JSON and round-trips them", async () => {
    const s = snap(100);
    const packed = await packSnapshot(s);
    expect(packed.enc).toBe("json");
    expect(await unpackSnapshot(packed)).toEqual(s);
  });

  it("gzips large snapshots and round-trips them", async () => {
    const s = snap(PACK_GZIP_ABOVE + 10);
    const packed = await packSnapshot(s);
    expect(packed.enc).toBe("gzip64");
    expect(JSON.stringify(packed).length).toBeLessThan(PACK_GZIP_ABOVE / 10);
    expect(await unpackSnapshot(packed)).toEqual(s);
    expect(await unpackSnapshot(await packSnapshot(snap(10), { forceGzip: true }))).toEqual(
      snap(10),
    );
  });

  it("rejects unknown encodings and garbage", async () => {
    await expect(unpackSnapshot({ enc: "zip", data: "" } as never)).rejects.toThrow();
    await expect(unpackSnapshot({ enc: "gzip64", data: "bm90IGd6aXA=" })).rejects.toThrow();
  });
});

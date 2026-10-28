import { describe, expect, it } from "vite-plus/test";
import type { SimSnapshot } from "@gamez/kernel";
import {
  jsonWithinLimits,
  MAX_IMPORT_SNAPSHOT_DEPTH,
  MAX_IMPORT_SNAPSHOT_NODES,
  PACK_GZIP_ABOVE,
  packSnapshot,
  unpackSnapshot,
} from "../src/index.ts";

/** Literal sizes on purpose: the limits are asserted, not imported. */
const EIGHT_MIB = 8 * 1024 * 1024;
/** Above the largest base64 a legitimate gzip of an 8 MiB snapshot can take. */
const LONG_BASE64 = 12 * 1024 * 1024;

/** gzip of `size` zero bytes, built at runtime (a decompression bomb when size is large). */
async function gzipZeros(size: number): Promise<string> {
  const gz = await new Response(
    new Blob([new Uint8Array(size)]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  // Compressed zeros are small, so the spread stays well under the argument limit.
  return btoa(String.fromCharCode(...new Uint8Array(gz)));
}

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

describe("unpackSnapshot size limits", () => {
  it("rejects a gzip bomb once the inflated output passes maxBytes", async () => {
    const data = await gzipZeros(1024 * 1024);
    await expect(unpackSnapshot({ enc: "gzip64", data }, { maxBytes: 1024 })).rejects.toThrow(
      /too large/,
    );
  });

  it("rejects output above the default cap", async () => {
    const data = await gzipZeros(EIGHT_MIB + 1);
    await expect(unpackSnapshot({ enc: "gzip64", data })).rejects.toThrow(/too large/);
  });

  it("refuses over-long base64 before decoding it", async () => {
    const data = "A".repeat(1024 + 4);
    await expect(unpackSnapshot({ enc: "gzip64", data }, { maxInputChars: 1024 })).rejects.toThrow(
      /too large/,
    );
    await expect(unpackSnapshot({ enc: "gzip64", data: "A".repeat(LONG_BASE64) })).rejects.toThrow(
      /too large/,
    );
  });

  it("still unpacks legitimate snapshots within the limits", async () => {
    const s = snap(PACK_GZIP_ABOVE * 4);
    const packed = await packSnapshot(s);
    expect(packed.enc).toBe("gzip64");
    expect(await unpackSnapshot(packed, { maxBytes: 4 * 1024 * 1024 })).toEqual(s);
    expect(await unpackSnapshot(await packSnapshot(s, { forceGzip: true }))).toEqual(s);
  });
});

describe("jsonWithinLimits: import structure bound (R8)", () => {
  it("uses limits far above a real save (about 500 nodes, depth 7) and far below a bomb", () => {
    expect(MAX_IMPORT_SNAPSHOT_NODES).toBe(50_000);
    expect(MAX_IMPORT_SNAPSHOT_DEPTH).toBe(32);
    expect(jsonWithinLimits(snap(3000))).toBe(true);
  });

  it("counts every node: objects, arrays and scalars", () => {
    expect(jsonWithinLimits(1, 1)).toBe(true);
    expect(jsonWithinLimits([1, 2], 3)).toBe(true);
    expect(jsonWithinLimits([1, 2], 2)).toBe(false);
    expect(jsonWithinLimits({ a: { b: null } }, 3)).toBe(true);
    expect(jsonWithinLimits({ a: { b: null } }, 2)).toBe(false);
  });

  it("rejects a wide array of empty objects", () => {
    expect(jsonWithinLimits(Array.from({ length: MAX_IMPORT_SNAPSHOT_NODES }, () => ({})))).toBe(
      false,
    );
    expect(jsonWithinLimits(Array.from({ length: MAX_IMPORT_SNAPSHOT_NODES - 1 }, () => 0))).toBe(
      true,
    );
  });

  it("rejects a wide object", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < MAX_IMPORT_SNAPSHOT_NODES; i++) wide[`k${i}`] = i;
    expect(jsonWithinLimits({ world: { resources: wide } })).toBe(false);
  });

  it("rejects deep nesting without recursing (no stack overflow)", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(jsonWithinLimits(deep, Number.MAX_SAFE_INTEGER)).toBe(false);
    let ok: unknown = 0;
    for (let i = 0; i < MAX_IMPORT_SNAPSHOT_DEPTH; i++) ok = { v: ok };
    expect(jsonWithinLimits(ok)).toBe(true);
    expect(jsonWithinLimits({ v: ok })).toBe(false);
  });
});

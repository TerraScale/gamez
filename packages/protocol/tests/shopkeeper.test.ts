import { describe, expect, it } from "vite-plus/test";
import { binaryCodec, jsonCodec } from "../src/index.ts";
import type { EntityState, ServerMessage } from "../src/messages.ts";
import { makeEntity } from "./fixtures.ts";

/** A wave C world fixture: the ghost shopkeeper of plot p1 (docs/design/wave-C.md §5.4). */
const keeper: EntityState = {
  id: "shops:p1",
  kind: "shopkeeper",
  name: "Ann's Wares",
  appearance: "unit.hero.merchant",
  pos: { x: 52, y: 30 },
  path: [],
  pathStartedAt: 0,
  speed: 0,
  tag: "Ann · Open",
};

const messages: ServerMessage[] = [
  {
    t: "welcome",
    selfId: "acc:classic-town",
    chunkId: "classic-town:0:0",
    seq: 9,
    serverTime: 1_767_225_600_000,
    entities: [makeEntity(1), keeper, { ...keeper, id: "shops:p2", tag: undefined } as never],
  },
  { t: "delta", chunkId: "classic-town:0:0", seq: 10, upserts: [keeper], removes: [] },
  { t: "delta", chunkId: "classic-town:0:0", seq: 11, upserts: [], removes: ["shops:p1"] },
];

/** JSON drops undefined fields; normalise the expectation the same way. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("entity kind shopkeeper", () => {
  it.each(messages.map((m, i) => [i, m] as const))("json round-trips message %i", (_, msg) => {
    expect(jsonCodec.decodeServer(jsonCodec.encodeServer(msg))).toEqual(plain(msg));
  });

  it.each(messages.map((m, i) => [i, m] as const))("binary round-trips message %i", (_, msg) => {
    const frame = binaryCodec.encodeServer(plain(msg));
    expect(binaryCodec.decodeServer(frame)).toEqual(plain(msg));
  });

  it("binary encodes the kind as byte 2 and rejects unknown kind codes", () => {
    const frame = binaryCodec.encodeServer({
      t: "delta",
      chunkId: "c",
      seq: 1,
      upserts: [keeper],
      removes: [],
    }) as Uint8Array;
    // tag(1) + chunkId(1+1) + seq(4) + count(1) + id(1+8) -> kind byte.
    const kindAt = 1 + 2 + 4 + 1 + 1 + keeper.id.length;
    expect(frame[kindAt]).toBe(2);
    const bad = frame.slice();
    bad[kindAt] = 3;
    expect(() => binaryCodec.decodeServer(bad)).toThrow(/unknown entity kind 3/);
  });

  it("binary keeps speed 0 and pathStartedAt 0 exactly", () => {
    const out = binaryCodec.decodeServer(
      binaryCodec.encodeServer({
        t: "delta",
        chunkId: "c",
        seq: 1,
        upserts: [keeper],
        removes: [],
      }),
    );
    expect(out.t === "delta" && out.upserts[0]).toMatchObject({ speed: 0, pathStartedAt: 0 });
  });
});

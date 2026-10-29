import { describe, expect, it } from "vite-plus/test";
import {
  MAX_COMPANIONS,
  binaryCodec,
  jsonCodec,
  type ClientMessage,
  type CompanionPose,
  type EntityState,
} from "../src/index.ts";
import { makeEntity } from "./fixtures.ts";

/** Party companions (party.md §11.3): carried by entities and pose reports. */
const companions: CompanionPose[] = [
  { appearance: "unit.hero.rogue", name: "Lyra", dx: 1, dy: 0 },
  { appearance: "unit.hero.sorcerer", name: "Mira", dx: -4, dy: 4 },
  { appearance: "unit.hero", name: "ünïcödé 🎲", dx: 0, dy: -2 },
];

/** Returns a copy of the bytes as a standalone ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function f64(v: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return [...b];
}

describe("companions on entities (server frames)", () => {
  const entities: EntityState[] = [
    { ...makeEntity(1), companions: [] },
    { ...makeEntity(2), companions },
    { ...makeEntity(3), tag: "Lv 3 Mage", companions: [companions[0]!] },
    makeEntity(4),
  ];

  it.each([
    ["json", jsonCodec],
    ["binary", binaryCodec],
  ])("%s round-trips [], three companions and an absent field", (_, codec) => {
    const frame = codec.encodeServer({
      t: "delta",
      chunkId: "classic-town:0:0",
      seq: 7,
      upserts: entities,
      removes: [],
    });
    const decoded = codec.decodeServer(
      typeof frame === "string" ? frame : toArrayBuffer(frame as Uint8Array),
    );
    expect(decoded).toEqual({
      t: "delta",
      chunkId: "classic-town:0:0",
      seq: 7,
      upserts: entities,
      removes: [],
    });
    if (decoded.t !== "delta") throw new Error("expected delta");
    // [] is kept as [] (it clears a list); an absent field stays absent.
    expect(decoded.upserts[0]).toHaveProperty("companions", []);
    expect(decoded.upserts[3]).not.toHaveProperty("companions");
  });

  it("round-trips companions in a welcome next to tags and paths", () => {
    const welcome = {
      t: "welcome" as const,
      selfId: "a",
      chunkId: "classic-town:0:0",
      seq: 2,
      serverTime: 5,
      entities: [{ ...makeEntity(9), tag: "Lv 9 Warrior", companions }],
    };
    const bytes = binaryCodec.encodeServer(welcome);
    expect(binaryCodec.decodeServer(toArrayBuffer(bytes as Uint8Array))).toEqual(welcome);
    expect(jsonCodec.decodeServer(jsonCodec.encodeServer(welcome) as string)).toEqual(welcome);
  });
});

describe("companions on pose reports (client frames)", () => {
  const poses: ClientMessage[] = [
    { t: "pose", pos: { x: 3, y: 4 }, path: [], speed: 4, companions: [] },
    {
      t: "pose",
      pos: { x: 3, y: 4 },
      path: [{ x: 4, y: 4 }],
      speed: 4,
      appearance: "unit.hero.warrior",
      tag: "Lv 2 Warrior",
      companions,
    },
    { t: "pose", pos: { x: 3, y: 4 }, path: [], speed: 4 },
  ];

  it.each([
    ["json", jsonCodec],
    ["binary", binaryCodec],
  ])("%s round-trips [], three companions and an absent field", (_, codec) => {
    for (const msg of poses) {
      const frame = codec.encodeClient(msg);
      const decoded = codec.decodeClient(
        typeof frame === "string" ? frame : toArrayBuffer(frame as Uint8Array),
      );
      expect(decoded).toEqual(msg);
    }
    const [empty, full, absent] = poses.map((m) => {
      const frame = codec.encodeClient(m);
      return codec.decodeClient(
        typeof frame === "string" ? frame : toArrayBuffer(frame as Uint8Array),
      );
    });
    expect(empty).toHaveProperty("companions", []);
    expect(full).toHaveProperty("companions", companions);
    expect(absent).not.toHaveProperty("companions");
  });

  it("binary: a pose with companions sets flag bit 2 and no other pose flags", () => {
    const bytes = binaryCodec.encodeClient({
      t: "pose",
      pos: { x: 1, y: 1 },
      path: [],
      speed: 2,
      companions: [],
    });
    // tag(1) + pos(4) + path count(1) + speed(8) = 14 bytes, then the flags byte.
    expect(bytes[14]).toBe(0x04);
  });

  it("binary: a pose without companions has no companions flag", () => {
    const bytes = binaryCodec.encodeClient({ t: "pose", pos: { x: 1, y: 1 }, path: [], speed: 2 });
    expect(bytes[14]).toBe(0);
  });
});

describe("binary codec: frames without companions and bad companion frames", () => {
  it("decodes an old pose frame (no companions flag) exactly as before", () => {
    // Hand-built v2 frame: tag 4, pos (3, 4), empty path, speed 4, flags 0.
    const old = Uint8Array.from([4, 3, 0, 4, 0, 0, ...f64(4), 0]);
    const msg = binaryCodec.decodeClient(toArrayBuffer(old));
    expect(msg).toEqual({ t: "pose", pos: { x: 3, y: 4 }, path: [], speed: 4 });
    expect(msg).not.toHaveProperty("companions");
  });

  it("rejects a companion count above MAX_COMPANIONS", () => {
    const frame = Uint8Array.from([4, 3, 0, 4, 0, 0, ...f64(4), 0x04, MAX_COMPANIONS + 1]);
    expect(() => binaryCodec.decodeClient(toArrayBuffer(frame))).toThrow(/companions exceed/);
  });

  it("rejects a truncated companion list", () => {
    // Count 2, but only one entry's bytes follow.
    const entry = [1, 0x61, 1, 0x62, 0, 0];
    const frame = Uint8Array.from([4, 3, 0, 4, 0, 0, ...f64(4), 0x04, 2, ...entry]);
    expect(() => binaryCodec.decodeClient(toArrayBuffer(frame))).toThrow(/truncated/);
  });

  it("rejects unknown pose and entity flag bits", () => {
    const badPose = Uint8Array.from([4, 3, 0, 4, 0, 0, ...f64(4), 0x08]);
    expect(() => binaryCodec.decodeClient(toArrayBuffer(badPose))).toThrow(/unknown pose flags/);
  });

  it("refuses to encode more than MAX_COMPANIONS companions", () => {
    const five = Array.from({ length: MAX_COMPANIONS + 1 }, () => companions[0]!);
    expect(() =>
      binaryCodec.encodeClient({
        t: "pose",
        pos: { x: 1, y: 1 },
        path: [],
        speed: 2,
        companions: five,
      }),
    ).toThrow(RangeError);
  });

  it("refuses offsets that do not fit in a signed byte", () => {
    const bad = [{ appearance: "unit.hero", name: "x", dx: 200, dy: 0 }];
    expect(() =>
      binaryCodec.encodeClient({
        t: "pose",
        pos: { x: 1, y: 1 },
        path: [],
        speed: 2,
        companions: bad,
      }),
    ).toThrow(RangeError);
  });

  it("encodes negative offsets as signed bytes that decode back", () => {
    const msg: ClientMessage = {
      t: "pose",
      pos: { x: 1, y: 1 },
      path: [],
      speed: 2,
      companions: [{ appearance: "unit.hero", name: "x", dx: -4, dy: -1 }],
    };
    expect(
      binaryCodec.decodeClient(toArrayBuffer(binaryCodec.encodeClient(msg) as Uint8Array)),
    ).toEqual(msg);
  });
});

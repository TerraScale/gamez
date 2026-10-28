import { describe, expect, it } from "vite-plus/test";
import { binaryCodec, jsonCodec } from "../src/index.ts";
import type { ClientMessage, EntityState, ServerMessage } from "../src/messages.ts";
import { makeDelta, makeEntity, makeWelcome } from "./fixtures.ts";

const clientMessages: ClientMessage[] = [
  { t: "hello", token: "eyJhbGciOiJIUzI1NiJ9.payload.sig" },
  { t: "hello", token: "" },
  { t: "moveTo", target: { x: 12, y: 34 } },
  { t: "moveTo", target: { x: 0, y: 0 } },
  { t: "moveTo", target: { x: 65535, y: 65535 } },
  { t: "ping", clientTime: 1_767_225_600_000.123 },
];

const serverMessages: ServerMessage[] = [
  makeWelcome(3),
  makeWelcome(0),
  makeDelta(),
  { t: "delta", chunkId: "c", seq: 0, upserts: [], removes: [] },
  { t: "delta", chunkId: "c", seq: 4294967295, upserts: [], removes: ["a", "b", "c"] },
  { t: "pong", clientTime: 0.1 + 0.2, serverTime: 1e-300 },
  { t: "error", code: "rate_limited", message: "slow down" },
];

/** Returns a copy of the bytes as a standalone ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe("binaryCodec round trip", () => {
  it("has the name binary", () => {
    expect(binaryCodec.name).toBe("binary");
  });

  it.each(clientMessages.map((m) => [m.t, m] as const))("round-trips client %s", (_, msg) => {
    const frame = binaryCodec.encodeClient(msg);
    expect(frame).toBeInstanceOf(Uint8Array);
    expect(binaryCodec.decodeClient(frame)).toEqual(msg);
    expect(binaryCodec.decodeClient(toArrayBuffer(frame as Uint8Array))).toEqual(msg);
  });

  it.each(serverMessages.map((m, i) => [`${i}:${m.t}`, m] as const))(
    "round-trips server %s",
    (_, msg) => {
      const frame = binaryCodec.encodeServer(msg);
      expect(frame).toBeInstanceOf(Uint8Array);
      expect(binaryCodec.decodeServer(frame)).toEqual(msg);
      expect(binaryCodec.decodeServer(toArrayBuffer(frame as Uint8Array))).toEqual(msg);
    },
  );

  it("decodes from a Uint8Array view with a nonzero byteOffset", () => {
    const frame = binaryCodec.encodeServer(makeDelta()) as Uint8Array;
    const padded = new Uint8Array(frame.length + 10);
    padded.set(frame, 5);
    const view = padded.subarray(5, 5 + frame.length);
    expect(binaryCodec.decodeServer(view)).toEqual(makeDelta());
  });

  it("round-trips unicode names and ids", () => {
    const entity: EntityState = {
      ...makeEntity(1),
      id: "персонаж-1",
      name: "Zoë 🧙 Ωmega 漢字 ‮rtl",
      appearance: "unit.héros/🔥",
    };
    const msg: ServerMessage = {
      t: "delta",
      chunkId: "chunk:é:🌍",
      seq: 1,
      upserts: [entity],
      removes: ["ид-2", "🎲"],
    };
    expect(binaryCodec.decodeServer(binaryCodec.encodeServer(msg))).toEqual(msg);
  });

  it("round-trips a 1000-tile path", () => {
    const path = Array.from({ length: 1000 }, (_, i) => ({ x: i % 65536, y: (i * 37) % 65536 }));
    const entity: EntityState = { ...makeEntity(2), path };
    const msg: ServerMessage = {
      t: "welcome",
      selfId: "char-2",
      chunkId: "chunk:0:0",
      seq: 7,
      serverTime: 0,
      entities: [entity],
    };
    expect(binaryCodec.decodeServer(binaryCodec.encodeServer(msg))).toEqual(msg);
  });

  it("round-trips a 500-entity welcome", () => {
    const msg = makeWelcome(500);
    expect(binaryCodec.decodeServer(binaryCodec.encodeServer(msg))).toEqual(msg);
  });

  it("preserves coordinates at 0 and 65535 in entities and paths", () => {
    const entity: EntityState = {
      ...makeEntity(3),
      pos: { x: 0, y: 65535 },
      path: [
        { x: 65535, y: 0 },
        { x: 0, y: 0 },
        { x: 65535, y: 65535 },
      ],
    };
    const msg: ServerMessage = {
      t: "welcome",
      selfId: "char-3",
      chunkId: "c",
      seq: 7,
      serverTime: 1,
      entities: [entity],
    };
    expect(binaryCodec.decodeServer(binaryCodec.encodeServer(msg))).toEqual(msg);
  });

  it("preserves float64 times and speed exactly", () => {
    const entity: EntityState = {
      ...makeEntity(4),
      pathStartedAt: Number.MAX_SAFE_INTEGER,
      speed: Math.PI,
    };
    const tiny: EntityState = { ...makeEntity(5), pathStartedAt: 5e-324, speed: 1 / 3 };
    const msg: ServerMessage = {
      t: "welcome",
      selfId: "x",
      chunkId: "c",
      seq: 7,
      serverTime: 0.1 + 0.2,
      entities: [entity, tiny],
    };
    const decoded = binaryCodec.decodeServer(binaryCodec.encodeServer(msg));
    expect(decoded).toEqual(msg);
  });

  it("round-trips empty arrays and empty strings", () => {
    const msg: ServerMessage = {
      t: "welcome",
      selfId: "",
      chunkId: "",
      seq: 7,
      serverTime: 0,
      entities: [],
    };
    expect(binaryCodec.decodeServer(binaryCodec.encodeServer(msg))).toEqual(msg);

    const entity: EntityState = { ...makeEntity(6), path: [], name: "" };
    const withEntity: ServerMessage = {
      t: "delta",
      chunkId: "c",
      seq: 9,
      upserts: [entity],
      removes: [],
    };
    expect(binaryCodec.decodeServer(binaryCodec.encodeServer(withEntity))).toEqual(withEntity);
  });

  it("encodes ghost and player kinds distinctly", () => {
    const player = { ...makeEntity(1), kind: "player" as const };
    const ghost = { ...makeEntity(1), kind: "ghost" as const };
    const decode = (e: EntityState) =>
      binaryCodec.decodeServer(
        binaryCodec.encodeServer({ t: "delta", chunkId: "c", seq: 1, upserts: [e], removes: [] }),
      );
    expect(decode(player)).toEqual({
      t: "delta",
      chunkId: "c",
      seq: 1,
      upserts: [player],
      removes: [],
    });
    expect(decode(ghost)).toEqual({
      t: "delta",
      chunkId: "c",
      seq: 1,
      upserts: [ghost],
      removes: [],
    });
  });
});

describe("binaryCodec errors", () => {
  it("throws on a string frame", () => {
    const json = jsonCodec.encodeServer(makeDelta());
    expect(typeof json).toBe("string");
    expect(() => binaryCodec.decodeServer(json)).toThrow(/got a string/);
    expect(() => binaryCodec.decodeClient('{"t":"ping","clientTime":1}')).toThrow(/got a string/);
  });

  it("throws on an unknown client tag", () => {
    expect(() => binaryCodec.decodeClient(new Uint8Array([99]))).toThrow(
      /unknown client message tag 99/,
    );
  });

  it("throws on an unknown server tag", () => {
    expect(() => binaryCodec.decodeServer(new Uint8Array([0]))).toThrow(
      /unknown server message tag 0/,
    );
  });

  it("throws on an unknown entity kind", () => {
    const frame = binaryCodec.encodeServer(makeDelta()) as Uint8Array;
    // Layout: tag, chunkId (len + bytes), seq (u32), upsert count, entity id (len + bytes), kind.
    const copy = frame.slice();
    const chunkLen = copy[1] ?? 0;
    const kindOffset = 1 + 1 + chunkLen + 4 + 1 + 1 + "char-7".length;
    copy[kindOffset] = 7;
    expect(() => binaryCodec.decodeServer(copy)).toThrow(/unknown entity kind 7/);
  });

  it("throws on every strict prefix of a valid frame", () => {
    const client = binaryCodec.encodeClient({ t: "hello", token: "abc" }) as Uint8Array;
    for (let n = 0; n < client.length; n++) {
      expect(() => binaryCodec.decodeClient(client.subarray(0, n))).toThrow();
    }

    const server = binaryCodec.encodeServer(makeWelcome(3)) as Uint8Array;
    for (let n = 0; n < server.length; n++) {
      expect(() => binaryCodec.decodeServer(server.subarray(0, n))).toThrow(/truncated|varint/);
    }
  });

  it("throws on a truncated 500-entity welcome", () => {
    const frame = binaryCodec.encodeServer(makeWelcome(500)) as Uint8Array;
    expect(() => binaryCodec.decodeServer(frame.subarray(0, frame.length - 1))).toThrow(
      /truncated/,
    );
    expect(() => binaryCodec.decodeServer(frame.subarray(0, frame.length >> 1))).toThrow(
      /truncated/,
    );
  });

  it("throws on a count larger than the remaining bytes", () => {
    // welcome tag, selfId "", chunkId "", seq u32, serverTime f64, then an entity count of 2^30.
    const frame = new Uint8Array([
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      ...new Uint8Array(8),
      0x80,
      0x80,
      0x80,
      0x80,
      0x04,
    ]);
    expect(() => binaryCodec.decodeServer(frame)).toThrow(/count .* exceeds remaining/);
  });

  it("throws on trailing bytes", () => {
    const frame = binaryCodec.encodeClient({ t: "moveTo", target: { x: 1, y: 2 } }) as Uint8Array;
    const padded = new Uint8Array([...frame, 0]);
    expect(() => binaryCodec.decodeClient(padded)).toThrow(/trailing bytes/);
  });

  it("rejects tile coordinates outside uint16 on encode", () => {
    expect(() => binaryCodec.encodeClient({ t: "moveTo", target: { x: 65536, y: 0 } })).toThrow(
      RangeError,
    );
    expect(() => binaryCodec.encodeClient({ t: "moveTo", target: { x: -1, y: 0 } })).toThrow(
      RangeError,
    );
    expect(() => binaryCodec.encodeClient({ t: "moveTo", target: { x: 1.5, y: 0 } })).toThrow(
      RangeError,
    );
  });

  it("rejects seq outside uint32 on encode", () => {
    const msg: ServerMessage = {
      t: "delta",
      chunkId: "c",
      seq: 4294967296,
      upserts: [],
      removes: [],
    };
    expect(() => binaryCodec.encodeServer(msg)).toThrow(RangeError);
  });
});

describe("binaryCodec welcome seq", () => {
  const welcome = (seq: number): ServerMessage => ({
    t: "welcome",
    selfId: "me",
    chunkId: "classic:0:0",
    seq,
    serverTime: 1,
    entities: [makeEntity(1)],
  });

  it("round-trips the seq at both ends of uint32", () => {
    for (const seq of [0, 1, 255, 65536, 4294967295]) {
      const decoded = binaryCodec.decodeServer(binaryCodec.encodeServer(welcome(seq)));
      expect(decoded).toEqual(welcome(seq));
      expect(decoded.t === "welcome" && decoded.seq).toBe(seq);
    }
  });

  it("rejects a seq outside uint32 on encode", () => {
    expect(() => binaryCodec.encodeServer(welcome(4294967296))).toThrow(RangeError);
    expect(() => binaryCodec.encodeServer(welcome(-1))).toThrow(RangeError);
  });

  it("throws when the seq bytes are missing", () => {
    const frame = binaryCodec.encodeServer(welcome(3)) as Uint8Array;
    // tag, selfId "me", chunkId "classic:0:0" then seq: drop the seq and everything after it.
    const cut = 1 + 1 + 2 + 1 + 11;
    expect(() => binaryCodec.decodeServer(frame.subarray(0, cut + 2))).toThrow(/truncated/);
  });
});

describe("binaryCodec size", () => {
  it("is smaller than jsonCodec for a 200-entity welcome", () => {
    const msg = makeWelcome(200);
    const json = jsonCodec.encodeServer(msg);
    const binary = binaryCodec.encodeServer(msg) as Uint8Array;
    const jsonBytes = new TextEncoder().encode(json as string).length;
    console.log(`welcome(200 entities): json=${jsonBytes} bytes, binary=${binary.length} bytes`);
    expect(binary.length).toBeLessThan(jsonBytes);
  });
});

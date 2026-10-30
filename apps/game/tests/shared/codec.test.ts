import { binaryCodec, jsonCodec, type ClientMessage, type ServerMessage } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  codec,
  CODEC_QUERY,
  codecByName,
  decodeClientFrame,
  decodeServerFrame,
  encodeClientFrame,
  encodeServerFrame,
  legacyCodec,
} from "../../src/shared/codec.ts";

const pong: ServerMessage = { t: "pong", clientTime: 12, serverTime: 3400 };

describe("presence wire codec", () => {
  it("speaks binary now and keeps JSON as the legacy format", () => {
    expect(codec).toBe(binaryCodec);
    expect(legacyCodec).toBe(jsonCodec);
    expect(CODEC_QUERY).toBe(`codec=${codec.name}`);
  });

  it("answers a socket in the codec it announced, and JSON when it announced nothing", () => {
    expect(codecByName(codec.name)).toBe(codec);
    expect(codecByName("json")).toBe(legacyCodec);
    expect(codecByName(null)).toBe(legacyCodec);
    expect(codecByName(undefined)).toBe(legacyCodec);
    expect(codecByName("unknown")).toBe(legacyCodec);
  });

  it("decodes a server frame by its type: text is JSON, bytes are binary", () => {
    const asJson = legacyCodec.encodeServer(pong);
    const asBinary = codec.encodeServer(pong);
    expect(typeof asJson).toBe("string");
    expect(asBinary).toBeInstanceOf(Uint8Array);
    expect(decodeServerFrame(asJson)).toEqual(pong);
    expect(decodeServerFrame(asBinary)).toEqual(pong);
    const buffer = (asBinary as Uint8Array).slice().buffer;
    expect(decodeServerFrame(buffer)).toEqual(pong);
  });

  it("decodes a client frame by its type", () => {
    const ping = { t: "ping" as const, clientTime: 7 };
    expect(decodeClientFrame(legacyCodec.encodeClient(ping))).toEqual(ping);
    expect(decodeClientFrame(codec.encodeClient(ping))).toEqual(ping);
  });

  it("falls back to a JSON text frame when a message does not fit the binary codec", () => {
    // seq is a uint32 in the binary codec; JSON carries any number.
    const delta: ServerMessage = { t: "delta", chunkId: "c", seq: -1, upserts: [], removes: [] };
    expect(() => codec.encodeServer(delta)).toThrow(RangeError);
    const frame = encodeServerFrame(codec, delta);
    expect(typeof frame).toBe("string");
    expect(decodeServerFrame(frame)).toEqual(delta);
    expect(encodeServerFrame(codec, pong)).toBeInstanceOf(Uint8Array);
    expect(typeof encodeServerFrame(legacyCodec, pong)).toBe("string");

    const pose: ClientMessage = { t: "pose", pos: { x: -1, y: 0 }, path: [], speed: 4 };
    const sent = encodeClientFrame(pose);
    expect(typeof sent).toBe("string");
    expect(decodeClientFrame(sent)).toEqual(pose);
    expect(encodeClientFrame({ t: "ping", clientTime: 7 })).toBeInstanceOf(Uint8Array);
  });
});

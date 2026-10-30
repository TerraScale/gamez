import { binaryCodec, jsonCodec, type ServerMessage } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  codec,
  CODEC_QUERY,
  codecByName,
  decodeClientFrame,
  decodeServerFrame,
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
});

import { describe, test } from "vite-plus/test";
import { binaryCodec, jsonCodec } from "../src/index.ts";
import { makeDelta, makeWelcome } from "../tests/fixtures.ts";

const welcome = makeWelcome(200);
const delta = makeDelta();

describe("welcome, 200 entities", () => {
  test("encode + decode", async ({ bench }) => {
    await bench.compare(
      bench("json", () => {
        jsonCodec.decodeServer(jsonCodec.encodeServer(welcome));
      }),
      bench("binary", () => {
        binaryCodec.decodeServer(binaryCodec.encodeServer(welcome));
      }),
    );
  });
});

describe("small delta", () => {
  test("encode + decode", async ({ bench }) => {
    await bench.compare(
      bench("json", () => {
        jsonCodec.decodeServer(jsonCodec.encodeServer(delta));
      }),
      bench("binary", () => {
        binaryCodec.decodeServer(binaryCodec.encodeServer(delta));
      }),
    );
  });
});

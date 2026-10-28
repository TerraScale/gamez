import { describe, expect, it } from "vite-plus/test";
import { parseServerMessage } from "../../src/client/instance/messages.ts";
import { MAX_CLIENT_FRAME, parseClientMessage } from "../../src/server/instance/messages.ts";
import { parseVerifiedClientMessage } from "../../src/server/instance/verified-messages.ts";
import { MAX_VERIFIED_CLIENT_FRAME } from "@gamez/protocol";

const snapshot = {
  modeId: "m",
  contentHash: "abc",
  tick: 0,
  rng: [1, 2, 3, 4],
  world: { nextEntity: 1, components: {}, resources: {} },
};

describe("parseClientMessage", () => {
  it("accepts valid messages", () => {
    expect(parseClientMessage('{"t":"join","token":"x","mode":"steps"}')).toEqual({
      t: "join",
      token: "x",
      mode: "steps",
      fresh: false,
    });
    expect(parseClientMessage('{"t":"join","token":"x","mode":"steps","fresh":true}')).toEqual({
      t: "join",
      token: "x",
      mode: "steps",
      fresh: true,
    });
    expect(parseClientMessage('{"t":"action","seq":3,"name":"a.b","payload":{"x":1}}')).toEqual({
      t: "action",
      seq: 3,
      name: "a.b",
      payload: { x: 1 },
    });
    expect(parseClientMessage('{"t":"action","seq":1,"name":"a"}')).toMatchObject({
      payload: null,
    });
    expect(parseClientMessage('{"t":"ping","clientTime":12.5}')).toEqual({
      t: "ping",
      clientTime: 12.5,
    });
  });

  it("decodes binary frames as UTF-8 JSON", () => {
    const frame = new TextEncoder().encode('{"t":"ping","clientTime":1}').buffer;
    expect(parseClientMessage(frame)).toEqual({ t: "ping", clientTime: 1 });
  });

  it("rejects malformed messages", () => {
    const bad = [
      "",
      "nope",
      "null",
      "[]",
      '{"t":"hello"}',
      '{"t":"join","mode":"steps"}',
      '{"t":"join","token":"x","mode":""}',
      '{"t":"join","token":"x","mode":"steps","fresh":"yes"}',
      '{"t":"action","seq":0,"name":"a"}',
      '{"t":"action","seq":1.5,"name":"a"}',
      '{"t":"action","seq":"1","name":"a"}',
      '{"t":"action","seq":1,"name":""}',
      '{"t":"action","seq":1}',
      '{"t":"ping"}',
      '{"t":"ping","clientTime":"now"}',
    ];
    for (const frame of bad) expect(parseClientMessage(frame), frame).toBeNull();
  });

  it("rejects oversized frames", () => {
    const payload = "x".repeat(MAX_CLIENT_FRAME);
    expect(parseClientMessage(JSON.stringify({ t: "action", seq: 1, name: "a", payload }))).toBe(
      null,
    );
  });
});

describe("parseServerMessage", () => {
  it("accepts valid messages", () => {
    const state = {
      t: "state",
      instanceId: "i",
      mode: "m",
      contentHash: "abc",
      lastSeq: 0,
      snapshot,
    };
    expect(parseServerMessage(JSON.stringify(state))).toEqual(state);
    const result = {
      t: "result",
      seq: 1,
      ok: false,
      error: { code: "c", message: "m" },
      events: [],
      snapshot,
    };
    expect(parseServerMessage(JSON.stringify(result))).toEqual(result);
    expect(parseServerMessage('{"t":"pong","clientTime":1,"serverTime":2}')).toMatchObject({
      t: "pong",
    });
    expect(parseServerMessage('{"t":"error","code":"x","message":"y"}')).toMatchObject({
      t: "error",
    });
  });

  it("rejects malformed messages", () => {
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
    expect(parseServerMessage("{")).toBeNull();
    expect(parseServerMessage('{"t":"state","instanceId":"i"}')).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({ t: "result", seq: 1, ok: true, events: [], snapshot: {} }),
      ),
    ).toBeNull();
    expect(parseServerMessage('{"t":"error","code":1}')).toBeNull();
  });
});

describe("parseVerifiedClientMessage gzip64 import frames", () => {
  const importFrame = (data: string) =>
    JSON.stringify({ t: "import", savedAt: 1, snapshot: { enc: "gzip64", data } });

  it("accepts a small gzip64 import", () => {
    expect(parseVerifiedClientMessage(importFrame("H4sIAAAAAAAAA"))).toMatchObject({
      t: "import",
      snapshot: { enc: "gzip64" },
    });
  });

  it("refuses gzip64 data longer than the frame cap", () => {
    const data = "A".repeat(MAX_VERIFIED_CLIENT_FRAME + 4);
    expect(parseVerifiedClientMessage(importFrame(data))).toBeNull();
    expect(
      parseVerifiedClientMessage(new TextEncoder().encode(importFrame(data)).buffer),
    ).toBeNull();
  });
});

import type { EntityState, ServerMessage, TilePos } from "../src/messages.ts";

/** Deterministic entity with a path of `pathLen` tiles, so tests and benchmarks share one shape. */
export function makeEntity(i: number, pathLen = 4): EntityState {
  const path: TilePos[] = Array.from({ length: pathLen }, (_, k) => ({
    x: (i + k) % 48,
    y: (i * 3 + k) % 48,
  }));
  return {
    id: `char-${i}`,
    kind: i % 5 === 0 ? "ghost" : "player",
    name: `Hero ${i}`,
    appearance: "unit.hero",
    pos: { x: i % 48, y: (i * 7) % 48 },
    path,
    pathStartedAt: 1_767_225_600_000 + i * 13.37,
    speed: 2.5 + (i % 3) * 0.25,
  };
}

export function makeWelcome(count: number): ServerMessage {
  return {
    t: "welcome",
    selfId: "char-0",
    chunkId: "chunk:0:0",
    seq: 1041,
    serverTime: 1_767_225_600_123.5,
    entities: Array.from({ length: count }, (_, i) => makeEntity(i)),
  };
}

export function makeDelta(): ServerMessage {
  return {
    t: "delta",
    chunkId: "chunk:0:0",
    seq: 1042,
    upserts: [makeEntity(7, 2)],
    removes: ["char-3"],
  };
}

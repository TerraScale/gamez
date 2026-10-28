import { SYNC_CURSOR_DDL, type Projection } from "../src/index.ts";
import { FakeD1Database } from "./fakes.ts";

export const CHARACTER_SUMMARY_DDL = `CREATE TABLE character_summary (
  id TEXT PRIMARY KEY,
  name TEXT,
  level INTEGER,
  _version INTEGER NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _updated_at INTEGER NOT NULL
)`;

export interface Summary {
  name: string;
  level: number;
}

export const characterSummary: Projection<Summary> = {
  table: "character_summary",
  pkColumn: "id",
  toRow: (p) => ({ name: p.name, level: p.level }),
};

/** A D1 fake with the character_summary projection table and sync_cursor. */
export async function setupD1(): Promise<FakeD1Database> {
  const d1 = new FakeD1Database();
  await d1.exec(CHARACTER_SUMMARY_DDL);
  await d1.exec(SYNC_CURSOR_DDL);
  return d1;
}

/** Seeded PRNG (mulberry32) returning floats in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

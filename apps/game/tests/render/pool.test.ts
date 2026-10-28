import { describe, expect, it } from "vite-plus/test";
import { Pool } from "../../src/client/render/pool.ts";

interface Item {
  id: number;
  reset: number;
}

function makePool(max: number) {
  let next = 0;
  const created: Item[] = [];
  const pool = new Pool<Item>(
    () => {
      const item = { id: next++, reset: 0 };
      created.push(item);
      return item;
    },
    (item) => {
      item.reset++;
    },
    max,
  );
  return { pool, created };
}

describe("Pool", () => {
  it("creates items on demand up to the cap", () => {
    const { pool, created } = makePool(3);
    pool.spawn();
    pool.spawn();
    expect(created).toHaveLength(2);
    expect(pool.active).toHaveLength(2);
    expect(pool.size).toBe(2);
  });

  it("reuses retired items instead of creating new ones", () => {
    const { pool, created } = makePool(3);
    const a = pool.spawn();
    pool.spawn();
    pool.retire(a);
    const again = pool.spawn();
    expect(again).toBe(a);
    expect(created).toHaveLength(2);
    expect(a.reset).toBe(1);
  });

  it("recycles the oldest active item when full", () => {
    const { pool, created } = makePool(2);
    const first = pool.spawn();
    const second = pool.spawn();
    const third = pool.spawn();
    expect(created).toHaveLength(2);
    expect(third).toBe(first);
    expect(first.reset).toBe(1);
    expect(pool.active).toEqual([second, first]);
  });

  it("ignores retiring an item it does not own", () => {
    const { pool } = makePool(2);
    pool.spawn();
    pool.retire({ id: 99, reset: 0 });
    expect(pool.active).toHaveLength(1);
  });

  it("drains every item, active and idle", () => {
    const { pool } = makePool(4);
    const a = pool.spawn();
    pool.spawn();
    pool.retire(a);
    const seen: number[] = [];
    pool.drain((item) => seen.push(item.id));
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1]);
    expect(pool.active).toHaveLength(0);
    expect(pool.size).toBe(0);
  });
});

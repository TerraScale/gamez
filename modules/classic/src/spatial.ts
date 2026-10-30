/**
 * Spatial grid for unit queries (CONTRACT, implemented). Derived data: it is
 * NOT stored in the world (snapshots would clone it). One grid per World
 * object lives in a WeakMap and is rebuilt from scratch every tick by
 * classic.core.spatial (pre -1000), so it is always a pure function of the
 * world state and rollback/restore cannot desync it.
 *
 * Contents: entities of the current area that have Pos + Body and no Dead.
 * classic.core.movement calls grid.move() after moving a unit and
 * classic.monsters.spawn inserts new units, so queries stay exact within a
 * tick; anything else that moves a unit (blink, knockback, dash) must call
 * grid.move() too. Query results are sorted by entity id (deterministic).
 */
import type { Entity, World } from "@gamez/kernel";
import { AreaTag, Body, Dead, Pos } from "./components.ts";
import { currentDepth } from "./resources.ts";

/** Cell size in sub units (4 tiles). */
export const GRID_CELL = 1024;

/** Ascending ids (hoisted so queries allocate no comparator). */
const byId = (a: Entity, b: Entity): number => a - b;

export class SpatialGrid {
  private cols = 0;
  private rows = 0;
  /**
   * Per cell, parallel arrays of the first `count[cell]` units and their
   * positions. Order inside a cell is arbitrary (removal swaps with the last
   * unit): every query sorts its result by id. The arrays are reused across
   * rebuilds, so a rebuild resets counters instead of truncating 1000+ arrays.
   */
  private cellE: Entity[][] = [];
  private cellX: number[][] = [];
  private cellY: number[][] = [];
  private count = new Int32Array(0);
  /** Cell of every indexed unit. */
  private readonly where = new Map<Entity, number>();
  /** Tick of the last rebuild (diagnostics). */
  builtTick = -1;

  /** Clears and re-inserts every live unit of the current area. `widthTiles`/`heightTiles` bound the grid. */
  rebuild(world: World, widthTiles: number, heightTiles: number, tick: number): void {
    this.cols = Math.max(1, Math.ceil((widthTiles * 256) / GRID_CELL));
    this.rows = Math.max(1, Math.ceil((heightTiles * 256) / GRID_CELL));
    const n = this.cols * this.rows;
    if (this.cellE.length !== n) {
      this.cellE = Array.from({ length: n }, () => []);
      this.cellX = Array.from({ length: n }, () => []);
      this.cellY = Array.from({ length: n }, () => []);
      this.count = new Int32Array(n);
    } else this.count.fill(0);
    this.where.clear();
    const depth = currentDepth(world);
    for (const e of world.query(Pos, Body, AreaTag)) {
      if (world.peek(e, AreaTag)!.depth !== depth || world.has(e, Dead)) continue;
      const p = world.peek(e, Pos)!;
      this.insert(e, p.x, p.y);
    }
    this.builtTick = tick;
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / GRID_CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / GRID_CELL)));
    return cy * this.cols + cx;
  }

  /** Appends a unit to a cell. */
  private push(cell: number, e: Entity, x: number, y: number): void {
    const i = this.count[cell]!;
    this.cellE[cell]![i] = e;
    this.cellX[cell]![i] = x;
    this.cellY[cell]![i] = y;
    this.count[cell] = i + 1;
  }

  /** Index of `e` in its cell, or -1. */
  private indexIn(cell: number, e: Entity): number {
    const es = this.cellE[cell]!;
    const n = this.count[cell]!;
    for (let i = 0; i < n; i++) if (es[i] === e) return i;
    return -1;
  }

  /** Removes slot `i` of a cell (swaps the last unit into it). */
  private cut(cell: number, i: number): void {
    const last = this.count[cell]! - 1;
    const es = this.cellE[cell]!;
    const xs = this.cellX[cell]!;
    const ys = this.cellY[cell]!;
    es[i] = es[last]!;
    xs[i] = xs[last]!;
    ys[i] = ys[last]!;
    this.count[cell] = last;
  }

  has(e: Entity): boolean {
    return this.where.has(e);
  }

  insert(e: Entity, x: number, y: number): void {
    if (this.cellE.length === 0) return;
    if (this.where.has(e)) {
      this.move(e, x, y);
      return;
    }
    const cell = this.cellOf(x, y);
    this.push(cell, e, x, y);
    this.where.set(e, cell);
  }

  move(e: Entity, x: number, y: number): void {
    const from = this.where.get(e);
    if (from === undefined) {
      this.insert(e, x, y);
      return;
    }
    const cell = this.cellOf(x, y);
    const i = this.indexIn(from, e);
    if (cell === from && i >= 0) {
      this.cellX[cell]![i] = x;
      this.cellY[cell]![i] = y;
      return;
    }
    if (i >= 0) this.cut(from, i);
    this.push(cell, e, x, y);
    this.where.set(e, cell);
  }

  remove(e: Entity): void {
    const cell = this.where.get(e);
    if (cell === undefined) return;
    const i = this.indexIn(cell, e);
    if (i >= 0) this.cut(cell, i);
    this.where.delete(e);
  }

  /** Entities within `r` sub of (x, y) (inclusive), sorted by id. Pass `out` to reuse an array. */
  query(x: number, y: number, r: number, out: Entity[] = []): Entity[] {
    out.length = 0;
    if (this.cellE.length === 0) return out;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor((x - r) / GRID_CELL));
    const x1 = Math.min(this.cols - 1, Math.floor((x + r) / GRID_CELL));
    const y0 = Math.max(0, Math.floor((y - r) / GRID_CELL));
    const y1 = Math.min(this.rows - 1, Math.floor((y + r) / GRID_CELL));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = cy * this.cols + cx;
        const n = this.count[cell]!;
        if (n === 0) continue;
        const es = this.cellE[cell]!;
        const xs = this.cellX[cell]!;
        const ys = this.cellY[cell]!;
        for (let i = 0; i < n; i++) {
          const dx = xs[i]! - x;
          const dy = ys[i]! - y;
          if (dx * dx + dy * dy <= r2) out.push(es[i]!);
        }
      }
    }
    return out.length > 1 ? out.sort(byId) : out;
  }

  /**
   * Closest entity within `r` that passes `filter` (ties -> lower id), or 0.
   */
  nearest(x: number, y: number, r: number, filter: (e: Entity) => boolean): Entity {
    let best = 0;
    let bestD = Infinity;
    for (const e of this.query(x, y, r)) {
      if (!filter(e)) continue;
      const cell = this.where.get(e)!;
      const i = this.indexIn(cell, e);
      const dx = this.cellX[cell]![i]! - x;
      const dy = this.cellY[cell]![i]! - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** Number of indexed units. */
  get size(): number {
    return this.where.size;
  }
}

const grids = new WeakMap<World, SpatialGrid>();

/** The grid of this world (empty until the first rebuild). */
export function gridOf(world: World): SpatialGrid {
  let g = grids.get(world);
  if (!g) {
    g = new SpatialGrid();
    grids.set(world, g);
  }
  return g;
}

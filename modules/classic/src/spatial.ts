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

export class SpatialGrid {
  private cols = 0;
  private rows = 0;
  private cells: Entity[][] = [];
  private readonly where = new Map<Entity, { x: number; y: number; cell: number }>();
  /** Tick of the last rebuild (diagnostics). */
  builtTick = -1;

  /** Clears and re-inserts every live unit of the current area. `widthTiles`/`heightTiles` bound the grid. */
  rebuild(world: World, widthTiles: number, heightTiles: number, tick: number): void {
    this.cols = Math.max(1, Math.ceil((widthTiles * 256) / GRID_CELL));
    this.rows = Math.max(1, Math.ceil((heightTiles * 256) / GRID_CELL));
    const n = this.cols * this.rows;
    if (this.cells.length !== n) this.cells = Array.from({ length: n }, () => []);
    else for (const c of this.cells) c.length = 0;
    this.where.clear();
    const depth = currentDepth(world);
    for (const e of world.query(Pos, Body, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth || world.has(e, Dead)) continue;
      const p = world.read(e, Pos);
      this.insert(e, p.x, p.y);
    }
    this.builtTick = tick;
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / GRID_CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / GRID_CELL)));
    return cy * this.cols + cx;
  }

  has(e: Entity): boolean {
    return this.where.has(e);
  }

  insert(e: Entity, x: number, y: number): void {
    if (this.cells.length === 0) return;
    if (this.where.has(e)) {
      this.move(e, x, y);
      return;
    }
    const cell = this.cellOf(x, y);
    this.cells[cell]!.push(e);
    this.where.set(e, { x, y, cell });
  }

  move(e: Entity, x: number, y: number): void {
    const w = this.where.get(e);
    if (!w) {
      this.insert(e, x, y);
      return;
    }
    const cell = this.cellOf(x, y);
    if (cell !== w.cell) {
      const list = this.cells[w.cell]!;
      const at = list.indexOf(e);
      if (at >= 0) list.splice(at, 1);
      this.cells[cell]!.push(e);
      w.cell = cell;
    }
    w.x = x;
    w.y = y;
  }

  remove(e: Entity): void {
    const w = this.where.get(e);
    if (!w) return;
    const list = this.cells[w.cell]!;
    const at = list.indexOf(e);
    if (at >= 0) list.splice(at, 1);
    this.where.delete(e);
  }

  /** Entities within `r` sub of (x, y) (inclusive), sorted by id. Pass `out` to reuse an array. */
  query(x: number, y: number, r: number, out: Entity[] = []): Entity[] {
    out.length = 0;
    if (this.cells.length === 0) return out;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor((x - r) / GRID_CELL));
    const x1 = Math.min(this.cols - 1, Math.floor((x + r) / GRID_CELL));
    const y0 = Math.max(0, Math.floor((y - r) / GRID_CELL));
    const y1 = Math.min(this.rows - 1, Math.floor((y + r) / GRID_CELL));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (const e of this.cells[cy * this.cols + cx]!) {
          const w = this.where.get(e)!;
          const dx = w.x - x;
          const dy = w.y - y;
          if (dx * dx + dy * dy <= r2) out.push(e);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * Closest entity within `r` that passes `filter` (ties -> lower id), or 0.
   */
  nearest(x: number, y: number, r: number, filter: (e: Entity) => boolean): Entity {
    let best = 0;
    let bestD = Infinity;
    for (const e of this.query(x, y, r)) {
      if (!filter(e)) continue;
      const w = this.where.get(e)!;
      const d = (w.x - x) * (w.x - x) + (w.y - y) * (w.y - y);
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

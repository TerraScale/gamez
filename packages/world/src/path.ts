import type { TilePos } from "@gamez/protocol";
import { inBounds, isWalkable, tileIndex, type TileMap } from "./map.ts";

const SQRT2 = Math.SQRT2;
const DIAG_EXTRA = SQRT2 - 1;

/** Octile distance: exact lower bound for 8-directional moves with unit and sqrt(2) costs. */
function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + DIAG_EXTRA * Math.min(dx, dy);
}

/**
 * Binary min-heap of open nodes ordered by (f, h, insertion sequence).
 * Parallel arrays keep pushes allocation-free.
 */
class OpenSet {
  private readonly node: number[] = [];
  private readonly f: number[] = [];
  private readonly h: number[] = [];
  private readonly seq: number[] = [];
  private nextSeq = 0;

  get size(): number {
    return this.node.length;
  }

  push(node: number, f: number, h: number): void {
    this.node.push(node);
    this.f.push(f);
    this.h.push(h);
    this.seq.push(this.nextSeq++);
    let i = this.node.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.node[0] ?? -1;
    const last = this.node.length - 1;
    this.swap(0, last);
    this.node.pop();
    this.f.pop();
    this.h.pop();
    this.seq.pop();
    let i = 0;
    const n = this.node.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }

  private less(i: number, j: number): boolean {
    const fi = this.f[i] ?? 0;
    const fj = this.f[j] ?? 0;
    if (fi !== fj) return fi < fj;
    const hi = this.h[i] ?? 0;
    const hj = this.h[j] ?? 0;
    if (hi !== hj) return hi < hj;
    return (this.seq[i] ?? 0) < (this.seq[j] ?? 0);
  }

  private swap(i: number, j: number): void {
    swapAt(this.node, i, j);
    swapAt(this.f, i, j);
    swapAt(this.h, i, j);
    swapAt(this.seq, i, j);
  }
}

function swapAt(a: number[], i: number, j: number): void {
  const t = a[i] ?? 0;
  a[i] = a[j] ?? 0;
  a[j] = t;
}

/**
 * A* over the walkable grid with 8-directional movement.
 * - Diagonal steps cost sqrt(2); a diagonal step is only allowed when both
 *   orthogonal neighbours are walkable (no corner cutting).
 * - Returns the tiles to walk excluding `from` and including `to`.
 * - Returns [] when from === to; returns null when `to` is blocked/out of
 *   bounds or unreachable.
 * - Deterministic: ties broken by lower f, then lower h, then insertion order,
 *   so client and server compute identical paths.
 * - Gives up (returns null) after expanding `maxNodes` nodes.
 */
export function findPath(
  map: TileMap,
  from: TilePos,
  to: TilePos,
  maxNodes = 20_000,
): TilePos[] | null {
  if (!isWalkable(map, to.x, to.y) || !inBounds(map, from.x, from.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];

  const { width } = map;
  const count = width * map.height;
  const start = tileIndex(map, from.x, from.y);
  const goal = tileIndex(map, to.x, to.y);
  const gScore = new Float64Array(count).fill(Infinity);
  const parent = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const open = new OpenSet();

  gScore[start] = 0;
  const h0 = octile(from.x, from.y, to.x, to.y);
  open.push(start, h0, h0);

  let expanded = 0;
  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue;
    if (cur === goal) {
      const path: TilePos[] = [];
      for (let i = goal; i !== start; i = parent[i] ?? start) {
        path.push({ x: i % width, y: Math.floor(i / width) });
      }
      return path.reverse();
    }
    if (++expanded > maxNodes) return null;
    closed[cur] = 1;

    const cx = cur % width;
    const cy = Math.floor(cur / width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!isWalkable(map, nx, ny)) continue;
        const diagonal = dx !== 0 && dy !== 0;
        if (diagonal && (!isWalkable(map, cx + dx, cy) || !isWalkable(map, cx, cy + dy))) continue;
        const ni = tileIndex(map, nx, ny);
        if (closed[ni]) continue;
        const g = (gScore[cur] ?? 0) + (diagonal ? SQRT2 : 1);
        if (g < (gScore[ni] ?? Infinity)) {
          gScore[ni] = g;
          parent[ni] = cur;
          const h = octile(nx, ny, to.x, to.y);
          open.push(ni, g + h, h);
        }
      }
    }
  }
  return null;
}

/** Seconds needed to walk `path` starting at `from` at `speed` tiles/s (diagonals count sqrt(2)). */
export function pathDuration(from: TilePos, path: TilePos[], speed: number): number {
  let dist = 0;
  let prev = from;
  for (const p of path) {
    dist += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return dist / speed;
}

/**
 * Fractional position along a path at `elapsed` seconds. Used by clients to
 * interpolate and by the server to know where a walker is right now.
 */
export function positionAlong(
  from: TilePos,
  path: TilePos[],
  speed: number,
  elapsed: number,
): { x: number; y: number; done: boolean } {
  let remaining = Math.max(0, elapsed) * speed;
  let prev = from;
  for (const p of path) {
    const seg = Math.hypot(p.x - prev.x, p.y - prev.y);
    if (remaining < seg) {
      const t = remaining / seg;
      return { x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t, done: false };
    }
    remaining -= seg;
    prev = p;
  }
  return { x: prev.x, y: prev.y, done: true };
}

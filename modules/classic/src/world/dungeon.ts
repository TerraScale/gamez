/**
 * Dungeon level generator (classic.world, design §9.2). PURE: the level is a
 * function of (registry, worldSeed, depth) only, drawn from
 * createRng(mix(worldSeed, depth)). It never touches ctx.rng, so every sim,
 * the renderer and the server see the identical level.
 *
 * Steps: rooms by rejection sampling -> spanning tree over room centres plus
 * loop corridors -> L-shaped corridors (2 wide, 3 in caves) -> doors ->
 * features (stairs, waypoint, boss spot) -> walls -> perimeter decor ->
 * validation (every room reachable from the spawn; decor is dropped if not).
 */
import { createRng, type FrozenRegistry, type Rng } from "@gamez/kernel";
import { mix, type TilePos } from "../fixed.ts";
import { isBossDepth, isWaypointDepth, MAIN_DUNGEON_DEPTH, tierOf } from "../rules.ts";
import type { Rect } from "../types.ts";
import {
  balanceOf,
  centreOf,
  DEFAULT_LEVEL,
  distAt,
  distancesFrom,
  looksOf,
  pickTheme,
  filled,
  tileKey,
  type ThemePick,
} from "./common.ts";
import type { ClassicMap } from "./maps.ts";

const ROCK = 0;
const ROOM = 1;
const CORRIDOR = 2;
const DOOR = 3;

/** Clear gap, in tiles, kept between two rooms. */
const ROOM_GAP = 2;
/** Loop corridors prefer room pairs at most this far apart (Manhattan, tiles). */
const LOOP_MAX_DIST = 48;
/** Extra loop corridors, percent of the spanning-tree edges. */
const LOOP_SHARE_PCT = 15;
/** Chance (percent) that a room perimeter tile gets a decor prop. */
const DECOR_PCT = 12;
/** Decor keeps this many tiles away from doors and stairs. */
const DECOR_CLEARANCE = 2;

/**
 * Shape of a level. Dungeon levels take it from the balance proto and the
 * theme cycle; Rift levels (wave A, ./riftMap.ts) pass their own. `rift`
 * levels have no stairs at all (the rift exit appears when the guardian dies).
 */
export interface LevelShape {
  width: number;
  height: number;
  rooms: [number, number];
  roomSize: [number, number];
  theme: ThemePick;
  /** Display name of the map. */
  name: string;
  rift: boolean;
}

/** Generates the dungeon level `depth` (>= 1). `shape` overrides the balance-driven default. */
export function buildDungeon(
  registry: FrozenRegistry,
  worldSeed: number,
  depth: number,
  shape?: LevelShape,
): ClassicMap {
  const bal = balanceOf(registry);
  const rift = shape?.rift ?? false;
  const width = shape?.width ?? bal?.levelWidth ?? DEFAULT_LEVEL.width;
  const height = shape?.height ?? bal?.levelHeight ?? DEFAULT_LEVEL.height;
  const roomCount = shape?.rooms ?? bal?.rooms ?? DEFAULT_LEVEL.rooms;
  const roomSize = shape?.roomSize ?? bal?.roomSize ?? DEFAULT_LEVEL.roomSize;
  const theme = shape?.theme ?? pickTheme(registry, depth);
  const looks = looksOf(theme.proto);
  // The main dungeon ends at MAIN_DUNGEON_DEPTH: no stairs down there (wave A).
  const hasUp = !rift;
  const hasDown = !rift && depth < MAIN_DUNGEON_DEPTH;
  const caves = tierOf(depth) === 1;
  const corridorWidth = caves ? 3 : 2;
  const rng = createRng(mix(worldSeed, depth));
  const n = width * height;
  const kind = new Uint8Array(n);
  const blocked = new Uint8Array(n);

  // 1-2. Rooms and corridors.
  const rooms = placeRooms(rng, width, height, roomCount, roomSize);
  for (const r of rooms) fillRoom(kind, width, r);
  connectRooms(rng, kind, width, height, rooms, corridorWidth);
  if (caves) smoothCorridors(rng, kind, width, height);
  const r0 = rooms[0] ?? { x: 1, y: 1, w: 3, h: 3 };
  const spawn: TilePos = { x: r0.x + 2, y: r0.y + 1 };
  const spawnIdx = tileKey(width, spawn.x, spawn.y);
  repairConnectivity(rng, kind, width, height, rooms, corridorWidth, spawnIdx);

  // 3. Doors where corridors enter rooms.
  markDoors(kind, width, height);

  // 4. Features: stairs up (arrival) in rooms[0], stairs down in the farthest room.
  const stairsUp: TilePos = { x: r0.x + 1, y: r0.y + 1 };
  const reach = distancesFrom(width, height, walkMask(kind, null), spawnIdx);
  const farIdx = farthestRoom(rooms, reach, width);
  const downRoom = farIdx >= 0 ? (rooms[farIdx] ?? r0) : r0;
  const stairsDown: TilePos =
    farIdx >= 0
      ? { x: downRoom.x + 1, y: downRoom.y + 1 }
      : { x: r0.x + r0.w - 2, y: r0.y + r0.h - 2 };
  const bossSpot = isBossDepth(depth) ? centreOf(downRoom) : null;
  const waypoint = isWaypointDepth(depth) && depth > 0 ? centreOf(r0) : null;

  // 5. Perimeter decor, kept away from doors and stairs.
  const decorId: (string | null)[] = filled<string | null>(n, null);
  const specials: TilePos[] = [stairsUp, stairsDown];
  if (waypoint) specials.push(waypoint);
  for (let i = 0; i < n; i++) if (kind[i] === DOOR) specials.push(indexToTile(i, width));
  if (looks.decor.length > 0) {
    placeDecor(rng, rooms, kind, width, specials, looks.decor, blocked, decorId);
  }
  // 6. Validation: everything important must stay reachable, else drop the decor.
  const reachNow = distancesFrom(width, height, walkMask(kind, blocked), spawnIdx);
  const mustReach = rooms.map(centreOf);
  if (hasUp) mustReach.push(stairsUp);
  if (hasDown) mustReach.push(stairsDown);
  if (waypoint) mustReach.push(waypoint);
  if (mustReach.some((p) => distAt(reachNow, width, p) < 0)) {
    blocked.fill(0);
    decorId.fill(null);
  }

  // 7. Tiles: ground, walls and objects.
  const ground: string[] = filled(n, "tile.void");
  const objects: (string | null)[] = filled<string | null>(n, null);
  const walkable: number[] = filled(n, 0);
  let walkableCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = tileKey(width, x, y);
      const k = kind[i] ?? ROCK;
      if (k === ROCK) {
        ground[i] = "tile.void";
        objects[i] = hasOpenNeighbour(kind, width, height, x, y) ? looks.wall : null;
        walkable[i] = 0;
        continue;
      }
      ground[i] = floorVariant(looks.floor, x, y);
      if (blocked[i] === 1) {
        objects[i] = decorId[i] ?? null;
        walkable[i] = 0;
        continue;
      }
      walkable[i] = 1;
      walkableCount++;
      if (k === DOOR) objects[i] = looks.door;
    }
  }
  if (hasUp) objects[tileKey(width, stairsUp.x, stairsUp.y)] = looks.stairsUp;
  if (hasDown) objects[tileKey(width, stairsDown.x, stairsDown.y)] = looks.stairsDown;
  if (waypoint) objects[tileKey(width, waypoint.x, waypoint.y)] = looks.waypoint;

  return {
    id: `classic.d${depth}`,
    width,
    height,
    ground,
    objects,
    walkable,
    spawn,
    depth,
    theme: theme.id,
    name: shape?.name ?? `${theme.name} - Level ${depth}`,
    rooms,
    stairsDown: hasDown ? stairsDown : null,
    stairsUp: hasUp ? stairsUp : null,
    waypoint,
    npcSpots: [],
    portalSpot: { x: spawn.x, y: spawn.y },
    stash: null,
    bossSpot,
    walkableCount,
  };
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** Rejection-sampled rooms; rooms[0] is the arrival room. Never empty. */
function placeRooms(
  rng: Rng,
  width: number,
  height: number,
  count: readonly [number, number],
  size: readonly [number, number],
): Rect[] {
  const minSize = Math.max(3, Math.min(size[0], size[1]));
  const maxSize = Math.max(minSize, size[0], size[1]);
  const lo = Math.max(1, Math.min(count[0], count[1]));
  const hi = Math.max(lo, count[0], count[1]);
  const want = rng.int(lo, hi);
  const rooms: Rect[] = [];
  const attempts = want * 200;
  for (let a = 0; a < attempts && rooms.length < want; a++) {
    const w = rng.int(minSize, maxSize);
    const h = rng.int(minSize, maxSize);
    const maxX = width - w - 2;
    const maxY = height - h - 2;
    if (maxX < 1 || maxY < 1) continue;
    const room: Rect = { x: rng.int(1, maxX), y: rng.int(1, maxY), w, h };
    if (rooms.some((other) => tooClose(other, room))) continue;
    rooms.push(room);
  }
  if (rooms.length === 0) {
    const w = Math.max(3, Math.min(maxSize, width - 2));
    const h = Math.max(3, Math.min(maxSize, height - 2));
    rooms.push({ x: 1, y: 1, w, h });
  }
  return rooms;
}

function tooClose(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w + ROOM_GAP &&
    b.x < a.x + a.w + ROOM_GAP &&
    a.y < b.y + b.h + ROOM_GAP &&
    b.y < a.y + a.h + ROOM_GAP
  );
}

function fillRoom(kind: Uint8Array, width: number, r: Rect): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) kind[tileKey(width, x, y)] = ROOM;
  }
}

// ---------------------------------------------------------------------------
// Corridors
// ---------------------------------------------------------------------------

/** Spanning tree (Prim over room centres, Manhattan distance) plus loop corridors. */
function connectRooms(
  rng: Rng,
  kind: Uint8Array,
  width: number,
  height: number,
  rooms: readonly Rect[],
  corridorWidth: number,
): void {
  const n = rooms.length;
  if (n < 2) return;
  const centres = rooms.map(centreOf);
  const dist = (a: number, b: number): number =>
    Math.abs((centres[a]?.x ?? 0) - (centres[b]?.x ?? 0)) +
    Math.abs((centres[a]?.y ?? 0) - (centres[b]?.y ?? 0));

  const tree = spanningTree(n, dist);
  const treeKeys = new Set(tree.map(([a, b]) => a * n + b));
  const candidates: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!treeKeys.has(i * n + j)) candidates.push([i, j]);
    }
  }
  const extraWanted = Math.max(1, Math.round(((n - 1) * LOOP_SHARE_PCT) / 100));
  const near = candidates.filter(([a, b]) => dist(a, b) <= LOOP_MAX_DIST);
  const pool = near.length >= extraWanted ? near : candidates;
  const extra = rng.shuffle(pool).slice(0, extraWanted);

  for (const [a, b] of [...tree, ...extra]) {
    carveL(
      kind,
      width,
      height,
      centres[a] ?? { x: 0, y: 0 },
      centres[b] ?? { x: 0, y: 0 },
      corridorWidth,
      rng.next() < 0.5,
    );
  }
}

/** Prim's algorithm; ties resolved by the lower index. Pairs are [low, high]. */
function spanningTree(n: number, dist: (a: number, b: number) => number): [number, number][] {
  const inTree: boolean[] = filled(n, false);
  const bestD: number[] = filled(n, Infinity);
  const bestFrom: number[] = filled(n, 0);
  inTree[0] = true;
  for (let j = 1; j < n; j++) {
    bestD[j] = dist(0, j);
    bestFrom[j] = 0;
  }
  const edges: [number, number][] = [];
  for (let step = 1; step < n; step++) {
    let pick = -1;
    for (let j = 0; j < n; j++) {
      if (inTree[j]) continue;
      if (pick < 0 || (bestD[j] ?? Infinity) < (bestD[pick] ?? Infinity)) pick = j;
    }
    if (pick < 0) break;
    inTree[pick] = true;
    const from = bestFrom[pick] ?? 0;
    edges.push([Math.min(from, pick), Math.max(from, pick)]);
    for (let j = 0; j < n; j++) {
      if (inTree[j]) continue;
      const d = dist(pick, j);
      if (d < (bestD[j] ?? Infinity)) {
        bestD[j] = d;
        bestFrom[j] = pick;
      }
    }
  }
  return edges;
}

/** L-shaped corridor between two tile centres: horizontal first or vertical first. */
function carveL(
  kind: Uint8Array,
  width: number,
  height: number,
  a: TilePos,
  b: TilePos,
  corridorWidth: number,
  horizontalFirst: boolean,
): void {
  if (horizontalFirst) {
    carveRow(kind, width, height, a.y, a.x, b.x, corridorWidth);
    carveColumn(kind, width, height, b.x, a.y, b.y, corridorWidth);
  } else {
    carveColumn(kind, width, height, a.x, a.y, b.y, corridorWidth);
    carveRow(kind, width, height, b.y, a.x, b.x, corridorWidth);
  }
}

function carveRow(
  kind: Uint8Array,
  width: number,
  height: number,
  y: number,
  x0: number,
  x1: number,
  corridorWidth: number,
): void {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    for (let k = 0; k < corridorWidth; k++) carveTile(kind, width, height, x, y + k);
  }
}

function carveColumn(
  kind: Uint8Array,
  width: number,
  height: number,
  x: number,
  y0: number,
  y1: number,
  corridorWidth: number,
): void {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let k = 0; k < corridorWidth; k++) carveTile(kind, width, height, x + k, y);
  }
}

/** Rock inside the playable area (the outer ring stays rock) becomes corridor. */
function carveTile(kind: Uint8Array, width: number, height: number, x: number, y: number): void {
  if (x < 1 || y < 1 || x > width - 2 || y > height - 2) return;
  const i = tileKey(width, x, y);
  if (kind[i] === ROCK) kind[i] = CORRIDOR;
}

/** Cave levels: one cellular-automata pass that roughens corridor edges. */
function smoothCorridors(rng: Rng, kind: Uint8Array, width: number, height: number): void {
  const cut: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = tileKey(width, x, y);
      if (kind[i] !== CORRIDOR) continue;
      let rock = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx !== 0 || dy !== 0) && kind[tileKey(width, x + dx, y + dy)] === ROCK) rock++;
        }
      }
      if (rock >= 5 && rng.next() < 0.5) cut.push(i);
    }
  }
  for (const i of cut) kind[i] = ROCK;
}

/** Joins every room that the spawn cannot reach with a direct corridor to the nearest reachable room. */
function repairConnectivity(
  rng: Rng,
  kind: Uint8Array,
  width: number,
  height: number,
  rooms: readonly Rect[],
  corridorWidth: number,
  spawnIdx: number,
): void {
  for (let guard = 0; guard <= rooms.length; guard++) {
    const reach = distancesFrom(width, height, walkMask(kind, null), spawnIdx);
    const centres = rooms.map(centreOf);
    const lost = centres.findIndex((c) => distAt(reach, width, c) < 0);
    if (lost < 0) return;
    const from = centres[lost] ?? { x: 0, y: 0 };
    let best = -1;
    let bestD = Infinity;
    centres.forEach((c, k) => {
      if (distAt(reach, width, c) < 0) return;
      const d = Math.abs(c.x - from.x) + Math.abs(c.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best < 0) return;
    carveL(kind, width, height, from, centres[best] ?? from, corridorWidth, rng.next() < 0.5);
  }
}

/** Corridor tiles touching a room become doors (walkable). */
function markDoors(kind: Uint8Array, width: number, height: number): void {
  const doors: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = tileKey(width, x, y);
      if (kind[i] !== CORRIDOR) continue;
      const touchesRoom =
        (x > 0 && kind[i - 1] === ROOM) ||
        (x < width - 1 && kind[i + 1] === ROOM) ||
        (y > 0 && kind[i - width] === ROOM) ||
        (y < height - 1 && kind[i + width] === ROOM);
      if (touchesRoom) doors.push(i);
    }
  }
  for (const i of doors) kind[i] = DOOR;
}

// ---------------------------------------------------------------------------
// Features and decor
// ---------------------------------------------------------------------------

/** Index of the room (>= 1) with the largest distance from the spawn; -1 when none is reachable. */
function farthestRoom(rooms: readonly Rect[], reach: Int32Array, width: number): number {
  let best = -1;
  let bestD = -1;
  for (let k = 1; k < rooms.length; k++) {
    const d = distAt(reach, width, centreOf(rooms[k] ?? { x: 0, y: 0, w: 1, h: 1 }));
    if (d > bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** Decor only on room perimeter tiles, never within DECOR_CLEARANCE of a door or stairs. */
function placeDecor(
  rng: Rng,
  rooms: readonly Rect[],
  kind: Uint8Array,
  width: number,
  specials: readonly TilePos[],
  decor: readonly string[],
  blocked: Uint8Array,
  decorId: (string | null)[],
): void {
  for (const room of rooms) {
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        const left = x === room.x;
        const right = x === room.x + room.w - 1;
        const top = y === room.y;
        const bottom = y === room.y + room.h - 1;
        // Perimeter only. A corner and its two edge neighbours stay free: props there
        // could wall the corner in.
        if (!(left || right || top || bottom)) continue;
        if (corners(room).some((c) => Math.abs(c.x - x) + Math.abs(c.y - y) <= 1)) continue;
        if (rng.int(1, 100) > DECOR_PCT) continue;
        const i = tileKey(width, x, y);
        if (kind[i] !== ROOM) continue;
        if (
          specials.some((s) => Math.max(Math.abs(s.x - x), Math.abs(s.y - y)) <= DECOR_CLEARANCE)
        ) {
          continue;
        }
        blocked[i] = 1;
        decorId[i] = decor[rng.int(0, decor.length - 1)] ?? null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Walkable mask: any non-rock tile that is not blocked by decor. */
function walkMask(kind: Uint8Array, blocked: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(kind.length);
  for (let i = 0; i < kind.length; i++) {
    const open = (kind[i] ?? ROCK) !== ROCK && (blocked === null || blocked[i] !== 1);
    out[i] = open ? 1 : 0;
  }
  return out;
}

function hasOpenNeighbour(
  kind: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if ((kind[tileKey(width, nx, ny)] ?? ROCK) !== ROCK) return true;
    }
  }
  return false;
}

function floorVariant(floor: readonly string[], x: number, y: number): string {
  return floor[mix(x, y) % floor.length] ?? floor[0] ?? "tile.dungeon.floor";
}

function indexToTile(i: number, width: number): TilePos {
  const x = i % width;
  return { x, y: (i - x) / width };
}

/** The four corner tiles of a rectangle. */
function corners(r: Rect): TilePos[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w - 1, y: r.y },
    { x: r.x, y: r.y + r.h - 1 },
    { x: r.x + r.w - 1, y: r.y + r.h - 1 },
  ];
}

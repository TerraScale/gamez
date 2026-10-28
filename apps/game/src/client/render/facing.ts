import { tileToScreen } from "@gamez/world";
import type { Facing } from "./types.ts";

/** The 8 iso facings as tile-space unit deltas; their screen directions come from tileToScreen. */
const FACING_DELTAS: [Facing, number, number][] = [
  ["n", -1, -1],
  ["ne", 0, -1],
  ["e", 1, -1],
  ["se", 1, 0],
  ["s", 1, 1],
  ["sw", 0, 1],
  ["w", -1, 1],
  ["nw", -1, 0],
];

const FACING_UNIT_SCREEN = FACING_DELTAS.map(([facing, dx, dy]) => {
  const { sx, sy } = tileToScreen(dx, dy);
  const len = Math.hypot(sx, sy);
  return { facing, ux: sx / len, uy: sy / len };
});

/**
 * Maps a tile-space movement delta to the closest of the 8 iso screen
 * directions. A zero delta faces south.
 */
export function facingFromDelta(dx: number, dy: number): Facing {
  if (dx === 0 && dy === 0) return "s";
  const { sx, sy } = tileToScreen(dx, dy);
  const len = Math.hypot(sx, sy);
  let best: Facing = "s";
  let bestDot = -Infinity;
  for (const dir of FACING_UNIT_SCREEN) {
    const dot = (dir.ux * sx + dir.uy * sy) / len;
    if (dot > bestDot) {
      bestDot = dot;
      best = dir.facing;
    }
  }
  return best;
}

import { DEFAULT_ISO, screenToTile, type IsoMetrics } from "@gamez/world";

/** Moves `current` toward `target` by an exponential step. `rate` is per second, so the result is frame-rate independent. */
export function smoothToward(current: number, target: number, dtMs: number, rate: number): number {
  return current + (target - current) * (1 - Math.exp((-rate * dtMs) / 1000));
}

/**
 * Tile under a point given in stage-local CSS px. (offsetX, offsetY) is the
 * world layer's position on the stage. Returns null outside the map.
 */
export function pickTile(
  screenX: number,
  screenY: number,
  offsetX: number,
  offsetY: number,
  width: number,
  height: number,
  m: IsoMetrics = DEFAULT_ISO,
): { x: number; y: number } | null {
  const t = screenToTile(screenX - offsetX, screenY - offsetY, m);
  const x = Math.floor(t.x);
  const y = Math.floor(t.y);
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return { x, y };
}

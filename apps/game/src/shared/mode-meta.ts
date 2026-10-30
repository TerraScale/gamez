/**
 * Light per-mode metadata for the mode picker. The browser lists modes from
 * here so the picker never imports the mode packages (their sims are large
 * and load only when a mode starts, see client/instance/modes.ts).
 *
 * Must match the `mode` specs in MODES (catalog.ts); tests/shared/mode-meta
 * fails when they drift.
 */
import type { ModeInfo } from "@gamez/protocol";

export const MODE_META: readonly ModeInfo[] = [
  {
    id: "classic",
    name: "Classic",
    description:
      "Idle isometric ARPG: dive a deep dungeon, slay monsters, loot, level up - by hand or on autopilot.",
    world: null,
  },
  {
    id: "duel",
    name: "Duel",
    description:
      "Turn-based creature battles. Pick moves, catch wild creatures, heal between fights.",
    world: null,
  },
  {
    id: "steps",
    name: "Steps",
    description: "Step-based roguelike: the world moves only when you do.",
    world: null,
  },
];

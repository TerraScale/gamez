/**
 * Catalog entry for the Town Plaza presence demo (the view lives in
 * classic.ts). Kept apart so the picker can list it without pulling the
 * plaza view into the main chunk.
 */
import type { ModeInfo } from "@gamez/protocol";

export const CLASSIC_WORLD = "classic-world";

/** Catalog entry for the plaza mode; the picker always lists it. */
export const classicInfo: ModeInfo = {
  id: "plaza",
  name: "Town Plaza",
  description:
    "Multiplayer presence demo: a shared isometric town. Tap to walk, meet other players.",
  world: CLASSIC_WORLD,
};

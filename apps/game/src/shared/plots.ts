/**
 * Shop plots per presence world (wave-C.md §5.1). CONTRACT (architect).
 * Pure data shared by the PlotAuctionDO (fixtures, auctions) and tests.
 * Classic town: "market street" along the east road (y 35-36), four plots
 * on each side, clear of the plaza, the NPC ring, the houses and the stairs
 * (modules/classic/src/world/town.ts). Clients never need this list: the
 * shopkeepers arrive as presence fixtures with their positions.
 */
import type { TilePos } from "@gamez/protocol";

export interface PlotSpec {
  id: string;
  pos: TilePos;
}

export const PLOTS: Readonly<Record<string, readonly PlotSpec[]>> = {
  "classic-town": [
    { id: "p1", pos: { x: 46, y: 33 } },
    { id: "p2", pos: { x: 50, y: 33 } },
    { id: "p3", pos: { x: 54, y: 33 } },
    { id: "p4", pos: { x: 58, y: 33 } },
    { id: "p5", pos: { x: 46, y: 38 } },
    { id: "p6", pos: { x: 50, y: 38 } },
    { id: "p7", pos: { x: 54, y: 38 } },
    { id: "p8", pos: { x: 58, y: 38 } },
  ],
};

/** Plots of a world ([] for worlds without shops). Own keys only. */
export function plotsOf(world: string): readonly PlotSpec[] {
  return Object.hasOwn(PLOTS, world) ? (PLOTS[world] ?? []) : [];
}

/** Fixture entity id of a plot's shopkeeper. */
export function shopFixtureId(plotId: string): string {
  return `shops:${plotId}`;
}

/**
 * Inputs of the wave A HUD section builders (CONTRACT, architect). Every
 * section lives in its own file of src/client/model/ and is called by
 * buildHud (hudModel.ts) at 10 Hz. Builders are pure: they read the world
 * and the registry, never mutate them, never throw for a missing resource or
 * component (return null / defaults), and allocate only small objects
 * (buildHud shares structure with the previous snapshot afterwards).
 */
import type { Entity, FrozenRegistry, World } from "@gamez/kernel";
import type { ItemInstance } from "../../types.ts";
import type { HeroView, ItemView } from "../contract.ts";

export interface ModelContext {
  world: World;
  registry: FrozenRegistry;
  /** Hero entity (0 = none: most builders return null). */
  hero: Entity;
  /** The hero view of this snapshot (null without a hero). */
  heroView: HeroView | null;
  tick: number;
  /** Open NPC panel entity (0 = none): the smith for craft, the gambler for gamble. */
  vendor: Entity;
  /** The shared item view builder (same text and comparison as the inventory). */
  itemView(item: ItemInstance): ItemView;
}

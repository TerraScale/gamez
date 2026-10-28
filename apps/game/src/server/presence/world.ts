/**
 * Presence world routing helpers (wave-B.md §7). Pure: no Workers or DOM APIs.
 */
import {
  DEFAULT_PRESENCE_WORLD,
  presenceEntityId,
  presenceWorld,
  relayName,
  type PresenceWorldSpec,
} from "../../shared/worlds.ts";

/** The default world ("plaza"): what phase-0 clients and unnamed chunks get. */
export function defaultWorld(): PresenceWorldSpec {
  const world = presenceWorld(DEFAULT_PRESENCE_WORLD);
  if (!world) throw new Error(`default presence world ${DEFAULT_PRESENCE_WORLD} is missing`);
  return world;
}

/**
 * The world a `world` query parameter names. Absent means the default world
 * (phase-0 clients never send it); an unknown id gives null (the route answers 404).
 */
export function worldFromParam(param: string | null): PresenceWorldSpec | null {
  return param === null ? defaultWorld() : presenceWorld(param);
}

/** The RelayDO name and entity id a player gets in a world. */
export function placement(
  continent: string,
  accountId: string,
  world: PresenceWorldSpec,
): { relay: string; entityId: string } {
  return { relay: relayName(continent, world), entityId: presenceEntityId(accountId, world) };
}

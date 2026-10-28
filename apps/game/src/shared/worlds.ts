/**
 * Presence worlds (wave-B.md §7), shared by the Worker, the RelayDO/ChunkDO
 * and the client. CONTRACT (architect).
 *
 * - "plaza": the phase-0 Town Plaza demo. Server-validated tap-to-move
 *   (ChunkDO plans paths on the classic.town map), positions persisted in the
 *   CharacterDO "<accountId>:classic". Legacy names kept so existing state stays valid.
 * - "classic-town": other players in the classic mode's town. The client's
 *   own sim moves its hero; the client reports poses (PoseUpdate) and the
 *   chunk only checks bounds and rate. Nothing is persisted (presence only),
 *   except world fixtures (wave C: ghost shopkeepers, ChunkFixtureApi).
 *
 * Relay sharding (wave C §12): a world's sockets per region spread over
 * `relayShards` RelayDOs by a stable hash of the account id, so one account's
 * sockets always meet on the same relay. The chunk still fans out once per relay.
 *
 * Pure: no Workers or DOM APIs.
 */
import { townMap } from "@gamez/classic.town";
import type { TilePos } from "@gamez/protocol";
import type { TileMap } from "@gamez/world";

export type PresenceMovement = "server-path" | "client-pose";

export interface PresenceWorldSpec {
  id: string;
  /** ChunkDO name (one chunk per world in wave B). */
  chunk: string;
  movement: PresenceMovement;
  /** server-path only: the map paths are planned on. */
  map: TileMap | null;
  width: number;
  height: number;
  spawn: TilePos;
  /** CharacterDO mode for persisted positions; null = not persisted. */
  characterMode: string | null;
  /** RelayDOs per region (>= 1). Plaza keeps exactly one, under its legacy name. */
  relayShards: number;
}

/** Size of the classic mode's town (modules/classic/src/world/town.ts TOWN_SIZE). */
export const CLASSIC_TOWN_SIZE = 72;

export const PRESENCE_WORLDS: Readonly<Record<string, PresenceWorldSpec>> = {
  plaza: {
    id: "plaza",
    chunk: "classic:0:0",
    movement: "server-path",
    map: townMap,
    width: townMap.width,
    height: townMap.height,
    spawn: townMap.spawn,
    characterMode: "classic",
    relayShards: 1,
  },
  "classic-town": {
    id: "classic-town",
    chunk: "classic-town:0:0",
    movement: "client-pose",
    map: null,
    width: CLASSIC_TOWN_SIZE,
    height: CLASSIC_TOWN_SIZE,
    spawn: { x: 36, y: 46 },
    characterMode: null,
    relayShards: 4,
  },
};

export const DEFAULT_PRESENCE_WORLD = "plaza";

/** The world with this id (absent id = the default world); null for unknown ids. Own keys only. */
export function presenceWorld(id: string | null | undefined): PresenceWorldSpec | null {
  const key = id ?? DEFAULT_PRESENCE_WORLD;
  return Object.hasOwn(PRESENCE_WORLDS, key) ? (PRESENCE_WORLDS[key] ?? null) : null;
}

/** The world a chunk name belongs to (null for unknown chunks). */
export function worldOfChunk(chunk: string): PresenceWorldSpec | null {
  for (const w of Object.values(PRESENCE_WORLDS)) if (w.chunk === chunk) return w;
  return null;
}

/** 32-bit FNV-1a over the UTF-16 code units of `s`: stable across runtimes and deploys. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The relay shard an account uses in a world: stableHash(accountId) % relayShards. */
export function relayShard(accountId: string, world: PresenceWorldSpec): number {
  const shards = Math.max(1, Math.floor(world.relayShards));
  return shards === 1 ? 0 : stableHash(accountId) % shards;
}

/**
 * RelayDO name per region, world and shard: "relay:<continent>:<world>:<shard>".
 * Plaza keeps the phase-0 name "relay:<continent>:0" (it has one shard).
 */
export function relayName(continent: string, world: PresenceWorldSpec, shard = 0): string {
  return world.id === DEFAULT_PRESENCE_WORLD
    ? `relay:${continent}:0`
    : `relay:${continent}:${world.id}:${shard}`;
}

/** Character / entity id of an account in a world (plaza: the phase-0 "<accountId>:classic"). */
export function presenceEntityId(accountId: string, world: PresenceWorldSpec): string {
  return `${accountId}:${world.characterMode ?? world.id}`;
}

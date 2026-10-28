/**
 * Internal contracts between the Worker and its Durable Objects (phase 0).
 *
 * Topology (see plan §2):
 *   client --WS--> RelayDO (one per region shard; holds sockets)
 *   RelayDO --RPC--> ChunkDO (presence authority for a slice of the world)
 *   ChunkDO --RPC deliver()--> every subscribed RelayDO (fan-out once per relay)
 *   RelayDO/ChunkDO --RPC--> CharacterDO (authoritative character state + outbox -> D1)
 */
import type { EntityId, EntityState, TilePos } from "@gamez/protocol";
import type { ReplicationBatch } from "@gamez/sync";

export interface Env {
  ASSETS: Fetcher;
  RELAY: DurableObjectNamespace<import("./do/relay.ts").RelayDO>;
  CHUNK: DurableObjectNamespace<import("./do/chunk.ts").ChunkDO>;
  CHARACTER: DurableObjectNamespace<import("./do/character.ts").CharacterDO>;
  DB: D1Database;
  SYNC_QUEUE: Queue<ReplicationBatch>;
  AUTH_SECRET: string;
}

/** Game mode id; phase 0 only runs "classic". */
export type ModeId = string;

export interface CharacterRecord {
  /** "<accountId>:<mode>" — also the CharacterDO name and the entity id in the world. */
  id: string;
  accountId: string;
  mode: ModeId;
  name: string;
  appearance: string;
  pos: TilePos;
  createdAt: number;
  updatedAt: number;
}

/** RPC surface of CharacterDO. */
export interface CharacterApi {
  /** Loads the character, creating it at `spawn` with display `name` on first call. */
  getOrCreate(
    accountId: string,
    mode: ModeId,
    spawn: TilePos,
    name: string,
  ): Promise<CharacterRecord>;
  /** Persists the resting position (writes row + outbox in one transaction). */
  savePosition(pos: TilePos): Promise<void>;
}

/** RPC surface of ChunkDO. Name format: "<mode>:<cx>:<cy>"; phase 0 uses "classic:0:0". */
export interface ChunkApi {
  /**
   * Relay starts receiving deltas; returns the current full state. A relay
   * that lost its memory (cold start) passes `liveIds`, the characters it
   * still has sockets for; the chunk then drops any other avatar that joined
   * through that relay (stale after a restart or crash).
   */
  subscribe(relay: string, liveIds?: EntityId[]): Promise<{ seq: number; entities: EntityState[] }>;
  unsubscribe(relay: string): Promise<void>;
  /**
   * Puts a character's avatar into the chunk (or refreshes it) and returns its
   * state. `relay` is the relay holding the player's socket.
   */
  join(character: CharacterRecord, relay: string): Promise<EntityState>;
  leave(id: EntityId): Promise<void>;
  /**
   * Validates and starts a walk from the entity's current (interpolated)
   * tile to `target`. Broadcasts the new path. Persists the destination to
   * the CharacterDO once the walk ends.
   */
  moveTo(id: EntityId, target: TilePos): Promise<{ ok: boolean; reason?: string }>;
}

/** RPC surface of RelayDO used by chunks. */
export interface RelayApi {
  deliver(chunkId: string, seq: number, upserts: EntityState[], removes: EntityId[]): Promise<void>;
}

/** Payload of the "character_summary" outbox records (projected to D1). */
export interface CharacterSummary {
  characterId: string;
  accountId: string;
  mode: ModeId;
  name: string;
  x: number;
  y: number;
}

/** Headers the Worker sets on the WebSocket upgrade it forwards to a RelayDO. */
export const RELAY_HEADERS = {
  accountId: "x-gamez-account-id",
  name: "x-gamez-name",
  relay: "x-gamez-relay",
} as const;

export const PHASE0_MODE: ModeId = "classic";
export const PHASE0_CHUNK = "classic:0:0";
export const WALK_SPEED = 4; // tiles per second

/**
 * Wire messages between the game client and its RelayDO.
 *
 * Phase 0 keeps this deliberately small: presence (who is where, walking
 * which path) plus movement intents. Positions are tile coordinates; motion
 * is described by a path plus the server time it started, so clients can
 * interpolate locally with zero per-frame traffic.
 */

export type EntityId = string;

export interface TilePos {
  x: number;
  y: number;
}

/**
 * "shopkeeper" (wave C): a world fixture of a pose world (ChunkFixtureApi), the
 * ghost of a shop owner standing on a leased plot; id "shops:<plotId>" (shared/plots.ts shopFixtureId).
 */
export type EntityKind = "player" | "ghost" | "shopkeeper";

/**
 * Party (classic, docs/design/party.md §11.3): a companion hero walking with
 * a player's avatar. Drawn by other clients at the avatar's (interpolated)
 * position plus (dx, dy); it has no id, path or presence of its own.
 */
export interface CompanionPose {
  /** "unit.hero" or "unit.hero.<x>", at most 64 chars (same rule as PoseUpdate.appearance). */
  appearance: string;
  /** Display name, at most 24 chars. */
  name: string;
  /** Integer tile offset from the avatar, each in -4..4. */
  dx: number;
  dy: number;
}

/** At most this many companions per avatar (a party of four = the player + 3). */
export const MAX_COMPANIONS = 3;

export interface EntityState {
  id: EntityId;
  kind: EntityKind;
  name: string;
  /** Logical sprite/animation set id from the asset manifest, e.g. "unit.hero". */
  appearance: string;
  /** Tile the entity stands on (or started walking from, when `path` is non-empty). */
  pos: TilePos;
  /** Tiles still to walk, in order, excluding `pos`. Empty when standing still. */
  path: TilePos[];
  /** Server epoch ms at which walking from `pos` along `path` began. */
  pathStartedAt: number;
  /** Walking speed in tiles per second. */
  speed: number;
  /**
   * Wave B: short cosmetic label under the name ("Lv 12 Warrior <TAG>"),
   * at most 40 chars. Client-reported in pose worlds; optional everywhere.
   */
  tag?: string;
  /** Party companions (pose worlds only; the last reported list, sanitised by the server). Absent = none. */
  companions?: CompanionPose[];
}

/**
 * Wave B pose report (worlds with movement "client-pose", e.g. the classic
 * town, wave-B.md §7): the client's own sim moves the hero; the server only
 * relays where it is and where it is heading. `path` is at most 8 tiles.
 */
export interface PoseUpdate {
  pos: TilePos;
  path: TilePos[];
  /** Tiles per second, clamped by the server to 1..12. */
  speed: number;
  /** "unit.hero" or "unit.hero.<x>", at most 64 chars. */
  appearance?: string;
  tag?: string;
  /**
   * Party companions (at most MAX_COMPANIONS). Absent = unchanged since the
   * last pose; [] = none. The server drops invalid entries (bad appearance,
   * names too long, offsets outside -4..4) and caps the list.
   */
  companions?: CompanionPose[];
}

export type ClientMessage =
  | { t: "hello"; token: string }
  | { t: "moveTo"; target: TilePos }
  /** Wave B: pose worlds only (moveTo is rejected there, pose in server-path worlds). */
  | ({ t: "pose" } & PoseUpdate)
  | { t: "ping"; clientTime: number };

export type ServerMessage =
  | {
      t: "welcome";
      selfId: EntityId;
      chunkId: string;
      /** The chunk delta seq this snapshot corresponds to; the next delta must be seq + 1. */
      seq: number;
      serverTime: number;
      entities: EntityState[];
    }
  | {
      t: "delta";
      chunkId: string;
      /** Monotonic per chunk. A gap means the client must resync. */
      seq: number;
      upserts: EntityState[];
      removes: EntityId[];
    }
  | { t: "pong"; clientTime: number; serverTime: number }
  | { t: "error"; code: string; message: string };

/** Encoded frame as sent over a WebSocket. */
export type Frame = string | Uint8Array;

/**
 * A wire format. Implementations must round-trip every message exactly
 * (numbers in tile coordinates are integers in 0..65535; times are epoch ms).
 */
export interface Codec {
  readonly name: string;
  encodeClient(msg: ClientMessage): Frame;
  decodeClient(frame: Frame | ArrayBuffer): ClientMessage;
  encodeServer(msg: ServerMessage): Frame;
  decodeServer(frame: Frame | ArrayBuffer): ServerMessage;
}

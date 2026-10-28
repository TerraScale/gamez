import type { EntityId, EntityState, ServerMessage } from "@gamez/protocol";
import type { Walk } from "../shared/walk.ts";

type Welcome = Extract<ServerMessage, { t: "welcome" }>;
type Delta = Extract<ServerMessage, { t: "delta" }>;

/**
 * How a delta relates to the last applied seq: the next one ("apply"), an old
 * or duplicate one ("stale"), or one past a missed delta ("gap", resync).
 * `last` is null only before any welcome, when any seq is accepted as the base.
 */
export function checkSeq(last: number | null, seq: number): "apply" | "stale" | "gap" {
  if (last === null || seq === last + 1) return "apply";
  return seq <= last ? "stale" : "gap";
}

/**
 * Client-side mirror of the chunk: server entity states plus an optional
 * locally predicted walk for the player's own avatar.
 */
export class WorldState {
  selfId: EntityId | null = null;
  chunkId: string | null = null;
  readonly entities = new Map<EntityId, EntityState>();
  #lastSeq: number | null = null;
  #prediction: Walk | null = null;
  #removed: EntityId[] = [];

  /**
   * Replaces everything with a welcome snapshot. The snapshot is the state at
   * `msg.seq`, so the next delta must be seq + 1 (anything else is a gap or stale).
   */
  reset(msg: Welcome): void {
    const next = new Map(msg.entities.map((e) => [e.id, e]));
    for (const id of this.entities.keys()) if (!next.has(id)) this.#removed.push(id);
    this.entities.clear();
    for (const [id, e] of next) this.entities.set(id, e);
    this.selfId = msg.selfId;
    this.chunkId = msg.chunkId;
    this.#lastSeq = msg.seq;
    this.#prediction = null;
  }

  /** Applies a delta; returns "gap" when the caller must resync. */
  applyDelta(msg: Delta): "apply" | "stale" | "gap" {
    const verdict = checkSeq(this.#lastSeq, msg.seq);
    if (verdict !== "apply") return verdict;
    for (const id of msg.removes) {
      if (this.entities.delete(id)) this.#removed.push(id);
    }
    for (const e of msg.upserts) {
      this.entities.set(e.id, e);
      // The server's path replaces whatever we predicted.
      if (e.id === this.selfId) this.#prediction = null;
    }
    this.#lastSeq = msg.seq;
    return "apply";
  }

  /** Overrides the own avatar's walk until the server's version arrives. */
  predictSelf(walk: Pick<EntityState, "pos" | "path" | "pathStartedAt">): void {
    const self = this.self();
    if (self) this.#prediction = { ...walk, speed: self.speed };
  }

  clearPrediction(): void {
    this.#prediction = null;
  }

  /** Own avatar, with the prediction applied. */
  self(): EntityState | undefined {
    const e = this.selfId ? this.entities.get(this.selfId) : undefined;
    return e && this.#prediction ? { ...e, ...this.#prediction } : e;
  }

  /** Every entity as it should be drawn (prediction applied to self). */
  *visible(): Iterable<EntityState> {
    for (const e of this.entities.values()) {
      yield e.id === this.selfId ? this.self()! : e;
    }
  }

  /** Ids removed since the last call (for the renderer). */
  drainRemoved(): EntityId[] {
    const out = this.#removed;
    this.#removed = [];
    return out;
  }
}

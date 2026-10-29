import type { EntityId, EntityState, PoseUpdate, TilePos } from "@gamez/protocol";
import { isWalkable, pathDuration, type TileMap } from "@gamez/world";
import { DurableObject } from "cloudflare:workers";
import { analyticsFor } from "../analytics/index.ts";
import { markDoActive } from "../analytics/do-active.ts";
import {
  WALK_SPEED,
  type CharacterRecord,
  type ChunkApi,
  type ChunkPoseApi,
  type ChunkFixtureApi,
  type Env,
  sqlStoreOf,
} from "../contracts.ts";
import { planWalk, walkAt, walkEnd } from "../../shared/walk.ts";
import { worldOfChunk, type PresenceWorldSpec } from "../../shared/worlds.ts";
import { RelayFanout } from "../presence/fanout.ts";
import { FixtureError, FixtureStore, validateFixtures } from "../presence/fixtures.ts";
import { poseState, sameStanding, sanitisePose } from "../presence/pose.ts";
import { defaultWorld } from "../presence/world.ts";

/** Min interval between delta flushes; changes inside the window are coalesced. */
const FLUSH_INTERVAL_MS = 50;

interface Avatar {
  state: EntityState;
  /** Relay holding this player's socket. */
  relay: string;
}

/**
 * The persisted seq is a ceiling, raised SEQ_RESERVE at a time, instead of a
 * write per delta: a restarted chunk resumes at the ceiling, past anything it
 * delivered, so every relay sees a gap and resyncs with a full snapshot.
 */
const SEQ_RESERVE = 10_000;

/** Counters since the chunk woke up (dev stats route, load tests). */
export interface ChunkStats {
  chunk: string;
  avatars: number;
  fixtures: number;
  relays: string[];
  seq: number;
  poses: number;
  flushes: number;
  upsertsSent: number;
  deliverFailures: number;
  /** Epoch ms the counters started at. */
  since: number;
}

interface PresenceRow extends Record<string, SqlStorageValue> {
  id: string;
  relay: string;
  state: string;
}

/**
 * Presence authority for one world slice. Name: the chunk name of a presence
 * world (shared/worlds.ts, e.g. "classic:0:0" for plaza, "classic-town:0:0").
 * Avatars, subscribed relays and a delta seq ceiling are persisted, so an
 * evicted chunk wakes up with the same members and relays resync (pose
 * worlds persist an avatar at join, not at every pose). Deltas fan out once per relay, never
 * once per player.
 *
 * Server-path worlds (plaza) plan walks on the world's map and settle them
 * with an alarm, persisting the final tile to the CharacterDO. Client-pose
 * worlds (classic-town) take poses from the clients (bounds and shape
 * checked), never touch a CharacterDO and never use alarms.
 *
 * World fixtures (wave C §5.4, presence/fixtures.ts) live next to the avatars:
 * persisted per group, part of subscribe() state and broadcast as normal
 * upserts/removes, but never moved, never timed out and never addressable by
 * join, pose, moveTo or leave.
 */
export class ChunkDO extends DurableObject<Env> implements ChunkApi, ChunkPoseApi, ChunkFixtureApi {
  readonly #world: PresenceWorldSpec;
  #sql = this.ctx.storage.sql;
  #kv = this.ctx.storage.kv;
  #avatars = new Map<EntityId, Avatar>();
  /** Subscribed relays (one delivery per relay per delta, sharded relays included). */
  #relays = new RelayFanout();
  #stubs = new Map<string, DurableObjectStub<import("./relay.ts").RelayDO>>();
  #seq = 0;
  #upserts = new Set<EntityId>();
  #removes = new Set<EntityId>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #lastFlush = 0;
  #seqCeiling = 0;
  /** True while a delta is being delivered; changes meanwhile wait for the next flush (backpressure). */
  #flushing = false;
  /** Persistent world fixtures (own SQLite table, loaded synchronously). */
  readonly #fixtures = new FixtureStore(sqlStoreOf(this.ctx.storage));
  readonly #stats = { poses: 0, flushes: 0, upsertsSent: 0, deliverFailures: 0, since: Date.now() };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "ChunkDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    this.#world = worldOfChunk(this.chunkId) ?? defaultWorld();
    void ctx.blockConcurrencyWhile(async () => {
      this.#sql.exec(
        "CREATE TABLE IF NOT EXISTS presence (id TEXT PRIMARY KEY, relay TEXT NOT NULL, state TEXT NOT NULL)",
      );
      for (const row of this.#sql.exec<PresenceRow>("SELECT id, relay, state FROM presence")) {
        this.#avatars.set(row.id, {
          relay: row.relay,
          state: JSON.parse(row.state) as EntityState,
        });
      }
      this.#relays = new RelayFanout(this.#kv.get<string[]>("relays") ?? []);
      this.#seq = this.#kv.get<number>("seq") ?? 0;
      this.#seqCeiling = this.#seq;
    });
  }

  get chunkId(): string {
    return this.ctx.id.name ?? this.#world.chunk;
  }

  async subscribe(
    relay: string,
    liveIds?: EntityId[],
  ): Promise<{ seq: number; entities: EntityState[] }> {
    if (this.#relays.add(relay)) this.#saveRelays();
    if (liveIds) {
      const live = new Set(liveIds);
      for (const [id, a] of this.#avatars) if (a.relay === relay && !live.has(id)) this.#drop(id);
    }
    return {
      seq: this.#seq,
      entities: [...this.#avatars.values()].map((a) => a.state).concat(this.#fixtures.all()),
    };
  }

  async unsubscribe(relay: string): Promise<void> {
    if (this.#relays.remove(relay)) this.#saveRelays();
    this.#stubs.delete(relay);
  }

  async join(character: CharacterRecord, relay: string): Promise<EntityState> {
    if (this.#fixtures.has(character.id)) throw new Error(`id ${character.id} is a world fixture`);
    const existing = this.#avatars.get(character.id);
    const state: EntityState = existing
      ? { ...existing.state, name: character.name, appearance: character.appearance }
      : {
          id: character.id,
          kind: "player",
          name: character.name,
          appearance: character.appearance,
          pos: this.#startTile(character.pos),
          path: [],
          pathStartedAt: Date.now(),
          speed: WALK_SPEED,
        };
    this.#put({ state, relay });
    return state;
  }

  /**
   * Wave C (docs/design/wave-C.md §5.4): replaces one fixture group (pose
   * worlds only). Throws FixtureError (message "<code>: …") for a bad set,
   * leaving the old group in place. Changes go out with the next delta.
   */
  async setFixtures(group: string, fixtures: EntityState[]): Promise<void> {
    if (this.#world.movement !== "client-pose") {
      throw new FixtureError("bad-group", `world ${this.#world.id} has no fixtures`);
    }
    const clean = validateFixtures(group, fixtures, this.#world);
    const change = this.#fixtures.replace(group, clean, (id) => this.#avatars.has(id));
    for (const id of change.removes) {
      this.#upserts.delete(id);
      this.#removes.add(id);
    }
    for (const f of change.upserts) {
      this.#removes.delete(f.id);
      this.#upserts.add(f.id);
    }
    if (change.upserts.length > 0 || change.removes.length > 0) this.#scheduleFlush();
  }

  /** The fixtures of one group (or all), in id order. */
  async fixtures(group?: string): Promise<EntityState[]> {
    return group === undefined ? this.#fixtures.all() : this.#fixtures.group(group);
  }

  /** Load counters (dev stats route and tools/loadtest). */
  async stats(): Promise<ChunkStats> {
    return {
      chunk: this.chunkId,
      avatars: this.#avatars.size,
      fixtures: this.#fixtures.size,
      relays: this.#relays.names().sort(),
      seq: this.#seq,
      ...this.#stats,
    };
  }

  async leave(id: EntityId): Promise<void> {
    this.#drop(id);
  }

  /** Server-path worlds only; client-pose worlds answer "wrong-world". */
  async moveTo(id: EntityId, target: TilePos): Promise<{ ok: boolean; reason?: string }> {
    const map = this.#world.map;
    if (this.#world.movement !== "server-path" || !map) {
      return { ok: false, reason: "wrong-world" };
    }
    const avatar = this.#avatars.get(id);
    if (!avatar) return { ok: false, reason: "not-joined" };
    const plan = planWalk(map, avatar.state, target, Date.now());
    if (!plan.ok) return { ok: false, reason: plan.reason };
    this.#put({ ...avatar, state: { ...avatar.state, ...plan.walk } });
    await this.#scheduleWalkAlarm();
    return { ok: true };
  }

  /**
   * Client-pose worlds only (wave-B.md §7): continues the avatar's walk into
   * the reported pose (continueWalk, so the drawn avatar never jumps) and
   * queues a delta. Nothing is persisted
   * beyond the presence row.
   */
  async pose(id: EntityId, pose: PoseUpdate): Promise<{ ok: boolean; reason?: string }> {
    return this.#pose(id, pose);
  }

  #pose(id: EntityId, pose: PoseUpdate): { ok: boolean; reason?: string } {
    if (this.#world.movement !== "client-pose") return { ok: false, reason: "wrong-world" };
    const avatar = this.#avatars.get(id);
    if (!avatar) return { ok: false, reason: "not-joined" };
    this.#stats.poses++;
    const check = sanitisePose(pose, this.#world);
    if (!check.ok) return { ok: false, reason: check.reason };
    const now = Date.now();
    // Companions (party, §11.3) replace the list only when the report carries one.
    const state = poseState(avatar.state, check.pose, now);
    // A keepalive of a hero standing still: nothing to broadcast.
    if (sameStanding(avatar.state, state, now)) return { ok: true };
    // Pose worlds keep poses in memory only (the row stays as of the join): a
    // SQLite write per pose held every outgoing delta behind storage commits
    // (docs/bench/2026-10-waveC-presence.md). A restarted chunk shows the avatar
    // at its join tile until its next pose, a fraction of a second later.
    this.#put({ ...avatar, state }, false);
    return { ok: true };
  }

  /**
   * A relay's batch of poses (wave C §12: one RPC per relay round trip instead
   * of one per pose); same rules as pose(), one result per entry.
   */
  async poses(
    batch: { id: EntityId; pose: PoseUpdate }[],
  ): Promise<{ ok: boolean; reason?: string }[]> {
    if (!Array.isArray(batch)) return [];
    return batch.map((entry) => this.#pose(entry.id, entry.pose));
  }

  /** Settles every finished walk and persists its final tile to the CharacterDO (server-path worlds). */
  async alarm(): Promise<void> {
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "ChunkDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    if (this.#world.movement !== "server-path") return;
    const now = Date.now();
    for (const avatar of this.#avatars.values()) {
      const { state } = avatar;
      if (state.path.length === 0) continue;
      const endsAt = walkEndsAt(state);
      if (endsAt > now) continue;
      const final = walkEnd(state);
      // Same motion, normalised to "standing at final"; clients derive it themselves, so no delta.
      this.#persist({
        ...avatar,
        state: { ...state, pos: final, path: [], pathStartedAt: endsAt },
      });
      this.#savePosition(state.id, final);
    }
    await this.#scheduleWalkAlarm();
  }

  /** A join's start tile: the character's saved tile when it is usable in this world, else the spawn. */
  #startTile(pos: TilePos): TilePos {
    const map: TileMap | null = this.#world.map;
    const usable = map
      ? isWalkable(map, pos.x, pos.y)
      : Number.isInteger(pos.x) &&
        Number.isInteger(pos.y) &&
        pos.x >= 0 &&
        pos.y >= 0 &&
        pos.x < this.#world.width &&
        pos.y < this.#world.height;
    return usable ? { x: pos.x, y: pos.y } : { ...this.#world.spawn };
  }

  /** Stores an avatar and queues it for the next delta. */
  #put(avatar: Avatar, persist = true): void {
    if (persist) this.#persist(avatar);
    else this.#avatars.set(avatar.state.id, avatar);
    this.#removes.delete(avatar.state.id);
    this.#upserts.add(avatar.state.id);
    this.#scheduleFlush();
  }

  #persist(avatar: Avatar): void {
    this.#avatars.set(avatar.state.id, avatar);
    this.#sql.exec(
      "INSERT OR REPLACE INTO presence (id, relay, state) VALUES (?, ?, ?)",
      avatar.state.id,
      avatar.relay,
      JSON.stringify(avatar.state),
    );
  }

  /** Removes an avatar, saving the tile it was last standing on (server-path worlds only). */
  #drop(id: EntityId): void {
    const avatar = this.#avatars.get(id);
    if (!avatar) return;
    this.#avatars.delete(id);
    this.#sql.exec("DELETE FROM presence WHERE id = ?", id);
    this.#upserts.delete(id);
    this.#removes.add(id);
    this.#scheduleFlush();
    if (this.#world.characterMode !== null) {
      this.#savePosition(id, walkAt(avatar.state, Date.now()).from);
    }
  }

  #savePosition(characterId: string, pos: TilePos): void {
    this.env.CHARACTER.getByName(characterId)
      .savePosition(pos)
      .catch((err: unknown) => console.error("savePosition failed", characterId, err));
  }

  async #scheduleWalkAlarm(): Promise<void> {
    if (this.#world.movement !== "server-path") return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const { state } of this.#avatars.values()) {
      if (state.path.length > 0) earliest = Math.min(earliest, walkEndsAt(state));
    }
    if (earliest === Number.POSITIVE_INFINITY) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > earliest) await this.ctx.storage.setAlarm(earliest);
  }

  #scheduleFlush(): void {
    if (this.#flushTimer || this.#flushing) return;
    const delay = Math.max(0, this.#lastFlush + FLUSH_INTERVAL_MS - Date.now());
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flush();
    }, delay);
  }

  async #flush(): Promise<void> {
    if (this.#upserts.size === 0 && this.#removes.size === 0) return;
    const upserts: EntityState[] = [];
    for (const id of this.#upserts) {
      const state = this.#avatars.get(id)?.state ?? this.#fixtures.get(id);
      if (state) upserts.push(state);
    }
    const removes = [...this.#removes];
    this.#upserts.clear();
    this.#removes.clear();
    const seq = ++this.#seq;
    if (seq > this.#seqCeiling) {
      this.#seqCeiling = seq + SEQ_RESERVE;
      this.#kv.put("seq", this.#seqCeiling);
    }
    this.#lastFlush = Date.now();
    this.#stats.flushes++;
    this.#stats.upsertsSent += upserts.length;

    // One delta in flight at a time: under load, changes pile into the next
    // (bigger) delta instead of piling up concurrent deliveries.
    this.#flushing = true;
    let result;
    try {
      result = await this.#relays.deliver((r) =>
        this.#relay(r).deliver(this.chunkId, seq, upserts, removes),
      );
    } finally {
      this.#flushing = false;
      if (this.#upserts.size > 0 || this.#removes.size > 0) this.#scheduleFlush();
    }
    for (const f of result.failed) {
      this.#stats.deliverFailures++;
      console.error("deliver failed", f.relay, f.failures, f.reason);
    }
    if (result.dropped.length === 0) return;
    // Give up on those relays and the players behind them; they re-subscribe when they recover.
    const dropped = new Set(result.dropped);
    for (const relay of dropped) this.#stubs.delete(relay);
    this.#saveRelays();
    for (const [id, a] of this.#avatars) if (dropped.has(a.relay)) this.#drop(id);
  }

  /** One cached stub per relay, so deliveries to it stay in order. */
  #relay(name: string) {
    let stub = this.#stubs.get(name);
    if (!stub) {
      stub = this.env.RELAY.getByName(name);
      this.#stubs.set(name, stub);
    }
    return stub;
  }

  #saveRelays(): void {
    this.#kv.put("relays", this.#relays.names());
  }
}

function walkEndsAt(state: EntityState): number {
  return state.pathStartedAt + pathDuration(state.pos, state.path, state.speed) * 1000;
}

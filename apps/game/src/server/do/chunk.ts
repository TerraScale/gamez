import type { EntityId, EntityState, PoseUpdate, TilePos } from "@gamez/protocol";
import { isWalkable, pathDuration, type TileMap } from "@gamez/world";
import { DurableObject } from "cloudflare:workers";
import {
  WALK_SPEED,
  type CharacterRecord,
  type ChunkApi,
  type ChunkPoseApi,
  type Env,
} from "../contracts.ts";
import { planWalk, walkAt, walkEnd } from "../../shared/walk.ts";
import { worldOfChunk, type PresenceWorldSpec } from "../../shared/worlds.ts";
import { continueWalk, sanitisePose } from "../presence/pose.ts";
import { defaultWorld } from "../presence/world.ts";

/** Min interval between delta flushes; changes inside the window are coalesced. */
const FLUSH_INTERVAL_MS = 50;
/** Consecutive failed deliveries after which a relay is dropped. */
const MAX_RELAY_FAILURES = 3;

interface Avatar {
  state: EntityState;
  /** Relay holding this player's socket. */
  relay: string;
}

interface PresenceRow extends Record<string, SqlStorageValue> {
  id: string;
  relay: string;
  state: string;
}

/**
 * Presence authority for one world slice. Name: the chunk name of a presence
 * world (shared/worlds.ts, e.g. "classic:0:0" for plaza, "classic-town:0:0").
 * Avatars, subscribed relays and the delta seq are persisted, so an evicted
 * chunk wakes up with the same state. Deltas fan out once per relay, never
 * once per player.
 *
 * Server-path worlds (plaza) plan walks on the world's map and settle them
 * with an alarm, persisting the final tile to the CharacterDO. Client-pose
 * worlds (classic-town) take poses from the clients (bounds and shape
 * checked), never touch a CharacterDO and never use alarms.
 */
export class ChunkDO extends DurableObject<Env> implements ChunkApi, ChunkPoseApi {
  readonly #world: PresenceWorldSpec;
  #sql = this.ctx.storage.sql;
  #kv = this.ctx.storage.kv;
  #avatars = new Map<EntityId, Avatar>();
  /** Subscribed relay name -> consecutive delivery failures. */
  #relays = new Map<string, number>();
  #stubs = new Map<string, DurableObjectStub<import("./relay.ts").RelayDO>>();
  #seq = 0;
  #upserts = new Set<EntityId>();
  #removes = new Set<EntityId>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #lastFlush = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
      for (const relay of this.#kv.get<string[]>("relays") ?? []) this.#relays.set(relay, 0);
      this.#seq = this.#kv.get<number>("seq") ?? 0;
    });
  }

  get chunkId(): string {
    return this.ctx.id.name ?? this.#world.chunk;
  }

  async subscribe(
    relay: string,
    liveIds?: EntityId[],
  ): Promise<{ seq: number; entities: EntityState[] }> {
    if (!this.#relays.has(relay)) {
      this.#relays.set(relay, 0);
      this.#saveRelays();
    }
    if (liveIds) {
      const live = new Set(liveIds);
      for (const [id, a] of this.#avatars) if (a.relay === relay && !live.has(id)) this.#drop(id);
    }
    return { seq: this.#seq, entities: [...this.#avatars.values()].map((a) => a.state) };
  }

  async unsubscribe(relay: string): Promise<void> {
    if (this.#relays.delete(relay)) this.#saveRelays();
    this.#stubs.delete(relay);
  }

  async join(character: CharacterRecord, relay: string): Promise<EntityState> {
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
    if (this.#world.movement !== "client-pose") return { ok: false, reason: "wrong-world" };
    const avatar = this.#avatars.get(id);
    if (!avatar) return { ok: false, reason: "not-joined" };
    const check = sanitisePose(pose, this.#world);
    if (!check.ok) return { ok: false, reason: check.reason };
    const { appearance, tag } = check.pose;
    const state: EntityState = {
      ...avatar.state,
      ...continueWalk(avatar.state, check.pose, Date.now()),
      appearance,
    };
    delete state.tag;
    if (tag !== undefined) state.tag = tag;
    this.#put({ ...avatar, state });
    return { ok: true };
  }

  /** Settles every finished walk and persists its final tile to the CharacterDO (server-path worlds). */
  async alarm(): Promise<void> {
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
  #put(avatar: Avatar): void {
    this.#persist(avatar);
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
    if (this.#flushTimer) return;
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
      const avatar = this.#avatars.get(id);
      if (avatar) upserts.push(avatar.state);
    }
    const removes = [...this.#removes];
    this.#upserts.clear();
    this.#removes.clear();
    const seq = ++this.#seq;
    this.#kv.put("seq", seq);
    this.#lastFlush = Date.now();

    const relays = [...this.#relays.keys()];
    const results = await Promise.allSettled(
      relays.map((r) => this.#relay(r).deliver(this.chunkId, seq, upserts, removes)),
    );
    results.forEach((result, i) => {
      const relay = relays[i]!;
      if (!this.#relays.has(relay)) return;
      if (result.status === "fulfilled") {
        this.#relays.set(relay, 0);
        return;
      }
      const failures = (this.#relays.get(relay) ?? 0) + 1;
      console.error("deliver failed", relay, failures, result.reason);
      if (failures < MAX_RELAY_FAILURES) {
        this.#relays.set(relay, failures);
        return;
      }
      // Give up on the relay and the players behind it; it re-subscribes when it recovers.
      this.#relays.delete(relay);
      this.#stubs.delete(relay);
      this.#saveRelays();
      for (const [id, a] of this.#avatars) if (a.relay === relay) this.#drop(id);
    });
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
    this.#kv.put("relays", [...this.#relays.keys()]);
  }
}

function walkEndsAt(state: EntityState): number {
  return state.pathStartedAt + pathDuration(state.pos, state.path, state.speed) * 1000;
}

import type {
  ClientMessage,
  EntityId,
  EntityState,
  PoseUpdate,
  ServerMessage,
} from "@gamez/protocol";
import { DurableObject } from "cloudflare:workers";
import { RELAY_HEADERS, type CharacterRecord, type Env, type RelayApi } from "../contracts.ts";
import { codec } from "../../shared/codec.ts";
import { presenceEntityId, presenceWorld, type PresenceWorldSpec } from "../../shared/worlds.ts";
import { SocketLimiter, type LimitedKind } from "../rate-limit.ts";
import { defaultWorld } from "../presence/world.ts";
import { PoseQueue } from "../presence/pose.ts";
import { analyticsFor } from "../analytics/index.ts";
import { markDoActive } from "../analytics/do-active.ts";
import { WS_ABNORMAL_CLOSE, wsClosed, wsOpened } from "../analytics/ws.ts";

/** Per-socket state; survives hibernation via serializeAttachment. */
interface SocketInfo {
  accountId: string;
  characterId: string;
  name: string;
  /** True once the socket got its welcome; only ready sockets receive deltas. */
  ready: boolean;
  /** Accept time (epoch ms), for ws.close durationS. Absent on sockets accepted before analytics. */
  openedAt?: number;
}

/**
 * Holds client WebSockets for one region, one presence world and one shard.
 * Name: "relay:<continent>:0" (plaza) or "relay:<continent>:<world>:<shard>"
 * (shared/worlds.ts relayName; shard = relayShard(accountId), so one account's
 * sockets share a relay). World fixtures (shopkeepers) arrive like any other
 * entity, in the chunk's subscribe() state and deltas; poses and moves only
 * ever name the socket's own character, never a fixture. Uses the Hibernation API, so idle sockets cost
 * nothing; the in-memory entity cache is rebuilt from the chunk after a wake-up.
 */
export class RelayDO extends DurableObject<Env> implements RelayApi {
  /** Mirror of the chunk's entities; null until (re)built after a cold start. */
  #entities: Map<EntityId, EntityState> | null = null;
  #seq = 0;
  #building: Promise<void> | null = null;
  /** Serialises deliveries so they're applied in arrival order. */
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * Token buckets per socket. In memory only: hibernation resets them, which is
   * harmless because a sleeping relay has no traffic to limit.
   */
  readonly #limits = new WeakMap<WebSocket, SocketLimiter>();
  /** The world, read from storage once (a storage read per message showed up in the wave C profile). */
  #world: PresenceWorldSpec | null = null;
  #chunkStub: DurableObjectStub<import("./chunk.ts").ChunkDO> | null = null;
  /**
   * Poses waiting for the next batch RPC, latest per character (an older pose
   * of the same character is superseded). One batch is in flight at a time, so
   * a quiet relay forwards each pose at once and a busy one coalesces.
   */
  readonly #poseBatch = new PoseQueue<{ ws: WebSocket; info: SocketInfo; pose: PoseUpdate }>();
  #posesInFlight = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "RelayDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
  }

  get name(): string {
    return this.ctx.id.name ?? this.ctx.storage.kv.get<string>("name") ?? "relay:XX:0";
  }

  /** The presence world this relay serves (stored at the first upgrade; plaza for older relays). */
  get world(): PresenceWorldSpec {
    this.#world ??=
      presenceWorld(this.ctx.storage.kv.get<string>("world") ?? null) ?? defaultWorld();
    return this.#world;
  }

  #chunk() {
    this.#chunkStub ??= this.env.CHUNK.getByName(this.world.chunk);
    return this.#chunkStub;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const accountId = request.headers.get(RELAY_HEADERS.accountId);
    const name = request.headers.get(RELAY_HEADERS.name);
    const relay = request.headers.get(RELAY_HEADERS.relay);
    if (!accountId || !name) return new Response("missing identity", { status: 400 });
    const world = presenceWorld(request.headers.get(RELAY_HEADERS.world) ?? null);
    if (!world) return new Response("unknown world", { status: 404 });
    if (this.ctx.storage.kv.get("world") !== world.id) {
      this.ctx.storage.kv.put("world", world.id);
      this.#world = null;
      this.#chunkStub = null;
    }
    if (relay && !this.ctx.id.name && this.ctx.storage.kv.get("name") !== relay) {
      this.ctx.storage.kv.put("name", relay);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const info: SocketInfo = {
      accountId,
      characterId: presenceEntityId(accountId, world),
      name,
      ready: false,
      openedAt: Date.now(),
    };
    server.serializeAttachment(info);
    wsOpened(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "presence",
      world.id,
    );
    void this.#onboard(server, info).catch((err: unknown) => {
      console.error("onboard failed", err);
      this.#send(server, { t: "error", code: "join-failed", message: "could not join the world" });
      server.close(1011, "join failed");
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The character behind a socket in this world. Server-path worlds keep the
   * persisted CharacterDO; client-pose worlds use a transient record (nothing is stored).
   */
  async #character(info: SocketInfo): Promise<CharacterRecord> {
    const world = this.world;
    if (world.characterMode === null) {
      const now = Date.now();
      return {
        id: info.characterId,
        accountId: info.accountId,
        mode: world.id,
        name: info.name,
        appearance: "unit.hero",
        pos: { ...world.spawn },
        createdAt: now,
        updatedAt: now,
      };
    }
    return this.env.CHARACTER.getByName(info.characterId).getOrCreate(
      info.accountId,
      world.characterMode,
      world.spawn,
      info.name,
    );
  }

  /** Character -> chunk subscription -> join -> welcome. */
  async #onboard(ws: WebSocket, info: SocketInfo): Promise<void> {
    const character = await this.#character(info);
    await this.#ensureEntities();
    const self = await this.#chunk().join(character, this.name);
    if (ws.readyState !== WebSocket.OPEN) return;
    this.#remember(self);
    this.#welcome(ws, info);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "RelayDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    const info = ws.deserializeAttachment() as SocketInfo | null;
    if (!info) return;
    let msg: ClientMessage;
    try {
      msg = codec.decodeClient(message);
    } catch {
      this.#send(ws, { t: "error", code: "bad-message", message: "could not decode message" });
      return;
    }
    if (typeof msg !== "object" || msg === null || typeof msg.t !== "string") {
      this.#send(ws, { t: "error", code: "bad-message", message: "could not decode message" });
      return;
    }
    switch (msg.t) {
      case "ping":
        if (!this.#admit(ws, "ping")) return;
        this.#send(ws, { t: "pong", clientTime: msg.clientTime, serverTime: Date.now() });
        return;
      case "moveTo":
        if (!this.#admit(ws, "moveTo")) return;
        if (this.world.movement !== "server-path") return this.#wrongWorld(ws);
        await this.#moveTo(ws, info, msg.target);
        return;
      case "pose":
        if (!this.#admit(ws, "pose")) return;
        if (this.world.movement !== "client-pose") return this.#wrongWorld(ws);
        this.#queuePose(ws, info, msg);
        return;
      case "hello":
        // Identity comes from the verified token at upgrade time; nothing to do.
        return;
    }
  }

  async #moveTo(ws: WebSocket, info: SocketInfo, target: { x: number; y: number }): Promise<void> {
    let res = await this.#chunk().moveTo(info.characterId, target);
    if (!res.ok && res.reason === "not-joined") {
      // The chunk dropped us (e.g. after delivery failures): re-subscribe, rejoin, retry once.
      await this.#rejoin(info);
      res = await this.#chunk().moveTo(info.characterId, target);
    }
    if (!res.ok) {
      this.#send(ws, { t: "error", code: res.reason ?? "move-rejected", message: "move rejected" });
    }
  }

  /** Queues a client-reported pose for the chunk (which checks and sanitises it). */
  #queuePose(ws: WebSocket, info: SocketInfo, msg: Extract<ClientMessage, { t: "pose" }>): void {
    // A newer pose replaces a queued one, but keeps its companions change (pose.ts coalescePose).
    this.#poseBatch.put(info.characterId, { ws, info, pose: msg });
    if (!this.#posesInFlight) void this.#sendPoses();
  }

  /** Sends queued poses, one batch RPC at a time, until the queue is empty. */
  async #sendPoses(): Promise<void> {
    this.#posesInFlight = true;
    try {
      while (this.#poseBatch.size > 0) {
        const batch = this.#poseBatch.drain();
        try {
          await this.#forwardPoses(batch);
        } catch (err) {
          console.error("pose batch failed", err);
          for (const b of batch) {
            this.#send(b.ws, { t: "error", code: "pose-failed", message: "pose not delivered" });
          }
        }
      }
    } finally {
      this.#posesInFlight = false;
    }
  }

  async #forwardPoses(batch: { ws: WebSocket; info: SocketInfo; pose: PoseUpdate }[]) {
    const entries = (list: typeof batch) =>
      list.map((b) => ({ id: b.info.characterId, pose: b.pose }));
    const results = await this.#chunk().poses(entries(batch));
    const retry = batch.filter((_, i) => results[i]?.reason === "not-joined");
    const outcome = new Map(batch.map((b, i) => [b, results[i]]));
    if (retry.length > 0) {
      // The chunk dropped us (e.g. after delivery failures): re-subscribe, rejoin, retry once.
      for (const b of retry) await this.#rejoin(b.info);
      const again = await this.#chunk().poses(entries(retry));
      retry.forEach((b, i) => outcome.set(b, again[i]));
    }
    for (const [b, res] of outcome) {
      if (res?.ok) continue;
      this.#send(b.ws, { t: "error", code: res?.reason ?? "bad-pose", message: "pose rejected" });
    }
  }

  #wrongWorld(ws: WebSocket): void {
    this.#send(ws, {
      t: "error",
      code: "wrong-world",
      message: `not allowed in world ${this.world.id}`,
    });
  }

  /** Applies the per-socket rate limit; over-limit messages are dropped, with at most one notice a second. */
  #admit(ws: WebSocket, kind: LimitedKind): boolean {
    const now = Date.now();
    let limiter = this.#limits.get(ws);
    if (!limiter) {
      limiter = new SocketLimiter(now);
      this.#limits.set(ws, limiter);
    }
    if (limiter.admit(kind, now)) return true;
    if (limiter.noticeDue(now)) {
      this.#send(ws, {
        t: "error",
        code: "rate_limited",
        message: `slow down: ${limiter.dropped} message(s) dropped`,
      });
    }
    return false;
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.#recordClose(ws, code);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    await this.#disconnected(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.#recordClose(ws, WS_ABNORMAL_CLOSE);
    await this.#disconnected(ws);
  }

  /** One ws.close point for a socket that is going away (before its cleanup). */
  #recordClose(ws: WebSocket, code: number): void {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    wsClosed(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "presence",
      this.world.id,
      code,
      info?.openedAt,
      Date.now(),
    );
  }

  /** Called by the chunk with each coalesced delta. */
  async deliver(
    chunkId: string,
    seq: number,
    upserts: EntityState[],
    removes: EntityId[],
  ): Promise<void> {
    const run = this.#queue.then(() => this.#applyDelta(chunkId, seq, upserts, removes));
    this.#queue = run.catch(() => {});
    await run;
  }

  async #applyDelta(
    chunkId: string,
    seq: number,
    upserts: EntityState[],
    removes: EntityId[],
  ): Promise<void> {
    if (!this.#entities) {
      // A late delivery after the last socket left: stay unsubscribed.
      if (this.#sockets().length === 0) return;
      // Cold (hibernated or restarted): rebuild from the chunk, then either pass this
      // delta through (the snapshot is exactly at it) or resend full state.
      await this.#ensureEntities();
      if (this.#seq === seq) this.#broadcast({ t: "delta", chunkId, seq, upserts, removes });
      else if (this.#seq > seq) this.#welcomeAll();
      return;
    }
    if (seq <= this.#seq) return;
    if (seq !== this.#seq + 1) {
      // Missed a delta: refresh and give every client a full snapshot.
      this.#entities = null;
      await this.#ensureEntities();
      this.#welcomeAll();
      return;
    }
    for (const id of removes) this.#entities.delete(id);
    for (const e of upserts) this.#entities.set(e.id, e);
    this.#seq = seq;
    this.#broadcast({ t: "delta", chunkId, seq, upserts, removes });
  }

  /** Builds the entity cache (subscribing to the chunk) unless it's already there. */
  #ensureEntities(): Promise<void> {
    if (this.#entities) return Promise.resolve();
    this.#building ??= (async () => {
      try {
        const liveIds = this.#sockets().map(([, info]) => info.characterId);
        const snap = await this.#chunk().subscribe(this.name, liveIds);
        this.#entities = new Map(snap.entities.map((e) => [e.id, e]));
        this.#seq = snap.seq;
      } finally {
        this.#building = null;
      }
    })();
    return this.#building;
  }

  async #rejoin(info: SocketInfo): Promise<void> {
    const character = await this.#character(info);
    this.#entities = null;
    await this.#ensureEntities();
    const self = await this.#chunk().join(character, this.name);
    this.#remember(self);
  }

  /** Puts a fresh state into the cache (if built) ahead of its delta. */
  #remember(e: EntityState): void {
    this.#entities?.set(e.id, e);
  }

  async #disconnected(ws: WebSocket): Promise<void> {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    const others = this.#sockets().filter(([s]) => s !== ws);
    try {
      if (info && !others.some(([, o]) => o.characterId === info.characterId)) {
        await this.#chunk().leave(info.characterId);
      }
    } finally {
      if (others.length === 0) {
        this.#entities = null;
        await this.#chunk().unsubscribe(this.name);
      }
    }
  }

  /** Open sockets with their attachment. */
  #sockets(): [WebSocket, SocketInfo][] {
    const out: [WebSocket, SocketInfo][] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const info = ws.deserializeAttachment() as SocketInfo | null;
      if (info) out.push([ws, info]);
    }
    return out;
  }

  #welcome(ws: WebSocket, info: SocketInfo): void {
    this.#send(ws, this.#welcomeMessage(info));
    if (!info.ready) ws.serializeAttachment({ ...info, ready: true });
  }

  #welcomeAll(): void {
    for (const [ws, info] of this.#sockets()) if (info.ready) this.#welcome(ws, info);
  }

  #welcomeMessage(info: SocketInfo): ServerMessage {
    return {
      t: "welcome",
      selfId: info.characterId,
      chunkId: this.world.chunk,
      seq: this.#seq,
      serverTime: Date.now(),
      entities: [...(this.#entities?.values() ?? [])],
    };
  }

  /** Encodes once and sends to every ready socket. */
  #broadcast(msg: ServerMessage): void {
    const frame = codec.encodeServer(msg);
    for (const [ws, info] of this.#sockets()) {
      if (!info.ready) continue;
      try {
        ws.send(frame);
      } catch {
        // Socket went away mid-broadcast; its close handler cleans up.
      }
    }
  }

  #send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(codec.encodeServer(msg));
    } catch {
      // Closed.
    }
  }
}

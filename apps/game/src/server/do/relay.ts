import { townMap } from "@gamez/classic.town";
import type { ClientMessage, EntityId, EntityState, ServerMessage } from "@gamez/protocol";
import { DurableObject } from "cloudflare:workers";
import { PHASE0_CHUNK, PHASE0_MODE, RELAY_HEADERS, type Env, type RelayApi } from "../contracts.ts";
import { codec } from "../../shared/codec.ts";
import { SocketLimiter } from "../rate-limit.ts";

/** Per-socket state; survives hibernation via serializeAttachment. */
interface SocketInfo {
  accountId: string;
  characterId: string;
  name: string;
  /** True once the socket got its welcome; only ready sockets receive deltas. */
  ready: boolean;
}

/**
 * Holds client WebSockets for one region shard. Name: "relay:<continent>:<n>".
 * Uses the Hibernation API, so idle sockets cost nothing; the in-memory entity
 * cache is rebuilt from the chunk after a wake-up.
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

  get name(): string {
    return this.ctx.id.name ?? this.ctx.storage.kv.get<string>("name") ?? "relay:XX:0";
  }

  #chunk() {
    return this.env.CHUNK.getByName(PHASE0_CHUNK);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const accountId = request.headers.get(RELAY_HEADERS.accountId);
    const name = request.headers.get(RELAY_HEADERS.name);
    const relay = request.headers.get(RELAY_HEADERS.relay);
    if (!accountId || !name) return new Response("missing identity", { status: 400 });
    if (relay && !this.ctx.id.name && this.ctx.storage.kv.get("name") !== relay) {
      this.ctx.storage.kv.put("name", relay);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const info: SocketInfo = {
      accountId,
      characterId: `${accountId}:${PHASE0_MODE}`,
      name,
      ready: false,
    };
    server.serializeAttachment(info);
    void this.#onboard(server, info).catch((err: unknown) => {
      console.error("onboard failed", err);
      this.#send(server, { t: "error", code: "join-failed", message: "could not join the world" });
      server.close(1011, "join failed");
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Character -> chunk subscription -> join -> welcome. */
  async #onboard(ws: WebSocket, info: SocketInfo): Promise<void> {
    const character = await this.env.CHARACTER.getByName(info.characterId).getOrCreate(
      info.accountId,
      PHASE0_MODE,
      townMap.spawn,
      info.name,
    );
    await this.#ensureEntities();
    const self = await this.#chunk().join(character, this.name);
    if (ws.readyState !== WebSocket.OPEN) return;
    this.#remember(self);
    this.#welcome(ws, info);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    if (!info) return;
    let msg: ClientMessage;
    try {
      msg = codec.decodeClient(message);
    } catch {
      this.#send(ws, { t: "error", code: "bad-message", message: "could not decode message" });
      return;
    }
    if (msg.t === "moveTo" || msg.t === "ping") {
      if (!this.#admit(ws, msg.t)) return;
    }
    switch (msg.t) {
      case "ping":
        this.#send(ws, { t: "pong", clientTime: msg.clientTime, serverTime: Date.now() });
        return;
      case "moveTo": {
        let res = await this.#chunk().moveTo(info.characterId, msg.target);
        if (!res.ok && res.reason === "not-joined") {
          // The chunk dropped us (e.g. after delivery failures): re-subscribe, rejoin, retry once.
          await this.#rejoin(info);
          res = await this.#chunk().moveTo(info.characterId, msg.target);
        }
        if (!res.ok) {
          this.#send(ws, {
            t: "error",
            code: res.reason ?? "move-rejected",
            message: "move rejected",
          });
        }
        return;
      }
      case "hello":
        // Identity comes from the verified token at upgrade time; nothing to do.
        return;
    }
  }

  /** Applies the per-socket rate limit; over-limit messages are dropped, with at most one notice a second. */
  #admit(ws: WebSocket, kind: "moveTo" | "ping"): boolean {
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
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    await this.#disconnected(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.#disconnected(ws);
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
    const character = await this.env.CHARACTER.getByName(info.characterId).getOrCreate(
      info.accountId,
      PHASE0_MODE,
      townMap.spawn,
      info.name,
    );
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
      chunkId: PHASE0_CHUNK,
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

import { DurableObject } from "cloudflare:workers";
import { INSTANCE_HEADERS, type Env } from "../contracts.ts";
import { InstanceHost, type InstanceSocket, type SocketInfo } from "../instance/host.ts";
import { encodeServerMessage } from "../instance/messages.ts";
import { findMode, instanceName, loadedMode } from "../instance/modes.ts";
import { SqlInstanceStore } from "../instance/sql-store.ts";

/**
 * Generic host for instanced modes, per contracts.ts (InstanceDO section).
 * Name: "<mode>:<accountId>". Hibernatable WebSockets carry the
 * InstanceClientMessage / InstanceServerMessage protocol; all game logic is
 * in InstanceHost (src/server/instance/host.ts), this class only adapts
 * sockets, SQLite and the alarm to it.
 */
export class InstanceDO extends DurableObject<Env> {
  #host: InstanceHost | null = null;
  #store: SqlInstanceStore | null = null;
  readonly #wrappers = new WeakMap<WebSocket, InstanceSocket>();

  get #name(): string {
    return this.ctx.id.name ?? this.ctx.storage.kv.get<string>("name") ?? this.ctx.id.toString();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const accountId = request.headers.get(INSTANCE_HEADERS.accountId);
    const name = request.headers.get(INSTANCE_HEADERS.name);
    const mode = request.headers.get(INSTANCE_HEADERS.mode);
    if (!accountId || !name || !mode) return new Response("missing identity", { status: 400 });

    const kv = this.ctx.storage.kv;
    const storedMode = kv.get<string>("mode");
    if (storedMode !== undefined && storedMode !== mode) {
      return new Response("instance belongs to another mode", { status: 409 });
    }
    if (!findMode(mode)) return new Response("unknown mode", { status: 404 });
    if (storedMode === undefined) kv.put("mode", mode);
    if (!this.ctx.id.name && kv.get("name") === undefined) {
      kv.put("name", instanceName(mode, accountId));
    }
    if (!this.#getHost()) return new Response("unknown mode", { status: 404 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const info: SocketInfo = { accountId, name, mode, joined: false };
    server.serializeAttachment(info);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!ws.deserializeAttachment()) return;
    const host = this.#getHost();
    if (!host) {
      ws.send(
        encodeServerMessage({ t: "error", code: "unknown_mode", message: "mode not available" }),
      );
      ws.close(1011, "unknown mode");
      return;
    }
    host.handleMessage(this.#wrap(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    this.#getHost()?.handleClose(this.#wrap(ws));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.#getHost()?.handleClose(this.#wrap(ws));
  }

  async alarm(): Promise<void> {
    this.#getHost()?.alarm();
  }

  /** The host for this instance's mode (stored on the first upgrade); null if unknown. */
  #getHost(): InstanceHost | null {
    if (this.#host) return this.#host;
    const id = this.ctx.storage.kv.get<string>("mode");
    const loaded = id ? loadedMode(id) : null;
    if (!loaded) return null;
    this.#store ??= new SqlInstanceStore(this.ctx.storage);
    this.#host = new InstanceHost({
      name: this.#name,
      loaded,
      store: this.#store,
      sockets: () => this.#sockets(),
      now: () => Date.now(),
      randomSeed: () => crypto.getRandomValues(new Uint32Array(1))[0]!,
      setAlarm: (at) => void this.ctx.storage.setAlarm(at),
    });
    return this.#host;
  }

  #sockets(): InstanceSocket[] {
    const out: InstanceSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN || !ws.deserializeAttachment()) continue;
      out.push(this.#wrap(ws));
    }
    return out;
  }

  /** Stable adapter per WebSocket, so per-socket rate limits key on it. */
  #wrap(ws: WebSocket): InstanceSocket {
    let w = this.#wrappers.get(ws);
    if (!w) {
      w = {
        get info() {
          return ws.deserializeAttachment() as SocketInfo;
        },
        setInfo: (info) => ws.serializeAttachment(info),
        send: (frame) => ws.send(frame),
        close: (code, reason) => ws.close(code, reason),
      };
      this.#wrappers.set(ws, w);
    }
    return w;
  }
}

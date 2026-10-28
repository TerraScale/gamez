import { DurableObject } from "cloudflare:workers";
import { Outbox, type ReplicationBatch } from "@gamez/sync";
import type { ArenaBuild } from "@gamez/protocol";
import { featureEnabled } from "../config/flags.ts";
import { INSTANCE_HEADERS, sqlStoreOf, type Env, type InstancePlatformApi } from "../contracts.ts";
import { accountGateway } from "../economy/gateway.ts";
import { SqlBankStore } from "../instance/bank-store.ts";
import { InstanceHost, type InstanceSocket, type SocketInfo } from "../instance/host.ts";
import { encodeServerMessage } from "../instance/messages.ts";
import { findMode, instanceName, loadedMode } from "../instance/modes.ts";
import { SqlInstanceStore } from "../instance/sql-store.ts";
import { VerifiedHost, type VerifiedPlatformDeps } from "../instance/verified-host.ts";
import { SqlVerifiedStore } from "../instance/verified-store.ts";

/** Outbox records per queue message (reports are small; well under 128 KB). */
const FLUSH_BATCH = 200;
/** First re-drive of a pending bank op, and the retry period while some stay pending. */
const REDRIVE_MS = 5_000;
const REDRIVE_RETRY_MS = 30_000;

/**
 * Generic host for instanced modes, per contracts.ts (InstanceDO section).
 * Name: "<mode>:<accountId>". Hibernatable WebSockets carry the
 * InstanceClientMessage / InstanceServerMessage protocol; all game logic is
 * in InstanceHost (src/server/instance/host.ts), this class only adapts
 * sockets, SQLite and the alarm to it.
 *
 * Client-driven modes (ModeSpec.instance.clientDriven, e.g. classic) get a
 * VerifiedHost instead (docs/design/wave-B.md §2): the browser runs the sim,
 * this DO replays and persists its input segments, and reports verified state
 * to D1 through an outbox drained by the alarm.
 */
export class InstanceDO extends DurableObject<Env> implements InstancePlatformApi {
  #host: InstanceHost | VerifiedHost | null = null;
  #store: SqlInstanceStore | null = null;
  #outbox: Outbox | null = null;
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
    await host.handleMessage(this.#wrap(ws), message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    await this.#getHost()?.handleClose(this.#wrap(ws));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.#getHost()?.handleClose(this.#wrap(ws));
  }

  /**
   * Wave C (docs/design/wave-C.md §6.2): the verified hero as an arena build
   * (VerifiedHost.exportBuild), or null for instances that never started or
   * modes without builds.
   */
  async exportBuild(displayName: string): Promise<ArenaBuild | null> {
    if (this.ctx.storage.kv.get<string>("mode") === undefined) return null;
    const host = this.#getHost();
    return host instanceof VerifiedHost ? host.exportBuild(displayName) : null;
  }

  async alarm(): Promise<void> {
    const host = this.#getHost();
    if (!(host instanceof VerifiedHost)) {
      host?.alarm();
      return;
    }
    // Pending bank ops first (their own errors are caught inside), then the outbox.
    let pending = 0;
    try {
      pending = await host.redrive();
    } catch (err) {
      console.error(`instance ${this.#name}: bank re-drive failed`, err);
      pending = host.pendingBankOps();
    }
    try {
      await this.#flushOutbox();
    } finally {
      if (pending > 0 && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + REDRIVE_RETRY_MS);
      }
    }
  }

  /** Wave C platform deps of the verified host: bank account calls, flag, season reports. */
  #platformDeps(): VerifiedPlatformDeps {
    const env = this.env;
    return {
      store: new SqlBankStore(sqlStoreOf(this.ctx.storage)),
      account: accountGateway(env),
      bankEnabled: () => featureEnabled(env, "bank"),
      vaultCount: async (accountId) => (await env.ACCOUNT.getByName(accountId).vault()).length,
      seasonProgress: (accountId, key, total) =>
        env.ACCOUNT.getByName(accountId).seasonProgress(key, total),
      scheduleRedrive: () => {
        void (async () => {
          if ((await this.ctx.storage.getAlarm()) === null) {
            await this.ctx.storage.setAlarm(Date.now() + REDRIVE_MS);
          }
        })().catch((err: unknown) => {
          console.error(`instance ${this.#name}: could not schedule the bank re-drive`, err);
        });
      },
    };
  }

  /** Drains the verified host's report outbox into the sync queue (a throw retries the alarm). */
  async #flushOutbox(): Promise<void> {
    const outbox = this.#outbox;
    if (!outbox) return;
    const sink = {
      send: async (batch: ReplicationBatch) => {
        await this.env.SYNC_QUEUE.send(batch);
      },
    };
    await outbox.flush(sink, FLUSH_BATCH);
    // Records appended while the flush was in flight need another alarm.
    if (outbox.size() > 0) await outbox.scheduleFlush(this.ctx.storage, 0);
  }

  /** The host for this instance's mode (stored on the first upgrade); null if unknown. */
  #getHost(): InstanceHost | VerifiedHost | null {
    if (this.#host) return this.#host;
    const id = this.ctx.storage.kv.get<string>("mode");
    const loaded = id ? loadedMode(id) : null;
    if (!loaded) return null;
    const policy = loaded.mode.instance?.clientDriven;
    if (policy) {
      const outbox = new Outbox(this.ctx.storage.sql, `instance:${this.#name}`);
      outbox.init();
      this.#outbox = outbox;
      this.#host = new VerifiedHost({
        name: this.#name,
        loaded,
        policy,
        store: new SqlVerifiedStore(sqlStoreOf(this.ctx.storage)),
        sockets: () => this.#sockets(),
        now: () => Date.now(),
        randomSeed: () => crypto.getRandomValues(new Uint32Array(1))[0]!,
        outbox,
        scheduleFlush: () => {
          outbox.scheduleFlush(this.ctx.storage).catch((err: unknown) => {
            console.error(`instance ${this.#name}: could not schedule the outbox flush`, err);
          });
        },
        platform: policy.platform ? this.#platformDeps() : null,
      });
      return this.#host;
    }
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

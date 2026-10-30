/**
 * Presence connection for a pose world (wave-B.md §7): one socket to
 * /ws?token&world=<id>, a mirror of the chunk's entities (WorldState) and a
 * server clock estimate (ClockSync). Views change on roster changes only,
 * never per frame. OWNER: T-presence.
 */
import type { PoseUpdate, ServerMessage } from "@gamez/protocol";
import type { PresenceConnection, PresenceView } from "@gamez/ui-host";
import { CODEC_QUERY } from "../../shared/codec.ts";
import { ClockSync } from "../clock.ts";
import { Connection, type NetStatus } from "../net.ts";
import { WorldState } from "../state.ts";

/** The presence socket URL for `world`; `host` is location.host, `secure` true for https pages. */
export function presenceUrl(host: string, secure: boolean, token: string, world: string): string {
  const proto = secure ? "wss:" : "ws:";
  return `${proto}//${host}/ws?token=${encodeURIComponent(token)}&world=${encodeURIComponent(world)}&${CODEC_QUERY}`;
}

export class PresenceClient implements PresenceConnection {
  readonly world: string;
  readonly #clock = new ClockSync();
  readonly #state = new WorldState();
  readonly #listeners = new Set<(view: PresenceView) => void>();
  readonly #conn: Connection;
  #status: NetStatus = "connecting";
  #view: PresenceView = { status: "connecting", selfId: null, others: [] };
  #closed = false;
  /**
   * The latest own pose, sent again after every welcome. The server joins an
   * avatar without a tag and other clients hide it until its first pose, so a
   * pose reported while connecting (or before a reconnect) must not be lost: a
   * hero standing still never reports a changed pose (QA wave C: a stationary
   * hero that rejoined town stayed invisible to others).
   */
  #lastPose: PoseUpdate | null = null;

  /** Connects at once. `url` is asked for on every (re)connect, so a new session token is picked up. */
  constructor(world: string, url: () => Promise<string>) {
    this.world = world;
    this.#conn = new Connection({
      clock: this.#clock,
      url,
      onStatus: (status) => this.#setStatus(status),
      onUnauthorized: () => this.close(),
      onMessage: (msg) => this.#onMessage(msg),
    });
    this.#conn.start();
  }

  getView(): PresenceView {
    return this.#view;
  }

  subscribe(cb: (view: PresenceView) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  /**
   * Reports the own avatar; the caller rate-limits. Sent at once while online;
   * otherwise kept and sent with the next welcome (as is the last pose after a
   * reconnect or resync).
   */
  setPose(pose: PoseUpdate): void {
    if (this.#closed) return;
    this.#lastPose = pose;
    if (this.#status !== "online") return;
    this.#conn.send({ t: "pose", ...pose });
  }

  serverNow(): number {
    return this.#clock.serverNow();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#conn.stop();
    this.#listeners.clear();
  }

  #setStatus(status: NetStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#publish();
  }

  #onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        if (this.#clock.rtt === null) this.#clock.seed(msg.serverTime);
        this.#state.reset(msg);
        this.#state.drainRemoved();
        this.#publish();
        // The relay has joined us by now: (re)announce where we stand.
        if (this.#lastPose && !this.#closed) this.#conn.send({ t: "pose", ...this.#lastPose });
        return;
      case "delta": {
        const verdict = this.#state.applyDelta(msg);
        if (verdict === "gap") {
          this.#conn.resync();
          return;
        }
        this.#state.drainRemoved();
        if (verdict === "apply" && this.#touchesOthers(msg)) this.#publish();
        return;
      }
      case "error":
        if (msg.code !== "rate_limited") console.warn("presence error", msg.code, msg.message);
        return;
      case "pong":
        return;
    }
  }

  /** True when a delta adds, changes or removes someone other than self. */
  #touchesOthers(msg: Extract<ServerMessage, { t: "delta" }>): boolean {
    const self = this.#state.selfId;
    return msg.removes.length > 0 || msg.upserts.some((e) => e.id !== self);
  }

  #publish(): void {
    const selfId = this.#state.selfId;
    const others = [...this.#state.entities.values()].filter((e) => e.id !== selfId);
    this.#view = { status: this.#status, selfId, others };
    for (const cb of this.#listeners) cb(this.#view);
  }
}

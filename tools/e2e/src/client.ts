import type { ClientMessage, ServerMessage } from "@gamez/protocol";
// The same codec constant the browser client uses, so the e2e follows a wire-format switch.
import { codec } from "../../../apps/game/src/shared/codec.ts";

export interface Guest {
  token: string;
  accountId: string;
  name: string;
}

export interface Received<M extends ServerMessage = ServerMessage> {
  msg: M;
  /** performance.now() when the frame arrived. */
  at: number;
}

export async function loginGuest(baseUrl: string): Promise<Guest> {
  const res = await fetch(`${baseUrl}/api/guest`, { method: "POST" });
  if (!res.ok) throw new Error(`guest login failed: HTTP ${res.status}`);
  return (await res.json()) as Guest;
}

/** A scripted player on Node's global WebSocket that records every server message. */
export class BotClient {
  readonly log: Received[] = [];
  /** performance.now() when the socket was created. */
  readonly openedAt = performance.now();
  readonly closed: Promise<CloseEvent>;
  private readonly ws: WebSocket;
  private readonly waiters = new Set<() => void>();
  readonly guest: Guest;

  constructor(baseUrl: string, guest: Guest) {
    this.guest = guest;
    const url = `${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(guest.token)}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", (ev: MessageEvent<string | ArrayBuffer>) => {
      this.log.push({ msg: codec.decodeServer(ev.data), at: performance.now() });
      for (const wake of this.waiters) wake();
    });
    this.closed = new Promise((resolve) => this.ws.addEventListener("close", resolve));
  }

  /** "<accountId>:classic", the entity id the server gives this player. */
  get characterId(): string {
    return `${this.guest.accountId}:classic`;
  }

  send(msg: ClientMessage): void {
    // Codecs allocate their own buffers, so a binary frame is always ArrayBuffer-backed.
    this.ws.send(codec.encodeClient(msg) as string | Uint8Array<ArrayBuffer>);
  }

  /** Resolves with the first message (from index `from` on) that matches. */
  waitFor<M extends ServerMessage>(
    label: string,
    match: (m: ServerMessage) => m is M,
    timeoutMs = 10_000,
    from = 0,
  ): Promise<Received<M>> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        for (let i = from; i < this.log.length; i++) {
          const r = this.log[i]!;
          if (match(r.msg)) {
            done();
            resolve(r as Received<M>);
            return true;
          }
        }
        return false;
      };
      const timer = setTimeout(() => {
        done();
        const errors = this.log
          .filter((r) => r.msg.t === "error")
          .map((r) => JSON.stringify(r.msg));
        reject(
          new Error(
            `${this.guest.name}: timed out waiting for ${label}${errors.length ? `; errors: ${errors.join(", ")}` : ""}`,
          ),
        );
      }, timeoutMs);
      const wake = (): void => void check();
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
      };
      if (!check()) this.waiters.add(wake);
    });
  }

  /** Closes and waits for the server's close frame (at most 3 s). */
  async close(): Promise<void> {
    this.ws.close(1000, "bye");
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, 3000))]);
  }
}

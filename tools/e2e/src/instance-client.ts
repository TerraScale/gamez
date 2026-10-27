/**
 * A scripted player for /ws/instance (InstanceDO): JSON frames, every server
 * message recorded, plus helpers to join and to send one action and await its
 * result.
 */
import type { InstanceClientMessage, InstanceServerMessage } from "@gamez/protocol";
import type { Guest } from "./client.ts";

export type StateMsg = Extract<InstanceServerMessage, { t: "state" }>;
export type ResultMsg = Extract<InstanceServerMessage, { t: "result" }>;

export interface InstanceReceived {
  msg: InstanceServerMessage;
  /** performance.now() when the frame arrived. */
  at: number;
}

export class InstanceBot {
  readonly log: InstanceReceived[] = [];
  readonly openedAt = performance.now();
  readonly opened: Promise<void>;
  readonly closed: Promise<CloseEvent>;
  readonly guest: Guest;
  readonly mode: string;
  private readonly ws: WebSocket;
  private readonly waiters = new Set<() => void>();

  constructor(baseUrl: string, guest: Guest, mode: string) {
    this.guest = guest;
    this.mode = mode;
    const q = `token=${encodeURIComponent(guest.token)}&mode=${encodeURIComponent(mode)}`;
    this.ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws/instance?${q}`);
    this.ws.addEventListener("message", (ev: MessageEvent<string | ArrayBuffer>) => {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
      this.log.push({ msg: JSON.parse(text) as InstanceServerMessage, at: performance.now() });
      for (const wake of this.waiters) wake();
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error(`${mode}: socket error`)), {
        once: true,
      });
    });
    this.closed = new Promise((resolve) => this.ws.addEventListener("close", resolve));
  }

  send(msg: InstanceClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Sends join and resolves with the next `state`. */
  async join(fresh = false): Promise<StateMsg> {
    await this.opened;
    const from = this.log.length;
    this.send({ t: "join", token: this.guest.token, mode: this.mode, fresh });
    return (await this.waitFor("state", (m): m is StateMsg => m.t === "state", 10_000, from)).msg;
  }

  /** Sends one action and resolves with its `result`. */
  async act(seq: number, name: string, payload: unknown): Promise<ResultMsg> {
    const from = this.log.length;
    this.send({ t: "action", seq, name, payload });
    const res = await this.waitFor(
      `result ${seq} (${name})`,
      (m): m is ResultMsg => m.t === "result" && m.seq === seq,
      10_000,
      from,
    );
    return res.msg;
  }

  /** Resolves with the first message (from index `from` on) that matches. */
  waitFor<M extends InstanceServerMessage>(
    label: string,
    match: (m: InstanceServerMessage) => m is M,
    timeoutMs = 10_000,
    from = 0,
  ): Promise<InstanceReceived & { msg: M }> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        for (let i = from; i < this.log.length; i++) {
          const r = this.log[i]!;
          if (match(r.msg)) {
            done();
            resolve(r as InstanceReceived & { msg: M });
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
            `${this.mode}: timed out waiting for ${label}${errors.length ? `; errors: ${errors.join(", ")}` : ""}`,
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

/**
 * A scripted chat socket for the wave B e2e (docs/design/wave-B.md §5): one
 * /ws/chat connection on Node's WebSocket that records every server frame.
 * OWNER: T-chat.
 */
import type { ChatClientMessage, ChatServerMessage } from "@gamez/protocol";

export interface ChatLogEntry {
  msg: ChatServerMessage;
  at: number;
}

export class ChatBot {
  readonly log: ChatLogEntry[] = [];
  readonly closed: Promise<CloseEvent>;
  readonly opened: Promise<void>;
  readonly label: string;
  private readonly ws: WebSocket;
  private readonly waiters = new Set<() => void>();

  /** `token` is the guest or account token; `channel` e.g. "global". */
  constructor(baseUrl: string, token: string, channel: string, label = "bot") {
    this.label = label;
    const url = `${baseUrl.replace(/^http/, "ws")}/ws/chat?token=${encodeURIComponent(token)}&channel=${encodeURIComponent(channel)}`;
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (ev: MessageEvent<string>) => {
      this.log.push({
        msg: JSON.parse(String(ev.data)) as ChatServerMessage,
        at: performance.now(),
      });
      for (const wake of this.waiters) wake();
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () =>
        reject(new Error(`${label}: chat socket failed to open`)),
      );
    });
    this.opened.catch(() => {});
    this.closed = new Promise((resolve) => this.ws.addEventListener("close", resolve));
  }

  send(msg: ChatClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Sends a chat line and returns its nonce. */
  say(text: string, nonce: string): string {
    this.send({ t: "send", text, nonce });
    return nonce;
  }

  /**
   * Resolves with the first frame (from index `from` on) that matches; rejects
   * after `timeoutMs`, naming the error frames received so far.
   */
  waitFor<M extends ChatServerMessage>(
    label: string,
    match: (m: ChatServerMessage) => m is M,
    timeoutMs = 10_000,
    from = 0,
  ): Promise<M> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        for (let i = from; i < this.log.length; i++) {
          const m = this.log[i]!.msg;
          if (match(m)) {
            done();
            resolve(m);
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
            `${this.label}: timed out waiting for ${label}${errors.length ? `; errors: ${errors.join(", ")}` : ""}`,
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

  /** The ack or error answering the send with this nonce. */
  outcome(
    nonce: string,
    timeoutMs = 10_000,
  ): Promise<Extract<ChatServerMessage, { t: "ack" | "error" }>> {
    return this.waitFor(
      `outcome of ${nonce}`,
      (m): m is Extract<ChatServerMessage, { t: "ack" | "error" }> =>
        (m.t === "ack" || m.t === "error") && m.nonce === nonce,
      timeoutMs,
    );
  }

  /** Every frame received so far of one type. */
  frames<T extends ChatServerMessage["t"]>(t: T): Extract<ChatServerMessage, { t: T }>[] {
    return this.log
      .map((r) => r.msg)
      .filter((m): m is Extract<ChatServerMessage, { t: T }> => m.t === t);
  }

  /** Closes and waits for the close frame (at most 3 s). */
  async close(): Promise<void> {
    this.ws.close(1000, "bye");
    await Promise.race([this.closed, new Promise((r) => setTimeout(r, 3000))]);
  }
}

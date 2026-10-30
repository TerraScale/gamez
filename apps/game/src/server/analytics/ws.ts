/**
 * WebSocket open and close points (docs/design/admin-dashboard.md §2.7, §3).
 * "ws.open" on accept, "ws.close" on close. The open time lives in each
 * socket's attachment (openedAt), which survives hibernation.
 */
import type { Analytics } from "./types.ts";

export type WsKind = "presence" | "instance" | "chat";

/** Close code recorded when a socket fails without a close frame (RFC 6455 1006). */
export const WS_ABNORMAL_CLOSE = 1006;

/**
 * The mode blob of a chat channel: "global", the catalog mode id for "mode:<id>",
 * or "guild". The guild id is left out to keep the blob bounded.
 */
export function chatWsMode(channel: string): string {
  if (channel === "global") return "global";
  if (channel.startsWith("mode:")) return channel.slice(5) || "unknown";
  if (channel.startsWith("guild:")) return "guild";
  return "unknown";
}

/** One "ws.open" point. Call after the socket is accepted and its attachment is stored. */
export function wsOpened(analytics: Analytics, kind: WsKind, mode: string): void {
  try {
    analytics.write("ws.open", { kind, mode });
  } catch {
    // Instrumentation never breaks a socket.
  }
}

/**
 * One "ws.close" point. `openedAt` comes from the attachment (epoch ms); a missing
 * or later-than-now value counts as 0 seconds. `code` is the close code (or
 * WS_ABNORMAL_CLOSE for a socket error).
 */
export function wsClosed(
  analytics: Analytics,
  kind: WsKind,
  mode: string,
  code: number,
  openedAt: number | undefined,
  now: number,
): void {
  try {
    const span = openedAt === undefined ? 0 : now - openedAt;
    const durationS = Number.isFinite(span) && span > 0 ? Math.round(span / 100) / 10 : 0;
    analytics.write("ws.close", { kind, mode, code: String(code) }, { durationS });
  } catch {
    // Instrumentation never breaks a socket.
  }
}

/**
 * Records at most one "ws.close" per socket. A host that closes a socket itself
 * (a guild revoke, a membership sweep) records the close at that moment; the
 * runtime's later webSocketClose for the same socket is then skipped, so each
 * close is counted once whichever side reports it.
 */
export class WsCloseOnce<S extends object> {
  readonly #seen = new WeakSet<S>();

  record(
    socket: S,
    analytics: Analytics,
    kind: WsKind,
    mode: string,
    code: number,
    openedAt: number | undefined,
    now: number,
  ): boolean {
    if (this.#seen.has(socket)) return false;
    this.#seen.add(socket);
    wsClosed(analytics, kind, mode, code, openedAt, now);
    return true;
  }
}

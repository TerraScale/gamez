/**
 * Chat wire helpers: parse ChatClientMessage frames (untrusted input) and
 * encode ChatServerMessage frames. Pure.
 */
import type { ChatClientMessage, ChatServerMessage, ReportReason } from "@gamez/protocol";

/** Frames above this size are rejected before JSON parsing. */
export const MAX_CHAT_FRAME = 4096;
const MAX_SEND_TEXT = 1000;
const REASONS: readonly ReportReason[] = ["spam", "abuse", "cheating", "other"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The client message of a frame, or null when it is malformed. Never throws. */
export function parseChatClientMessage(raw: string | ArrayBuffer): ChatClientMessage | null {
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    if (text.length > MAX_CHAT_FRAME) return null;
    const v: unknown = JSON.parse(text);
    if (!isRecord(v)) return null;
    switch (v.t) {
      case "send":
        if (typeof v.text !== "string" || v.text.length > MAX_SEND_TEXT) return null;
        if (typeof v.nonce !== "string" || v.nonce.length < 1 || v.nonce.length > 64) return null;
        return { t: "send", text: v.text, nonce: v.nonce };
      case "report":
        if (typeof v.id !== "string" || v.id.length < 1 || v.id.length > 64) return null;
        if (!REASONS.includes(v.reason as ReportReason)) return null;
        return { t: "report", id: v.id, reason: v.reason as ReportReason };
      case "block":
        if (typeof v.accountId !== "string" || v.accountId.length < 1 || v.accountId.length > 100)
          return null;
        if (typeof v.blocked !== "boolean") return null;
        return { t: "block", accountId: v.accountId, blocked: v.blocked };
      case "ping":
        if (typeof v.clientTime !== "number" || !Number.isFinite(v.clientTime)) return null;
        return { t: "ping", clientTime: v.clientTime };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function encodeChatServerMessage(msg: ChatServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * JSON wire format for /ws/instance (InstanceClientMessage /
 * InstanceServerMessage). Client frames are untrusted: parseClientMessage
 * checks the full shape and returns null for anything malformed.
 */
import type { InstanceClientMessage, InstanceServerMessage } from "@gamez/protocol";

/** Largest client frame we decode (action payloads are small). */
export const MAX_CLIENT_FRAME = 16 * 1024;

/** WebSocket close code: another connection for the same player joined this instance. */
export const CLOSE_REPLACED = 4409;

const decoder = new TextDecoder();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isShortString(v: unknown, max = 256): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

/** Decodes and validates one client frame; null when it is not a valid message. */
export function parseClientMessage(frame: string | ArrayBuffer): InstanceClientMessage | null {
  const size = typeof frame === "string" ? frame.length : frame.byteLength;
  if (size > MAX_CLIENT_FRAME) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(typeof frame === "string" ? frame : decoder.decode(frame));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw.t) {
    case "join": {
      if (typeof raw.token !== "string" || raw.token.length > 4096) return null;
      if (!isShortString(raw.mode, 64)) return null;
      if (raw.fresh !== undefined && typeof raw.fresh !== "boolean") return null;
      return { t: "join", token: raw.token, mode: raw.mode, fresh: raw.fresh === true };
    }
    case "action": {
      if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 1) return null;
      if (!isShortString(raw.name, 128)) return null;
      return { t: "action", seq: raw.seq as number, name: raw.name, payload: raw.payload ?? null };
    }
    case "ping": {
      if (typeof raw.clientTime !== "number" || !Number.isFinite(raw.clientTime)) return null;
      return { t: "ping", clientTime: raw.clientTime };
    }
    default:
      return null;
  }
}

export function encodeServerMessage(msg: InstanceServerMessage): string {
  return JSON.stringify(msg);
}

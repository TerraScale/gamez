/**
 * Client end of the /ws/instance JSON wire format. Server frames are trusted
 * more than client ones but still checked enough that a bad frame is dropped
 * instead of corrupting the view.
 */
import type { SimSnapshot } from "@gamez/kernel";
import type { InstanceClientMessage, InstanceServerMessage } from "@gamez/protocol";

/** Close code: the token is invalid (same value as shared/codec.ts CLOSE_UNAUTHORIZED). */
export const CLOSE_UNAUTHORIZED = 4401;
/** Close code: a newer connection for the same player took over (server/instance/messages.ts). */
export const CLOSE_REPLACED = 4409;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSnapshot(v: unknown): v is SimSnapshot {
  return (
    isRecord(v) &&
    typeof v.modeId === "string" &&
    typeof v.contentHash === "string" &&
    typeof v.tick === "number" &&
    Array.isArray(v.rng) &&
    isRecord(v.world)
  );
}

function isError(v: unknown): v is { code: string; message: string } {
  return isRecord(v) && typeof v.code === "string" && typeof v.message === "string";
}

/** Decodes one server frame; null when it is not a valid message. */
export function parseServerMessage(frame: unknown): InstanceServerMessage | null {
  if (typeof frame !== "string") return null;
  let m: unknown;
  try {
    m = JSON.parse(frame);
  } catch {
    return null;
  }
  if (!isRecord(m)) return null;
  switch (m.t) {
    case "state":
      return typeof m.instanceId === "string" &&
        typeof m.mode === "string" &&
        typeof m.contentHash === "string" &&
        typeof m.lastSeq === "number" &&
        isSnapshot(m.snapshot)
        ? (m as InstanceServerMessage)
        : null;
    case "result":
      return typeof m.seq === "number" &&
        typeof m.ok === "boolean" &&
        (m.error === undefined || isError(m.error)) &&
        Array.isArray(m.events) &&
        isSnapshot(m.snapshot)
        ? (m as InstanceServerMessage)
        : null;
    case "pong":
      return typeof m.clientTime === "number" && typeof m.serverTime === "number"
        ? (m as InstanceServerMessage)
        : null;
    case "error":
      return isError(m) ? (m as InstanceServerMessage) : null;
    default:
      return null;
  }
}

export function encodeClientMessage(msg: InstanceClientMessage): string {
  return JSON.stringify(msg);
}

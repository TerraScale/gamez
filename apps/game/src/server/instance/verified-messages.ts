/**
 * Strict parser for VerifiedClientMessage frames (docs/design/wave-B.md §2.3).
 * Client frames are untrusted: anything that is not exactly a known message
 * shape within the size limits is rejected (null). Semantic checks (ticks
 * continuing the verified state, segment limits of the mode) are the host's.
 */
import type { SegmentInput } from "@gamez/kernel";
import {
  isOpId,
  MAX_VERIFIED_CLIENT_FRAME,
  type BankOp,
  type PackedSnapshot,
  type VerifiedClientMessage,
  type VerifiedServerMessage,
} from "@gamez/protocol";

/** Generic bound on inputs per segment frame (the mode's policy is usually lower). */
export const MAX_FRAME_INPUTS = 1024;
/** Longest accepted hash string (kernel hashes are short hex). */
export const MAX_HASH_LENGTH = 64;
/** Longest accepted action name. */
export const MAX_ACTION_NAME = 128;

const decoder = new TextDecoder();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUint(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

function isHash(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_HASH_LENGTH;
}

function frameSize(frame: string | ArrayBuffer): number {
  // UTF-16 length is a lower bound of the UTF-8 size; good enough as a cheap cap.
  return typeof frame === "string" ? frame.length : frame.byteLength;
}

function parseInputs(v: unknown): SegmentInput[] | null {
  if (!Array.isArray(v) || v.length > MAX_FRAME_INPUTS) return null;
  const out: SegmentInput[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) return null;
    if (!isUint(raw.tick)) return null;
    if (typeof raw.name !== "string" || raw.name.length === 0) return null;
    if (raw.name.length > MAX_ACTION_NAME) return null;
    out.push({ tick: raw.tick, name: raw.name, payload: raw.payload ?? null });
  }
  return out;
}

function parsePacked(v: unknown): PackedSnapshot | null {
  if (!isRecord(v)) return null;
  if (v.enc === "json" && isRecord(v.data)) return { enc: "json", data: v.data as never };
  // gzip64 keeps its wire shape, bounded by the frame cap, but the host refuses
  // to inflate it (ADR 0007 R8): imports must be enc "json".
  if (
    v.enc === "gzip64" &&
    typeof v.data === "string" &&
    v.data.length > 0 &&
    v.data.length <= MAX_VERIFIED_CLIENT_FRAME
  ) {
    return { enc: "gzip64", data: v.data };
  }
  return null;
}

/** Largest amount a bank op may carry (the mode's own cap is usually lower). */
export const MAX_BANK_AMOUNT = 1_000_000_000;
/** Longest accepted vault uid. */
export const MAX_VAULT_UID = 64;

function isAmount(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_BANK_AMOUNT;
}

/** Strict BankOp shape (wave-C.md §2.2); null when anything is off. */
export function parseBankOp(v: unknown): BankOp | null {
  if (!isRecord(v)) return null;
  switch (v.kind) {
    case "depositGold":
      return isAmount(v.gold) ? { kind: "depositGold", gold: v.gold } : null;
    case "withdrawCoin":
      return isAmount(v.coin) ? { kind: "withdrawCoin", coin: v.coin } : null;
    case "depositItem":
      return Number.isSafeInteger(v.ref) && (v.ref as number) >= 1
        ? { kind: "depositItem", ref: v.ref as number }
        : null;
    case "withdrawItem":
      return typeof v.uid === "string" && v.uid.length > 0 && v.uid.length <= MAX_VAULT_UID
        ? { kind: "withdrawItem", uid: v.uid }
        : null;
    default:
      return null;
  }
}

/** Decodes and validates one client frame; null when it is not a valid message. */
export function parseVerifiedClientMessage(
  frame: string | ArrayBuffer,
): VerifiedClientMessage | null {
  if (frameSize(frame) > MAX_VERIFIED_CLIENT_FRAME) return null;
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
      if (typeof raw.mode !== "string" || raw.mode.length === 0 || raw.mode.length > 64)
        return null;
      if (raw.fresh !== undefined && typeof raw.fresh !== "boolean") return null;
      const msg: Extract<VerifiedClientMessage, { t: "join" }> = {
        t: "join",
        token: raw.token,
        mode: raw.mode,
      };
      if (raw.fresh === true) msg.fresh = true;
      if (raw.resume !== undefined && raw.resume !== null) {
        const r = raw.resume;
        if (!isRecord(r) || !isUint(r.tick) || !isHash(r.hash) || typeof r.pending !== "boolean")
          return null;
        msg.resume = { tick: r.tick, hash: r.hash, pending: r.pending };
        // Optional hint (offline-idle.md §5.2): an invalid value is dropped, not rejected.
        if (isUint(r.pendingToTick)) msg.resume.pendingToTick = r.pendingToTick;
      }
      return msg;
    }
    case "segment": {
      if (!isUint(raw.epoch) || !isUint(raw.seq)) return null;
      if (!isUint(raw.fromTick) || !isUint(raw.toTick)) return null;
      if (!isHash(raw.hash)) return null;
      const inputs = parseInputs(raw.inputs);
      if (!inputs) return null;
      return {
        t: "segment",
        epoch: raw.epoch,
        seq: raw.seq,
        fromTick: raw.fromTick,
        toTick: raw.toTick,
        inputs,
        hash: raw.hash,
      };
    }
    case "import": {
      const snapshot = parsePacked(raw.snapshot);
      if (!snapshot) return null;
      if (typeof raw.savedAt !== "number" || !Number.isFinite(raw.savedAt)) return null;
      return { t: "import", snapshot, savedAt: raw.savedAt };
    }
    case "ping": {
      if (typeof raw.clientTime !== "number" || !Number.isFinite(raw.clientTime)) return null;
      return { t: "ping", clientTime: raw.clientTime };
    }
    case "bank": {
      if (!isOpId(raw.opId)) return null;
      const op = parseBankOp(raw.op);
      if (!op) return null;
      const at = raw.at;
      if (!isRecord(at) || !isUint(at.tick) || !isHash(at.hash)) return null;
      return { t: "bank", opId: raw.opId, op, at: { tick: at.tick, hash: at.hash } };
    }
    default:
      return null;
  }
}

export function encodeVerifiedServerMessage(msg: VerifiedServerMessage): string {
  return JSON.stringify(msg);
}

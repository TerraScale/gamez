/**
 * Session tokens (phase 0 guest format, extended in wave B §3.1).
 *
 * Format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, payload))>`.
 * Verification uses `crypto.subtle.verify`, which compares the MAC in
 * constant time.
 *
 * Payload v1 (phase 0 guests): `{accountId, name, issuedAt}`.
 * Payload v2 (wave B): adds `kind` ("guest" | "registered") and `sid` (the
 * AccountDO session id of a registered login, null for guests). v1 tokens
 * stay valid and read as guests. Registered tokens are only half the check:
 * auth/session.ts also asks AccountDO.checkSession(sid) (revocation).
 */
import type { AccountKind } from "@gamez/protocol";

/** Tokens stop working 30 days after issue; the client then logs in again (close code 4401). */
export const GUEST_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Same limit for every token kind (wave B). */
export const TOKEN_MAX_AGE_MS = GUEST_TOKEN_MAX_AGE_MS;
/** Tolerated clock skew for tokens "issued in the future" (several isolates sign). */
export const TOKEN_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface Identity {
  accountId: string;
  name: string;
  /** Epoch ms when the token was issued. */
  issuedAt: number;
  /** v2 only; absent = guest (v1 token). */
  kind?: AccountKind;
  /** v2 only: session id of a registered login; null/absent for guests. */
  sid?: string | null;
}

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** base64url of `n` random bytes. */
export function randomId(bytes = 16): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** HMAC-signs any JSON value as `<payload>.<mac>` (tokens, OAuth state cookie). */
export async function signValue(secret: string, value: unknown): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(value)));
  const key = await hmacKey(secret, "sign");
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

/** The JSON value of a `signValue` string with a valid MAC, else undefined. */
export async function verifyValue(secret: string, signed: string): Promise<unknown> {
  const dot = signed.indexOf(".");
  if (dot <= 0 || dot !== signed.lastIndexOf(".")) return undefined;
  const payload = signed.slice(0, dot);
  const mac = fromBase64Url(signed.slice(dot + 1));
  if (!mac || mac.length !== 32) return undefined;
  const key = await hmacKey(secret, "verify");
  if (!(await crypto.subtle.verify("HMAC", key, mac, encoder.encode(payload)))) return undefined;
  const raw = fromBase64Url(payload);
  if (!raw) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return undefined;
  }
}

export async function signToken(secret: string, identity: Identity): Promise<string> {
  const payload: Identity = {
    accountId: identity.accountId,
    name: identity.name,
    issuedAt: identity.issuedAt,
  };
  if (identity.kind !== undefined) payload.kind = identity.kind;
  if (identity.sid !== undefined) payload.sid = identity.sid;
  return signValue(secret, payload);
}

/**
 * Returns the identity for a valid token, or null (bad format, bad MAC,
 * inconsistent v2 fields, issued in the future, or older than `maxAgeMs`).
 * v1 tokens come back without kind/sid.
 */
export async function verifyToken(
  secret: string,
  token: string,
  maxAgeMs = Number.POSITIVE_INFINITY,
  now = Date.now(),
): Promise<Identity | null> {
  const v = await verifyValue(secret, token);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const id = v as Partial<Record<keyof Identity, unknown>>;
  if (
    typeof id.accountId !== "string" ||
    id.accountId.length === 0 ||
    typeof id.name !== "string" ||
    typeof id.issuedAt !== "number" ||
    !Number.isFinite(id.issuedAt)
  ) {
    return null;
  }
  if (now - id.issuedAt > maxAgeMs) return null;
  if (id.issuedAt - now > TOKEN_FUTURE_SKEW_MS) return null;
  const out: Identity = { accountId: id.accountId, name: id.name, issuedAt: id.issuedAt };
  if (id.kind !== undefined) {
    if (id.kind !== "guest" && id.kind !== "registered") return null;
    out.kind = id.kind;
  }
  if (id.sid !== undefined) {
    if (id.sid !== null && typeof id.sid !== "string") return null;
    out.sid = id.sid;
  }
  // A registered session without a sid could never be revoked: refuse it.
  if (out.kind === "registered" && typeof out.sid !== "string") return null;
  return out;
}

/** A fresh guest identity: random account id and a "Guest-XXXX" display name. */
export function newGuest(now = Date.now()): Identity {
  const tag = crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16).toUpperCase();
  return { accountId: crypto.randomUUID(), name: `Guest-${tag.padStart(4, "0")}`, issuedAt: now };
}

/**
 * Guest session tokens (phase 0; real auth arrives in phase 2).
 *
 * Format: `<base64url(JSON identity)>.<base64url(HMAC-SHA256(secret, payload))>`.
 * Verification uses `crypto.subtle.verify`, which compares the MAC in
 * constant time.
 */

/** Guest tokens stop working after 30 days; the client then logs in again (close code 4401). */
export const GUEST_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface Identity {
  accountId: string;
  name: string;
  /** Epoch ms when the token was issued. */
  issuedAt: number;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
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

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signToken(secret: string, identity: Identity): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(identity)));
  const key = await hmacKey(secret, "sign");
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
}

/** Returns the identity for a valid token, or null (bad format, bad MAC, or older than `maxAgeMs`). */
export async function verifyToken(
  secret: string,
  token: string,
  maxAgeMs = Number.POSITIVE_INFINITY,
): Promise<Identity | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const mac = fromBase64Url(token.slice(dot + 1));
  if (!mac) return null;
  const key = await hmacKey(secret, "verify");
  if (!(await crypto.subtle.verify("HMAC", key, mac, encoder.encode(payload)))) return null;
  const raw = fromBase64Url(payload);
  if (!raw) return null;
  try {
    const id = JSON.parse(new TextDecoder().decode(raw)) as Partial<Identity>;
    if (
      typeof id.accountId !== "string" ||
      typeof id.name !== "string" ||
      typeof id.issuedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - id.issuedAt > maxAgeMs) return null;
    return { accountId: id.accountId, name: id.name, issuedAt: id.issuedAt };
  } catch {
    return null;
  }
}

/** A fresh guest identity: random account id and a "Guest-XXXX" display name. */
export function newGuest(now = Date.now()): Identity {
  const tag = crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16).toUpperCase();
  return { accountId: crypto.randomUUID(), name: `Guest-${tag.padStart(4, "0")}`, issuedAt: now };
}

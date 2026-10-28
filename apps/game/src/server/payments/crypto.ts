/**
 * WebCrypto helpers shared by the payment providers (wave-C.md §8). OWNER: T-pay.
 * WebCrypto only (Workers, Node 20+ and browsers share it). Nothing here reads
 * clocks: callers pass `now`.
 */

const encoder = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** HMAC-SHA256 of `message` keyed by `secret` (UTF-8), lowercase hex. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/** SHA-256 of `text` (UTF-8), lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/**
 * Constant-time string equality. Only the lengths leak (they are public for
 * every signature we compare). Never short-circuits on a mismatching byte.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ea = encoder.encode(a);
  const eb = encoder.encode(b);
  const n = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/**
 * Splits the external reference we write at every checkout ("<accountId>|<orderId>").
 * Null when it is missing or malformed.
 */
export function parseOrderRef(ref: unknown): { accountId: string; orderId: string } | null {
  if (typeof ref !== "string") return null;
  const bar = ref.indexOf("|");
  if (bar <= 0) return null;
  const accountId = ref.slice(0, bar);
  const orderId = ref.slice(bar + 1);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(accountId) || !/^o[0-9a-f]{24}$/.test(orderId)) return null;
  return { accountId, orderId };
}

/** Milliseconds timestamps and seconds timestamps both happen in provider headers. */
export function toMillis(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

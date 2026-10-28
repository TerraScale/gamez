/**
 * Password hashing (wave-B.md §3.2): PBKDF2-SHA256 through WebCrypto.
 *
 * Stored format: `pbkdf2-sha256$<iterations>$<salt>$<hash>` (salt and hash
 * base64url; 16-byte salt, 32-byte key). 100 000 iterations is workerd's
 * maximum for PBKDF2; tests pass fewer to stay fast. Verification re-derives
 * with the stored parameters and compares in constant time.
 */
import { PASSWORD_MAX, PASSWORD_MIN } from "@gamez/protocol";
import { fromBase64Url, toBase64Url } from "../auth.ts";

export const PBKDF2_ITERATIONS = 100_000;
/** workerd refuses PBKDF2 above this count. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
const SCHEME = "pbkdf2-sha256";

const encoder = new TextEncoder();

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Byte equality whose running time depends only on the lengths, never on where they differ. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Constant-time equality of two strings (UTF-8 bytes). */
export function constantTimeEqualText(a: string, b: string): boolean {
  return constantTimeEqual(encoder.encode(a), encoder.encode(b));
}

export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) {
    throw new RangeError(`PBKDF2 iterations must be 1..${PBKDF2_MAX_ITERATIONS}`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `${SCHEME}$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

interface ParsedHash {
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
  hash: Uint8Array<ArrayBuffer>;
}

export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== SCHEME) return null;
  const iterations = Number(parts[1]);
  if (!/^[1-9][0-9]*$/.test(parts[1] ?? "") || iterations > PBKDF2_MAX_ITERATIONS) return null;
  const salt = fromBase64Url(parts[2] ?? "");
  const hash = fromBase64Url(parts[3] ?? "");
  if (!salt || !hash || salt.length < 8 || hash.length !== KEY_BYTES) return null;
  return { iterations, salt, hash };
}

/** True when `password` matches `stored`; false for a wrong password or a malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.iterations);
  return constantTimeEqual(candidate, parsed.hash);
}

/** True when the stored hash uses fewer iterations than today's default (rehash on login). */
export function needsRehash(stored: string, iterations = PBKDF2_ITERATIONS): boolean {
  const parsed = parsePasswordHash(stored);
  return !parsed || parsed.iterations < iterations;
}

/** Server-side password policy (the client shows the same rules). */
export function passwordProblem(password: unknown): "weak_password" | null {
  if (typeof password !== "string") return "weak_password";
  const len = password.length;
  if (len < PASSWORD_MIN || len > PASSWORD_MAX) return "weak_password";
  if (password.trim().length === 0) return "weak_password";
  return null;
}

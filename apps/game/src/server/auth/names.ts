/**
 * Display-name and email rules (wave-B.md §3.3). Names: 3-20 chars of
 * [A-Za-z0-9 _-], trimmed, inner whitespace collapsed, not unique; a
 * registered account may not take a "Guest-" name.
 */
import { DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, type AccountKind } from "@gamez/protocol";

const NAME_CHARS = /^[A-Za-z0-9 _-]+$/;
const GUEST_PREFIX = /^guest-/i;

/** Trims and collapses inner whitespace (the stored form). */
export function normaliseDisplayName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** The normalised name, or null when it breaks the rules for `kind`. */
export function validDisplayName(name: unknown, kind: AccountKind): string | null {
  if (typeof name !== "string") return null;
  const n = normaliseDisplayName(name);
  if (n.length < DISPLAY_NAME_MIN || n.length > DISPLAY_NAME_MAX) return null;
  if (!NAME_CHARS.test(n)) return null;
  if (kind === "registered" && GUEST_PREFIX.test(n)) return null;
  return n;
}

export function isGuestName(name: string): boolean {
  return GUEST_PREFIX.test(name);
}

/** A valid registered name derived from free text (OAuth profile, email local part), or "Player-XXXX". */
export function suggestDisplayName(raw: string | null | undefined): string {
  const cleaned = normaliseDisplayName(
    (raw ?? "").replace(/[^A-Za-z0-9 _-]+/g, " ").slice(0, 64),
  ).slice(0, DISPLAY_NAME_MAX);
  const valid = validDisplayName(cleaned, "registered");
  if (valid) return valid;
  const tag = crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16).toUpperCase();
  return `Player-${tag.padStart(4, "0")}`;
}

export const EMAIL_MAX = 254;

/** Trimmed lowercase email, or null when it does not look like one. */
export function normaliseEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  if (e.length < 3 || e.length > EMAIL_MAX) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(e)) return null;
  return e;
}

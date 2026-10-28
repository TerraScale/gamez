/**
 * OAuth round-trip state (wave-B.md §3.3): PKCE S256 and the signed
 * `gz_oauth` cookie that carries the state, the code verifier and the link
 * target between /start and /callback. The cookie is HMAC-signed (not
 * encrypted) with a key derived from AUTH_SECRET for this purpose only, so a
 * session token can never pass as a cookie and vice versa. HttpOnly keeps
 * the verifier away from page scripts; SameSite=Lax lets the provider's
 * top-level redirect back carry it.
 */
import type { AccountKind } from "@gamez/protocol";
import { randomId, signValue, toBase64Url, verifyValue } from "../../auth.ts";
import { constantTimeEqualText } from "../password.ts";

export const OAUTH_COOKIE = "gz_oauth";
export const OAUTH_COOKIE_PATH = "/api/auth/oauth";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type OAuthProviderId = "google" | "discord" | "apple";
export const OAUTH_PROVIDERS: readonly OAuthProviderId[] = ["google", "discord", "apple"];

export function isOAuthProvider(p: string): p is OAuthProviderId {
  return (OAUTH_PROVIDERS as readonly string[]).includes(p);
}

/** The account a link flow attaches the login to (from the token given to /start). */
export interface LinkTarget {
  accountId: string;
  name: string;
  kind: AccountKind;
  sid: string | null;
}

export interface OAuthState {
  v: 1;
  provider: OAuthProviderId;
  state: string;
  verifier: string;
  stub: boolean;
  link: LinkTarget | null;
  redirectUri: string;
  expiresAt: number;
}

const stateKey = (secret: string) => `${secret}\u0000gamez-oauth-state-v1`;

/** PKCE code verifier: 32 random bytes, base64url (43 chars, RFC 7636 §4.1). */
export function newVerifier(): string {
  return randomId(32);
}

/** S256 challenge of a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export function newOAuthState(input: {
  provider: OAuthProviderId;
  stub: boolean;
  link: LinkTarget | null;
  redirectUri: string;
  now?: number;
}): OAuthState {
  return {
    v: 1,
    provider: input.provider,
    state: randomId(16),
    verifier: newVerifier(),
    stub: input.stub,
    link: input.link,
    redirectUri: input.redirectUri,
    expiresAt: (input.now ?? Date.now()) + OAUTH_STATE_TTL_MS,
  };
}

export async function sealState(secret: string, s: OAuthState): Promise<string> {
  return signValue(stateKey(secret), s);
}

function isLink(v: unknown): v is LinkTarget {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.accountId === "string" &&
    typeof l.name === "string" &&
    (l.kind === "guest" || l.kind === "registered") &&
    (l.sid === null || typeof l.sid === "string")
  );
}

/** The cookie's state when signed, unexpired and well formed; else null. */
export async function openState(
  secret: string,
  sealed: string,
  now = Date.now(),
): Promise<OAuthState | null> {
  const v = await verifyValue(stateKey(secret), sealed);
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (
    s.v !== 1 ||
    typeof s.provider !== "string" ||
    !isOAuthProvider(s.provider) ||
    typeof s.state !== "string" ||
    typeof s.verifier !== "string" ||
    typeof s.stub !== "boolean" ||
    typeof s.redirectUri !== "string" ||
    typeof s.expiresAt !== "number" ||
    !(s.link === null || isLink(s.link))
  ) {
    return null;
  }
  if (now > s.expiresAt) return null;
  return s as unknown as OAuthState;
}

/**
 * The state for a callback: cookie valid, for this provider, and its state
 * equal (constant time) to the `state` query parameter.
 */
export async function checkCallbackState(
  secret: string,
  cookieValue: string | null,
  provider: OAuthProviderId,
  stateParam: string | null,
  now = Date.now(),
): Promise<OAuthState | null> {
  if (!cookieValue || !stateParam) return null;
  const s = await openState(secret, cookieValue, now);
  if (!s || s.provider !== provider) return null;
  return constantTimeEqualText(s.state, stateParam) ? s : null;
}

export function stateCookie(value: string, secure: boolean): string {
  return [
    `${OAUTH_COOKIE}=${value}`,
    `Path=${OAUTH_COOKIE_PATH}`,
    `Max-Age=${OAUTH_STATE_TTL_MS / 1000}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearStateCookie(secure: boolean): string {
  return [
    `${OAUTH_COOKIE}=`,
    `Path=${OAUTH_COOKIE_PATH}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Value of one cookie in a Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

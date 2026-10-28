/**
 * OAuth round-trip state (wave-B.md §3.3, ADR 0007 R3/R4): PKCE S256 and the
 * signed `gz_oauth` cookie that carries the state, the code verifier, the
 * link *intent* and the browser's fragment nonce between /start and
 * /callback. The cookie is HMAC-signed (not encrypted) with a key derived
 * from AUTH_SECRET for this purpose only, so a session token can never pass
 * as a cookie and vice versa. HttpOnly keeps the verifier away from page
 * scripts; SameSite=Lax lets the provider's top-level redirect back carry it.
 *
 * A link flow names no account in the URL or the cookie: its callback hands
 * the SPA a sealed, 5-minute link code (sealLinkCode, its own derived key),
 * which the SPA redeems with its own bearer (POST /api/auth/oauth/link).
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

/**
 * The account a link attaches the login to. ADR 0007 R3: it is always the
 * authenticated bearer of POST /api/auth/oauth/link, never read from a URL
 * or carried in the state cookie.
 */
export interface LinkTarget {
  accountId: string;
  name: string;
  kind: AccountKind;
  sid: string | null;
}

/** The browser's fragment nonce (ADR 0007 R4): 16-64 of [A-Za-z0-9_-]. */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isNonce(v: unknown): v is string {
  return typeof v === "string" && NONCE_PATTERN.test(v);
}

export interface OAuthState {
  v: 2;
  provider: OAuthProviderId;
  state: string;
  verifier: string;
  stub: boolean;
  /** A link intent only (`?link=1`); which account is decided at redeem time. */
  link: boolean;
  /** Echoed as `&n=` in every fragment the callback produces. */
  nonce: string;
  redirectUri: string;
  expiresAt: number;
}

const stateKey = (secret: string) => `${secret}\u0000gamez-oauth-state-v1`;
const linkKey = (secret: string) => `${secret}\u0000gamez-oauth-link-v1`;

/** How long a link code from a callback stays redeemable. */
export const LINK_CODE_TTL_MS = 5 * 60 * 1000;

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
  link: boolean;
  nonce: string;
  redirectUri: string;
  now?: number;
}): OAuthState {
  return {
    v: 2,
    provider: input.provider,
    state: randomId(16),
    verifier: newVerifier(),
    stub: input.stub,
    link: input.link,
    nonce: input.nonce,
    redirectUri: input.redirectUri,
    expiresAt: (input.now ?? Date.now()) + OAUTH_STATE_TTL_MS,
  };
}

export async function sealState(secret: string, s: OAuthState): Promise<string> {
  return signValue(stateKey(secret), s);
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
    s.v !== 2 ||
    typeof s.provider !== "string" ||
    !isOAuthProvider(s.provider) ||
    typeof s.state !== "string" ||
    typeof s.verifier !== "string" ||
    typeof s.stub !== "boolean" ||
    typeof s.redirectUri !== "string" ||
    typeof s.expiresAt !== "number" ||
    typeof s.link !== "boolean" ||
    !isNonce(s.nonce)
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

/** What a link callback learned from the provider, for POST /api/auth/oauth/link. */
export interface LinkGrant {
  provider: OAuthProviderId;
  subject: string;
  email: string | null;
  name: string | null;
}

interface SealedLink extends LinkGrant {
  v: 1;
  exp: number;
}

/** Seals a verified provider profile into a short-lived link code (URL-safe). */
export async function sealLinkCode(
  secret: string,
  grant: LinkGrant,
  now = Date.now(),
): Promise<string> {
  const sealed: SealedLink = {
    v: 1,
    provider: grant.provider,
    subject: grant.subject,
    email: grant.email !== null && grant.email.length <= 320 ? grant.email : null,
    name: grant.name?.slice(0, 256) ?? null,
    exp: now + LINK_CODE_TTL_MS,
  };
  return signValue(linkKey(secret), sealed);
}

const nullableText = (v: unknown, max: number): v is string | null =>
  v === null || (typeof v === "string" && v.length <= max);

/** The grant of a link code when signed, unexpired and well formed; else null. */
export async function openLinkCode(
  secret: string,
  code: unknown,
  now = Date.now(),
): Promise<LinkGrant | null> {
  if (typeof code !== "string" || code.length === 0 || code.length > 2048) return null;
  const v = await verifyValue(linkKey(secret), code);
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (
    s.v !== 1 ||
    typeof s.provider !== "string" ||
    !isOAuthProvider(s.provider) ||
    typeof s.subject !== "string" ||
    s.subject.length === 0 ||
    s.subject.length > 256 ||
    !nullableText(s.email, 320) ||
    !nullableText(s.name, 256) ||
    typeof s.exp !== "number" ||
    now > s.exp
  ) {
    return null;
  }
  return { provider: s.provider, subject: s.subject, email: s.email, name: s.name };
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

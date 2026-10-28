/**
 * Account flows behind /api/auth/* (wave-B.md §3.3): register (guest upgrade
 * in place or a new account), login, display-name change and OAuth
 * completion. They only talk to IdentityDO and AccountDO through their RPC
 * surfaces, so tests run them against in-memory namespaces.
 *
 * Ordering and failure: the IdentityDO claim is the commit point ("this login
 * belongs to account X"); the AccountDO steps after it are idempotent and
 * re-run (healed) by the next login or retry, so a crash between the two
 * never strands a login.
 */
import type { AccountKind, AuthErrorCode, AuthProvider, AuthResponse } from "@gamez/protocol";
import { signToken } from "../auth.ts";
import { identityKey, type Env, type SessionIdentity } from "../contracts.ts";
import { normaliseEmail, suggestDisplayName, validDisplayName } from "./names.ts";
import { hashPassword, passwordProblem, PBKDF2_ITERATIONS } from "./password.ts";
import type { OAuthProfile } from "./oauth/providers.ts";
import { sessionStillOpen } from "./session.ts";
import type { LinkTarget } from "./oauth/state.ts";

export type AuthEnv = Pick<Env, "AUTH_SECRET" | "ACCOUNT" | "IDENTITY">;

export type FlowResult =
  | { ok: true; response: AuthResponse }
  | { ok: false; status: number; code: AuthErrorCode; message: string; retryAfterMs?: number };

/** Tunables (tests lower the PBKDF2 cost). */
export const flowConfig = { iterations: PBKDF2_ITERATIONS };

const fail = (
  status: number,
  code: AuthErrorCode,
  message: string,
  retryAfterMs?: number,
): FlowResult => ({
  ok: false,
  status,
  code,
  message,
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
});

/** Signs a token for the account's current profile and returns it with the view. */
export async function issue(
  env: AuthEnv,
  accountId: string,
  kind: AccountKind,
  sid: string | null,
): Promise<AuthResponse> {
  const view = await env.ACCOUNT.getByName(accountId).view();
  if (!view) throw new Error(`issue: account ${accountId} has no profile`);
  const token = await signToken(env.AUTH_SECRET, {
    accountId,
    name: view.displayName,
    issuedAt: Date.now(),
    kind,
    sid,
  });
  return { token, account: view };
}

const localPart = (email: string | null) => (email ? (email.split("@")[0] ?? null) : null);

/**
 * `client` is the caller's network identity (routes pass clientIp(request)):
 * IdentityDO keys its password-attempt lockout on (login, client), ADR 0007 R5.
 */
export async function register(
  env: AuthEnv,
  body: Record<string, unknown>,
  bearer: SessionIdentity | null,
  userAgent: string,
  client?: string,
): Promise<FlowResult> {
  const email = normaliseEmail(body.email);
  if (!email) return fail(400, "bad_email", "Enter a valid email address.");
  if (passwordProblem(body.password)) {
    return fail(400, "weak_password", "Passwords need 10 to 128 characters.");
  }
  const password = body.password as string;
  let displayName: string | null = null;
  if (body.displayName !== undefined && body.displayName !== null && body.displayName !== "") {
    displayName = validDisplayName(body.displayName, "registered");
    if (!displayName) {
      return fail(400, "bad_name", "Names are 3-20 letters, digits, spaces, _ or -.");
    }
  }

  const accountId = bearer?.accountId ?? crypto.randomUUID();
  const account = env.ACCOUNT.getByName(accountId);
  if (bearer?.kind === "registered") {
    const p = await account.profile();
    if (p?.identities.some((i) => i.provider === "email")) {
      return fail(400, "bad_request", "This account already has an email login.");
    }
  }

  const ident = env.IDENTITY.getByName(identityKey("email", email));
  const existing = await ident.get();
  if (existing && existing.accountId !== accountId) {
    return fail(409, "email_taken", "That email is already registered.");
  }
  if (existing) {
    // Same account: an earlier attempt claimed the login but did not finish.
    // Heal only with the password that attempt stored.
    const p = await account.profile();
    const linked = p?.identities.some((i) => i.provider === "email" && i.subject === email);
    if (linked) return fail(409, "email_taken", "That email is already registered.");
    const check = await ident.checkPassword(password, client);
    if (!check.ok) return fail(409, "email_taken", "That email is already registered.");
  } else {
    const passwordHash = await hashPassword(password, flowConfig.iterations);
    const { record } = await ident.claim({
      provider: "email",
      subject: email,
      accountId,
      email,
      passwordHash,
    });
    if (record.accountId !== accountId) {
      return fail(409, "email_taken", "That email is already registered.");
    }
  }

  await account.ensure(
    bearer
      ? { kind: bearer.kind, displayName: bearer.name }
      : { kind: "registered", displayName: displayName ?? suggestDisplayName(localPart(email)) },
  );
  await account.addIdentity({ provider: "email", subject: email, email });
  if (displayName) await account.setDisplayName(displayName);
  const sid =
    bearer?.kind === "registered" && bearer.sid
      ? bearer.sid
      : (await account.openSession(userAgent)).sid;
  return { ok: true, response: await issue(env, accountId, "registered", sid) };
}

export async function login(
  env: AuthEnv,
  body: Record<string, unknown>,
  userAgent: string,
  client?: string,
): Promise<FlowResult> {
  const email = normaliseEmail(body.email);
  const password = body.password;
  if (!email || typeof password !== "string" || password.length === 0 || password.length > 1024) {
    return fail(401, "bad_credentials", "Wrong email or password.");
  }
  const check = await env.IDENTITY.getByName(identityKey("email", email)).checkPassword(
    password,
    client,
  );
  if (!check.ok) {
    if (check.reason === "locked") {
      const after = check.retryAfterMs ?? 60_000;
      return fail(429, "locked", "Too many attempts. Try again later.", after);
    }
    return fail(401, "bad_credentials", "Wrong email or password.");
  }
  const account = env.ACCOUNT.getByName(check.accountId);
  await account.ensure({ kind: "registered", displayName: suggestDisplayName(localPart(email)) });
  await account.addIdentity({ provider: "email", subject: email, email });
  const session = await account.openSession(userAgent);
  return { ok: true, response: await issue(env, check.accountId, "registered", session.sid) };
}

export async function changeName(
  env: AuthEnv,
  who: SessionIdentity,
  body: Record<string, unknown>,
): Promise<FlowResult> {
  const name = validDisplayName(body.displayName, who.kind);
  if (!name) {
    return fail(
      400,
      "bad_name",
      who.kind === "registered"
        ? 'Names are 3-20 letters, digits, spaces, _ or -, and may not start with "Guest-".'
        : "Names are 3-20 letters, digits, spaces, _ or -.",
    );
  }
  const account = env.ACCOUNT.getByName(who.accountId);
  const profile = await account.ensure({ kind: who.kind, displayName: who.name });
  // The stored kind wins (a guest token cannot outlive the upgrade, but be strict anyway).
  if (!validDisplayName(name, profile.kind)) {
    return fail(400, "bad_name", 'Registered names may not start with "Guest-".');
  }
  await account.setDisplayName(name);
  return { ok: true, response: await issue(env, who.accountId, who.kind, who.sid) };
}

/**
 * Finishes an OAuth login (link = null: sign in or sign up) or link (attach
 * the login to `link`'s account, upgrading a guest in place). ADR 0007 R3:
 * `link` is only ever the authenticated bearer of POST /api/auth/oauth/link.
 */
export async function completeOAuth(
  env: AuthEnv,
  provider: Exclude<AuthProvider, "email">,
  profile: OAuthProfile,
  link: LinkTarget | null,
  userAgent: string,
): Promise<FlowResult> {
  const ident = env.IDENTITY.getByName(identityKey(provider, profile.subject));
  const email = profile.email;
  if (link) {
    if (!(await sessionStillOpen(env, link))) {
      return fail(401, "unauthorized", "Your session ended; sign in again.");
    }
    const { record } = await ident.claim({
      provider,
      subject: profile.subject,
      accountId: link.accountId,
      email,
      passwordHash: null,
    });
    if (record.accountId !== link.accountId) {
      return fail(409, "identity_taken", "That login belongs to another account.");
    }
    const account = env.ACCOUNT.getByName(link.accountId);
    await account.ensure({ kind: link.kind, displayName: link.name });
    await account.addIdentity({ provider, subject: profile.subject, email });
    const sid =
      link.kind === "registered" && link.sid
        ? link.sid
        : (await account.openSession(userAgent)).sid;
    return { ok: true, response: await issue(env, link.accountId, "registered", sid) };
  }

  const existing = await ident.get();
  let accountId = existing?.accountId ?? null;
  if (!accountId) {
    const { record } = await ident.claim({
      provider,
      subject: profile.subject,
      accountId: crypto.randomUUID(),
      email,
      passwordHash: null,
    });
    accountId = record.accountId;
  }
  const account = env.ACCOUNT.getByName(accountId);
  await account.ensure({
    kind: "registered",
    displayName: suggestDisplayName(profile.name ?? localPart(email)),
  });
  await account.addIdentity({ provider, subject: profile.subject, email });
  const session = await account.openSession(userAgent);
  return { ok: true, response: await issue(env, accountId, "registered", session.sid) };
}

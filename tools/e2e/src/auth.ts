/**
 * Wave B e2e: accounts and auth (docs/design/wave-B.md §3). OWNER: T-auth.
 * Guest upgrade in place, login from another guest, wrong password and
 * lockout, logout revocation, display names, the OAuth stub round trip
 * (login, link, identity_taken), the account_summary D1 row, and, after the
 * dev-server restart, persisted logins and sessions.
 */
import type { AccountView, AuthResponse, ProvidersResponse } from "@gamez/protocol";
import { api, loginEmail, oauthStub, registerGuest, type Registered } from "./accounts.ts";
import { loginGuest } from "./client.ts";
import type { E2eContext, E2eFeature } from "./features.ts";
import { check } from "./report.ts";

interface AuthState {
  main: Registered;
  /** Token of a still-open session from before the restart. */
  sessionToken: string;
  oauthSubject: string;
  oauthAccountId: string;
}

const KEY = "auth";

function tokenKind(token: string): { kind?: string; sid?: string | null; name?: string } {
  try {
    const payload = token.split(".")[0] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      kind?: string;
      sid?: string | null;
      name?: string;
    };
  } catch {
    return {};
  }
}

async function me(url: string, token: string) {
  return api<AccountView>(url, "/api/me", { token });
}

async function waitForRow(
  ctx: E2eContext,
  accountId: string,
  kind: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const rows = await ctx.db.query(
      "SELECT account_id, display_name, kind FROM account_summary WHERE account_id = ?",
      [accountId],
    );
    if (rows[0] && rows[0].kind === kind) return rows[0];
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

export const authFeature: E2eFeature = {
  name: "auth",

  async run(ctx) {
    const { url } = ctx;
    const suffix = Date.now().toString(36);

    // providers: every OAuth provider is a stub on the e2e host (localhost)
    const prov = await api<ProvidersResponse>(url, "/api/auth/providers");
    check(
      prov.status === 200 &&
        prov.body.providers.some((p) => p.id === "google" && p.enabled && p.stub) &&
        prov.body.providers.some((p) => p.id === "email" && p.enabled && !p.stub),
      "auth: providers list email + stub OAuth on localhost",
    );

    // 1. a guest upgrades in place
    const guest = await loginGuest(url);
    const guestMe = await me(url, guest.token);
    check(guestMe.status === 200 && guestMe.body.kind === "guest", "auth: /api/me answers a guest");
    const main = await registerGuest(url, guest, `Hero ${suffix.slice(-4)}`);
    check(main.accountId === guest.accountId, "auth: register keeps the guest's accountId");
    const mainMe = await me(url, main.token);
    check(
      mainMe.status === 200 &&
        mainMe.body.kind === "registered" &&
        mainMe.body.accountId === guest.accountId &&
        mainMe.body.identities.some((i) => i.provider === "email" && i.email === main.email),
      "auth: /api/me shows the registered account with its email login",
    );
    check(
      tokenKind(main.token).kind === "registered" && typeof tokenKind(main.token).sid === "string",
      "auth: the new token is a v2 registered session token",
    );
    check(
      (await me(url, guest.token)).status === 401,
      "auth: the old guest token stops working after the upgrade",
    );
    const dupe = await api<{ error: { code: string } }>(url, "/api/auth/register", {
      token: (await loginGuest(url)).token,
      body: { email: main.email.toUpperCase(), password: main.password },
    });
    check(
      dupe.status === 409 && dupe.body.error?.code === "email_taken",
      "auth: registering a taken email (any case) -> email_taken",
    );

    // 2. login from a fresh guest lands on the same account
    const other = await loginGuest(url);
    const login = await loginEmail(url, main.email, main.password, other.token);
    check(
      login.status === 200 && login.body.account?.accountId === main.accountId,
      "auth: login from a fresh guest returns the registered account",
    );

    // 3. wrong passwords -> bad_credentials, then locked (on a throwaway account)
    const victim = `e2e-lock-${suffix}@example.test`;
    await api<AuthResponse>(url, "/api/auth/register", {
      body: { email: victim, password: "lockout-pass-123" },
    });
    const codes: string[] = [];
    let retryAfter = 0;
    for (let i = 0; i < 5; i++) {
      const r = await loginEmail(url, victim, `wrong-pass-${i}-xyz`);
      codes.push(`${r.status}:${r.body.error?.code ?? "ok"}`);
      retryAfter = (r.body.error as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 0;
    }
    check(
      codes.slice(0, 4).every((c) => c === "401:bad_credentials"),
      `auth: wrong password -> bad_credentials (${codes.slice(0, 4).join(", ")})`,
    );
    check(
      codes[4] === "429:locked" && retryAfter > 0,
      `auth: 5th wrong password -> locked (${codes[4]}, retry ${retryAfter} ms)`,
    );
    const lockedRight = await loginEmail(url, victim, "lockout-pass-123");
    check(lockedRight.status === 429, "auth: a locked login refuses even the right password");

    // 4. logout revokes only that session
    const second = await loginEmail(url, main.email, main.password);
    const out = await api<{ ok: boolean }>(url, "/api/auth/logout", {
      token: second.body.token,
      method: "POST",
    });
    check(out.status === 200, "auth: logout answers 200");
    check((await me(url, second.body.token)).status === 401, "auth: the logged-out token gets 401");
    check((await me(url, main.token)).status === 200, "auth: other sessions stay open");

    // 5. display name
    const renamed = await api<AuthResponse>(url, "/api/account/name", {
      token: main.token,
      body: { displayName: `Ember ${suffix.slice(-4)}` },
    });
    check(
      renamed.status === 200 &&
        renamed.body.account.displayName === `Ember ${suffix.slice(-4)}` &&
        tokenKind(renamed.body.token).name === `Ember ${suffix.slice(-4)}`,
      "auth: display-name change returns a new token with the name",
    );
    const badName = await api<{ error: { code: string } }>(url, "/api/account/name", {
      token: main.token,
      body: { displayName: "Guest-ABCD" },
    });
    check(badName.body.error?.code === "bad_name", "auth: registered names may not be Guest-*");
    main.token = renamed.body.token;

    // 6. OAuth stub: login creates an account and the token works on /api/me
    const subject = `e2e-${suffix}`;
    const oauthLogin = await oauthStub(url, "google", {
      subject,
      email: `${subject}@example.test`,
      name: "Stub Tester",
    });
    const oauthMe = oauthLogin.token ? await me(url, oauthLogin.token) : null;
    check(
      oauthMe?.status === 200 &&
        oauthMe.body.kind === "registered" &&
        oauthMe.body.identities.some((i) => i.provider === "google"),
      `auth: OAuth stub start -> page -> callback -> #auth token works (${oauthLogin.steps.join(", ")})`,
    );
    const oauthAgain = await oauthStub(url, "google", { subject });
    const againMe = oauthAgain.token ? await me(url, oauthAgain.token) : null;
    check(
      againMe?.body.accountId === oauthMe?.body.accountId,
      "auth: signing in again with the same OAuth login returns the same account",
    );

    // 7. link a stub Google identity to a guest; another account linking it -> identity_taken
    const linker = await loginGuest(url);
    const linkSubject = `e2e-link-${suffix}`;
    const linked = await oauthStub(url, "google", {
      subject: linkSubject,
      linkToken: linker.token,
    });
    const linkedMe = linked.token ? await me(url, linked.token) : null;
    check(
      linkedMe?.body.accountId === linker.accountId &&
        linkedMe.body.kind === "registered" &&
        linkedMe.body.identities.some((i) => i.provider === "google"),
      "auth: linking a Google login upgrades the guest in place",
    );
    const thief = await loginGuest(url);
    const stolen = await oauthStub(url, "google", { subject: linkSubject, linkToken: thief.token });
    check(
      stolen.error === "identity_taken",
      `auth: a second account linking the same login -> identity_taken (${stolen.fragment})`,
    );
    const noCookie = await fetch(
      `${url}/api/auth/oauth/google/callback?code=stub%3Ax&state=forged`,
      { redirect: "manual" },
    );
    check(
      (noCookie.headers.get("location") ?? "").endsWith("#auth_error=oauth_failed"),
      "auth: a callback without the state cookie fails",
    );

    // 8. the account_summary read model gets the registered profile
    const row = await waitForRow(ctx, main.accountId, "registered");
    check(
      row !== null && row.display_name === `Ember ${suffix.slice(-4)}`,
      `auth: account_summary row in D1 (${row ? `${String(row.display_name)}/${String(row.kind)}` : "missing"})`,
    );

    const state: AuthState = {
      main,
      sessionToken: main.token,
      oauthSubject: subject,
      oauthAccountId: oauthMe?.body.accountId ?? "",
    };
    ctx.state.set(KEY, state);
  },

  async afterRestart(ctx) {
    const state = ctx.state.get(KEY) as AuthState | undefined;
    if (!state) {
      check(false, "auth after restart: no state from run()");
      return;
    }
    const { url } = ctx;
    const still = await me(url, state.sessionToken);
    check(
      still.status === 200 && still.body.kind === "registered",
      "auth after restart: the open session token still works",
    );
    const again = await loginEmail(url, state.main.email, state.main.password);
    check(
      again.status === 200 && again.body.account?.accountId === state.main.accountId,
      "auth after restart: email login returns the same account",
    );
    const oauth = await oauthStub(url, "google", { subject: state.oauthSubject });
    const oauthMe = oauth.token ? await me(url, oauth.token) : null;
    check(
      oauthMe?.body.accountId === state.oauthAccountId,
      "auth after restart: the OAuth login still maps to its account",
    );
  },
};

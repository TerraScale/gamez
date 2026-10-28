/**
 * e2e helpers for wave B accounts (docs/design/wave-B.md §3). Shared by the
 * auth, chat and guild features. OWNER: T-auth (others import, never edit).
 */
import type { AccountView, ApiError, AuthResponse } from "@gamez/protocol";
import type { Guest } from "./client.ts";

export interface Registered extends Guest {
  email: string;
  password: string;
  account: AccountView;
}

/** POST JSON with an optional bearer token; returns status and parsed body. */
export async function api<T>(
  baseUrl: string,
  path: string,
  opts: { token?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body: body as T };
}

/** Upgrades `guest` in place to a registered account with a unique e2e email. */
export async function registerGuest(
  baseUrl: string,
  guest: Guest,
  displayName?: string,
): Promise<Registered> {
  const email = `e2e-${guest.accountId.slice(0, 8)}-${Date.now().toString(36)}@example.test`;
  const password = "correct-horse-battery-9";
  const res = await api<AuthResponse>(baseUrl, "/api/auth/register", {
    token: guest.token,
    body: { email, password, ...(displayName ? { displayName } : {}) },
  });
  if (res.status !== 200) {
    throw new Error(`register failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.token,
    accountId: res.body.account.accountId,
    name: res.body.account.displayName,
    email,
    password,
    account: res.body.account,
  };
}

/** POST /api/auth/login; returns status and body (AuthResponse or ApiError). */
export async function loginEmail(
  baseUrl: string,
  email: string,
  password: string,
  token?: string,
): Promise<{ status: number; body: AuthResponse & ApiError }> {
  return api<AuthResponse & ApiError>(baseUrl, "/api/auth/login", {
    ...(token ? { token } : {}),
    body: { email, password },
  });
}

/** A fresh OAuth fragment nonce, like the SPA keeps in sessionStorage (ADR 0007 R4). */
export function oauthNonce(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export interface OAuthStubResult {
  /** The callback's raw `/#…` fragment (`auth=`, `oauth_link=` or `auth_error=`, plus `&n=`). */
  fragment: string;
  /** The session token: from `#auth=`, or from redeeming `#oauth_link=` with `linkToken`. */
  token: string | null;
  /** `auth_error=<code>`, a failed redeem's error code, or "nonce_mismatch". */
  error: string | null;
  /** The `#oauth_link=` code of a link flow (redeemed only when `linkToken` was given). */
  linkCode: string | null;
  /** True when the fragment echoed this flow's nonce. */
  nonceEchoed: boolean;
  steps: string[];
}

/**
 * Runs the local stub OAuth round trip like a browser (dev hosts only):
 * /start?n=<nonce> (cookie) -> stub page -> form POST -> /callback with the
 * cookie. The fragment must echo the nonce (the SPA drops it otherwise). A
 * link flow (`linkToken`) gets `#oauth_link=<code>`, which is redeemed like
 * the SPA does: POST /api/auth/oauth/link with `linkToken` as the bearer.
 * `csrfToken` replays the old CSRF URL `?link=1&token=<csrfToken>` (ADR 0007
 * R3) and redeems nothing.
 */
export async function oauthStub(
  baseUrl: string,
  provider: "google" | "discord" | "apple",
  opts: { subject: string; email?: string; name?: string; linkToken?: string; csrfToken?: string },
): Promise<OAuthStubResult> {
  const steps: string[] = [];
  const nonce = oauthNonce();
  const q = opts.csrfToken
    ? `?link=1&token=${encodeURIComponent(opts.csrfToken)}&n=${nonce}`
    : `?n=${nonce}&link=${opts.linkToken ? 1 : 0}`;
  const start = await fetch(`${baseUrl}/api/auth/oauth/${provider}/start${q}`, {
    redirect: "manual",
  });
  steps.push(`start ${start.status}`);
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const stubUrl = new URL(start.headers.get("location") ?? "/", baseUrl);
  let final = stubUrl;
  if (stubUrl.pathname.endsWith("/stub")) {
    const page = await fetch(stubUrl, { redirect: "manual" });
    const html = await page.text();
    steps.push(`stub page ${page.status} ${html.includes("<form") ? "form" : "no form"}`);
    const form = new URLSearchParams({
      state: stubUrl.searchParams.get("state") ?? "",
      code_challenge: stubUrl.searchParams.get("code_challenge") ?? "",
      subject: opts.subject,
      email: opts.email ?? "",
      name: opts.name ?? "",
    });
    const posted = await fetch(`${stubUrl.origin}${stubUrl.pathname}`, {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    steps.push(`stub form ${posted.status}`);
    const callback = await fetch(new URL(posted.headers.get("location") ?? "/", baseUrl), {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
    });
    steps.push(`callback ${callback.status}`);
    final = new URL(callback.headers.get("location") ?? "/", baseUrl);
  }
  const fragment = final.hash.slice(1);
  const params = new URLSearchParams(fragment);
  const nonceEchoed = params.get("n") === nonce;
  steps.push(`nonce ${nonceEchoed ? "echoed" : "missing"}`);
  const linkCode = params.get("oauth_link");
  let token = params.get("auth");
  let error = params.get("auth_error");
  if (!nonceEchoed)
    return { fragment, token: null, error: "nonce_mismatch", linkCode, nonceEchoed, steps };
  if (linkCode && opts.linkToken) {
    const redeemed = await api<AuthResponse & ApiError>(baseUrl, "/api/auth/oauth/link", {
      token: opts.linkToken,
      body: { code: linkCode },
    });
    steps.push(`redeem ${redeemed.status}`);
    if (redeemed.status === 200) token = redeemed.body.token;
    else error = redeemed.body.error?.code ?? `http_${redeemed.status}`;
  }
  return { fragment, token, error, linkCode, nonceEchoed, steps };
}

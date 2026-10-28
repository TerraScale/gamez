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

/**
 * Runs the local stub OAuth round trip like a browser (dev hosts only):
 * /start (cookie) -> stub page -> form POST -> /callback with the cookie.
 * Returns the final `/#…` fragment: `auth=<token>` or `auth_error=<code>`.
 */
export async function oauthStub(
  baseUrl: string,
  provider: "google" | "discord" | "apple",
  opts: { subject: string; email?: string; name?: string; linkToken?: string },
): Promise<{ fragment: string; token: string | null; error: string | null; steps: string[] }> {
  const steps: string[] = [];
  const q = opts.linkToken ? `?link=1&token=${encodeURIComponent(opts.linkToken)}` : "?link=0";
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
  const token = fragment.startsWith("auth=") ? decodeURIComponent(fragment.slice(5)) : null;
  const error = fragment.startsWith("auth_error=") ? fragment.slice("auth_error=".length) : null;
  return { fragment, token, error, steps };
}

/**
 * Local stub OAuth provider (wave-B.md §3.3), dev hosts only (isDevHost):
 * stands in for an unconfigured provider so the whole OAuth round trip
 * (state cookie, PKCE, callback, claim, link) runs locally and in e2e.
 *
 *   /start -> 302 GET /api/auth/oauth/<p>/stub?state&code_challenge (this form)
 *   form POST /api/auth/oauth/<p>/stub -> 302 /callback?code=stub:<b64url json>&state
 *
 * The code carries the PKCE challenge; the callback checks it against the
 * verifier from the cookie, like a real provider would. No network calls.
 * Stub subjects are stored as "stub-<subject>" so they never collide with
 * real provider ids.
 */
import { fromBase64Url, toBase64Url } from "../../auth.ts";
import { normaliseEmail } from "../names.ts";
import type { OAuthProfile } from "./providers.ts";
import type { OAuthProviderId } from "./state.ts";

export const STUB_CODE_PREFIX = "stub:";
const SUBJECT = /^[A-Za-z0-9._@-]{1,64}$/;

export interface StubGrant {
  sub: string;
  email: string | null;
  name: string | null;
  /** PKCE challenge the stub "authorize" step was given. */
  cc: string;
}

export function encodeStubCode(g: StubGrant): string {
  return STUB_CODE_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(g)));
}

/** The grant of a stub code, or null when malformed. */
export function decodeStubCode(code: string): StubGrant | null {
  if (!code.startsWith(STUB_CODE_PREFIX) || code.length > 2048) return null;
  const raw = fromBase64Url(code.slice(STUB_CODE_PREFIX.length));
  if (!raw) return null;
  try {
    const g = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    if (typeof g.sub !== "string" || !SUBJECT.test(g.sub)) return null;
    if (typeof g.cc !== "string" || g.cc.length < 16 || g.cc.length > 128) return null;
    const email = g.email === null || g.email === undefined ? null : normaliseEmail(g.email);
    if (g.email !== null && g.email !== undefined && email === null) return null;
    const name = typeof g.name === "string" && g.name.length <= 64 ? g.name : null;
    return { sub: g.sub, email, name, cc: g.cc };
  } catch {
    return null;
  }
}

/** The profile a verified stub grant stands for. */
export function stubProfile(g: StubGrant): OAuthProfile {
  return { subject: `stub-${g.sub}`, email: g.email, name: g.name };
}

/** Builds the callback redirect for a submitted stub form; null when a field is invalid. */
export function stubCallbackLocation(
  provider: OAuthProviderId,
  origin: string,
  form: { state: string; challenge: string; subject: string; email: string; name: string },
): string | null {
  const sub = form.subject.trim();
  if (!SUBJECT.test(sub)) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(form.state)) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(form.challenge)) return null;
  const emailText = form.email.trim();
  const email = emailText ? normaliseEmail(emailText) : null;
  if (emailText && !email) return null;
  const name = form.name.trim().slice(0, 64) || null;
  const code = encodeStubCode({ sub, email, name, cc: form.challenge });
  const u = new URL(`/api/auth/oauth/${provider}/callback`, origin);
  u.searchParams.set("code", code);
  u.searchParams.set("state", form.state);
  return u.href;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const LABEL: Record<OAuthProviderId, string> = {
  google: "Google",
  discord: "Discord",
  apple: "Apple",
};

/** The stub "authorize" page: a small form, styled to match gamez, no scripts. */
export function stubPage(
  provider: OAuthProviderId,
  input: { state: string; challenge: string; error?: string },
): Response {
  const p = esc(LABEL[provider]);
  const suggested = `tester-${toBase64Url(crypto.getRandomValues(new Uint8Array(4)))}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stub sign-in · ${p}</title>
<style>
:root{color-scheme:dark;--bg:#14110f;--card:#211c18;--line:#3b3129;--ink:#efe6d8;--dim:#a8998a;--gold:#d9a441;--bad:#e0705a}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 30% 10%,#2a211b,var(--bg) 60%);font:16px/1.4 system-ui,sans-serif;color:var(--ink);padding:16px}
form{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:0 12px 40px #0008}
h1{font-size:20px;margin:0 0 4px;color:var(--gold);letter-spacing:.02em}p{margin:0 0 16px;color:var(--dim);font-size:14px}
label{display:block;font-size:13px;color:var(--dim);margin:12px 0 4px}input{width:100%;min-height:44px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:#16120f;color:var(--ink);font-size:16px}
button{margin-top:18px;width:100%;min-height:44px;border:0;border-radius:8px;background:var(--gold);color:#1b140c;font-weight:700;font-size:16px;cursor:pointer}
.err{color:var(--bad);font-size:14px;margin-top:8px}.tag{display:inline-block;font-size:11px;padding:2px 6px;border-radius:4px;background:#3b3129;color:var(--dim);margin-left:6px;vertical-align:middle}
</style></head><body>
<form method="post" action="/api/auth/oauth/${esc(provider)}/stub" autocomplete="off">
<h1>${p} <span class="tag">local stub</span></h1>
<p>Development sign-in. No real ${p} account is used; nothing leaves this machine.</p>
<input type="hidden" name="state" value="${esc(input.state)}">
<input type="hidden" name="code_challenge" value="${esc(input.challenge)}">
<label for="subject">Subject (stable user id)</label>
<input id="subject" name="subject" required maxlength="64" pattern="[A-Za-z0-9._@\\-]{1,64}" value="${esc(suggested)}">
<label for="email">Email (optional)</label>
<input id="email" name="email" type="email" maxlength="254" placeholder="tester@example.test">
<label for="name">Display name (optional)</label>
<input id="name" name="name" maxlength="64" placeholder="Tester">
${input.error ? `<div class="err">${esc(input.error)}</div>` : ""}
<button type="submit">Continue as this user</button>
</form></body></html>`;
  return new Response(html, {
    status: input.error ? 400 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

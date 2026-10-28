/**
 * /api/guest, /api/me, /api/auth/*, /api/account/name (wave-B.md §3).
 * OWNER: T-auth. Logic lives in auth/flows.ts (accounts), auth/oauth/*
 * (OAuth state, providers, stub); this file is HTTP glue and input checks.
 *
 *   POST /api/guest                          new guest token (kind "guest")
 *   GET  /api/me                             AccountView (creates the profile lazily)
 *   GET  /api/auth/providers                 ProvidersResponse
 *   POST /api/auth/register                  {email,password,displayName?} -> AuthResponse
 *   POST /api/auth/login                     {email,password} -> AuthResponse
 *   POST /api/auth/logout                    revokes a registered session
 *   POST /api/account/name                   {displayName} -> AuthResponse
 *   GET  /api/auth/oauth/:p/start?link=&token=  302 to the provider (or the stub page)
 *   GET  /api/auth/oauth/:p/callback         302 to /#auth=<token> or /#auth_error=<code>
 *   GET|POST /api/auth/oauth/:p/stub         local stub provider (dev hosts only)
 */
import type { AuthErrorCode, ProviderInfo, ProvidersResponse } from "@gamez/protocol";
import { newGuest, signToken } from "../auth.ts";
import { changeName, completeOAuth, login, register, type FlowResult } from "../auth/flows.ts";
import { clientIp, IpLimiter } from "../auth/limiter.ts";
import {
  authorizeUrl,
  exchangeCode,
  providerMode,
  redirectUriFor,
  type OAuthProfile,
} from "../auth/oauth/providers.ts";
import {
  checkCallbackState,
  clearStateCookie,
  isOAuthProvider,
  newOAuthState,
  OAUTH_COOKIE,
  OAUTH_PROVIDERS,
  pkceChallenge,
  readCookie,
  sealState,
  stateCookie,
  type LinkTarget,
  type OAuthProviderId,
} from "../auth/oauth/state.ts";
import { decodeStubCode, stubCallbackLocation, stubPage, stubProfile } from "../auth/oauth/stub.ts";
import { authenticateRequest } from "../auth/session.ts";
import { apiError, json, readJson } from "../http.ts";
import type { RouteContext, RouteHandler } from "./types.ts";

let limiter = new IpLimiter();

/** Tests swap the per-isolate limiter (a fresh or generous one per test). */
export function setAuthLimiter(next: IpLimiter): void {
  limiter = next;
}

const OAUTH_PATH = /^\/api\/auth\/oauth\/([a-z]+)\/(start|callback|stub)$/;

function userAgent(request: Request): string {
  return (request.headers.get("user-agent") ?? "").slice(0, 200);
}

function flowResponse(r: FlowResult): Response {
  if (r.ok) return json(r.response);
  if (r.retryAfterMs !== undefined) {
    return json(
      { error: { code: r.code, message: r.message, retryAfterMs: r.retryAfterMs } },
      r.status,
      { "retry-after": String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) },
    );
  }
  return apiError(r.status, r.code, r.message);
}

const err = (status: number, code: AuthErrorCode, message: string) =>
  apiError(status, code, message);
const unauthorized = () => err(401, "unauthorized", "Sign in first.");
const methodNotAllowed = () => apiError(405, "method_not_allowed", "method not allowed");

function providers(c: RouteContext): ProvidersResponse {
  const list: ProviderInfo[] = [{ id: "email", enabled: true, stub: false }];
  for (const id of OAUTH_PROVIDERS) {
    const mode = providerMode(id, c.env, c.url);
    list.push({ id, enabled: mode !== "disabled", stub: mode === "stub" });
  }
  return { providers: list };
}

// ---- OAuth -------------------------------------------------------------------

function fragmentRedirect(
  url: URL,
  fragment: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: `${url.origin}/#${fragment}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

async function oauthStart(c: RouteContext, provider: OAuthProviderId): Promise<Response> {
  const { env, url, request } = c;
  const mode = providerMode(provider, env, url);
  if (mode === "disabled") return fragmentRedirect(url, "auth_error=provider_disabled");
  let link: LinkTarget | null = null;
  if (url.searchParams.get("link") === "1") {
    const who = await authenticateRequest(request, env, url);
    if (!who) return fragmentRedirect(url, "auth_error=unauthorized");
    link = { accountId: who.accountId, name: who.name, kind: who.kind, sid: who.sid };
  }
  const redirectUri = redirectUriFor(url, provider);
  const st = newOAuthState({ provider, stub: mode === "stub", link, redirectUri });
  const challenge = await pkceChallenge(st.verifier);
  let location: string;
  if (mode === "real" && provider !== "apple") {
    location = authorizeUrl(provider, env, { redirectUri, state: st.state, challenge });
  } else {
    const stub = new URL(`/api/auth/oauth/${provider}/stub`, url.origin);
    stub.searchParams.set("state", st.state);
    stub.searchParams.set("code_challenge", challenge);
    location = stub.href;
  }
  const secure = url.protocol === "https:";
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": stateCookie(await sealState(env.AUTH_SECRET, st), secure),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

async function oauthStub(c: RouteContext, provider: OAuthProviderId): Promise<Response> {
  const { request, url, env } = c;
  if (providerMode(provider, env, url) !== "stub") {
    return apiError(404, "not_found", "no stub provider here");
  }
  if (request.method === "GET") {
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(state) || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)) {
      return err(400, "bad_request", "missing state or code_challenge");
    }
    return stubPage(provider, { state, challenge });
  }
  if (request.method !== "POST") return methodNotAllowed();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return err(400, "bad_request", "expected a form");
  }
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.slice(0, 300) : "";
  };
  const input = {
    state: field("state"),
    challenge: field("code_challenge"),
    subject: field("subject"),
    email: field("email"),
    name: field("name"),
  };
  const location = stubCallbackLocation(provider, url.origin, input);
  if (!location) {
    return stubPage(provider, {
      state: input.state,
      challenge: input.challenge,
      error: "Check the fields: subject is 1-64 of A-Z a-z 0-9 . _ @ -, email must be valid.",
    });
  }
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

async function oauthCallback(c: RouteContext, provider: OAuthProviderId): Promise<Response> {
  const { request, url, env } = c;
  const clear = { "set-cookie": clearStateCookie(url.protocol === "https:") };
  const failWith = (code: AuthErrorCode) => fragmentRedirect(url, `auth_error=${code}`, clear);

  const mode = providerMode(provider, env, url);
  if (mode === "disabled") return failWith("provider_disabled");
  if (url.searchParams.has("error")) return failWith("oauth_failed");
  const st = await checkCallbackState(
    env.AUTH_SECRET,
    readCookie(request.headers.get("cookie"), OAUTH_COOKIE),
    provider,
    url.searchParams.get("state"),
  );
  if (!st) return failWith("oauth_failed");
  if (st.stub !== (mode === "stub") || st.redirectUri !== redirectUriFor(url, provider)) {
    return failWith("oauth_failed");
  }
  const code = url.searchParams.get("code") ?? "";
  if (!code || code.length > 4096) return failWith("oauth_failed");

  let profile: OAuthProfile;
  if (st.stub) {
    const grant = decodeStubCode(code);
    if (!grant || grant.cc !== (await pkceChallenge(st.verifier))) return failWith("oauth_failed");
    profile = stubProfile(grant);
  } else if (provider === "apple") {
    return failWith("provider_disabled");
  } else {
    try {
      profile = await exchangeCode(provider, env, {
        code,
        verifier: st.verifier,
        redirectUri: st.redirectUri,
      });
    } catch (e) {
      console.warn(`oauth: ${provider} exchange failed`, e);
      return failWith("oauth_failed");
    }
  }

  const result = await completeOAuth(env, provider, profile, st.link, userAgent(request));
  if (!result.ok) return failWith(result.code);
  return fragmentRedirect(url, `auth=${encodeURIComponent(result.response.token)}`, clear);
}

// ---- router ------------------------------------------------------------------

export const authRoutes: RouteHandler = async (c) => {
  const { request, env, url } = c;
  const path = url.pathname;
  const isAuth = path.startsWith("/api/auth/");
  if (!isAuth && path !== "/api/guest" && path !== "/api/me" && path !== "/api/account/name") {
    return null;
  }
  if (isAuth && !limiter.take(clientIp(request), Date.now())) {
    const after = limiter.retryAfterMs();
    return json(
      { error: { code: "locked", message: "Too many requests. Slow down.", retryAfterMs: after } },
      429,
      { "retry-after": String(Math.ceil(after / 1000)) },
    );
  }

  if (path === "/api/guest") {
    if (request.method !== "POST") return methodNotAllowed();
    const identity = { ...newGuest(), kind: "guest" as const, sid: null };
    const token = await signToken(env.AUTH_SECRET, identity);
    return json({ token, accountId: identity.accountId, name: identity.name, kind: "guest" });
  }

  if (path === "/api/me") {
    if (request.method !== "GET") return methodNotAllowed();
    const who = await authenticateRequest(request, env, url);
    if (!who) return unauthorized();
    const account = env.ACCOUNT.getByName(who.accountId);
    await account.ensure({ kind: who.kind, displayName: who.name });
    const view = await account.view();
    return view ? json(view) : unauthorized();
  }

  if (path === "/api/account/name") {
    if (request.method !== "POST") return methodNotAllowed();
    const who = await authenticateRequest(request, env, url);
    if (!who) return unauthorized();
    const body = await readJson(request);
    if (!body) return err(400, "bad_request", "expected a JSON object");
    return flowResponse(await changeName(env, who, body));
  }

  if (path === "/api/auth/providers") {
    if (request.method !== "GET") return methodNotAllowed();
    return json(providers(c));
  }

  if (path === "/api/auth/register" || path === "/api/auth/login") {
    if (request.method !== "POST") return methodNotAllowed();
    const body = await readJson(request);
    if (!body) return err(400, "bad_request", "expected a JSON object");
    if (path === "/api/auth/login") return flowResponse(await login(env, body, userAgent(request)));
    // A bearer, when sent, must be valid: it names the guest to upgrade.
    const hasBearer = (request.headers.get("authorization") ?? "") !== "";
    const who = hasBearer ? await authenticateRequest(request, env, url) : null;
    if (hasBearer && !who) return unauthorized();
    return flowResponse(await register(env, body, who, userAgent(request)));
  }

  if (path === "/api/auth/logout") {
    if (request.method !== "POST") return methodNotAllowed();
    const who = await authenticateRequest(request, env, url);
    if (!who) return unauthorized();
    if (who.kind === "registered" && who.sid) {
      await env.ACCOUNT.getByName(who.accountId).closeSession(who.sid);
    }
    return json({ ok: true });
  }

  const m = OAUTH_PATH.exec(path);
  if (m) {
    const provider = m[1] ?? "";
    if (!isOAuthProvider(provider)) return err(404, "provider_disabled", "unknown provider");
    if (m[2] === "stub") return oauthStub(c, provider);
    if (request.method !== "GET") return methodNotAllowed();
    return m[2] === "start" ? oauthStart(c, provider) : oauthCallback(c, provider);
  }

  return apiError(404, "not_found", "no such endpoint");
};

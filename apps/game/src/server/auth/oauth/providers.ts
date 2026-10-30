/**
 * OAuth providers (wave-B.md §3.3): Google (OpenID Connect, scopes
 * "openid email profile") and Discord ("identify email"), both
 * authorization code + PKCE S256 with a confidential client secret; Apple is
 * stub-only in wave B (real Sign in with Apple needs an ES256 client-secret
 * JWT from APPLE_PRIVATE_KEY, see docs/secrets.md).
 *
 * Mode per provider: "real" when its client id and secret are set, else
 * "stub" on dev hosts (http.ts isDevHost), else "disabled".
 */
import type { Env } from "../../contracts.ts";
import { isDevHost } from "../../http.ts";
import type { OAuthProviderId } from "./state.ts";

export type ProviderMode = "real" | "stub" | "disabled";

export type OAuthEnv = Pick<
  Env,
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "DISCORD_CLIENT_ID"
  | "DISCORD_CLIENT_SECRET"
  | "APPLE_CLIENT_ID"
  | "OAUTH_STUB"
  | "DEV_ROUTES_ENABLED"
>;

/** What the callback learned about the user. `email` only when the provider verified it. */
export interface OAuthProfile {
  subject: string;
  email: string | null;
  name: string | null;
}

interface RealProvider {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientId(env: OAuthEnv): string | undefined;
  clientSecret(env: OAuthEnv): string | undefined;
  extraAuthorizeParams: Record<string, string>;
  profile(accessToken: string, fetcher: typeof fetch): Promise<OAuthProfile>;
}

const TIMEOUT_MS = 10_000;

async function getJson(
  fetcher: typeof fetch,
  url: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const res = await fetcher(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`profile HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) throw new Error("profile: not an object");
  return body as Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

const REAL: Record<"google" | "discord", RealProvider> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    extraAuthorizeParams: { prompt: "select_account" },
    async profile(accessToken, fetcher) {
      const u = await getJson(
        fetcher,
        "https://openidconnect.googleapis.com/v1/userinfo",
        accessToken,
      );
      const subject = str(u.sub);
      if (!subject) throw new Error("google: no sub");
      return {
        subject,
        email: u.email_verified === true ? str(u.email) : null,
        name: str(u.name) ?? str(u.given_name),
      };
    },
  },
  discord: {
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    scope: "identify email",
    clientId: (env) => env.DISCORD_CLIENT_ID,
    clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
    extraAuthorizeParams: {},
    async profile(accessToken, fetcher) {
      const u = await getJson(fetcher, "https://discord.com/api/users/@me", accessToken);
      const subject = str(u.id);
      if (!subject) throw new Error("discord: no id");
      return {
        subject,
        email: u.verified === true ? str(u.email) : null,
        name: str(u.global_name) ?? str(u.username),
      };
    },
  },
};

export function providerMode(provider: OAuthProviderId, env: OAuthEnv, url: URL): ProviderMode {
  if (provider !== "apple") {
    const p = REAL[provider];
    if (p.clientId(env) && p.clientSecret(env)) return "real";
  }
  return isDevHost(url, env) ? "stub" : "disabled";
}

/** Callback URL registered with each provider: `<origin>/api/auth/oauth/<provider>/callback`. */
export function redirectUriFor(url: URL, provider: OAuthProviderId): string {
  return `${url.origin}/api/auth/oauth/${provider}/callback`;
}

/** The provider's authorize URL for a real flow. */
export function authorizeUrl(
  provider: "google" | "discord",
  env: OAuthEnv,
  input: { redirectUri: string; state: string; challenge: string },
): string {
  const p = REAL[provider];
  const u = new URL(p.authorizeUrl);
  u.searchParams.set("client_id", p.clientId(env) ?? "");
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", p.scope);
  u.searchParams.set("state", input.state);
  u.searchParams.set("code_challenge", input.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(p.extraAuthorizeParams)) u.searchParams.set(k, v);
  return u.href;
}

/** Exchanges the code (with the PKCE verifier) and reads the profile. Throws on any failure. */
export async function exchangeCode(
  provider: "google" | "discord",
  env: OAuthEnv,
  input: { code: string; verifier: string; redirectUri: string },
  fetcher: typeof fetch = fetch,
): Promise<OAuthProfile> {
  const p = REAL[provider];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: p.clientId(env) ?? "",
    client_secret: p.clientSecret(env) ?? "",
    code_verifier: input.verifier,
  });
  const res = await fetcher(p.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${provider} token HTTP ${res.status}`);
  const tok = (await res.json()) as Record<string, unknown>;
  const accessToken = str(tok.access_token);
  if (!accessToken) throw new Error(`${provider}: no access_token`);
  return p.profile(accessToken, fetcher);
}

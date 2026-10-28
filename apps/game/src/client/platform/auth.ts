/**
 * AuthApi (wave-B.md §3): register, login, logout, OAuth URLs and the display
 * name, over /api. Every success replaces the session in ../session.ts, which
 * notifies the app shell.
 */
import {
  type AccountView,
  type AuthProvider,
  type AuthResponse,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  type ProvidersResponse,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type ProviderInfo,
} from "@gamez/protocol";
import type { ApiResult, AuthApi } from "@gamez/ui-host";
import {
  beginOAuthNonce,
  clearSession,
  getSession,
  notifySessionChange,
  onSessionChange,
  type GuestSession,
  setSession,
} from "../session.ts";
import { badResponse, createHttp, type FetchFn, type HttpClient, unwrap } from "./http.ts";

export interface AuthDeps {
  http: HttpClient;
  /** The current session token. ADR 0007 R3: never put into an OAuth URL. */
  token(): string | null | undefined;
  /** Injectable for tests; defaults to ../session.ts beginOAuthNonce (stores it per tab). */
  oauthNonce?: () => string;
  /** Injectable for tests; defaults to ../session.ts getSession (POST /api/guest). */
  newGuest?: () => Promise<GuestSession>;
  /** Injectable for tests; defaults to ../session.ts setSession. */
  saveSession?: (s: GuestSession) => void;
  /** Injectable for tests; defaults to ../session.ts onSessionChange. */
  subscribe?: (cb: () => void) => () => void;
}

/** The session a successful AuthResponse stores. */
export function sessionFromAuth(res: AuthResponse): GuestSession {
  return {
    token: res.token,
    accountId: res.account.accountId,
    name: res.account.displayName,
    kind: res.account.kind,
  };
}

function isAuthResponse(v: unknown): v is AuthResponse {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<AuthResponse>;
  return (
    typeof r.token === "string" &&
    !!r.account &&
    typeof r.account === "object" &&
    typeof r.account.accountId === "string" &&
    typeof r.account.displayName === "string"
  );
}

export function createAuthApi(deps: AuthDeps): AuthApi {
  const { http } = deps;
  const save = deps.saveSession ?? setSession;
  const newGuest = deps.newGuest ?? (() => getSession());
  const subscribe = deps.subscribe ?? onSessionChange;
  const oauthNonce = deps.oauthNonce ?? beginOAuthNonce;

  /** Shared path of register/login/setDisplayName: store the new session. */
  async function adopt(res: ApiResult<unknown>, what: string): Promise<ApiResult<AccountView>> {
    if (!res.ok) return res;
    if (!isAuthResponse(res.value)) return badResponse(what);
    save(sessionFromAuth(res.value));
    return { ok: true, value: res.value.account };
  }

  return {
    async me() {
      const res = await http.request<AccountView>({ method: "GET", path: "/api/me" });
      if (!res.ok) return res;
      const account = unwrap(res.value, "account") as AccountView | undefined;
      if (!account || typeof account.accountId !== "string") return badResponse("/api/me");
      return { ok: true, value: account };
    },

    async providers(): Promise<ProviderInfo[]> {
      const res = await http.request<ProvidersResponse>({
        method: "GET",
        path: "/api/auth/providers",
      });
      if (!res.ok) return [];
      const list = (res.value as Partial<ProvidersResponse> | undefined)?.providers;
      return Array.isArray(list) ? list : [];
    },

    async register(email, password, displayName) {
      if (password.length < PASSWORD_MIN) {
        return {
          ok: false,
          code: "weak_password",
          message: `Use at least ${PASSWORD_MIN} characters`,
        };
      }
      if (password.length > PASSWORD_MAX) {
        return { ok: false, code: "weak_password", message: "Password is too long" };
      }
      const res = await http.request<AuthResponse>({
        method: "POST",
        path: "/api/auth/register",
        body: displayName === undefined ? { email, password } : { email, password, displayName },
      });
      return adopt(res, "/api/auth/register");
    },

    async login(email, password) {
      const res = await http.request<AuthResponse>({
        method: "POST",
        path: "/api/auth/login",
        body: { email, password },
      });
      return adopt(res, "/api/auth/login");
    },

    async logout() {
      // The server revokes the session; a failure still logs out locally.
      await http.request<unknown>({ method: "POST", path: "/api/auth/logout" });
      clearSession();
      try {
        save(await newGuest());
      } catch (err) {
        console.warn("could not start a new guest after logout", err);
        notifySessionChange();
      }
    },

    // ADR 0007 R3/R4: no token in the URL (a link names no account; the
    // return is redeemed with the bearer), and a fresh per-tab nonce that the
    // return fragment must echo.
    oauthUrl(provider: AuthProvider, opts: { link: boolean }): string {
      const n = encodeURIComponent(oauthNonce());
      return `/api/auth/oauth/${provider}/start?n=${n}&link=${opts.link ? 1 : 0}`;
    },

    async setDisplayName(name) {
      const trimmed = name.trim();
      if (trimmed.length < DISPLAY_NAME_MIN || trimmed.length > DISPLAY_NAME_MAX) {
        return {
          ok: false,
          code: "bad_name",
          message: `Names have ${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters`,
        };
      }
      const res = await http.request<AuthResponse>({
        method: "POST",
        path: "/api/account/name",
        body: { displayName: trimmed },
      });
      return adopt(res, "/api/account/name");
    },

    onSessionChange(cb: () => void): () => void {
      return subscribe(cb);
    },
  };
}

/**
 * Redeems the `#oauth_link=<code>` of a link flow this tab started (ADR 0007
 * R3): POST /api/auth/oauth/link with the current session as the bearer. The
 * login is attached to that account (a guest is upgraded in place). Resolves
 * to the session to store; nothing here throws or stores.
 */
export async function redeemOAuthLink(
  code: string,
  token: string,
  fetchFn?: FetchFn,
): Promise<ApiResult<GuestSession>> {
  const http = createHttp({ token: () => token, ...(fetchFn ? { fetch: fetchFn } : {}) });
  const res = await http.request<AuthResponse>({
    method: "POST",
    path: "/api/auth/oauth/link",
    body: { code },
  });
  if (!res.ok) return res;
  if (!isAuthResponse(res.value)) return badResponse("/api/auth/oauth/link");
  return { ok: true, value: sessionFromAuth(res.value) };
}

/**
 * The admin dashboard's own fetch helper (wave-C.md §9.3). OWNER: T-admin.
 * Sends the bearer token from the session on every call; never throws.
 */
import type { ConfigResponse, EconomyTelemetry, FeatureFlag } from "@gamez/protocol";
import type { ModerationResponse } from "../../server/admin/moderation.ts";
import type { AdminMe } from "../../server/admin/types.ts";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type AdminResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      /** From GET /api/admin/me on a "not an admin" answer: may the caller self-grant here? */
      devHost?: boolean;
    };

export interface AdminData {
  telemetry: EconomyTelemetry;
  moderation: ModerationResponse;
  config: ConfigResponse;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function failure(status: number, body: unknown, fallback: string) {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  return {
    ok: false as const,
    status,
    code: typeof err?.code === "string" ? err.code : `http_${status}`,
    message: typeof err?.message === "string" ? err.message : fallback,
  };
}

/** One request; resolves to the parsed body or a failure (never rejects). */
export async function adminRequest<T>(
  fetchFn: FetchFn,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<AdminResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  // Admin data is live: never answer it (or /api/config right after a flag write) from cache.
  const init: RequestInit = { method, headers, cache: "no-store" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetchFn(path, init);
  } catch {
    return { ok: false, status: 0, code: "network", message: "Network error, try again" };
  }
  let parsed: unknown;
  try {
    parsed = await readBody(res);
  } catch {
    parsed = undefined;
  }
  if (!res.ok) return failure(res.status, parsed, res.statusText || `HTTP ${res.status}`);
  return { ok: true, value: parsed as T };
}

/**
 * GET /api/admin/me: ok for an admin; a 403 result ("not an admin", with
 * `devHost` for the dev self-grant) for a player, without any failing
 * request; 401 without a session. A server without the endpoint (404) counts
 * as ok, so the data endpoints decide.
 */
export async function checkAdmin(
  fetchFn: FetchFn,
  token: string,
): Promise<AdminResult<AdminMe | null>> {
  const me = await adminRequest<AdminMe>(fetchFn, token, "GET", "/api/admin/me");
  if (!me.ok) return me.status === 404 ? { ok: true, value: null } : me;
  if (!me.value?.admin) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: "admins only",
      devHost: me.value?.devHost,
    };
  }
  return me;
}

/**
 * Loads the wave C dashboard data (economy, moderation, config). Asks GET
 * /api/admin/me first, so a player gets a 403 result ("not an admin")
 * without any failed request; a 401/403 from the data endpoints means the
 * same. Kept for compatibility: the sidebar shell loads per section.
 */
export async function loadAdminData(
  fetchFn: FetchFn,
  token: string,
  days: number,
): Promise<AdminResult<AdminData>> {
  const me = await checkAdmin(fetchFn, token);
  if (!me.ok) return me;
  const [telemetry, moderation, config] = await Promise.all([
    adminRequest<EconomyTelemetry>(fetchFn, token, "GET", `/api/admin/economy?days=${days}`),
    adminRequest<ModerationResponse>(fetchFn, token, "GET", "/api/admin/moderation"),
    adminRequest<ConfigResponse>(fetchFn, token, "GET", "/api/config"),
  ]);
  if (!telemetry.ok) return telemetry;
  if (!moderation.ok) return moderation;
  if (!config.ok) return config;
  return {
    ok: true,
    value: {
      telemetry: telemetry.value,
      moderation: moderation.value,
      config: config.value,
    },
  };
}

export async function setFlag(
  fetchFn: FetchFn,
  token: string,
  flag: FeatureFlag,
  value: boolean,
): Promise<AdminResult<ConfigResponse>> {
  return adminRequest<ConfigResponse>(fetchFn, token, "POST", "/api/admin/flags", {
    flags: { [flag]: value },
  });
}

export const MUTE_MINUTES = 60;

export async function muteAccount(
  fetchFn: FetchFn,
  token: string,
  channel: string,
  accountId: string,
): Promise<AdminResult<{ ok: true; until: number }>> {
  return adminRequest(fetchFn, token, "POST", "/api/admin/mute", {
    channel,
    accountId,
    minutes: MUTE_MINUTES,
  });
}

export async function hideMessage(
  fetchFn: FetchFn,
  token: string,
  channel: string,
  messageId: string,
): Promise<AdminResult<{ ok: true; hidden: number }>> {
  return adminRequest(fetchFn, token, "POST", "/api/admin/hide", {
    channel,
    ids: [messageId],
  });
}

export async function makeDevAdmin(
  fetchFn: FetchFn,
  token: string,
): Promise<AdminResult<{ ok: true }>> {
  return adminRequest(fetchFn, token, "POST", "/api/dev/admin/self");
}

/**
 * True on host names the server may treat as dev hosts: localhost, 127.0.0.1,
 * [::1] and *.ts.net. Only a fallback hint: the server also needs
 * DEV_ROUTES_ENABLED, and GET /api/admin/me's `devHost` wins when it answers.
 */
export function isDevHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".ts.net")
  );
}

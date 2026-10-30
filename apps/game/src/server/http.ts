/**
 * Small HTTP helpers shared by the /api routes (wave B). Pure Request/Response.
 */
import type { ApiError } from "@gamez/protocol";

/** Largest JSON request body the API reads. */
export const MAX_JSON_BODY = 16 * 1024;

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function apiError(status: number, code: string, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return json(body, status);
}

/** Parses a JSON object body (<= MAX_JSON_BODY); null when missing, too big or not an object. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_JSON_BODY) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_JSON_BODY) return null;
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The bearer token of `Authorization: Bearer <token>`, else "". */
export function bearerToken(request: Request): string {
  const h = request.headers.get("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

/**
 * Accepts a WebSocket upgrade only to close it with `code`: browsers hide the
 * HTTP status of failed upgrades, so a close code is the only signal.
 */
export function rejectSocket(code: number, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/** The env keys that decide whether dev-only stubs run. */
export interface DevGateEnv {
  /** "1" turns dev-only stubs on. Only local `.dev.vars` sets it; production never does. */
  DEV_ROUTES_ENABLED?: string;
  /** "1": stubs on any host (still needs DEV_ROUTES_ENABLED). "0": never. */
  OAUTH_STUB?: string;
}

/** True when the explicit dev switch is on (DEV_ROUTES_ENABLED === "1"). */
export function devRoutesEnabled(env: DevGateEnv): boolean {
  return env.DEV_ROUTES_ENABLED === "1";
}

/**
 * True where dev-only stubs may run (OAuth stub provider, payments stub,
 * /api/dev/*, dev admins). Always requires env.DEV_ROUTES_ENABLED === "1",
 * which only local `.dev.vars` sets (cloudflare.config.ts declares it in dev
 * mode only). Then OAUTH_STUB === "0" turns stubs off, OAUTH_STUB === "1"
 * allows any host, and otherwise the host must be localhost, 127.0.0.1,
 * [::1] or a tailnet *.ts.net name. A host name alone never enables them.
 */
export function isDevHost(url: URL, env: DevGateEnv): boolean {
  if (!devRoutesEnabled(env)) return false;
  if (env.OAUTH_STUB === "0") return false;
  if (env.OAUTH_STUB === "1") return true;
  const h = url.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".ts.net");
}

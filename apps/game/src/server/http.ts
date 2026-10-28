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

/**
 * True on hosts where dev-only stubs may run (OAuth stub provider, /api/dev/*):
 * env.OAUTH_STUB === "1", or (OAUTH_STUB !== "0" and the host is localhost,
 * 127.0.0.1 or a tailnet *.ts.net name). Production hosts never match.
 */
export function isDevHost(url: URL, env: { OAUTH_STUB?: string }): boolean {
  if (env.OAUTH_STUB === "1") return true;
  if (env.OAUTH_STUB === "0") return false;
  const h = url.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".ts.net");
}

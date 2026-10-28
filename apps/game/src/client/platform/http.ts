/**
 * Minimal JSON-over-fetch client for the /api platform routes (wave-B.md §3).
 * Every call resolves to an ApiResult: HTTP errors carry the server's
 * `{error: {code, message}}`, network failures become code "network".
 * Nothing here throws.
 */
import type { ApiResult } from "@gamez/ui-host";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | null | undefined;

export interface HttpRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
}

export interface HttpClient {
  request<T>(req: HttpRequest): Promise<ApiResult<T>>;
}

export interface HttpOptions {
  /** The bearer token to send, or null/empty for none. Read on every call. */
  token(): string | null | undefined;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchFn;
}

/** Builds `?a=1&b=x` from the defined, non-empty values ("" when none). */
export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * Turns a server error body into {code, message}; falls back to the status.
 * Exported for tests.
 */
export function errorFromBody(
  status: number,
  statusText: string,
  body: unknown,
): { code: string; message: string } {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const { code, message } = err as { code?: unknown; message?: unknown };
      if (typeof code === "string" && code) {
        return {
          code,
          message: typeof message === "string" && message ? message : code,
        };
      }
    }
  }
  return {
    code: `http_${status}`,
    message: statusText || `Request failed (HTTP ${status})`,
  };
}

/** Reads a JSON body, or undefined when the body is empty or not JSON. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Creates the request function. Relative URLs: same origin as the app. */
export function createHttp(opts: HttpOptions): HttpClient {
  const doFetch: FetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async request<T>(req: HttpRequest): Promise<ApiResult<T>> {
      const headers: Record<string, string> = { accept: "application/json" };
      const token = opts.token();
      if (token) headers.authorization = `Bearer ${token}`;
      const init: RequestInit = { method: req.method, headers };
      if (req.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(req.body);
      }
      const url = `${req.path}${buildQuery(req.query)}`;

      let res: Response;
      try {
        res = await doFetch(url, init);
      } catch {
        return { ok: false, code: "network", message: "Network error, try again" };
      }

      let body: unknown;
      try {
        body = await readJson(res);
      } catch {
        body = undefined;
      }

      if (!res.ok) {
        return { ok: false, ...errorFromBody(res.status, res.statusText, body) };
      }
      return { ok: true, value: body as T };
    },
  };
}

/**
 * The value of `key` when the body wraps it (`{key: value}`), else the body
 * itself. Lets the client accept both shapes while the API settles.
 */
export function unwrap(body: unknown, key: string): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && key in body) {
    return (body as Record<string, unknown>)[key];
  }
  return body;
}

/** Stand-in for a failed response whose body had the wrong shape. */
export function badResponse(what: string): { ok: false; code: string; message: string } {
  return { ok: false, code: "bad_response", message: `Unexpected response from ${what}` };
}

/**
 * ws:// or wss:// URL for `path` on `origin` (an http(s) origin), with the
 * query encoded. The token is never logged by this helper.
 */
export function wsUrl(origin: string, path: string, query: Record<string, string>): string {
  const url = new URL(path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** The app's origin in a browser; localhost elsewhere (tests pass their own). */
export function defaultOrigin(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin && loc.origin !== "null" ? loc.origin : "http://localhost";
}

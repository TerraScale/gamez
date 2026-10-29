/**
 * POST /api/telemetry: client telemetry batches (docs/design/admin-dashboard.md §9).
 * OWNER: T-telemetry.
 *
 * Answers 204 on accept (also when some events were skipped), 400 for a body
 * that is not a TelemetryBatch, 413 above TELEMETRY_LIMITS.maxBodyBytes, 405
 * for non-POST and 429 over the per-IP bucket. Public: a bearer token is
 * optional and only feeds AccountDO.touchActivity (at most once per account
 * per isolate per hour). No account id is ever written to analytics here:
 * the analytics index is the client session id (sid).
 */
import { scrubTelemetryMessage, TELEMETRY_BUILD_RE, TELEMETRY_LIMITS } from "@gamez/protocol";
import { analyticsFor, type Analytics } from "../analytics/index.ts";
import { clientIp, IpLimiter } from "../auth/limiter.ts";
import { sessionStillOpen } from "../auth/session.ts";
import { TOKEN_MAX_AGE_MS, verifyToken } from "../auth.ts";
import type { Env } from "../contracts.ts";
import { bearerToken } from "../http.ts";
import type { RouteHandler } from "./types.ts";

export const TELEMETRY_PATH = "/api/telemetry";

/** Per-IP bucket: burst 40, then 120 per minute (TELEMETRY_LIMITS; sized for shared NAT). */
export const TELEMETRY_RATE = {
  burst: TELEMETRY_LIMITS.ipBurst,
  perSecond: TELEMETRY_LIMITS.ipPerMinute / 60,
} as const;

/** One AccountDO touch per account per isolate per hour. */
export const TOUCH_EVERY_MS = 3_600_000;
const MAX_KEYS = 10_000;

const PLATFORMS = ["web", "pwa", "ios", "android"] as const;
const DEVICES = ["mobile", "tablet", "desktop"] as const;
const ERROR_KINDS = ["error", "unhandledrejection", "render"] as const;

const SID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MODE_RE = /^[A-Za-z0-9._-]{0,40}$/;
const GEO_RE = /^[A-Z]{2}$/;
const MAX_BUILD_CHARS = 40;
const MAX_CONTENT_HASH_CHARS = 64;
const MAX_LOAD_MS = 3_600_000;
const MAX_ELAPSED_S = 10_000_000;

export type TouchFn = (request: Request, now: number) => Promise<void> | void;

export interface TelemetryDeps {
  analytics: Analytics;
  now: () => number;
  touch: TouchFn;
  limiter: Pick<IpLimiter, "take">;
  /** Keeps the touch alive past the response (the route passes ctx.waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Session length band for `client.session` end points (boundaries exclusive at the top). */
export function lengthBand(elapsedS: number): string {
  if (elapsedS < 60) return "<1m";
  if (elapsedS < 300) return "1-5m";
  if (elapsedS < 900) return "5-15m";
  if (elapsedS < 1800) return "15-30m";
  if (elapsedS < 3600) return "30-60m";
  if (elapsedS < 7200) return "1-2h";
  return "2h+";
}

/** A finite number clamped to [min, max], or null when it is not a finite number. */
function num(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

function modeOf(v: unknown): string {
  return typeof v === "string" && MODE_RE.test(v) ? v : "";
}

function geoOf(v: unknown): string {
  return typeof v === "string" && GEO_RE.test(v) ? v : "XX";
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

interface BatchShape {
  sid: string;
  build: string;
  contentHash: string;
  events: unknown[];
}

/** Checks the batch envelope; null when it is not a TelemetryBatch (400). */
function parseBatch(v: unknown): BatchShape | null {
  const b = obj(v);
  if (!b || b.v !== 1) return null;
  const { sid, build, contentHash, events } = b;
  if (typeof sid !== "string" || !SID_RE.test(sid)) return null;
  if (typeof build !== "string" || build.length > MAX_BUILD_CHARS) return null;
  if (typeof contentHash !== "string" || contentHash.length > MAX_CONTENT_HASH_CHARS) return null;
  if (!Array.isArray(events) || events.length > TELEMETRY_LIMITS.maxEvents) return null;
  // Unknown build labels are folded into "other" so free text never becomes a dimension.
  return { sid, build: TELEMETRY_BUILD_RE.test(build) ? build : "other", contentHash, events };
}

interface EmitContext {
  analytics: Analytics;
  sid: string;
  build: string;
  contentHash: string;
  country: string;
  continent: string;
}

/**
 * Writes one raw event as analytics points. Returns true for session events
 * that prove a live account session (start/heartbeat), false otherwise. Invalid
 * events and unknown kinds are skipped without error.
 */
function emitEvent(raw: unknown, c: EmitContext): boolean {
  const e = obj(raw);
  if (!e) return false;
  const geo = { country: c.country, continent: c.continent };
  switch (e.k) {
    case "session.start": {
      const loadMs = num(e.loadMs, 0, MAX_LOAD_MS);
      if (loadMs === null) return false;
      c.analytics.write(
        "client.session",
        {
          phase: "start",
          platform: oneOf(e.platform, PLATFORMS, "web"),
          device: oneOf(e.device, DEVICES, "desktop"),
          ...geo,
          build: c.build,
          contentHash: c.contentHash,
        },
        { loadMs },
        c.sid,
      );
      return true;
    }
    case "session.heartbeat": {
      const elapsedS = num(e.elapsedS, 0, MAX_ELAPSED_S);
      if (elapsedS === null) return false;
      c.analytics.write(
        "client.session",
        {
          phase: "heartbeat",
          ...geo,
          build: c.build,
          contentHash: c.contentHash,
          mode: modeOf(e.mode),
        },
        { elapsedS, visible: e.visible === true ? 1 : 0 },
        c.sid,
      );
      return true;
    }
    case "session.end": {
      const elapsedS = num(e.elapsedS, 0, MAX_ELAPSED_S);
      if (elapsedS === null) return false;
      c.analytics.write(
        "client.session",
        {
          phase: "end",
          ...geo,
          build: c.build,
          contentHash: c.contentHash,
          mode: modeOf(e.mode),
          lengthBand: lengthBand(elapsedS),
        },
        { elapsedS },
        c.sid,
      );
      return false;
    }
    case "perf": {
      const fpsP50 = num(e.fpsP50, 0, 1000);
      const fpsP95 = num(e.fpsP95, 0, 1000);
      const frameMsP95 = num(e.frameMsP95, 0, 10_000);
      const samples = num(e.samples, 0, 1_000_000);
      const heapMb = num(e.heapMb, 0, 1_000_000);
      if (fpsP50 === null || fpsP95 === null || frameMsP95 === null) return false;
      if (samples === null || heapMb === null) return false;
      // The perf wire event carries no platform/device; those columns stay "".
      c.analytics.write(
        "client.perf",
        { mode: modeOf(e.mode), platform: "", device: "", build: c.build },
        { fpsP50, fpsP95, frameMsP95, samples, heapMb },
        c.sid,
      );
      return false;
    }
    case "error": {
      if (typeof e.message !== "string") return false;
      c.analytics.write(
        "client.error",
        {
          kind: oneOf(e.kind, ERROR_KINDS, "error"),
          build: c.build,
          // Never trust the client's normalisation: scrub again (no PII in analytics).
          messageKey: scrubTelemetryMessage(e.message),
          platform: "",
        },
        {},
        c.sid,
      );
      return false;
    }
    default:
      return false;
  }
}

/** True when the declared content-length is above the body limit. */
function declaredTooLarge(request: Request): boolean {
  const declared = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(declared) && declared > TELEMETRY_LIMITS.maxBodyBytes;
}

/** Reads the body with the size limits; a Response when it must be refused. */
async function readBody(request: Request): Promise<string | Response> {
  const max = TELEMETRY_LIMITS.maxBodyBytes;
  if (declaredTooLarge(request)) return tooLarge();
  let text: string;
  try {
    text = await request.text();
  } catch {
    return badRequest("unreadable body");
  }
  if (text.length > max || new TextEncoder().encode(text).byteLength > max) return tooLarge();
  return text;
}

function errorJson(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store", ...(headers as Record<string, string>) } },
  );
}

function badRequest(message: string): Response {
  return errorJson(400, "bad_request", message);
}

function tooLarge(): Response {
  return errorJson(413, "payload_too_large", `body above ${TELEMETRY_LIMITS.maxBodyBytes} bytes`);
}

/** A short, non-reversible key for the per-IP bucket (the IP itself is never kept). */
async function ipKey(request: Request): Promise<string> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(clientIp(request)),
    );
    return Array.from(new Uint8Array(digest).slice(0, 12), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return "anon";
  }
}

/** The pure request handler. Never throws; analytics writes are fire-and-forget. */
export async function handleTelemetry(request: Request, deps: TelemetryDeps): Promise<Response> {
  if (request.method !== "POST") {
    return errorJson(405, "method_not_allowed", "use POST", { allow: "POST" });
  }
  const now = deps.now();
  // Size first, so an oversize body is always 413 (not 429) and costs no token.
  if (declaredTooLarge(request)) return tooLarge();
  if (!deps.limiter.take(await ipKey(request), now)) {
    return errorJson(429, "rate_limited", "too many telemetry requests", { "retry-after": "2" });
  }
  const body = await readBody(request);
  if (typeof body !== "string") return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return badRequest("body is not JSON");
  }
  const batch = parseBatch(parsed);
  if (!batch) return badRequest("body is not a TelemetryBatch");

  const cf = (request as Request & { cf?: { country?: unknown; continent?: unknown } }).cf;
  const ctx: EmitContext = {
    analytics: deps.analytics,
    sid: batch.sid,
    build: batch.build,
    contentHash: batch.contentHash,
    country: geoOf(cf?.country),
    continent: geoOf(cf?.continent),
  };

  let touch = false;
  for (const raw of batch.events) {
    try {
      if (emitEvent(raw, ctx)) touch = true;
    } catch {
      // A malformed event never fails the batch.
    }
  }

  if (touch) {
    const pending = Promise.resolve()
      .then(() => deps.touch(request, now))
      .catch(() => undefined);
    deps.waitUntil?.(pending);
  }
  return new Response(null, { status: 204 });
}

/** Bounded per-isolate gate: one AccountDO touch per account per TOUCH_EVERY_MS. */
export class TouchGate {
  readonly #last = new Map<string, number>();

  take(accountId: string, now: number): boolean {
    const last = this.#last.get(accountId);
    if (last !== undefined && now - last < TOUCH_EVERY_MS) return false;
    if (this.#last.size >= MAX_KEYS) this.#last.clear();
    this.#last.set(accountId, now);
    return true;
  }
}

/**
 * The touch used by the route: verifies the bearer token, gates per account,
 * checks the session is still open, then records activity in AccountDO.
 */
export function makeTouch(
  env: Pick<Env, "AUTH_SECRET" | "ACCOUNT">,
  gate: TouchGate = new TouchGate(),
): TouchFn {
  return async (request, now) => {
    const token = bearerToken(request);
    if (!token || token.length > 4096) return;
    const id = await verifyToken(env.AUTH_SECRET, token, TOKEN_MAX_AGE_MS, now);
    if (!id) return;
    if (!gate.take(id.accountId, now)) return;
    const kind = id.kind ?? "guest";
    const sid = typeof id.sid === "string" ? id.sid : null;
    if (!(await sessionStillOpen(env, { accountId: id.accountId, kind, sid }))) return;
    await env.ACCOUNT.getByName(id.accountId).touchActivity(now);
  };
}

const telemetryLimiter = new IpLimiter(TELEMETRY_RATE);
const telemetryTouchGate = new TouchGate();

export const telemetryRoutes: RouteHandler = (c) => {
  if (c.url.pathname !== TELEMETRY_PATH) return null;
  return handleTelemetry(c.request, {
    analytics: analyticsFor(c.env, (p) => c.ctx.waitUntil(p)),
    now: () => Date.now(),
    touch: makeTouch(c.env, telemetryTouchGate),
    limiter: telemetryLimiter,
    waitUntil: (p) => c.ctx.waitUntil(p),
  });
};

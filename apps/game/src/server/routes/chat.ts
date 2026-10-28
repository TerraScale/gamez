/**
 * /ws/chat and /api/admin/* (wave-B.md §5). OWNER: T-chat.
 *
 * /ws/chat?token=…&channel=… authenticates, checks the channel (catalog mode,
 * or a guild the caller is in) and forwards the upgrade to ChatChannelDO with
 * CHAT_HEADERS. Refusals are close codes: 4401 unauthorized, 4403 not a
 * member of that guild, 4404 unknown channel.
 *
 * /api/admin/* only for accounts listed in ADMIN_ACCOUNT_IDS: 401 without a
 * valid token, 403 for any other account.
 */
import { MODES } from "../../shared/catalog.ts";
import { parseChannel } from "../chat/channels.ts";
import { authenticateRequest } from "../auth/session.ts";
import { CHAT_HEADERS, type Env } from "../contracts.ts";
import { apiError, json, readJson, rejectSocket } from "../http.ts";
import type { RouteHandler } from "./types.ts";

export const CHAT_PATH = "/ws/chat";
export const CLOSE_CHAT_UNAUTHORIZED = 4401;
export const CLOSE_CHAT_FORBIDDEN = 4403;
export const CLOSE_CHAT_UNKNOWN_CHANNEL = 4404;

/** Minimum bindings the access check needs (tests pass fakes). */
export type ChatAccessEnv = Pick<Env, "AUTH_SECRET" | "ACCOUNT">;

export type ChatAccess =
  | {
      ok: true;
      channel: string;
      accountId: string;
      name: string;
      kind: "guest" | "registered";
      tag: string | null;
    }
  | { ok: false; close: number; reason: string };

/**
 * Decides whether the request may join `channel`. Pure apart from the
 * AccountDO lookups; never throws.
 */
export async function chatAccess(
  request: Request,
  env: ChatAccessEnv,
  url: URL,
  modes: readonly { id: string }[] = MODES,
): Promise<ChatAccess> {
  const identity = await authenticateRequest(request, env, url);
  if (!identity) return { ok: false, close: CLOSE_CHAT_UNAUTHORIZED, reason: "unauthorized" };
  const ref = parseChannel(url.searchParams.get("channel") ?? "", modes);
  if (!ref) return { ok: false, close: CLOSE_CHAT_UNKNOWN_CHANNEL, reason: "unknown channel" };

  let membership: { guildId: string; tag: string } | null = null;
  try {
    membership = (await env.ACCOUNT.getByName(identity.accountId).guild()) ?? null;
  } catch (err) {
    console.error("chat: membership lookup failed", err);
    if (ref.kind === "guild") {
      return { ok: false, close: CLOSE_CHAT_FORBIDDEN, reason: "not a member" };
    }
  }
  if (ref.kind === "guild" && membership?.guildId !== ref.guildId) {
    return { ok: false, close: CLOSE_CHAT_FORBIDDEN, reason: "not a member" };
  }
  return {
    ok: true,
    channel: ref.channel,
    accountId: identity.accountId,
    name: identity.name,
    kind: identity.kind,
    tag: membership?.tag ?? null,
  };
}

/** Upgrades /ws/chat, or refuses it with a close code. */
export async function connectChat(
  request: Request,
  env: Pick<Env, "AUTH_SECRET" | "ACCOUNT" | "CHAT">,
  url: URL,
  modes: readonly { id: string }[] = MODES,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const access = await chatAccess(request, env, url, modes);
  if (!access.ok) return rejectSocket(access.close, access.reason);
  const headers = new Headers(request.headers);
  // Identity travels in headers we set ourselves; anything the client sent is overwritten.
  headers.set(CHAT_HEADERS.accountId, access.accountId);
  headers.set(CHAT_HEADERS.name, access.name);
  headers.set(CHAT_HEADERS.channel, access.channel);
  headers.set(CHAT_HEADERS.kind, access.kind);
  if (access.tag) headers.set(CHAT_HEADERS.tag, access.tag);
  else headers.delete(CHAT_HEADERS.tag);
  return env.CHAT.getByName(access.channel).fetch(new Request(request, { headers }));
}

/** ADMIN_ACCOUNT_IDS: comma-separated account ids. */
export function adminIds(env: { ADMIN_ACCOUNT_IDS?: string }): Set<string> {
  return new Set(
    (env.ADMIN_ACCOUNT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

const REPORTS_SQL = `SELECT id, channel, message_id, reporter_id, reported_id, reason, text, at, verdict
  FROM chat_report WHERE _deleted = 0 ORDER BY at DESC LIMIT 100`;

/** Verifies the caller is an admin: the accountId, or a ready error response. */
async function adminCaller(
  request: Request,
  env: Pick<Env, "AUTH_SECRET" | "ACCOUNT" | "ADMIN_ACCOUNT_IDS">,
  url: URL,
): Promise<{ ok: true; accountId: string } | { ok: false; response: Response }> {
  const identity = await authenticateRequest(request, env, url);
  if (!identity) return { ok: false, response: apiError(401, "unauthorized", "log in first") };
  if (!adminIds(env).has(identity.accountId)) {
    return { ok: false, response: apiError(403, "forbidden", "admins only") };
  }
  return { ok: true, accountId: identity.accountId };
}

/** Admin API: reports, mutes and hides. Unknown admin paths answer 404. */
export async function adminRoute(
  request: Request,
  env: Pick<Env, "AUTH_SECRET" | "ACCOUNT" | "ADMIN_ACCOUNT_IDS" | "CHAT" | "DB">,
  url: URL,
  modes: readonly { id: string }[] = MODES,
): Promise<Response> {
  const caller = await adminCaller(request, env, url);
  if (!caller.ok) return caller.response;
  const by = `admin:${caller.accountId}`;

  if (url.pathname === "/api/admin/reports") {
    if (request.method !== "GET") return apiError(405, "method_not_allowed", "use GET");
    try {
      const res = await env.DB.prepare(REPORTS_SQL).all<Record<string, unknown>>();
      return json({ reports: res.results });
    } catch (err) {
      console.error("admin: reports query failed", err);
      return apiError(500, "internal", "reports unavailable");
    }
  }

  if (url.pathname === "/api/admin/mute" || url.pathname === "/api/admin/hide") {
    if (request.method !== "POST") return apiError(405, "method_not_allowed", "use POST");
    const body = await readJson(request);
    const channel = typeof body?.channel === "string" ? body.channel : "";
    if (!parseChannel(channel, modes)) return apiError(400, "bad_request", "unknown channel");
    const stub = env.CHAT.getByName(channel);

    if (url.pathname === "/api/admin/mute") {
      const accountId = typeof body?.accountId === "string" ? body.accountId : "";
      const minutes = body?.minutes;
      if (accountId.length < 1 || accountId.length > 100) {
        return apiError(400, "bad_request", "accountId required");
      }
      if (
        typeof minutes !== "number" ||
        !Number.isInteger(minutes) ||
        minutes < 1 ||
        minutes > 10080
      ) {
        return apiError(400, "bad_request", "minutes must be an integer 1..10080");
      }
      const until = Date.now() + minutes * 60_000;
      await stub.mute(accountId, until, by);
      return json({ ok: true, until });
    }

    const ids = Array.isArray(body?.ids) ? body.ids : null;
    if (
      !ids ||
      ids.length < 1 ||
      ids.length > 50 ||
      !ids.every((id) => typeof id === "string" && id.length <= 64)
    ) {
      return apiError(400, "bad_request", "ids: 1..50 message ids");
    }
    await stub.hide(ids as string[], by);
    return json({ ok: true, hidden: ids.length });
  }

  return apiError(404, "not_found", "no such admin endpoint");
}

export const chatRoutes: RouteHandler = async ({ request, env, url }) => {
  if (url.pathname === CHAT_PATH) return connectChat(request, env, url);
  if (url.pathname.startsWith("/api/admin/")) return adminRoute(request, env, url);
  return null;
};

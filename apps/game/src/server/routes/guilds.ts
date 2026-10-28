/**
 * /api/guilds* (docs/design/wave-B.md §6). OWNER: T-guilds.
 *
 *   GET  /api/guilds?q=            search (D1 guild_index)        public  -> {guilds: GuildSummary[]}
 *   GET  /api/guilds/mine          my guild or null                auth    -> {guild: GuildInfo | null}
 *   GET  /api/guilds/:id           one guild                       public  -> {guild: GuildInfo}
 *   POST /api/guilds               create {name, tag, open}        account -> 201 {guild}
 *   POST /api/guilds/:id/join      join an open guild              account -> {guild}
 *   POST /api/guilds/leave         leave my guild                  auth    -> {guild: GuildInfo | null}
 *   POST /api/guilds/kick          kick {accountId}                auth    -> {guild}
 *
 * Errors: `{error: {code, message}}` with the GuildErrorCode (protocol/platform.ts).
 * Guests browse but never create or join (guest_forbidden).
 *
 * Saga (AGENTS.md §11): reserveGuild (AccountDO) -> GuildDO -> confirmGuild,
 * or releaseGuild on a definite failure. A thrown error leaves the reservation
 * to expire (60 s); a retry of join heals a half-done create.
 */
import type { GuildErrorCode, GuildInfo, GuildSummary } from "@gamez/protocol";
import { authenticateRequest } from "../auth/session.ts";
import type { Env, GuildMembership } from "../contracts.ts";
import { checkGuildName, checkGuildTag, isGuildId } from "../guild/rules.ts";
import { apiError, json, readJson } from "../http.ts";
import type { RouteHandler } from "./types.ts";

const PREFIX = "/api/guilds";
const SEARCH_LIMIT = 50;
const SEARCH_QUERY_MAX = 64;
const ACCOUNT_ID_MAX = 128;

/** HTTP status per guild error code. */
const STATUS: Record<GuildErrorCode, number> = {
  bad_request: 400,
  bad_name: 400,
  bad_tag: 400,
  name_taken: 409,
  already_in_guild: 409,
  not_in_guild: 409,
  not_found: 404,
  full: 409,
  closed: 403,
  forbidden: 403,
  guest_forbidden: 403,
};

const MESSAGES: Record<GuildErrorCode, string> = {
  bad_request: "bad request",
  bad_name: "invalid guild name",
  bad_tag: "invalid guild tag",
  name_taken: "a guild with that name already exists",
  already_in_guild: "you already belong to a guild",
  not_in_guild: "you are not in a guild",
  not_found: "no such guild",
  full: "the guild is full",
  closed: "the guild is closed",
  forbidden: "you may not do that",
  guest_forbidden: "sign in with an account to join or create guilds",
};

function guildError(code: GuildErrorCode, message = MESSAGES[code]): Response {
  return apiError(STATUS[code], code, message);
}

export const guildRoutes: RouteHandler = async ({ request, env, url }) => {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  const parts = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);
  const method = request.method;

  if (parts.length === 0) {
    if (method === "GET") return search(env, url);
    if (method === "POST") return createGuild(request, env, url);
    return null;
  }
  if (parts.length === 1) {
    const [head] = parts as [string];
    if (head === "mine" && method === "GET") return mine(request, env, url);
    if (head === "leave" && method === "POST") return leave(request, env, url);
    if (head === "kick" && method === "POST") return kick(request, env, url);
    if (method === "GET") return getGuild(env, head);
    return null;
  }
  if (parts.length === 2 && parts[1] === "join" && method === "POST") {
    return join(request, env, url, parts[0] as string);
  }
  return null;
};

// ---- public ---------------------------------------------------------------

/** GET /api/guilds?q= : D1 read model. A missing table reads as no guilds. */
async function search(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, SEARCH_QUERY_MAX);
  let sql = "SELECT guild_id, name, tag, open, member_count FROM guild_index WHERE _deleted = 0";
  const params: string[] = [];
  if (q.length > 0) {
    sql += " AND name LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLike(q)}%`);
  }
  sql += ` ORDER BY member_count DESC, guild_id ASC LIMIT ${SEARCH_LIMIT}`;
  try {
    const res = await env.DB.prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>();
    const guilds: GuildSummary[] = (res.results ?? []).map((r) => ({
      id: text(r.guild_id),
      name: text(r.name),
      tag: text(r.tag),
      open: Number(r.open) === 1,
      memberCount: Number(r.member_count ?? 0),
    }));
    return json({ guilds });
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return json({ guilds: [] });
    throw err;
  }
}

/** GET /api/guilds/:id */
async function getGuild(env: Env, id: string): Promise<Response> {
  if (!isGuildId(id)) return guildError("not_found");
  const guild = await env.GUILD.getByName(id).info();
  if (guild === null) return guildError("not_found");
  return json({ guild });
}

// ---- authenticated --------------------------------------------------------

/** GET /api/guilds/mine */
async function mine(request: Request, env: Env, url: URL): Promise<Response> {
  const who = await authenticateRequest(request, env, url);
  if (who === null) return unauthorized();
  const membership = await env.ACCOUNT.getByName(who.accountId).guild();
  if (membership === null) return json({ guild: null });
  const guild = await env.GUILD.getByName(membership.guildId).info();
  return json({ guild: guild ?? null });
}

/** POST /api/guilds */
async function createGuild(request: Request, env: Env, url: URL): Promise<Response> {
  const who = await authenticateRequest(request, env, url);
  if (who === null) return unauthorized();
  if (who.kind !== "registered") return guildError("guest_forbidden");

  const body = await readJson(request);
  if (body === null) return guildError("bad_request", "expected a JSON object");
  const name = checkGuildName(body.name);
  if (!name.ok) return guildError("bad_name", name.message);
  const tag = checkGuildTag(body.tag);
  if (!tag.ok) return guildError("bad_tag", tag.message);
  const open = body.open ?? true;
  if (typeof open !== "boolean") return guildError("bad_request", "open must be true or false");

  const account = env.ACCOUNT.getByName(who.accountId);
  const opId = crypto.randomUUID();
  const slot = await account.reserveGuild(opId, name.id);
  if (!slot.ok) return alreadyIn(env, slot.current, name.id);

  const guild = env.GUILD.getByName(name.id);
  const res = await guild.create({
    opId,
    name: name.name,
    tag: tag.tag,
    open,
    founder: { accountId: who.accountId, displayName: who.name },
  });
  if (!res.ok) {
    await account.releaseGuild(opId, name.id);
    return guildError(res.code);
  }
  await account.confirmGuild(opId, { guildId: name.id, tag: res.guild.tag, role: "leader" });
  return json({ guild: res.guild }, 201);
}

/** POST /api/guilds/:id/join */
async function join(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  const who = await authenticateRequest(request, env, url);
  if (who === null) return unauthorized();
  if (who.kind !== "registered") return guildError("guest_forbidden");
  if (!isGuildId(id)) return guildError("not_found");

  const account = env.ACCOUNT.getByName(who.accountId);
  const opId = crypto.randomUUID();
  const slot = await account.reserveGuild(opId, id);
  if (!slot.ok) return alreadyIn(env, slot.current, id);

  const res = await env.GUILD.getByName(id).join({
    opId,
    member: { accountId: who.accountId, displayName: who.name },
  });
  if (!res.ok) {
    await account.releaseGuild(opId, id);
    return guildError(res.code);
  }
  await account.confirmGuild(opId, { guildId: id, tag: res.guild.tag, role: "member" });
  return json({ guild: res.guild });
}

/** POST /api/guilds/leave */
async function leave(request: Request, env: Env, url: URL): Promise<Response> {
  const who = await authenticateRequest(request, env, url);
  if (who === null) return unauthorized();
  const account = env.ACCOUNT.getByName(who.accountId);
  const membership = await account.guild();
  if (membership === null) return guildError("not_in_guild");

  const opId = crypto.randomUUID();
  const res = await env.GUILD.getByName(membership.guildId).leave({
    opId,
    accountId: who.accountId,
  });
  await account.releaseGuild(opId, membership.guildId);
  return json({ guild: res.guild });
}

/** POST /api/guilds/kick {accountId} */
async function kick(request: Request, env: Env, url: URL): Promise<Response> {
  const who = await authenticateRequest(request, env, url);
  if (who === null) return unauthorized();
  const body = await readJson(request);
  if (body === null) return guildError("bad_request", "expected a JSON object");
  const target = body.accountId;
  if (typeof target !== "string" || target.length === 0 || target.length > ACCOUNT_ID_MAX) {
    return guildError("bad_request", "accountId is required");
  }

  const membership = await env.ACCOUNT.getByName(who.accountId).guild();
  if (membership === null) return guildError("forbidden");

  const opId = crypto.randomUUID();
  const res = await env.GUILD.getByName(membership.guildId).kick({
    by: who.accountId,
    target,
  });
  // A kick answered not_found means the target is not in the roster, so the
  // release is only healing a slot left behind by an earlier crash.
  if (res.ok || res.code === "not_found") {
    await env.ACCOUNT.getByName(target).releaseGuild(opId, membership.guildId);
  }
  if (!res.ok) return guildError(res.code);
  return json({ guild: res.guild });
}

// ---- helpers ----------------------------------------------------------------

/** Guilds are an account feature: a guest token authenticates (kick checks, leave) but create/join refuse it. */
function unauthorized(): Response {
  return apiError(401, "unauthorized", "sign in first");
}

/**
 * The reservation failed. When the account already belongs to the guild it
 * asked for (a retry after success), that is success: answer with the guild.
 */
async function alreadyIn(
  env: Env,
  current: GuildMembership | null,
  wanted: string,
): Promise<Response> {
  if (current !== null && current.guildId === wanted) {
    const guild: GuildInfo | null = await env.GUILD.getByName(wanted).info();
    if (guild !== null) return json({ guild });
  }
  return guildError("already_in_guild");
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Escapes LIKE wildcards so a search for "50%" is literal. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

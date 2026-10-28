/**
 * Pure flows behind the social components: each takes the platform interface
 * it needs and returns a plain result, so the React layer stays thin and the
 * flows are tested with fake services (tests/social.flows.test.ts).
 */
import type {
  AccountView,
  ApiResult,
  AuthApi,
  ChatChannelClient,
  GuildApi,
  GuildInfo,
  GuildSummary,
  LeaderboardApi,
  LeaderboardQuery,
  LeaderboardResponse,
} from "../platform.ts";
import type { ProviderInfo } from "@gamez/protocol";
import { CHAT_MAX_LEN, GUILD_MAX_MEMBERS } from "@gamez/protocol";
import {
  authErrorText,
  guildErrorText,
  validateDisplayName,
  validateEmail,
  validateGuildName,
  validateGuildTag,
  validatePassword,
} from "./text.ts";

export type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

export function toLoadState<T>(r: ApiResult<T>): LoadState<T> {
  return r.ok ? { status: "ready", value: r.value } : { status: "error", message: errorMessage(r) };
}

function errorMessage(r: { code: string; message: string }): string {
  return r.message || "Something went wrong. Try again.";
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** Trims, checks length locally, then sends. Never sends blank or over-long text. */
export function sendChat(
  client: ChatChannelClient,
  raw: string,
): Promise<ApiResult<{ id: string }>> {
  const text = raw.trim();
  if (!text) return Promise.resolve({ ok: false, code: "empty", message: "Type a message first." });
  if (text.length > CHAT_MAX_LEN) {
    return Promise.resolve({
      ok: false,
      code: "too_long",
      message: `Messages can be up to ${CHAT_MAX_LEN} characters.`,
    });
  }
  return client.send(text);
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

/** The query a board tab + class filter means. "All classes" omits classId. */
export function leaderboardQuery(
  board: LeaderboardQuery["board"],
  mode: string,
  classId: string,
  limit = 50,
): LeaderboardQuery {
  const q: LeaderboardQuery = { board, mode, limit };
  if (classId) q.classId = classId;
  return q;
}

export type BoardState =
  | { status: "loading" }
  | { status: "warming" }
  | { status: "error"; message: string }
  | { status: "ready"; response: LeaderboardResponse };

export async function loadLeaderboard(
  api: LeaderboardApi,
  query: LeaderboardQuery,
): Promise<BoardState> {
  const r = await api.fetch(query);
  if (!r.ok) return { status: "error", message: errorMessage(r) };
  if (!r.value.available) return { status: "warming" };
  return { status: "ready", response: r.value };
}

// ---------------------------------------------------------------------------
// Guilds
// ---------------------------------------------------------------------------

export interface CreateGuildForm {
  name: string;
  tag: string;
  open: boolean;
}

/** Validates locally; returns the first problem in plain words, or null. */
export function checkCreateGuild(form: CreateGuildForm): string | null {
  return validateGuildName(form.name) ?? validateGuildTag(form.tag);
}

export async function createGuild(
  guilds: GuildApi,
  form: CreateGuildForm,
): Promise<ApiResult<GuildInfo>> {
  const problem = checkCreateGuild(form);
  if (problem) return { ok: false, code: "bad_request", message: problem };
  const r = await guilds.create({
    name: form.name.trim(),
    tag: form.tag.trim().toUpperCase(),
    open: form.open,
  });
  return r.ok ? r : { ok: false, code: r.code, message: guildErrorText(r.code, r.message) };
}

/**
 * Why a guild's Join button is disabled, as a short button label (it must fit a
 * 375px row), or null when it can be joined. The longer explanation for guests
 * is the status line above the list.
 */
export function guildJoinBlock(guild: GuildSummary, account: AccountView | null): string | null {
  if (!account || account.kind !== "registered") return "Sign in";
  if (account.guildId) return "In a guild";
  if (!guild.open) return "Invite only";
  if (guild.memberCount >= GUILD_MAX_MEMBERS) return "Full";
  return null;
}

export async function loadGuildList(
  guilds: GuildApi,
  query: string,
): Promise<LoadState<GuildSummary[]>> {
  const q = query.trim();
  return toLoadState(await guilds.list(q || undefined));
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface RegisterForm {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginForm {
  email: string;
  password: string;
}

/** Local checks for the register form; the first problem wins. */
export function checkRegister(form: RegisterForm): string | null {
  return (
    validateEmail(form.email) ??
    validatePassword(form.password) ??
    validateDisplayName(form.displayName)
  );
}

export async function registerAccount(
  auth: AuthApi,
  form: RegisterForm,
): Promise<ApiResult<AccountView>> {
  const problem = checkRegister(form);
  if (problem) return { ok: false, code: "bad_request", message: problem };
  const name = form.displayName.trim();
  const r = await auth.register(form.email.trim(), form.password, name || undefined);
  return r.ok ? r : { ok: false, code: r.code, message: authErrorText(r.code, r.message) };
}

export async function loginAccount(
  auth: AuthApi,
  form: LoginForm,
): Promise<ApiResult<AccountView>> {
  const problem = validateEmail(form.email) ?? (form.password ? null : "Enter your password.");
  if (problem) return { ok: false, code: "bad_request", message: problem };
  const r = await auth.login(form.email.trim(), form.password);
  return r.ok ? r : { ok: false, code: r.code, message: authErrorText(r.code, r.message) };
}

export async function saveDisplayName(
  auth: AuthApi,
  name: string,
): Promise<ApiResult<AccountView>> {
  const problem = validateDisplayName(name);
  if (problem || !name.trim()) {
    return { ok: false, code: "bad_name", message: problem ?? "Enter a display name." };
  }
  const r = await auth.setDisplayName(name.trim());
  return r.ok ? r : { ok: false, code: r.code, message: authErrorText(r.code, r.message) };
}

/** OAuth providers that can be linked or used to sign in (the email one is not OAuth). */
export function oauthProviders(providers: readonly ProviderInfo[]): ProviderInfo[] {
  return providers.filter((p) => p.id !== "email");
}

export function linkedProviders(account: AccountView): Set<string> {
  return new Set(account.identities.map((i) => i.provider));
}

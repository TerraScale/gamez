/**
 * Platform wire types (wave B, docs/design/wave-B.md §3-§6): the HTTP API
 * under /api and the chat socket /ws/chat. Shared by the Worker, the client
 * platform SDK (apps/game/src/client/platform) and tools/e2e.
 *
 * Every authenticated HTTP call sends `Authorization: Bearer <token>`.
 * Errors are `{ error: { code, message } }` with a 4xx/5xx status.
 */

// ---------------------------------------------------------------------------
// Auth and accounts
// ---------------------------------------------------------------------------

export type AuthProvider = "email" | "google" | "discord" | "apple";
export type AccountKind = "guest" | "registered";

export interface ApiError {
  error: { code: string; message: string };
}

/** POST /api/guest (unchanged shape, plus kind). */
export interface GuestResponse {
  token: string;
  accountId: string;
  name: string;
  kind?: AccountKind;
}

export interface ProviderInfo {
  id: AuthProvider;
  /** Login with it is possible right now. */
  enabled: boolean;
  /** True when the local stub provider stands in (dev/e2e only, never in production). */
  stub: boolean;
}

/** GET /api/auth/providers */
export interface ProvidersResponse {
  providers: ProviderInfo[];
}

/** GET /api/me, and `account` of AuthResponse. */
export interface AccountView {
  accountId: string;
  displayName: string;
  kind: AccountKind;
  /** Linked identities (never secrets). `email` only for provider "email" (and OAuth when given). */
  identities: { provider: AuthProvider; email?: string }[];
  guildId: string | null;
  guildTag: string | null;
  createdAt: number;
}

/**
 * POST /api/auth/register {email, password, displayName?}: with a guest
 * bearer token the guest account is upgraded in place (same accountId, all
 * progress kept); without one a new account is created.
 * POST /api/auth/login {email, password}: switches to that account.
 * Both answer AuthResponse; the client replaces its session token.
 */
export interface RegisterRequest {
  email: string;
  password: string;
  displayName?: string;
}
export interface LoginRequest {
  email: string;
  password: string;
}
export interface AuthResponse {
  token: string;
  account: AccountView;
}

/** POST /api/account/name */
export interface DisplayNameRequest {
  displayName: string;
}

/** Error codes of /api/auth/* (ApiError.error.code). */
export type AuthErrorCode =
  | "bad_request"
  | "weak_password"
  | "bad_email"
  | "bad_name"
  | "email_taken"
  | "identity_taken"
  | "bad_credentials"
  | "locked"
  | "provider_disabled"
  | "oauth_failed"
  | "unauthorized";

/** Password rules (client shows them; the server enforces them). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 20;

// ---------------------------------------------------------------------------
// Account economy (AccountDO; read-mostly in wave B)
// ---------------------------------------------------------------------------

/** Account-wide currencies. "coin" is the universal soft currency, "gem" premium (entitlements only). */
export type Currency = "coin" | "gem";

export interface WalletView {
  balances: Record<Currency, number>;
}

export interface UniversalItem {
  /** Unique per account. */
  uid: string;
  /** Logical item id, e.g. "universal.material.ember_dust". */
  itemId: string;
  count: number;
  /** Mode that produced it ("" = platform). */
  origin: string;
}

export type CosmeticSlot = "title" | "nameplate" | "chatColor";

export interface CosmeticsView {
  owned: string[];
  equipped: Partial<Record<CosmeticSlot, string>>;
}

export interface EntitlementView {
  id: string;
  /** Product / grant id, e.g. "cosmetic.title.founder". */
  sku: string;
  grantedAt: number;
  source: string;
}

// ---------------------------------------------------------------------------
// Leaderboards (D1 read model, wave-B.md §4)
// ---------------------------------------------------------------------------

export type LeaderboardBoard = "level" | "depth" | "rift";

/** GET /api/leaderboards?board=&mode=classic&classId=&limit= */
export interface LeaderboardQuery {
  board: LeaderboardBoard;
  /** Mode id; only "classic" has boards in wave B. */
  mode?: string;
  /** Class filter ("classic.class.warrior" …); omitted = all classes. */
  classId?: string;
  /** 1..100, default 50. */
  limit?: number;
}

export interface LeaderboardRow {
  rank: number;
  accountId: string;
  displayName: string;
  heroName: string;
  classId: string;
  heroLevel: number;
  /** The ranked value: level, deepest depth or rift score. */
  value: number;
  /** Board-specific extras: rift {riftLevel, ticks, deaths}; depth/level {xp}. */
  extra: Record<string, number>;
  /** Progress came from an imported (unverified) local save. */
  imported: boolean;
  updatedAt: number;
}

export interface LeaderboardResponse {
  board: LeaderboardBoard;
  mode: string;
  classId: string | null;
  rows: LeaderboardRow[];
  /** False when the read model is not migrated yet (rows empty). */
  available: boolean;
}

// ---------------------------------------------------------------------------
// Guilds (GuildDO + D1 guild_index, wave-B.md §6)
// ---------------------------------------------------------------------------

export type GuildRole = "leader" | "officer" | "member";

export interface GuildMember {
  accountId: string;
  displayName: string;
  role: GuildRole;
  joinedAt: number;
}

export interface GuildInfo {
  /** Slug of the name: lowercase a-z, 0-9 and "-", 3..24 chars. Also the GuildDO name. */
  id: string;
  name: string;
  /** 2..5 chars A-Z0-9, shown as <TAG>. */
  tag: string;
  /** Anyone may join an open guild; closed guilds are invite-only (wave C). */
  open: boolean;
  createdAt: number;
  members: GuildMember[];
}

export interface GuildSummary {
  id: string;
  name: string;
  tag: string;
  open: boolean;
  memberCount: number;
}

export const GUILD_MAX_MEMBERS = 50;

/** POST /api/guilds */
export interface CreateGuildRequest {
  name: string;
  tag: string;
  open: boolean;
}

/** Error codes of /api/guilds* . */
export type GuildErrorCode =
  | "bad_request"
  | "bad_name"
  | "bad_tag"
  | "name_taken"
  | "already_in_guild"
  | "not_in_guild"
  | "not_found"
  | "full"
  | "closed"
  | "forbidden"
  | "guest_forbidden";

// ---------------------------------------------------------------------------
// Chat (ChatChannelDO over /ws/chat?token&channel, wave-B.md §5)
// ---------------------------------------------------------------------------

/** "global", "mode:<modeId>" or "guild:<guildId>". */
export type ChannelId = string;

export interface ChatMessage {
  /** Unique per channel, sortable ("<at base36>-<n>"). */
  id: string;
  channel: ChannelId;
  from: string;
  name: string;
  /** Guild tag of the sender at send time. */
  tag?: string;
  /** Text after the word filter. */
  text: string;
  at: number;
  /** System notices (mutes, joins) have no sender. */
  system?: boolean;
}

export const CHAT_MAX_LEN = 280;
export const CHAT_HISTORY = 50;

export type ChatClientMessage =
  | { t: "send"; text: string; nonce: string }
  | { t: "report"; id: string; reason: ReportReason }
  | { t: "block"; accountId: string; blocked: boolean }
  | { t: "ping"; clientTime: number };

export type ReportReason = "spam" | "abuse" | "cheating" | "other";

export type ChatServerMessage =
  | {
      t: "welcome";
      channel: ChannelId;
      self: { accountId: string; displayName: string };
      /** Oldest first; already filtered by the viewer's block list. */
      history: ChatMessage[];
      /** Set while the viewer is muted in this channel. */
      mutedUntil: number | null;
      blocked: string[];
    }
  | { t: "message"; msg: ChatMessage }
  /** Moderation hid these messages (Llama Guard, admin): clients remove them. */
  | { t: "hidden"; ids: string[] }
  | { t: "ack"; nonce: string; id: string }
  | { t: "muted"; until: number; reason: string }
  | { t: "blocked"; blocked: string[] }
  | { t: "pong"; clientTime: number; serverTime: number }
  | { t: "error"; code: ChatErrorCode; message: string; nonce?: string };

export type ChatErrorCode =
  | "bad_message"
  | "rate_limited"
  | "muted"
  | "too_long"
  | "empty"
  | "duplicate"
  | "filtered"
  | "forbidden"
  | "internal";

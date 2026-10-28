/**
 * Wave B client platform services (docs/design/wave-B.md §8): what the app
 * shell gives a mode beyond its world: the verified sim connection, town
 * presence, auth, leaderboards, chat and guilds. Interfaces only; the
 * implementations live in apps/game/src/client/platform (HTTP/WS) and
 * apps/game/src/client/instance/verified.ts. Mode packages depend on these
 * interfaces, never on apps/game.
 */
import type { GameEvent, RecordedSegment, SimSnapshot } from "@gamez/kernel";
import type {
  AccountView,
  AuthProvider,
  ChannelId,
  ChatMessage,
  CosmeticsView,
  CreateGuildRequest,
  EntityState,
  GuildInfo,
  GuildSummary,
  LeaderboardQuery,
  LeaderboardResponse,
  PoseUpdate,
  ProviderInfo,
  ReportReason,
  VerifyLimits,
  WalletView,
} from "@gamez/protocol";

export type {
  AccountView,
  AuthProvider,
  ChannelId,
  ChatMessage,
  GuildInfo,
  GuildSummary,
  LeaderboardQuery,
  LeaderboardResponse,
};

// ---------------------------------------------------------------------------
// Verified sim connection (client-driven modes, wave-B.md §2)
// ---------------------------------------------------------------------------

export type VerifiedStatus = "connecting" | "online" | "offline" | "closed";

/** vstate with the snapshot already unpacked. */
export interface VerifiedState {
  instanceId: string;
  epoch: number;
  tick: number;
  hash: string;
  /** True: keep the local sim (it continues tick/hash). snapshot is null then. */
  continued: boolean;
  snapshot: SimSnapshot | null;
  offline: { elapsedMs: number; events: GameEvent[] } | null;
  imported: boolean;
  importable: boolean;
  limits: VerifyLimits;
}

export interface VerifiedAck {
  epoch: number;
  seq: number;
  tick: number;
  hash: string;
  creditMs: number;
}

/** resync with the snapshot already unpacked: restore it and drop local progress after `tick`. */
export interface VerifiedResync {
  epoch: number;
  seq: number;
  code: string;
  message: string;
  tick: number;
  hash: string;
  snapshot: SimSnapshot;
}

export interface VerifiedHandlers {
  /**
   * Asked before every (re)join. Return the local continuation point (the
   * last server-verified tick/hash the local sim descends from, and whether
   * unacked segments exist), or null to adopt the server state.
   */
  resume(): { tick: number; hash: string; pending: boolean } | null;
  state(s: VerifiedState): void;
  verified(a: VerifiedAck): void;
  resync(r: VerifiedResync): void;
  status(s: VerifiedStatus): void;
  error?(code: string, message: string): void;
}

/** A segment as submitted: the recorder's segment plus the epoch it was recorded in and a client seq. */
export interface SegmentSubmission extends RecordedSegment {
  epoch: number;
  seq: number;
}

/** Socket to the player's InstanceDO for a client-driven mode. */
export interface VerifiedConnection {
  readonly mode: string;
  readonly status: VerifiedStatus;
  /** Opens the socket and joins; reconnects with backoff (calling handlers.resume() each time). */
  start(handlers: VerifiedHandlers): void;
  /** Sends a segment; false when not online (the caller keeps it and resends after the next join). */
  submit(seg: SegmentSubmission): boolean;
  /** Local save migration (only while vstate.importable). The answer is a new state(). */
  importSave(snapshot: SimSnapshot, savedAt: number): void;
  /** Discards the server instance and starts a new one (server seed); answered by state(). */
  restart(): void;
  /** Server clock estimate (epoch ms). */
  serverNow(): number;
  close(): void;
}

// ---------------------------------------------------------------------------
// Presence (pose worlds such as the classic town, wave-B.md §7)
// ---------------------------------------------------------------------------

export interface PresenceView {
  status: "connecting" | "online" | "offline";
  selfId: string | null;
  /** Everyone else in the world (never self). */
  others: readonly EntityState[];
}

export interface PresenceConnection {
  readonly world: string;
  getView(): PresenceView;
  /** Called on every change of others/status; never at frame rate. */
  subscribe(cb: (view: PresenceView) => void): () => void;
  /** Reports the own avatar (rate limited by the caller to <= 4/s; the server drops excess). */
  setPose(pose: PoseUpdate): void;
  /** Server clock estimate (epoch ms) for interpolating `others` with walkAt(). */
  serverNow(): number;
  close(): void;
}

// ---------------------------------------------------------------------------
// Auth, leaderboards, chat, guilds, account
// ---------------------------------------------------------------------------

export type ApiResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export interface AuthApi {
  /** Current account (creates the AccountDO record for an old guest on first call). */
  me(): Promise<ApiResult<AccountView>>;
  providers(): Promise<ProviderInfo[]>;
  /** Upgrades the current guest in place (same accountId) or creates an account. Replaces the session. */
  register(email: string, password: string, displayName?: string): Promise<ApiResult<AccountView>>;
  /** Switches to the email account. Replaces the session. */
  login(email: string, password: string): Promise<ApiResult<AccountView>>;
  /** Revokes the session and falls back to a fresh guest. */
  logout(): Promise<void>;
  /** URL to navigate to for OAuth (`link`: attach to the current account instead of logging in). */
  oauthUrl(provider: AuthProvider, opts: { link: boolean }): string;
  setDisplayName(name: string): Promise<ApiResult<AccountView>>;
  /** Fires after every session change (login, register, logout, OAuth return). */
  onSessionChange(cb: () => void): () => void;
}

export interface LeaderboardApi {
  fetch(q: LeaderboardQuery): Promise<ApiResult<LeaderboardResponse>>;
}

export interface ChatChannelView {
  channel: ChannelId;
  status: "connecting" | "online" | "offline" | "closed";
  /** Oldest first, at most CHAT_HISTORY*2, hidden and blocked removed. */
  messages: readonly ChatMessage[];
  mutedUntil: number | null;
  blocked: readonly string[];
  /** Last error (rate limit, filter…) for a toast; cleared by the next successful send. */
  error: { code: string; message: string } | null;
}

export interface ChatChannelClient {
  readonly channel: ChannelId;
  getView(): ChatChannelView;
  subscribe(cb: (view: ChatChannelView) => void): () => void;
  /** Resolves once acked or rejected. */
  send(text: string): Promise<ApiResult<{ id: string }>>;
  report(messageId: string, reason: ReportReason): void;
  block(accountId: string, blocked: boolean): void;
  close(): void;
}

export interface ChatApi {
  /** Opens (or reuses) the socket of a channel. */
  join(channel: ChannelId): ChatChannelClient;
}

export interface GuildApi {
  mine(): Promise<ApiResult<GuildInfo | null>>;
  list(query?: string): Promise<ApiResult<GuildSummary[]>>;
  get(id: string): Promise<ApiResult<GuildInfo>>;
  create(req: CreateGuildRequest): Promise<ApiResult<GuildInfo>>;
  join(id: string): Promise<ApiResult<GuildInfo>>;
  leave(): Promise<ApiResult<null>>;
  kick(accountId: string): Promise<ApiResult<GuildInfo>>;
}

export interface AccountApi {
  wallet(): Promise<ApiResult<WalletView>>;
  cosmetics(): Promise<ApiResult<CosmeticsView>>;
}

/** Everything platform-side a mode may use (ClientServices.platform). */
export interface PlatformServices {
  auth: AuthApi;
  leaderboards: LeaderboardApi;
  chat: ChatApi;
  guilds: GuildApi;
  account: AccountApi;
}

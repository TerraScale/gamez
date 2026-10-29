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
  ArenaLadderResponse,
  ArenaMatch,
  ArenaStatus,
  ArenaTicket,
  AuthProvider,
  BankOp,
  BankResult,
  CheckoutResponse,
  ConfigResponse,
  FiatCurrency,
  ItemCategory,
  MarketListing,
  MarketListRequest,
  MarketMineResponse,
  MarketSearchQuery,
  MarketSearchResponse,
  NoticesResponse,
  OrdersResponse,
  PassTrack,
  PassView,
  PaymentProviderId,
  PlotsResponse,
  PlotView,
  ShopConfigureRequest,
  ShopView,
  StoreResponse,
  TradeListResponse,
  TradeView,
  VaultResponse,
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
  /** Resync "offline": the deferred offline grant the server applied (shown as the away summary). */
  offline?: { elapsedMs: number; events: GameEvent[] } | null;
}

/** Wave C: the server's answer to a bank op (protocol verified.ts "bank"). */
export interface BankAnswer {
  opId: string;
  result: BankResult;
  applied: { tick: number; name: string; payload: unknown; hash: string } | null;
}

export interface VerifiedHandlers {
  /**
   * Asked before every (re)join. Return the local continuation point (the
   * last server-verified tick/hash the local sim descends from, and whether
   * unacked segments exist), or null to adopt the server state.
   */
  resume(): { tick: number; hash: string; pending: boolean; pendingToTick?: number } | null;
  state(s: VerifiedState): void;
  verified(a: VerifiedAck): void;
  resync(r: VerifiedResync): void;
  status(s: VerifiedStatus): void;
  error?(code: string, message: string): void;
  /** Wave C: answer to sendBank (after any resync it caused). */
  bank?(answer: BankAnswer): void;
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
  /**
   * Wave C bank op (docs/design/wave-C.md §2.4): the caller has submitted a
   * segment ending at `at` and paused its sim. false when not online.
   * Answered through handlers.bank.
   */
  sendBank?(msg: { opId: string; op: BankOp; at: { tick: number; hash: string } }): boolean;
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

// ---------------------------------------------------------------------------
// Wave C (docs/design/wave-C.md §10.1). Mutating calls take an optional opId;
// the SDK generates one when absent and reuses it for its own retries.
// ---------------------------------------------------------------------------

export interface VaultApi {
  vault(): Promise<ApiResult<VaultResponse>>;
  notices(sinceId?: string | null): Promise<ApiResult<NoticesResponse>>;
  markRead(upToId: string): Promise<ApiResult<{ marked: number }>>;
}

export interface TradeApi {
  list(): Promise<ApiResult<TradeListResponse>>;
  open(withAccountId: string, opId?: string): Promise<ApiResult<TradeView>>;
  get(tradeId: string): Promise<ApiResult<TradeView>>;
  offer(tradeId: string, coin: number, uids: string[]): Promise<ApiResult<TradeView>>;
  accept(tradeId: string, versions: [number, number]): Promise<ApiResult<TradeView>>;
  cancel(tradeId: string): Promise<ApiResult<TradeView>>;
}

export interface MarketApi {
  search(q: MarketSearchQuery): Promise<ApiResult<MarketSearchResponse>>;
  mine(): Promise<ApiResult<MarketMineResponse>>;
  list(req: Omit<MarketListRequest, "opId"> & { opId?: string }): Promise<ApiResult<MarketListing>>;
  bid(listingId: string, amount: number, opId?: string): Promise<ApiResult<MarketListing>>;
  buy(listingId: string, opId?: string): Promise<ApiResult<MarketListing>>;
  cancel(listingId: string, opId?: string): Promise<ApiResult<MarketListing>>;
}

export interface ShopsApi {
  plots(world: string): Promise<ApiResult<PlotsResponse>>;
  bidPlot(
    world: string,
    plotId: string,
    amount: number,
    opId?: string,
  ): Promise<ApiResult<PlotView>>;
  shop(world: string, plotId: string): Promise<ApiResult<ShopView>>;
  configure(world: string, plotId: string, req: ShopConfigureRequest): Promise<ApiResult<ShopView>>;
  stock(
    world: string,
    plotId: string,
    uid: string,
    price: number,
    opId?: string,
  ): Promise<ApiResult<ShopView>>;
  unstock(
    world: string,
    plotId: string,
    entryId: string,
    opId?: string,
  ): Promise<ApiResult<ShopView>>;
  buy(world: string, plotId: string, entryId: string, opId?: string): Promise<ApiResult<ShopView>>;
  claim(world: string, plotId: string, opId?: string): Promise<ApiResult<ShopView>>;
}

export interface ArenaApi {
  status(mode?: string): Promise<ApiResult<ArenaStatus>>;
  /** Registers the current verified build and queues a fight. */
  queue(mode?: string, opId?: string): Promise<ApiResult<ArenaTicket>>;
  poll(ticket: string, mode?: string): Promise<ApiResult<ArenaTicket>>;
  ladder(q?: {
    mode?: string;
    classId?: string;
    limit?: number;
  }): Promise<ApiResult<ArenaLadderResponse>>;
  match(id: string, mode?: string): Promise<ApiResult<ArenaMatch>>;
}

export interface PassApi {
  view(): Promise<ApiResult<PassView>>;
  claim(tier: number, track: PassTrack): Promise<ApiResult<PassView>>;
  /** Buys the premium track with gems (registered only); idempotent by opId. */
  premium?(opId?: string): Promise<ApiResult<PassView>>;
}

export interface StoreApi {
  catalog(country?: string): Promise<ApiResult<StoreResponse>>;
  checkout(
    sku: string,
    provider: PaymentProviderId,
    currency: FiatCurrency,
    opId?: string,
  ): Promise<ApiResult<CheckoutResponse>>;
  orders(): Promise<ApiResult<OrdersResponse>>;
}

export interface ConfigApi {
  get(): Promise<ApiResult<ConfigResponse>>;
}

/** Everything platform-side a mode may use (ClientServices.platform). */
export interface PlatformServices {
  auth: AuthApi;
  leaderboards: LeaderboardApi;
  chat: ChatApi;
  guilds: GuildApi;
  account: AccountApi;
  // Wave C (optional so wave B fakes stay valid; createPlatform always sets them).
  vault?: VaultApi;
  trade?: TradeApi;
  market?: MarketApi;
  shops?: ShopsApi;
  arena?: ArenaApi;
  pass?: PassApi;
  store?: StoreApi;
  config?: ConfigApi;
}

/**
 * Wave C: shell screens a mode can open over itself (ClientServices.openScreen).
 * The app shell renders them as sheets; the mode keeps running underneath.
 */
export type PlatformScreen =
  | { id: "market"; category?: ItemCategory; q?: string }
  | { id: "vault" }
  | { id: "trade"; with?: { accountId: string; displayName: string }; tradeId?: string }
  | { id: "plots"; world: string }
  | { id: "shop"; world: string; plotId: string }
  | { id: "arena"; mode: string }
  | { id: "pass" }
  | { id: "store" }
  | { id: "notices" };

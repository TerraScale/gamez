/**
 * Internal contracts between the Worker and its Durable Objects (phase 0).
 *
 * Topology (see plan §2):
 *   client --WS--> RelayDO (one per region shard; holds sockets)
 *   RelayDO --RPC--> ChunkDO (presence authority for a slice of the world)
 *   ChunkDO --RPC deliver()--> every subscribed RelayDO (fan-out once per relay)
 *   RelayDO/ChunkDO --RPC--> CharacterDO (authoritative character state + outbox -> D1)
 */
import type {
  AccountKind,
  AccountView,
  ArenaBuild,
  ArenaMatch,
  ArenaStatus,
  ArenaTicket,
  ConfigResponse,
  EconomyErrorCode,
  FeatureFlag,
  MarketListing,
  NoticeInput,
  NoticesResponse,
  OrderView,
  Party,
  PassTrack,
  PassView,
  PaymentProviderId,
  PlotView,
  ProductPrice,
  ShopView,
  TradeView,
  VaultItem,
  VaultItemInput,
  AuthProvider,
  ChatMessage,
  CosmeticSlot,
  CosmeticsView,
  Currency,
  EntityId,
  EntityState,
  EntitlementView,
  GuildInfo,
  GuildRole,
  PoseUpdate,
  ReportReason,
  TilePos,
  UniversalItem,
  WalletView,
} from "@gamez/protocol";
import type { ReplicationBatch } from "@gamez/sync";

export interface Env {
  ASSETS: Fetcher;
  RELAY: DurableObjectNamespace<import("./do/relay.ts").RelayDO>;
  CHUNK: DurableObjectNamespace<import("./do/chunk.ts").ChunkDO>;
  CHARACTER: DurableObjectNamespace<import("./do/character.ts").CharacterDO>;
  INSTANCE: DurableObjectNamespace<import("./do/instance.ts").InstanceDO>;
  // ---- wave B (docs/design/wave-B.md)
  ACCOUNT: DurableObjectNamespace<import("./do/account.ts").AccountDO>;
  IDENTITY: DurableObjectNamespace<import("./do/identity.ts").IdentityDO>;
  CHAT: DurableObjectNamespace<import("./do/chat.ts").ChatChannelDO>;
  GUILD: DurableObjectNamespace<import("./do/guild.ts").GuildDO>;
  // ---- wave C (docs/design/wave-C.md)
  ESCROW: DurableObjectNamespace<import("./do/escrow.ts").EscrowDO>;
  MARKET: DurableObjectNamespace<import("./do/market.ts").MarketDO>;
  PLOTS: DurableObjectNamespace<import("./do/plots.ts").PlotAuctionDO>;
  SHOP: DurableObjectNamespace<import("./do/shop.ts").ShopDO>;
  ARENA: DurableObjectNamespace<import("./do/arena.ts").ArenaDO>;
  CONFIG: DurableObjectNamespace<import("./do/config.ts").ConfigDO>;
  DB: D1Database;
  SYNC_QUEUE: Queue<ReplicationBatch>;
  AUTH_SECRET: string;
  // Optional secrets and vars (docs/secrets.md). Absent = feature disabled or stubbed.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  /** "1": local stub OAuth provider even off localhost (never set in production). "0": never. */
  OAUTH_STUB?: string;
  /** Comma-separated account ids allowed on /api/admin/*. */
  ADMIN_ACCOUNT_IDS?: string;
  /** Workers AI binding for Llama Guard moderation (not bound by default; see docs/secrets.md). */
  AI?: WorkersAiLike;
  /** "llama-guard" (default when AI is bound) | "stub" | "off". */
  MODERATION?: string;
  // ---- wave C payments (docs/secrets.md; absent = provider disabled, stub on dev hosts)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  ASAAS_API_KEY?: string;
  /** Token Asaas sends in the "asaas-access-token" header of webhooks. */
  ASAAS_WEBHOOK_TOKEN?: string;
  /** "sandbox" (default) | "production". */
  ASAAS_ENV?: string;
  MERCADOPAGO_ACCESS_TOKEN?: string;
  MERCADOPAGO_WEBHOOK_SECRET?: string;
  /** "1": the stub payment provider even off dev hosts (never in production). "0": never. */
  PAYMENTS_STUB?: string;
  /** Public origin for provider redirects/webhooks (default: the request origin). */
  PUBLIC_ORIGIN?: string;
}

/** The part of the Workers AI binding the moderator uses. */
export interface WorkersAiLike {
  run(model: string, input: unknown): Promise<unknown>;
}

/** Game mode id; phase 0 only runs "classic". */
export type ModeId = string;

export interface CharacterRecord {
  /** "<accountId>:<mode>" — also the CharacterDO name and the entity id in the world. */
  id: string;
  accountId: string;
  mode: ModeId;
  name: string;
  appearance: string;
  pos: TilePos;
  createdAt: number;
  updatedAt: number;
}

/** RPC surface of CharacterDO. */
export interface CharacterApi {
  /** Loads the character, creating it at `spawn` with display `name` on first call. */
  getOrCreate(
    accountId: string,
    mode: ModeId,
    spawn: TilePos,
    name: string,
  ): Promise<CharacterRecord>;
  /** Persists the resting position (writes row + outbox in one transaction). */
  savePosition(pos: TilePos): Promise<void>;
}

/** RPC surface of ChunkDO. Name format: "<mode>:<cx>:<cy>"; phase 0 uses "classic:0:0". */
export interface ChunkApi {
  /**
   * Relay starts receiving deltas; returns the current full state. A relay
   * that lost its memory (cold start) passes `liveIds`, the characters it
   * still has sockets for; the chunk then drops any other avatar that joined
   * through that relay (stale after a restart or crash).
   */
  subscribe(relay: string, liveIds?: EntityId[]): Promise<{ seq: number; entities: EntityState[] }>;
  unsubscribe(relay: string): Promise<void>;
  /**
   * Puts a character's avatar into the chunk (or refreshes it) and returns its
   * state. `relay` is the relay holding the player's socket.
   */
  join(character: CharacterRecord, relay: string): Promise<EntityState>;
  leave(id: EntityId): Promise<void>;
  /**
   * Validates and starts a walk from the entity's current (interpolated)
   * tile to `target`. Broadcasts the new path. Persists the destination to
   * the CharacterDO once the walk ends.
   */
  moveTo(id: EntityId, target: TilePos): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Wave B: client-pose worlds (wave-B.md §7). Validates bounds and sanitises
 * appearance/tag, sets the avatar's walk (pathStartedAt = now) and broadcasts.
 * Rejected in server-path worlds ("wrong-world").
 */
export interface ChunkPoseApi {
  pose(id: EntityId, pose: PoseUpdate): Promise<{ ok: boolean; reason?: string }>;
}

/** RPC surface of RelayDO used by chunks. */
export interface RelayApi {
  deliver(chunkId: string, seq: number, upserts: EntityState[], removes: EntityId[]): Promise<void>;
}

/** Payload of the "character_summary" outbox records (projected to D1). */
export interface CharacterSummary {
  characterId: string;
  accountId: string;
  mode: ModeId;
  name: string;
  x: number;
  y: number;
}

/** Headers the Worker sets on the WebSocket upgrade it forwards to a RelayDO. */
export const RELAY_HEADERS = {
  accountId: "x-gamez-account-id",
  name: "x-gamez-name",
  relay: "x-gamez-relay",
  /** Wave B: presence world id (shared/worlds.ts); absent = "plaza". */
  world: "x-gamez-world",
} as const;

export const PHASE0_MODE: ModeId = "classic";
export const PHASE0_CHUNK = "classic:0:0";
export const WALK_SPEED = 4; // tiles per second

/**
 * InstanceDO: generic host for instanced modes (phase 1: "duel", "steps";
 * later dungeons/arenas). Name format: "<mode>:<accountId>" — one live
 * instance per player per mode; `join` with fresh=true replaces it.
 *
 * It loads the mode from the shared catalog (src/shared/catalog.ts) with the
 * kernel, persists the SimSnapshot plus lastSeq in its SQLite after every
 * successful action (one transaction), runs fixed-tick modes with a DO alarm,
 * and talks to clients over hibernatable WebSockets using the
 * InstanceClientMessage / InstanceServerMessage protocol.
 * Players may only act on instances they belong to; maxPlayers comes from
 * the mode's ModeSpec.instance (default 1).
 */
export const INSTANCE_HEADERS = {
  accountId: "x-gamez-account-id",
  name: "x-gamez-name",
  mode: "x-gamez-mode",
} as const;

// ===========================================================================
// Wave B contracts (docs/design/wave-B.md). Read that file first.
// ===========================================================================

/** Minimal SQLite access the DO logic classes need (DO: ctx.storage; tests: FakeSqlStorage). */
export interface SqlStore {
  readonly sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}

/** Wraps a DO's storage as a SqlStore. */
export function sqlStoreOf(storage: DurableObjectStorage): SqlStore {
  return { sql: storage.sql, transactionSync: (fn) => storage.transactionSync(fn) };
}

// ---- sessions (§3) ---------------------------------------------------------

/**
 * Verified token payload. Guest tokens from phase 0 have only accountId,
 * name and issuedAt (kind defaults to "guest", no sid). Registered sessions
 * carry `sid`, checked against AccountDO.checkSession on authenticate.
 */
export interface SessionIdentity {
  accountId: string;
  name: string;
  issuedAt: number;
  kind: AccountKind;
  /** Session id (registered accounts); null for guests. */
  sid: string | null;
}

// ---- IdentityDO (§3.2) -----------------------------------------------------

/**
 * Name: identityKey(provider, subject) = "<provider>:<subject>"; email
 * subjects are normalised (trim + lowercase). The single writer of "who owns
 * this login", so two accounts can never claim the same email or OAuth id.
 */
export interface IdentityRecord {
  provider: AuthProvider;
  subject: string;
  accountId: string;
  email: string | null;
  createdAt: number;
}

export type PasswordCheck =
  | { ok: true; accountId: string }
  | { ok: false; reason: "no_identity" | "bad_password" | "locked"; retryAfterMs?: number };

export interface IdentityApi {
  get(): Promise<IdentityRecord | null>;
  /**
   * Claims the identity for `accountId` unless already claimed. Returns the
   * owner either way (`created` false = it belonged to someone, maybe the same account).
   * `passwordHash` (email only) is stored with the claim.
   */
  claim(input: {
    provider: AuthProvider;
    subject: string;
    accountId: string;
    email: string | null;
    passwordHash: string | null;
  }): Promise<{ record: IdentityRecord; created: boolean }>;
  /**
   * Email identities: verifies `password` against the stored hash with
   * attempt limiting. ADR 0007: the lockout is per (login, client), where
   * `client` is the caller's network identity (the Worker passes
   * clientIp(request); the store hashes it before storing). One client's
   * failures never lock out another client. Absent = "unknown".
   */
  checkPassword(password: string, client?: string): Promise<PasswordCheck>;
}

export function identityKey(provider: AuthProvider, subject: string): string {
  return `${provider}:${provider === "email" ? subject.trim().toLowerCase() : subject}`;
}

// ---- AccountDO (§3.3) ------------------------------------------------------

/** Name: the accountId. Created lazily by ensure(). */
export interface AccountProfile {
  accountId: string;
  kind: AccountKind;
  displayName: string;
  createdAt: number;
  identities: { provider: AuthProvider; subject: string; email: string | null }[];
}

export interface SessionInfo {
  sid: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent: string;
}

/** A wallet change; idempotent by txId (a replay returns the first result). */
export interface WalletTx {
  txId: string;
  currency: Currency;
  /** Positive = credit, negative = debit. Integer. */
  amount: number;
  reason: string;
}

export type WalletTxResult =
  | { ok: true; balance: number; replayed: boolean }
  | { ok: false; code: "insufficient_funds" | "bad_tx"; balance: number }
  /**
   * ADR 0007: the txId was already applied with different parameters
   * (currency or amount). Nothing changed; never treat it as a replay.
   */
  | { ok: false; code: "conflict"; balance: number };

/** One entitlement grant (payment webhook, achievement, admin); idempotent by txId. */
export interface EntitlementGrant {
  txId: string;
  sku: string;
  source: string;
}

export interface GuildMembership {
  guildId: string;
  tag: string;
  role: GuildRole;
}

/** RPC surface of AccountDO (do/account.ts delegates to account/*.ts). */
export interface AccountApi {
  // profile and sessions — account/profile.ts (T-auth)
  ensure(input: { kind: AccountKind; displayName: string }): Promise<AccountProfile>;
  profile(): Promise<AccountProfile | null>;
  /** Profile + guild for GET /api/me. */
  view(): Promise<AccountView | null>;
  setDisplayName(name: string): Promise<AccountProfile>;
  /** Adds a login to this account and marks it registered. */
  addIdentity(identity: {
    provider: AuthProvider;
    subject: string;
    email: string | null;
  }): Promise<AccountProfile>;
  openSession(userAgent: string): Promise<SessionInfo>;
  /** True when `sid` is open (touches lastSeenAt at most once a minute). */
  checkSession(sid: string): Promise<boolean>;
  closeSession(sid: string): Promise<void>;
  // shared economy — account/economy.ts (T-economy)
  wallet(): Promise<WalletView>;
  applyWalletTx(tx: WalletTx): Promise<WalletTxResult>;
  stash(): Promise<UniversalItem[]>;
  stashAdd(txId: string, item: Omit<UniversalItem, "uid">): Promise<UniversalItem[]>;
  stashRemove(txId: string, uid: string, count: number): Promise<UniversalItem[]>;
  cosmetics(): Promise<CosmeticsView>;
  equipCosmetic(slot: CosmeticSlot, id: string | null): Promise<CosmeticsView>;
  grantEntitlement(
    grant: EntitlementGrant,
  ): Promise<{ granted: boolean; entitlement: EntitlementView }>;
  entitlements(): Promise<EntitlementView[]>;
  // social — account/social.ts (T-guilds)
  blocks(): Promise<string[]>;
  setBlocked(target: string, blocked: boolean): Promise<string[]>;
  guild(): Promise<GuildMembership | null>;
  /** Guild saga step 1: reserves the single guild slot for `opId`; fails if in another guild. */
  reserveGuild(
    opId: string,
    guildId: string,
  ): Promise<{ ok: boolean; current: GuildMembership | null }>;
  /** Step 2 (after GuildDO accepted): stores the membership. Idempotent. */
  confirmGuild(opId: string, membership: GuildMembership): Promise<void>;
  /** Undo of step 1, or leave: clears the slot if it is held by `guildId`. Idempotent. */
  releaseGuild(opId: string, guildId: string): Promise<void>;
}

// ---- GuildDO (§6) ----------------------------------------------------------

/** Name: the guild id (slug of its name, guildSlug()). */
export interface GuildApi {
  info(): Promise<GuildInfo | null>;
  create(input: {
    opId: string;
    name: string;
    tag: string;
    open: boolean;
    founder: { accountId: string; displayName: string };
  }): Promise<{ ok: true; guild: GuildInfo } | { ok: false; code: "name_taken" | "bad_request" }>;
  join(input: {
    opId: string;
    member: { accountId: string; displayName: string };
  }): Promise<
    { ok: true; guild: GuildInfo } | { ok: false; code: "not_found" | "full" | "closed" }
  >;
  /** Leader leaving promotes the longest-standing officer, else member; last one out disbands. */
  leave(input: { opId: string; accountId: string }): Promise<{ guild: GuildInfo | null }>;
  kick(input: {
    by: string;
    target: string;
  }): Promise<{ ok: true; guild: GuildInfo } | { ok: false; code: "forbidden" | "not_found" }>;
}

/** Guild id for a display name: lowercase, spaces -> "-", only a-z0-9-, 3..24 chars; null if invalid. */
export function guildSlug(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length >= 3 && slug.length <= 24 ? slug : null;
}

// ---- ChatChannelDO (§5) ----------------------------------------------------

/**
 * Name: the channel id ("global", "mode:<modeId>", "guild:<guildId>").
 * The Worker route /ws/chat authenticates, checks access (guild channels:
 * AccountDO.guild() must match) and forwards the upgrade with these headers.
 */
export const CHAT_HEADERS = {
  accountId: "x-gamez-account-id",
  name: "x-gamez-name",
  channel: "x-gamez-channel",
  kind: "x-gamez-account-kind",
  tag: "x-gamez-guild-tag",
} as const;

/** RPC surface of ChatChannelDO (admin tools, guild disband). */
export interface ChatChannelApi {
  mute(accountId: string, untilMs: number, reason: string): Promise<void>;
  hide(messageIds: string[], reason: string): Promise<void>;
  /** System notice to everyone in the channel. */
  notice(text: string): Promise<void>;
  recent(limit: number): Promise<ChatMessage[]>;
  /**
   * ADR 0007: closes every socket of `accountId` in this channel (guild kick
   * or leave) and returns how many were closed. Idempotent.
   */
  revoke(accountId: string, reason: string): Promise<number>;
}

// ---- D1 outbox payloads (§4; projections.ts maps them to columns) ----------

/**
 * Envelope the VerifiedHost wraps every ClientDrivenPolicy.reports() row in.
 * pk = `${instanceName}/${key}`, e.g. "classic:<accountId>/hero".
 */
export interface ReportEnvelope {
  accountId: string;
  displayName: string;
  mode: string;
  /** The instance state descends from an imported local save. */
  imported: boolean;
  key: string;
  data: Record<string, string | number | boolean | null>;
}

/** "account_summary" (AccountDO profile changes). pk = accountId. */
export interface AccountSummaryPayload {
  accountId: string;
  displayName: string;
  kind: AccountKind;
  createdAt: number;
}

/** "guild_index" (GuildDO). pk = guildId; delete = disbanded. */
export interface GuildIndexPayload {
  guildId: string;
  name: string;
  tag: string;
  open: boolean;
  memberCount: number;
  leaderId: string;
  createdAt: number;
}

/** "chat_report" (ChatChannelDO). pk = `${channel}/${messageId}/${reporterId}`. */
export interface ChatReportPayload {
  channel: string;
  messageId: string;
  reporterId: string;
  reportedId: string;
  reason: ReportReason;
  text: string;
  at: number;
  /** Llama Guard / stub verdict when known. */
  verdict: "safe" | "unsafe" | "unknown";
}

// ===========================================================================
// Wave C contracts (docs/design/wave-C.md). Read that file first.
// ===========================================================================

/** Result of every wave C DO mutation: never throws for a rule violation. */
export type EconResult<T> =
  | { ok: true; value: T; replayed?: boolean }
  | { ok: false; code: EconomyErrorCode; message: string };

/** Economy flow class of a wallet change, for telemetry (economy_ledger). */
export type EconomyFlow = "faucet" | "sink" | "transfer";

/**
 * Wave C: WalletTx gains `flow` (telemetry). Absent = "transfer". The reason
 * is "<group>:<detail>" (group = flowGroup(), e.g. "market.tax:classic:weapon/3").
 */
export interface WalletTxC extends WalletTx {
  flow?: EconomyFlow;
}

export type VaultPutResult =
  | { ok: true; item: VaultItem; replayed: boolean }
  | { ok: false; code: "vault_full" | "bad_item" }
  /** ADR 0007: the txId was already used for a different item. Nothing changed. */
  | { ok: false; code: "conflict" };

export type VaultTakeResult =
  | { ok: true; item: VaultItem; replayed: boolean }
  | { ok: false; code: "not_found" }
  /** ADR 0007: the txId was already used to take a different uid. Nothing changed. */
  | { ok: false; code: "conflict" };

/** Wave C order record kept by AccountDO (account/purchases.ts). */
export interface OrderRecord extends OrderView {
  accountId: string;
  providerRef: string | null;
}

/**
 * Wave C AccountDO RPCs (do/account.ts delegates):
 *   account/vault.ts + account/notices.ts (T-escrow), account/pass.ts (T-pass),
 *   account/purchases.ts (T-pay).
 */
export interface AccountApiC {
  // vault — the wave B stash table with wave C columns (VaultItem)
  vault(): Promise<VaultItem[]>;
  vaultGet(uid: string): Promise<VaultItem | null>;
  /** Idempotent by txId: a replay returns the first result (same uid). */
  vaultPut(txId: string, item: VaultItemInput): Promise<VaultPutResult>;
  /** Removes the whole stack `uid`; idempotent by txId (replay returns the removed item). */
  vaultTake(txId: string, uid: string): Promise<VaultTakeResult>;
  /** applyWalletTx with a telemetry flow (writes the economy_ledger + account_wallet outbox rows). */
  walletTx(tx: WalletTxC): Promise<WalletTxResult>;
  // notices
  /** Idempotent by notice.id (a second push is ignored). Keeps the newest NOTICES_MAX. */
  notify(notice: NoticeInput): Promise<void>;
  notices(sinceId: string | null): Promise<NoticesResponse>;
  markNoticesRead(upToId: string): Promise<number>;
  /** Trades this account takes part in (EscrowDO keeps the truth; this is the index). */
  linkTrade(tradeId: string, open: boolean): Promise<void>;
  openTrades(): Promise<string[]>;
  // battle pass (T-pass)
  /** Monotonic progress of a source (e.g. "classic:<worldSeed>"): adds max(0, total - last) xp. */
  seasonProgress(source: string, total: number): Promise<PassView>;
  /** One-off xp (arena win…), idempotent by txId. */
  addSeasonXp(txId: string, xp: number, reason: string): Promise<PassView>;
  pass(): Promise<PassView>;
  claimPassReward(tier: number, track: PassTrack): Promise<EconResult<PassView>>;
  // purchases (T-pay)
  createOrder(input: {
    orderId: string;
    sku: string;
    provider: PaymentProviderId;
    price: ProductPrice;
  }): Promise<OrderRecord>;
  /** Payment confirmed (verified webhook): grants the product once per orderId. */
  fulfillOrder(input: {
    orderId: string;
    providerRef: string | null;
    eventId: string;
  }): Promise<EconResult<OrderRecord>>;
  /** Refund/chargeback: revokes what can be revoked (gems debited down to 0, entitlements marked revoked). */
  refundOrder(input: { orderId: string; eventId: string }): Promise<EconResult<OrderRecord>>;
  orders(): Promise<OrderRecord[]>;
}

/**
 * Idempotent account operations for wave C DOs (economy/gateway.ts wraps
 * env.ACCOUNT). Every call is safe to retry with the same txId.
 * txIds: "<domain>:<object>:<step>", e.g. "mk:classic:weapon/3:fee",
 * "trade:<tradeId>:a:coin", "plot:<world>/<plot>:bid:<n>", <= 128 chars.
 */
export interface AccountGateway {
  wallet(accountId: string): Promise<WalletView>;
  walletTx(accountId: string, tx: WalletTxC): Promise<WalletTxResult>;
  vaultGet(accountId: string, uid: string): Promise<VaultItem | null>;
  vaultTake(accountId: string, txId: string, uid: string): Promise<VaultTakeResult>;
  vaultPut(accountId: string, txId: string, item: VaultItemInput): Promise<VaultPutResult>;
  notify(accountId: string, notice: NoticeInput): Promise<void>;
  addSeasonXp(accountId: string, txId: string, xp: number, reason: string): Promise<void>;
}

// ---- InstanceDO platform RPC (T-bridge) ------------------------------------

export interface InstancePlatformApi {
  /**
   * The verified hero reduced to an arena build (policy.platform.build plus
   * accountId/displayName/sourceHash), or null (no hero, mode without builds,
   * nothing verified yet). Loads the instance from storage when cold.
   */
  exportBuild(displayName: string): Promise<ArenaBuild | null>;
}

// ---- EscrowDO (T-escrow): direct trade --------------------------------------

/**
 * Name: the tradeId ("t" + 24 hex). Saga (wave-C.md §3.3): open -> offers ->
 * both accept the same [aVersion, bVersion] -> committing (custody: debit
 * coin+fee and take items from both, each step idempotent by txId) ->
 * deliver to the other side -> done; any custody failure refunds what was
 * taken -> failed. Every state change is persisted before calling out; the
 * alarm re-drives a "committing" trade after a crash. Expires after TRADE_TTL_MS.
 */
export interface EscrowApi {
  open(input: { tradeId: string; a: Party; b: Party }): Promise<EconResult<TradeView>>;
  view(accountId: string): Promise<TradeView | null>;
  offer(input: { accountId: string; coin: number; uids: string[] }): Promise<EconResult<TradeView>>;
  accept(input: { accountId: string; versions: [number, number] }): Promise<EconResult<TradeView>>;
  cancel(accountId: string): Promise<EconResult<TradeView>>;
}

// ---- MarketDO (T-market): auction house shard -------------------------------

/**
 * Name: the shard "<scope>:<category>" (marketShard()). Listings in custody:
 * the item leaves the seller's vault when listed. Outbox -> market_listing +
 * economy_sale (D1 search and price index). Alarm: expiries and saga retries.
 */
export interface MarketApi {
  list(input: {
    opId: string;
    seller: Party;
    uid: string;
    buyout: number | null;
    startBid: number | null;
    durationH: number;
  }): Promise<EconResult<MarketListing>>;
  bid(input: {
    opId: string;
    bidder: Party;
    listingId: string;
    amount: number;
  }): Promise<EconResult<MarketListing>>;
  buy(input: { opId: string; buyer: Party; listingId: string }): Promise<EconResult<MarketListing>>;
  cancel(input: {
    opId: string;
    accountId: string;
    listingId: string;
  }): Promise<EconResult<MarketListing>>;
  get(listingId: string): Promise<MarketListing | null>;
}

// ---- PlotAuctionDO + ShopDO (T-shops) ---------------------------------------

/**
 * PlotAuctionDO, name: the presence world id ("classic-town"). Owns the plot
 * lease cycle (auction -> leased -> grace -> repossessed -> auction), rent
 * collection (sink) and the shopkeeper fixtures it pushes to the world's
 * ChunkDO (ChunkFixtureApi.setFixtures("shops", …)).
 */
export interface PlotAuctionApi {
  plots(): Promise<PlotView[]>;
  bid(input: {
    opId: string;
    bidder: Party;
    plotId: string;
    amount: number;
  }): Promise<EconResult<PlotView>>;
  /** Called by ShopDO when its owner changes look/name (refreshes the fixture). */
  refreshFixture(plotId: string): Promise<void>;
  /** Dev hosts only (route checks isDevHost): moves this DO's clock forward and runs due work. */
  devAdvance(ms: number): Promise<PlotView[]>;
}

/** ShopDO, name: "<world>/<plotId>". Stock in custody, earnings held until claimed. */
export interface ShopApi {
  view(viewerId: string | null): Promise<ShopView | null>;
  /** PlotAuctionDO: a lease starts (idempotent by leaseId). */
  openLease(input: {
    leaseId: string;
    world: string;
    plotId: string;
    owner: Party;
    endsAt: number;
  }): Promise<void>;
  /** PlotAuctionDO: lease ended or repossessed — return stock to the owner's vault, credit earnings, close. */
  closeLease(input: { leaseId: string; reason: "ended" | "repossessed" }): Promise<void>;
  configure(input: {
    accountId: string;
    name?: string;
    appearance?: string;
    open?: boolean;
  }): Promise<EconResult<ShopView>>;
  stock(input: {
    opId: string;
    accountId: string;
    uid: string;
    price: number;
  }): Promise<EconResult<ShopView>>;
  unstock(input: {
    opId: string;
    accountId: string;
    entryId: string;
  }): Promise<EconResult<ShopView>>;
  buy(input: { opId: string; buyer: Party; entryId: string }): Promise<EconResult<ShopView>>;
  claim(input: { opId: string; accountId: string }): Promise<EconResult<ShopView>>;
  /** For the fixture: owner, name, appearance, open; null when no lease. */
  fixture(): Promise<{ owner: Party; name: string; appearance: string; open: boolean } | null>;
}

// ---- ChunkDO fixtures (T-scale) ---------------------------------------------

/**
 * Wave C: persistent world fixtures of a pose world (shopkeeper ghosts).
 * Replaces every fixture of `group` with `fixtures` (persisted in the chunk's
 * SQLite, part of subscribe() state, broadcast as upserts/removes). Fixture
 * ids must start with "<group>:" ("shops:p1"); kind "shopkeeper".
 */
export interface ChunkFixtureApi {
  setFixtures(group: string, fixtures: EntityState[]): Promise<void>;
}

// ---- ArenaDO (T-arena) ------------------------------------------------------

/**
 * Name: "<mode>:<seasonId>" (e.g. "classic:2026-s1"). Ghost pool (latest
 * build per account), ratings, matchmaking queue (tickets), match log,
 * rewards (coin faucet + season xp through AccountGateway), outbox ->
 * arena_rating (D1 ladder). The only place where players fight players.
 */
export interface ArenaApi {
  /** Stores/refreshes the caller's ghost build. */
  register(build: ArenaBuild): Promise<ArenaStatus>;
  status(accountId: string): Promise<ArenaStatus>;
  /** Registers `build` and queues a fight (idempotent by opId: same ticket). */
  enqueue(input: { opId: string; build: ArenaBuild }): Promise<EconResult<ArenaTicket>>;
  poll(input: { accountId: string; ticket: string }): Promise<ArenaTicket | null>;
  match(id: string): Promise<ArenaMatch | null>;
}

// ---- ConfigDO (T-admin) -----------------------------------------------------

/** Name: "global". Feature flags (kill switches) and content versions. */
export interface ConfigApi {
  config(): Promise<ConfigResponse>;
  setFlags(patch: Partial<Record<FeatureFlag, boolean>>, by: string): Promise<ConfigResponse>;
}

// ---- Payments (T-pay): server/payments/provider.ts --------------------------

/** What a verified webhook means (provider-specific parsing done). */
export interface VerifiedWebhook {
  /** Provider event id (idempotency of the webhook itself). */
  eventId: string;
  kind: "paid" | "refunded" | "ignored";
  /** Our order id and account, from the metadata/external reference we set at checkout. */
  orderId: string | null;
  accountId: string | null;
  providerRef: string | null;
}

// ---- D1 outbox payloads (projections.ts) ------------------------------------

/** "account_wallet" (AccountDO, every balance change). pk = accountId. */
export interface AccountWalletPayload {
  accountId: string;
  coin: number;
  gem: number;
  updatedAt: number;
}

/** "economy_ledger" (AccountDO, every applied non-replayed wallet tx). pk = `${accountId}/${txId}`. */
export interface EconomyLedgerPayload {
  accountId: string;
  txId: string;
  currency: "coin" | "gem";
  amount: number;
  flow: EconomyFlow;
  /** flowGroup(reason), e.g. "market.tax". */
  reasonGroup: string;
  reason: string;
  at: number;
}

/** "market_listing" (MarketDO). pk = listing id. Delete = purged (status rows stay as non-active). */
export interface MarketListingPayload {
  listing: MarketListing;
}

/** "economy_sale" (MarketDO, ShopDO, EscrowDO for coin+item trades omitted). pk = saleId. */
export interface EconomySalePayload {
  saleId: string;
  venue: "market" | "shop";
  scope: string;
  category: string;
  itemId: string;
  name: string;
  rarity: string;
  level: number;
  price: number;
  tax: number;
  sellerId: string;
  buyerId: string;
  at: number;
}

/** "shop_index" (PlotAuctionDO). pk = `${world}/${plotId}`. */
export interface ShopIndexPayload {
  plot: PlotView;
  /** Stock size, open flag (from the ShopDO when leased). */
  stockCount: number;
  open: boolean;
}

/** "arena_rating" (ArenaDO). pk = `${seasonId}/${accountId}`. */
export interface ArenaRatingPayload {
  seasonId: string;
  mode: string;
  accountId: string;
  displayName: string;
  classId: string;
  level: number;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  updatedAt: number;
}

/** "purchase" (AccountDO purchases). pk = orderId. */
export interface PurchasePayload {
  order: OrderRecord;
}

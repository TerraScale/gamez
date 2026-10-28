/**
 * Wave C wire types (docs/design/wave-C.md): account vault and bank, notices,
 * direct trade (EscrowDO), auction house (MarketDO), shop plots and player
 * shops (PlotAuctionDO, ShopDO), arena (ArenaDO), battle pass, store and
 * payments, feature flags and the admin economy dashboard.
 *
 * CONTRACT (architect). Shared by the Worker routes, the client platform SDK
 * (apps/game/src/client/platform), the shared UI (packages/ui-host) and
 * tools/e2e. Every mutating POST carries a client-generated `opId`
 * (isOpId()) so a retried request never applies twice.
 *
 * Money: "coin" (WalletView) is the only currency of trade, market, shops and
 * plots. Amounts are positive safe integers. Fees and taxes are sinks
 * (@gamez/economy fees.ts computes them; the server is the only one applying them).
 */
import type { CosmeticSlot, Currency, UniversalItem } from "./platform.ts";
import type { TilePos } from "./messages.ts";

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** Client-generated idempotency key: 8..64 chars of [A-Za-z0-9_-]. */
export function isOpId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v);
}

/** Error codes of every wave C endpoint (ApiError.error.code). */
export type EconomyErrorCode =
  | "bad_request"
  | "unauthorized"
  | "guest_forbidden"
  | "disabled"
  | "not_found"
  | "forbidden"
  | "insufficient_funds"
  | "not_tradable"
  | "not_eligible"
  | "vault_full"
  | "no_room"
  | "too_many"
  | "too_low"
  | "expired"
  | "closed"
  | "conflict"
  | "busy"
  | "not_in_town"
  | "wrong_origin"
  | "rate_limited"
  | "unavailable"
  | "internal";

/** Account a wave C DO acts for (the Worker fills it from the authenticated session). */
export interface Party {
  accountId: string;
  displayName: string;
}

// ---------------------------------------------------------------------------
// Items, vault, bank (AccountDO vault; hero <-> account via the verified socket)
// ---------------------------------------------------------------------------

/** Market/browse category. A mode maps its items onto these. */
export type ItemCategory =
  | "weapon"
  | "armor"
  | "jewelry"
  | "gem"
  | "material"
  | "consumable"
  | "cosmetic"
  | "other";

export const ITEM_CATEGORIES: readonly ItemCategory[] = [
  "weapon",
  "armor",
  "jewelry",
  "gem",
  "material",
  "consumable",
  "cosmetic",
  "other",
];

/** Display data of a vault item, computed by the producing mode (never trusted for rules except category/level). */
export interface ItemSummary {
  /** Display name, <= 60 chars. */
  name: string;
  /** Mode rarity id ("normal" | "magic" | "rare" | "set" | "unique" for classic; "common" otherwise). */
  rarity: string;
  /** Item level (classic ilvl); 0 when meaningless. */
  level: number;
  category: ItemCategory;
  /** Equip slot id when equipment ("weapon", "helm"…), else null. */
  slot: string | null;
  /** Logical art id (icon), e.g. "item.sword". Never a file path. */
  icon: string;
  /** Up to 8 tooltip lines ("+12 Strength"), each <= 60 chars. */
  lines: string[];
}

/**
 * An item held by the account (the wave B "stash" row plus wave C columns).
 * Legacy wave B rows read as universal=true, tradable=true, data=null and a
 * summary derived from itemId.
 */
export interface VaultItem extends UniversalItem {
  /** May be withdrawn into any mode (gold-like materials, cosmetics). Else only into `origin`. */
  universal: boolean;
  /** May be traded, listed or stocked in a shop (the mode's tradable policy hook decides at deposit). */
  tradable: boolean;
  summary: ItemSummary;
  /**
   * Opaque mode payload (JSON text, <= VAULT_ITEM_DATA_MAX chars) that lets
   * the origin mode recreate the exact item on withdraw (classic: the
   * ItemInstance without uid/tab). null for plain stackables.
   */
  data: string | null;
}

export type VaultItemInput = Omit<VaultItem, "uid">;

export const VAULT_MAX_ITEMS = 200;
export const VAULT_ITEM_DATA_MAX = 4096;

/** GET /api/account/vault */
export interface VaultResponse {
  items: VaultItem[];
  max: number;
}

/**
 * Bank operation between the hero of a client-driven mode and the account,
 * sent over the verified instance socket (protocol verified.ts "bank").
 * Town only (the mode decides what "town" means; classic: depth 0).
 */
export type BankOp =
  /** Hero gold -> account coin; the mode applies its bank fee (classic: 5 %, min 1). */
  | { kind: "depositGold"; gold: number }
  /** Account coin -> hero gold, 1:1, no fee. */
  | { kind: "withdrawCoin"; coin: number }
  /** A hero item (classic: ItemInstance.uid in the bag or the stash) -> vault. */
  | { kind: "depositItem"; ref: number }
  /** Vault item -> hero bag (universal items, or items whose origin is this mode). */
  | { kind: "withdrawItem"; uid: string };

export type BankResult =
  | {
      ok: true;
      /** Coin credited (deposits) or debited (withdraw), when any. */
      coin?: number;
      /** Gold removed (deposit) or added (withdraw) to the hero, when any. */
      gold?: number;
      /** The vault item created (depositItem) or removed (withdrawItem). */
      item?: VaultItem;
      /** Coin balance after the operation. */
      balance: number;
    }
  | { ok: false; code: EconomyErrorCode; message: string };

// ---------------------------------------------------------------------------
// Notices (AccountDO inbox: trade invites, sales, outbids, rent, arena)
// ---------------------------------------------------------------------------

export type NoticeKind =
  | "trade.invite"
  | "trade.done"
  | "trade.cancelled"
  | "market.sold"
  | "market.won"
  | "market.outbid"
  | "market.expired"
  | "shop.sold"
  | "shop.rent_due"
  | "shop.repossessed"
  | "shop.lease_ended"
  | "plot.won"
  | "plot.outbid"
  | "arena.defended"
  | "pass.tier"
  | "store.granted"
  | "system";

export interface Notice {
  /** Idempotency key chosen by the producer (e.g. "market:<listingId>:sold"). */
  id: string;
  at: number;
  kind: NoticeKind;
  /** Short human text, <= 140 chars. */
  text: string;
  /** Machine data for links (tradeId, listingId, plotId, matchId…). */
  data: Record<string, string | number | boolean | null>;
  read: boolean;
}

export type NoticeInput = Omit<Notice, "read" | "at"> & { at?: number };

/** GET /api/account/notices?since=<id> */
export interface NoticesResponse {
  notices: Notice[];
  unread: number;
}

export const NOTICES_MAX = 100;

// ---------------------------------------------------------------------------
// Direct trade (EscrowDO "<tradeId>", wave-C.md §3)
// ---------------------------------------------------------------------------

export type TradeSide = "a" | "b";
export type TradeStatus = "open" | "committing" | "done" | "cancelled" | "failed";

export interface TradeOffer {
  coin: number;
  /** Vault items offered (snapshots; custody is only taken at commit). */
  items: VaultItem[];
  /** Bumped on every change of this side's offer; accepts name the pair of versions they saw. */
  version: number;
}

export interface TradeView {
  id: string;
  /** a = the inviter. */
  a: Party;
  b: Party;
  offers: Record<TradeSide, TradeOffer>;
  /**
   * What each side accepted: the [aVersion, bVersion] pair it saw, or null.
   * The trade commits when both accepted the current pair.
   */
  accepted: Record<TradeSide, [number, number] | null>;
  status: TradeStatus;
  /** Why it failed / was cancelled ("insufficient_funds", "expired", "cancelled_by_a"…). */
  reason: string | null;
  /** Coin fee each side pays on the coin it sends (sink), per @gamez/economy tradeFee(). */
  fees: Record<TradeSide, number>;
  createdAt: number;
  expiresAt: number;
}

export const TRADE_MAX_ITEMS = 8;
export const TRADE_TTL_MS = 10 * 60_000;

/** POST /api/trade {opId, with: accountId} -> TradeView */
export interface TradeOpenRequest {
  opId: string;
  with: string;
}
/** POST /api/trade/:id/offer -> TradeView */
export interface TradeOfferRequest {
  coin: number;
  uids: string[];
}
/** POST /api/trade/:id/accept -> TradeView */
export interface TradeAcceptRequest {
  versions: [number, number];
}
/** GET /api/trade -> my open trades (both directions). */
export interface TradeListResponse {
  trades: TradeView[];
}

// ---------------------------------------------------------------------------
// Auction house (MarketDO per shard "<scope>:<category>", D1 search, wave-C.md §4)
// ---------------------------------------------------------------------------

/** "universal" for universal items, else the origin mode id (classic gear trades among classic players). */
export type MarketScope = string;

export type ListingStatus = "active" | "sold" | "expired" | "cancelled";

export interface MarketListing {
  /** "<shard>/<seq>", e.g. "classic:weapon/42". */
  id: string;
  shard: string;
  seller: Party;
  /** The item (data omitted). */
  item: Omit<VaultItem, "data" | "uid">;
  /** Instant-buy price, or null (auction only). */
  buyout: number | null;
  /** Minimum first bid, or null (buyout only). */
  startBid: number | null;
  topBid: number | null;
  topBidder: Party | null;
  bids: number;
  /** Listing fee paid (sink, never refunded). */
  fee: number;
  createdAt: number;
  endsAt: number;
  status: ListingStatus;
  /** Final price when sold. */
  soldFor: number | null;
}

/** GET /api/market/search */
export interface MarketSearchQuery {
  scope?: MarketScope;
  category?: ItemCategory;
  /** Name substring (case-insensitive), <= 40 chars. */
  q?: string;
  rarity?: string;
  minLevel?: number;
  maxLevel?: number;
  sort?: "price_asc" | "price_desc" | "ending" | "newest";
  /** 1..50, default 30. */
  limit?: number;
  offset?: number;
}

export interface MarketSearchResponse {
  listings: MarketListing[];
  /** False when the read model is not migrated (listings empty). */
  available: boolean;
}

/** POST /api/market/list -> MarketListing */
export interface MarketListRequest {
  opId: string;
  /** Vault uid. */
  uid: string;
  buyout: number | null;
  startBid: number | null;
  durationH: 12 | 24 | 48;
}
/** POST /api/market/bid -> MarketListing */
export interface MarketBidRequest {
  opId: string;
  listingId: string;
  amount: number;
}
/** POST /api/market/buy -> MarketListing ; POST /api/market/cancel -> MarketListing */
export interface MarketListingRequest {
  opId: string;
  listingId: string;
}
/** GET /api/market/mine (D1: display only) */
export interface MarketMineResponse {
  listings: MarketListing[];
  /** Listings where I am the top bidder. */
  bids: MarketListing[];
}

// ---------------------------------------------------------------------------
// Shop plots and player shops (PlotAuctionDO "<world>", ShopDO "<world>/<plotId>", §5)
// ---------------------------------------------------------------------------

export type PlotState = "auction" | "leased" | "grace";

export interface PlotAuction {
  startedAt: number;
  endsAt: number;
  minBid: number;
  topBid: number | null;
  topBidder: Party | null;
  bids: number;
}

export interface PlotLease {
  owner: Party;
  startedAt: number;
  endsAt: number;
  /** Coin per rent period (sink). */
  rent: number;
  /** Rent is paid up to here; the next charge happens at paidUntil. */
  paidUntil: number;
  /** Set while in grace (rent unpaid): repossession time. */
  graceUntil: number | null;
}

export interface PlotView {
  /** "p1".."p8". */
  id: string;
  world: string;
  /** Tile where the shopkeeper ghost stands. */
  pos: TilePos;
  state: PlotState;
  auction: PlotAuction | null;
  lease: PlotLease | null;
  /** The shop's display name while leased. */
  shopName: string | null;
}

export interface ShopEntry {
  entryId: string;
  item: Omit<VaultItem, "data">;
  price: number;
}

export interface ShopView {
  plotId: string;
  world: string;
  owner: Party;
  name: string;
  /** Ghost shopkeeper look: "unit.hero" or "unit.hero.<x>". */
  appearance: string;
  open: boolean;
  stock: ShopEntry[];
  /** Owner only (null for other viewers): unclaimed earnings after tax. */
  earnings: number | null;
  leaseEndsAt: number;
}

export const SHOP_MAX_STOCK = 24;

/** GET /api/shops?world= -> PlotsResponse */
export interface PlotsResponse {
  world: string;
  plots: PlotView[];
}
/** POST /api/shops/plots/bid {opId, world, plotId, amount} -> PlotView */
export interface PlotBidRequest {
  opId: string;
  world: string;
  plotId: string;
  amount: number;
}
/** POST /api/shops/:world/:plotId/configure -> ShopView */
export interface ShopConfigureRequest {
  name?: string;
  appearance?: string;
  open?: boolean;
}
/** POST /api/shops/:world/:plotId/stock -> ShopView */
export interface ShopStockRequest {
  opId: string;
  uid: string;
  price: number;
}
/** POST /api/shops/:world/:plotId/unstock {opId, entryId} | buy {opId, entryId} -> ShopView */
export interface ShopEntryRequest {
  opId: string;
  entryId: string;
}
/** POST /api/shops/:world/:plotId/claim {opId} -> ShopView */
export interface ShopClaimRequest {
  opId: string;
}

// ---------------------------------------------------------------------------
// Arena (ArenaDO "<mode>:<seasonId>", async PvP against ghosts, wave-C.md §6)
// ---------------------------------------------------------------------------

export type ArenaSkillKind = "strike" | "projectile" | "nova" | "heal" | "shield";

/** One skill of an arena build, already reduced to arena terms by the source mode. */
export interface ArenaSkill {
  /** Source skill id (for icons/names), e.g. "classic.skill.fireball". */
  id: string;
  name: string;
  kind: ArenaSkillKind;
  /** Percent of weapon damage (strike/projectile/nova), heal % of max hp, or shield % of max hp. 1..1000. */
  power: number;
  /** Ticks between uses (arena runs at ARENA_HZ). 1..400. */
  cooldown: number;
  /** Reach in tiles (strike 1..2, projectile/nova 2..8, heal/shield 0). */
  range: number;
}

/**
 * A hero reduced to arena stats. Produced from verified state by the mode's
 * ClientDrivenPolicy.platform.build() (classic: modules/classic/src/platform/build.ts).
 * Every number is a non-negative safe integer.
 */
export interface ArenaBuild {
  /** Source mode ("classic"). */
  mode: string;
  accountId: string;
  /** Hero name. */
  name: string;
  /** Account display name. */
  displayName: string;
  classId: string;
  level: number;
  /** Ghost look: "unit.hero" or "unit.hero.<x>". */
  appearance: string;
  maxHp: number;
  /** Weapon damage per hit. */
  dmgMin: number;
  dmgMax: number;
  /** Basic attacks per 10 s (e.g. 12 = 1.2/s). 1..100. */
  attackRate: number;
  /** Flat damage reduction before resist. */
  armor: number;
  /** Percent damage resisted, 0..75. */
  resist: number;
  /** Crit chance percent 0..75 (crits deal 150 %). */
  critPct: number;
  /** Tiles per second, 1..8. */
  moveSpeed: number;
  /** 0..4 skills, in priority order. */
  skills: ArenaSkill[];
  /** Gear score for matchmaking display; never used by the fight. */
  power: number;
  /** stableHash of the source state (provenance; logs only). */
  sourceHash: string;
}

export type ArenaWinner = "attacker" | "defender" | "draw";

export interface ArenaFighterResult {
  party: Party;
  classId: string;
  level: number;
  ratingBefore: number;
  ratingAfter: number;
  ghost: boolean;
}

export interface ArenaMatch {
  id: string;
  seasonId: string;
  at: number;
  attacker: ArenaFighterResult;
  defender: ArenaFighterResult;
  winner: ArenaWinner;
  /** Fight seed and both builds: the client re-runs @gamez/mode-arena's fight() for the replay. */
  seed: number;
  builds: { attacker: ArenaBuild; defender: ArenaBuild };
  ticks: number;
  /** contentHash of the arena mode that resolved the fight (a client with another hash shows the result without replay). */
  contentHash: string;
  /** Rewards credited to the attacker (coin faucet, season xp). */
  rewards: { coin: number; seasonXp: number };
}

export interface ArenaMatchSummary {
  id: string;
  at: number;
  opponent: Party;
  /** From the viewer's side. */
  result: "win" | "loss" | "draw";
  ratingDelta: number;
  /** True when the viewer was the defending ghost. */
  defended: boolean;
}

export interface ArenaStatus {
  seasonId: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  /** True when the viewer's build is in the ghost pool. */
  registered: boolean;
  fightsLeftToday: number;
  /** Set while a queue ticket is waiting. */
  ticket: string | null;
  recent: ArenaMatchSummary[];
}

/**
 * POST /api/arena/queue {opId} -> ArenaTicket ; GET /api/arena/queue/:ticket -> ArenaTicket
 *
 * Outcomes of a fight request are tickets, never HTTP errors: a request the
 * server understood answers 200, and a refusal by the rules is a ticket with
 * status "failed" and a reason ("limit" once fightsLeftToday is 0, "no_build",
 * "no_opponent"). HTTP errors are kept for transport-level problems (400 bad
 * opId, 401, 403 guest_forbidden, 503 disabled). Clients check `status`.
 */
export interface ArenaTicket {
  ticket: string;
  status: "waiting" | "matched" | "failed";
  /** When matched. */
  match: ArenaMatch | null;
  /** When failed ("no_build", "no_opponent", "limit"…). */
  reason: string | null;
}

export interface ArenaLadderRow {
  rank: number;
  accountId: string;
  displayName: string;
  classId: string;
  level: number;
  rating: number;
  wins: number;
  losses: number;
}

/** GET /api/arena/ladder?mode=classic&limit= (D1) */
export interface ArenaLadderResponse {
  seasonId: string;
  rows: ArenaLadderRow[];
  available: boolean;
}

// ---------------------------------------------------------------------------
// Battle pass (AccountDO pass state; season content in @gamez/economy, wave-C.md §7)
// ---------------------------------------------------------------------------

export type PassTrack = "free" | "premium";

export type PassReward =
  | { kind: "cosmetic"; sku: string; name: string; slot: CosmeticSlot }
  | { kind: "coin"; amount: number }
  | { kind: "title"; sku: string; name: string };

export interface PassTierView {
  tier: number;
  /** Cumulative season xp needed. */
  xp: number;
  free: PassReward | null;
  premium: PassReward | null;
}

export interface PassView {
  seasonId: string;
  name: string;
  startsAt: number;
  endsAt: number;
  xp: number;
  /** Highest tier reached (0 = none). */
  tier: number;
  premium: boolean;
  /** Entitlement sku that unlocks premium (sold in the store). */
  premiumSku: string;
  /** Gem price of POST /api/pass/premium (absent from older servers). */
  premiumGems?: number;
  tiers: PassTierView[];
  claimed: Record<PassTrack, number[]>;
}

/** POST /api/pass/claim -> PassView */
export interface PassClaimRequest {
  tier: number;
  track: PassTrack;
}

// ---------------------------------------------------------------------------
// Store and payments (PaymentProvider: Stripe, Asaas, Mercado Pago, stub; §8)
// ---------------------------------------------------------------------------

export type PaymentProviderId = "stripe" | "asaas" | "mercadopago" | "stub";
export type FiatCurrency = "USD" | "BRL" | "EUR";

export interface ProductPrice {
  currency: FiatCurrency;
  /** Minor units (cents / centavos). */
  amountMinor: number;
}

export interface Product {
  sku: string;
  name: string;
  description: string;
  kind: "gems" | "pass" | "cosmetic";
  prices: ProductPrice[];
  /** What a paid order grants: gems credited and entitlement skus. */
  grants: { gems: number; entitlements: string[] };
}

export interface PaymentProviderInfo {
  id: PaymentProviderId;
  enabled: boolean;
  /** Sandbox stub standing in (dev hosts only). */
  stub: boolean;
  currencies: FiatCurrency[];
  /** Payment methods shown to players ("card", "pix", "boleto"). */
  methods: string[];
}

/** GET /api/store?country= */
export interface StoreResponse {
  products: Product[];
  providers: PaymentProviderInfo[];
  /** Routing suggestion for the country (BR -> asaas/mercadopago, LatAm -> mercadopago, else stripe). */
  suggested: PaymentProviderId | null;
}

/** POST /api/store/checkout -> CheckoutResponse */
export interface CheckoutRequest {
  opId: string;
  sku: string;
  provider: PaymentProviderId;
  currency: FiatCurrency;
}

export interface CheckoutResponse {
  orderId: string;
  /** Where to send the browser (provider page or the local stub page). */
  url: string;
}

export type OrderStatus = "pending" | "paid" | "refunded" | "failed";

export interface OrderView {
  orderId: string;
  sku: string;
  provider: PaymentProviderId;
  price: ProductPrice;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}

/** GET /api/store/orders */
export interface OrdersResponse {
  orders: OrderView[];
}

// ---------------------------------------------------------------------------
// Config / feature flags (ConfigDO "global") and admin economy (§9)
// ---------------------------------------------------------------------------

export type FeatureFlag = "market" | "trade" | "shops" | "arena" | "pass" | "store" | "bank";

export const FEATURE_FLAGS: readonly FeatureFlag[] = [
  "bank",
  "market",
  "trade",
  "shops",
  "arena",
  "pass",
  "store",
];

/** GET /api/config (public, cacheable 30 s) */
export interface ConfigResponse {
  flags: Record<FeatureFlag, boolean>;
  /** Current season id (@gamez/economy currentSeason). */
  seasonId: string;
  serverTime: number;
}

/** POST /api/admin/flags {flags: Partial<…>} -> ConfigResponse */
export interface FlagsPatchRequest {
  flags: Partial<Record<FeatureFlag, boolean>>;
}

export interface EconomyFlowDay {
  /** "YYYY-MM-DD" (UTC). */
  day: string;
  /** Coin created, by reason prefix ("bank.deposit", "arena.reward", "pass.reward"). */
  faucets: Record<string, number>;
  /** Coin destroyed, by reason prefix ("market.fee", "market.tax", "trade.fee", "shop.rent", "plot.bid"…). */
  sinks: Record<string, number>;
}

export interface PriceIndexPoint {
  day: string;
  category: ItemCategory;
  /** Median sale price that day (market + shops). */
  median: number;
  volume: number;
}

/** GET /api/admin/economy?days=14 (D1 aggregates; admin only) */
export interface EconomyTelemetry {
  at: number;
  /** Sum of account balances (account_wallet). Custody (bids, escrow) is not included. */
  moneySupply: Record<Currency, number>;
  accounts: number;
  flows: EconomyFlowDay[];
  priceIndex: PriceIndexPoint[];
  market: { active: number; sold24h: number; volume24h: number };
  shops: { leased: number; auction: number; grace: number };
  purchases: { paid24h: number; revenueMinor24h: Partial<Record<FiatCurrency, number>> };
}

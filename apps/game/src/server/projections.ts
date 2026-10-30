import type { Projection, ProjectionMap, SqlValue } from "@gamez/sync";
import type {
  AccountActivityPayload,
  PassProgressPayload,
  AccountSummaryPayload,
  AccountWalletPayload,
  ArenaRatingPayload,
  EconomyLedgerPayload,
  EconomySalePayload,
  MarketListingPayload,
  PurchasePayload,
  ShopIndexPayload,
  CharacterSummary,
  ChatReportPayload,
  GuildIndexPayload,
  ReportEnvelope,
} from "./contracts.ts";

/**
 * D1 read-model projections (tables live in migrations/). CONTRACT (wave B):
 * table and column names are fixed by migrations 0002-0005; builders report
 * needed changes instead of editing (a new column needs a new migration).
 */
export const characterSummary: Projection<CharacterSummary> = {
  table: "character_summary",
  pkColumn: "character_id",
  toRow: (p) => ({
    account_id: p.accountId,
    mode: p.mode,
    name: p.name,
    x: p.x,
    y: p.y,
  }),
};

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const flag = (v: unknown): number => (v === true || v === 1 ? 1 : 0);

function envelopeColumns(p: ReportEnvelope): Record<string, SqlValue> {
  return {
    account_id: p.accountId,
    display_name: p.displayName,
    mode: p.mode,
    imported: p.imported ? 1 : 0,
  };
}

/**
 * Classic hero summary, from the classic ClientDrivenPolicy.reports() row
 * { table: "classic_hero", key: "hero", data: ClassicHeroReport }.
 */
export const classicHero: Projection<ReportEnvelope> = {
  table: "classic_hero",
  pkColumn: "id",
  toRow: (p) => ({
    ...envelopeColumns(p),
    hero_name: str(p.data.heroName),
    class_id: str(p.data.classId),
    level: num(p.data.level),
    xp: num(p.data.xp),
    deepest_depth: num(p.data.deepestDepth),
    rift_best_level: num(p.data.riftBestLevel),
    rift_best_score: num(p.data.riftBestScore),
    play_ticks: num(p.data.playTicks),
    kills: num(p.data.kills),
    deaths: num(p.data.deaths),
  }),
};

/** One rift run, from { table: "leaderboard_rift", key: "run:<n>", data: ClassicRiftReport }. */
export const leaderboardRift: Projection<ReportEnvelope> = {
  table: "leaderboard_rift",
  pkColumn: "id",
  toRow: (p) => ({
    ...envelopeColumns(p),
    hero_name: str(p.data.heroName),
    class_id: str(p.data.classId),
    hero_level: num(p.data.heroLevel),
    rift_level: num(p.data.riftLevel),
    score: num(p.data.score),
    ticks: num(p.data.ticks),
    deaths: num(p.data.deaths),
    completed: flag(p.data.completed),
    run: num(p.data.run),
    end_tick: num(p.data.endTick),
  }),
};

export const accountSummary: Projection<AccountSummaryPayload> = {
  table: "account_summary",
  pkColumn: "account_id",
  toRow: (p) => ({
    display_name: p.displayName,
    kind: p.kind,
    created_at: p.createdAt,
    registered_at: p.registeredAt ?? null,
  }),
};

/** One row per account per UTC day active (migration 0010; admin dashboard §6). */
export const accountActivity: Projection<AccountActivityPayload> = {
  table: "account_activity",
  pkColumn: "id",
  toRow: (p) => ({
    account_id: p.accountId,
    day: num(p.day),
    kind: p.kind,
    first_at: num(p.firstAt),
  }),
};

/** Battle pass progress per account and season (migration 0010; admin dashboard §6). */
export const passProgress: Projection<PassProgressPayload> = {
  table: "pass_progress",
  pkColumn: "id",
  toRow: (p) => ({
    account_id: p.accountId,
    season_id: p.seasonId,
    level: num(p.level),
    xp: num(p.xp),
    premium: flag(p.premium),
    premium_at: typeof p.premiumAt === "number" ? num(p.premiumAt) : null,
    updated_at: num(p.updatedAt),
  }),
};

export const guildIndex: Projection<GuildIndexPayload> = {
  table: "guild_index",
  pkColumn: "guild_id",
  toRow: (p) => ({
    name: p.name,
    tag: p.tag,
    open: p.open ? 1 : 0,
    member_count: p.memberCount,
    leader_id: p.leaderId,
    created_at: p.createdAt,
  }),
};

export const chatReport: Projection<ChatReportPayload> = {
  table: "chat_report",
  pkColumn: "id",
  toRow: (p) => ({
    channel: p.channel,
    message_id: p.messageId,
    reporter_id: p.reporterId,
    reported_id: p.reportedId,
    reason: p.reason,
    text: p.text,
    at: p.at,
    verdict: p.verdict,
  }),
};

// ---- wave C (docs/design/wave-C.md; migrations 0006-0009). CONTRACT (architect).

/** Sort price of a listing: buyout, else top bid, else start bid. */
function listingPrice(l: MarketListingPayload["listing"]): number {
  return l.buyout ?? l.topBid ?? l.startBid ?? 0;
}

export const marketListing: Projection<MarketListingPayload> = {
  table: "market_listing",
  pkColumn: "id",
  toRow: ({ listing: l }) => ({
    shard: l.shard,
    scope: l.shard.slice(0, l.shard.indexOf(":")),
    category: l.item.summary.category,
    seller_id: l.seller.accountId,
    seller_name: l.seller.displayName,
    item_id: l.item.itemId,
    name: l.item.summary.name,
    name_lower: l.item.summary.name.toLowerCase(),
    rarity: l.item.summary.rarity,
    level: num(l.item.summary.level),
    slot: l.item.summary.slot,
    icon: l.item.summary.icon,
    count: num(l.item.count),
    listing_json: JSON.stringify(l),
    buyout: l.buyout,
    start_bid: l.startBid,
    top_bid: l.topBid,
    top_bidder_id: l.topBidder?.accountId ?? null,
    price: num(listingPrice(l)),
    bids: num(l.bids),
    status: l.status,
    created_at: num(l.createdAt),
    ends_at: num(l.endsAt),
  }),
};

export const economySale: Projection<EconomySalePayload> = {
  table: "economy_sale",
  pkColumn: "id",
  toRow: (p) => ({
    venue: p.venue,
    scope: p.scope,
    category: p.category,
    item_id: p.itemId,
    name: p.name,
    rarity: p.rarity,
    level: num(p.level),
    price: num(p.price),
    tax: num(p.tax),
    seller_id: p.sellerId,
    buyer_id: p.buyerId,
    at: num(p.at),
  }),
};

export const shopIndex: Projection<ShopIndexPayload> = {
  table: "shop_index",
  pkColumn: "id",
  toRow: ({ plot, stockCount, open }) => ({
    world: plot.world,
    plot_id: plot.id,
    state: plot.state,
    owner_id: plot.lease?.owner.accountId ?? null,
    owner_name: plot.lease?.owner.displayName ?? null,
    shop_name: plot.shopName,
    rent: num(plot.lease?.rent ?? 0),
    lease_ends_at: num(plot.lease?.endsAt ?? 0),
    auction_ends_at: num(plot.auction?.endsAt ?? 0),
    top_bid: plot.auction?.topBid ?? null,
    stock_count: num(stockCount),
    open: open ? 1 : 0,
    plot_json: JSON.stringify(plot),
  }),
};

export const arenaRating: Projection<ArenaRatingPayload> = {
  table: "arena_rating",
  pkColumn: "id",
  toRow: (p) => ({
    season_id: p.seasonId,
    mode: p.mode,
    account_id: p.accountId,
    display_name: p.displayName,
    class_id: p.classId,
    level: num(p.level),
    rating: num(p.rating),
    wins: num(p.wins),
    losses: num(p.losses),
    draws: num(p.draws),
    updated_at: num(p.updatedAt),
  }),
};

export const accountWallet: Projection<AccountWalletPayload> = {
  table: "account_wallet",
  pkColumn: "account_id",
  toRow: (p) => ({ coin: num(p.coin), gem: num(p.gem), updated_at: num(p.updatedAt) }),
};

export const economyLedger: Projection<EconomyLedgerPayload> = {
  table: "economy_ledger",
  pkColumn: "id",
  toRow: (p) => ({
    account_id: p.accountId,
    tx_id: p.txId,
    currency: p.currency,
    amount: num(p.amount),
    flow: p.flow,
    reason_group: p.reasonGroup,
    reason: p.reason,
    at: num(p.at),
  }),
};

export const purchase: Projection<PurchasePayload> = {
  table: "purchase",
  pkColumn: "id",
  toRow: ({ order: o }) => ({
    account_id: o.accountId,
    sku: o.sku,
    provider: o.provider,
    currency: o.price.currency,
    amount_minor: num(o.price.amountMinor),
    status: o.status,
    provider_ref: o.providerRef,
    created_at: num(o.createdAt),
    updated_at: num(o.updatedAt),
    // Migration 0011. Older payloads (before the amount check) carry neither.
    paid_currency: o.paid?.currency ?? null,
    paid_minor: o.paid ? num(o.paid.amountMinor) : null,
    fail_reason: o.failReason ?? null,
  }),
};

export const projections: ProjectionMap = {
  [characterSummary.table]: characterSummary,
  [classicHero.table]: classicHero,
  [leaderboardRift.table]: leaderboardRift,
  [accountSummary.table]: accountSummary,
  [accountActivity.table]: accountActivity,
  [passProgress.table]: passProgress,
  [guildIndex.table]: guildIndex,
  [chatReport.table]: chatReport,
  // wave C
  [marketListing.table]: marketListing,
  [economySale.table]: economySale,
  [shopIndex.table]: shopIndex,
  [arenaRating.table]: arenaRating,
  [accountWallet.table]: accountWallet,
  [economyLedger.table]: economyLedger,
  [purchase.table]: purchase,
};

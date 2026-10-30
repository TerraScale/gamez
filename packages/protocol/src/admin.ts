/**
 * Admin dashboard and client telemetry wire shapes (docs/design/admin-dashboard.md).
 * CONTRACT (architect). Shared by the Worker (routes/admin-metrics.ts,
 * routes/telemetry.ts) and the React admin app (apps/game/src/client/admin).
 *
 * Conventions:
 * - Times are epoch ms (UTC). Buckets are `bucketMs` wide and start at `t`.
 * - Money is in minor units per fiat currency; coin/gem are integers.
 * - Every section response carries `sources`, so the UI can say where each
 *   number came from (D1 read model, Analytics Engine, the local stub, a live
 *   DO call) and flag the ones that failed. A failed source yields empty data,
 *   never an HTTP error.
 */
import type { FiatCurrency, PaymentProviderId } from "./economy.ts";

// ---------------------------------------------------------------------------
// Ranges, series, distributions
// ---------------------------------------------------------------------------

export type AdminBucket = "hour" | "day";

/** Parsed `?from=&to=&bucket=` (server clamps: at most 90 days, at most 400 buckets). */
export interface AdminRange {
  from: number;
  to: number;
  bucket: AdminBucket;
  bucketMs: number;
}

export interface TimePoint {
  /** Bucket start. */
  t: number;
  v: number;
}

/** One line/bar series. `key` is stable (colour slot, CSV column); `label` is for people. */
export interface Series {
  key: string;
  label: string;
  points: TimePoint[];
}

export interface DistBucket {
  /** Bucket label: "1-9", "rare", "Hellbat", "BR"… */
  label: string;
  value: number;
}

/** A bar chart / histogram / share. Buckets keep the server's order. */
export interface Distribution {
  key: string;
  label: string;
  buckets: DistBucket[];
}

export interface FunnelStep {
  label: string;
  value: number;
}

export interface Quantiles {
  p50: number;
  p95: number;
  /** Values the quantiles were computed from (after sampling weights). */
  n: number;
}

export type AdminSourceKind = "d1" | "ae" | "local" | "live";

export interface AdminSource {
  /** What was read, e.g. "account_activity", "http.request", "ChunkDO". */
  name: string;
  kind: AdminSourceKind;
  ok: boolean;
  note?: string;
}

/** Fields every section response has. */
export interface AdminSectionBase {
  at: number;
  range: AdminRange;
  sources: AdminSource[];
}

// ---------------------------------------------------------------------------
// GET /api/admin/overview
// ---------------------------------------------------------------------------

export interface AdminOverview extends AdminSectionBase {
  accounts: { total: number; guest: number; registered: number };
  dau: number;
  wau: number;
  mau: number;
  /** Distinct client sessions with a heartbeat in the last CONCURRENT_WINDOW_MS. */
  concurrent: number;
  revenueMinor24h: Partial<Record<FiatCurrency, number>>;
  /** 5xx share of requests in the last hour, 0..1. */
  errorRate1h: number;
  /** p95 sync lag (enqueue -> applied) in the last hour. */
  syncLagP95Ms: number;
  /** DAU per day of the range, from the first tracked day (activitySince) on. */
  activeSeries: Series[];
  /** "YYYY-MM-DD": first day with activity data (D1 account_activity); null when none. */
  activitySince?: string | null;
}

export const CONCURRENT_WINDOW_MS = 120_000;

// ---------------------------------------------------------------------------
// GET /api/admin/players
// ---------------------------------------------------------------------------

export interface RetentionCohort {
  /** Cohort day "YYYY-MM-DD" (account created, UTC). */
  day: string;
  size: number;
  /** Share 0..1 active exactly on day +1 / +7 / +30; null when that day is in the future or size is 0. */
  d1: number | null;
  d7: number | null;
  d30: number | null;
}

export interface AdminPlayers extends AdminSectionBase {
  accounts: { total: number; guest: number; registered: number };
  /** "new" (accounts created) and "registered" (guest upgrades / direct registrations) per bucket. */
  signups: Series[];
  /** "dau" per day; "wau"/"mau" trailing windows ending each day (from activitySince on). */
  active: Series[];
  /** "YYYY-MM-DD": first day with activity data (D1 account_activity); null when none. */
  activitySince?: string | null;
  retention: RetentionCohort[];
  sessions: {
    /** session.start per bucket. */
    perBucket: Series[];
    /** Session length in seconds (from session.end / last heartbeat). */
    lengthS: Quantiles;
    lengthHistogram: Distribution;
  };
  platforms: Distribution;
  devices: Distribution;
  countries: Distribution;
  continents: Distribution;
}

// ---------------------------------------------------------------------------
// GET /api/admin/gameplay?mode=classic
// ---------------------------------------------------------------------------

export type ControlSplit = { manual: number; auto: number; idle: number; offline: number };

export interface AdminGameplay extends AdminSectionBase {
  mode: string;
  heroes: {
    total: number;
    byClass: Distribution;
    /** Level bands "1-9", "10-19", … */
    byLevel: Distribution;
    byDeepestDepth: Distribution;
    deepestDepth: number;
    kills: number;
    deaths: number;
  };
  /** Hours played per control mode (sim time) in the range; offline = granted offline time. */
  playtimeHours: ControlSplit;
  playtimeSeries: Series[];
  kills: { byMonster: Distribution; byRarity: Distribution; series: Series[] };
  deaths: { byDepth: Distribution; byKiller: Distribution };
  bosses: {
    rows: { monster: string; spawned: number; killed: number; killRate: number }[];
  };
  quests: {
    funnel: FunnelStep[];
    rows: { quest: string; accepted: number; completed: number }[];
  };
  rifts: { runs: number; completed: number; scoreHistogram: Distribution; bestScore: number };
  achievements: Distribution;
  skills: Distribution;
  talents: Distribution;
  drops: { byRarity: Distribution; perKill: Distribution };
  offline: {
    grants: number;
    hours: number;
    kills: number;
    xp: number;
    gold: number;
    items: number;
    levels: number;
    series: Series[];
  };
  xpPerHourByBand: Distribution;
  /** Parties are not in the game yet: null. */
  party: { parties: number; avgSize: number } | null;
}

// ---------------------------------------------------------------------------
// GET /api/admin/economy/details (the wave C /api/admin/economy stays as is)
// ---------------------------------------------------------------------------

export interface AdminEconomyDetails extends AdminSectionBase {
  /** Hero gold earned per hour of play, by level band (classic sim tallies). */
  goldPerHourByBand: Distribution;
  market: {
    sales: number;
    volume: number;
    taxes: number;
    medianPrice: number;
    series: Series[];
    byCategory: Distribution;
    byRarity: Distribution;
  };
  trades: { count: number; fees: number; series: Series[] };
  shops: { rentPaid: number; sales: number; volume: number; byState: Distribution };
  gems: { bought: number; spent: number; supply: number; series: Series[] };
  arena: {
    rewardsCoin: number;
    matches: number;
    players: number;
    ratingHistogram: Distribution;
  };
  /** Faucets and sinks over the range, by reason group (coin). */
  faucets: Distribution;
  sinks: Distribution;
  /**
   * All-time coin reconciliation (not the range): supply = Σ account_wallet.coin;
   * faucets / sinks = Σ ledger faucet / -Σ ledger sink; transfersNet = Σ ledger
   * transfer (negative = coin in custody: open market bids, escrow). When the
   * ledger is complete, supply = faucets - sinks + transfersNet.
   */
  coinLedger?: { supply: number; faucets: number; sinks: number; transfersNet: number };
}

// ---------------------------------------------------------------------------
// GET /api/admin/monetization
// ---------------------------------------------------------------------------

export interface AdminMonetization extends AdminSectionBase {
  /** Paid revenue per currency, per provider ("stripe", "asaas", "mercadopago", "stub"). */
  revenueMinor: Record<FiatCurrency, Partial<Record<PaymentProviderId, number>>>;
  revenueSeries: Series[];
  purchases: { paid: number; refunded: number; pending: number; failed: number };
  bySku: { sku: string; paid: number; refunded: number; revenueMinor: number; currency: string }[];
  /** Distinct paying accounts in the range. */
  payers: number;
  /** Revenue / distinct active accounts, per currency (minor units). */
  arpuMinor: Partial<Record<FiatCurrency, number>>;
  /** Revenue / payers, per currency (minor units). */
  arppuMinor: Partial<Record<FiatCurrency, number>>;
  pass: { seasonId: string; players: number; premium: number; conversion: number };
}

// ---------------------------------------------------------------------------
// GET /api/admin/social
// ---------------------------------------------------------------------------

export interface AdminSocial extends AdminSectionBase {
  chat: { messages: number; blocked: number; series: Series[]; byChannel: Distribution };
  moderation: {
    open: number;
    reports: number;
    actions: Distribution;
    series: Series[];
  };
  guilds: { count: number; members: number; sizeHistogram: Distribution };
  /** Top 10 per board; `accountId` (admin-only) lets the UI open the player in lookup. */
  leaderboards: {
    level: AdminLeaderRow[];
    rift: AdminLeaderRow[];
    arena: AdminLeaderRow[];
  };
}

/** One admin leaderboard row (GET /api/admin/social). */
export interface AdminLeaderRow {
  name: string;
  classId: string;
  value: number;
  accountId?: string;
}

// ---------------------------------------------------------------------------
// GET /api/admin/tech
// ---------------------------------------------------------------------------

export interface RouteHealth {
  route: string;
  requests: number;
  errors5xx: number;
  errors4xx: number;
  p50Ms: number;
  p95Ms: number;
}

export interface AdminTech extends AdminSectionBase {
  requests: Series[];
  errors: Series[];
  routes: RouteHealth[];
  websockets: { opens: number; byKind: Distribution; durationS: Quantiles; series: Series[] };
  durableObjects: Distribution;
  verification: { segments: number; resyncs: number; byCode: Distribution; series: Series[] };
  sync: {
    batches: number;
    records: number;
    lagMs: Quantiles;
    applyMs: Quantiles;
    dead: number;
    retries: number;
    series: Series[];
  };
  d1: { queries: number; latencyMs: Quantiles; byLabel: Distribution };
  client: {
    fps: Quantiles;
    frameMsP95: Quantiles;
    loadMs: Quantiles;
    errors: { build: string; kind: string; messageKey: string; count: number }[];
    builds: Distribution;
    contentHashes: Distribution;
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/players/search?q=  and  GET /api/admin/players/<accountId>
// ---------------------------------------------------------------------------

export interface AdminPlayerRow {
  accountId: string;
  displayName: string;
  kind: string;
  createdAt: number;
  /** Last activity day start (account_activity), 0 when none. */
  lastActiveDay: number;
}

export interface AdminPlayerSearch {
  q: string;
  rows: AdminPlayerRow[];
  /** Opaque cursor for the next page; null at the end. */
  next: string | null;
}

export interface AdminPlayerDetail {
  at: number;
  account: AdminPlayerRow & { registeredAt: number | null };
  /** Live AccountDO wallet when reachable, else the D1 account_wallet row. */
  wallet: { coin: number; gem: number; source: AdminSourceKind };
  heroes: {
    mode: string;
    heroName: string;
    classId: string;
    level: number;
    deepestDepth: number;
    kills: number;
    deaths: number;
    playHours: number;
    updatedAt: number;
  }[];
  ledger: {
    at: number;
    currency: string;
    amount: number;
    flow: string;
    reason: string;
  }[];
  purchases: {
    id: string;
    sku: string;
    provider: string;
    currency: string;
    amountMinor: number;
    status: string;
    at: number;
    /** Why a "failed" order failed (paid amount/currency/provider did not match); null otherwise. */
    failReason: string | null;
  }[];
  reports: { against: number; open: number };
  guild: { guildId: string; name: string } | null;
  arena: { seasonId: string; rating: number; wins: number; losses: number } | null;
  /** Days active in the last 30. */
  activeDays30: number;
  /** Server events of this account in the range (AE index = accountId), by metric. */
  recent: Distribution;
  sources: AdminSource[];
}

// ---------------------------------------------------------------------------
// Tunables: numeric live config next to the feature flags (ConfigDO "global")
// GET /api/admin/tunables, POST /api/admin/tunables {values: {key: number}}
// ---------------------------------------------------------------------------

export interface TunableSpec {
  key: string;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit: string;
}

/**
 * Registry of tunables. Readers clamp to [min, max] and fall back to
 * `default` when ConfigDO is unreachable (fail-open like the flags).
 * `classic.offlineXpPct`: XP earned while offline/idle-auto-killing, as a
 * percent of the normal XP (design default 20). The classic offline grant
 * reads it (wiring: docs/design/admin-dashboard.md §11).
 */
export const TUNABLES: readonly TunableSpec[] = [
  {
    key: "classic.offlineXpPct",
    label: "Offline XP",
    description: "XP the hero earns while offline, as a percent of normal XP.",
    min: 0,
    max: 100,
    step: 1,
    default: 20,
    unit: "%",
  },
];

export type TunableKey = (typeof TUNABLES)[number]["key"];

export interface TunablesResponse {
  values: Record<string, number>;
  specs: readonly TunableSpec[];
  audit: { key: string; value: number; by: string; at: number }[];
}

export interface TunablesPatchRequest {
  values: Record<string, number>;
}

// ---------------------------------------------------------------------------
// POST /api/telemetry (client -> server; public, sampled, rate-limited, no PII)
// ---------------------------------------------------------------------------

export type ClientPlatform = "web" | "pwa" | "ios" | "android";
export type ClientDevice = "mobile" | "tablet" | "desktop";

export type TelemetryEvent =
  | {
      k: "session.start";
      platform: ClientPlatform;
      device: ClientDevice;
      /** Navigation start -> app ready, ms. */
      loadMs: number;
    }
  | { k: "session.heartbeat"; elapsedS: number; mode: string; visible: boolean }
  | { k: "session.end"; elapsedS: number; mode: string }
  | {
      k: "perf";
      mode: string;
      fpsP50: number;
      fpsP95: number;
      frameMsP95: number;
      samples: number;
      /** performance.memory (Chromium only), MB; 0 when unknown. */
      heapMb: number;
    }
  | {
      k: "error";
      kind: "error" | "unhandledrejection" | "render";
      /** Message with digits/ids stripped, at most 120 chars (TELEMETRY_LIMITS). */
      message: string;
    };

export interface TelemetryBatch {
  v: 1;
  /** Random per page load (crypto.randomUUID), never an account id. */
  sid: string;
  /** Client build id (import.meta.env / package version). */
  build: string;
  /** contentHash of the mode the player is in, "" outside a mode. */
  contentHash: string;
  events: TelemetryEvent[];
}

export const TELEMETRY_LIMITS = {
  maxEvents: 20,
  maxBodyBytes: 8 * 1024,
  maxMessageChars: 120,
  /** Client: share of sessions that send perf events (session/error events are never sampled). */
  perfSampleRate: 0.25,
  heartbeatMs: 60_000,
  /**
   * Server: per-IP token bucket (requests). A client sends about one batch a
   * minute, so 120/min leaves room for ~100 players behind one carrier NAT.
   */
  ipBurst: 40,
  ipPerMinute: 120,
} as const;

/** Client build ids accepted by /api/telemetry; anything else is stored as "other". */
export const TELEMETRY_BUILD_RE = /^[A-Za-z0-9._+-]{1,40}$/;

/**
 * Scrubs a client error message so no personal data reaches analytics. Used by
 * the client before sending and again by the server (which must not trust the
 * client): URLs become `<url>`, e-mail addresses `<email>`, tokens/ids (6+
 * chars with letters and 2+ digits, or 8+ hex chars) `<id>`, digit runs `#`,
 * whitespace collapses, and the result is cut to TELEMETRY_LIMITS.maxMessageChars.
 */
export function scrubTelemetryMessage(input: string): string {
  return input
    .slice(0, 1000)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/[^\s@<>()"'`]+@[^\s@<>()"'`]+\.[a-z]{2,}/gi, "<email>")
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b(?=(?:[A-Za-z_-]*[0-9]){2})(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{6,}\b/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TELEMETRY_LIMITS.maxMessageChars);
}

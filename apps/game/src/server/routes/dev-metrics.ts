/**
 * POST /api/dev/admin/seed-metrics?days=7[&reset=1] (dev hosts only, admins
 * only): writes deterministic synthetic analytics points into the LOCAL stub
 * (MetricsDO "local") so every AE-backed chart has shape in dev
 * (docs/design/admin-dashboard.md §4.4). OWNER: T-analytics-core.
 *
 * Never touches Analytics Engine or D1. Points come from a fixed-seed LCG,
 * cover every metric in schema.ts, use real classic registry ids, carry
 * build = "seed" where the schema has a build, and an index starting with
 * "seed" (so reset=1 deletes earlier seeds only, never real dev points).
 * The stub keeps 14 days (LOCAL_LIMITS.keepMs): older seeded days are pruned
 * on ingest. Times depend on the request time; values do not.
 */
import { ITEM_RARITIES, KIND, type MonsterProto } from "@gamez/mode-classic";
import { requireAdmin } from "../admin/auth.ts";
import {
  METRICS,
  toStoredPoint,
  type BlobsOf,
  type DoublesOf,
  type MetricName,
  type StoredPoint,
} from "../analytics/schema.ts";
import { LOCAL_LIMITS } from "../analytics/types.ts";
import { LOCAL_METRICS_NAME } from "../analytics/query-local.ts";
import { apiError, isDevHost, json } from "../http.ts";
import { loadedMode } from "../instance/modes.ts";
import type { RouteHandler } from "./types.ts";

export const SEED_PATH = "/api/dev/admin/seed-metrics";
export const SEED_SEED = 0x5eed_2026;
export const SEED_BUILD = "seed";
export const SEED_DAYS_DEFAULT = 7;
export const SEED_DAYS_MAX = 30;
/** Points per ingest RPC. */
export const SEED_CHUNK = 1000;

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Real classic ids the seeder draws from (read from the loaded registry). */
export interface SeedIds {
  contentHash: string;
  classes: string[];
  monsters: string[];
  bosses: { id: string; depth: number }[];
  quests: string[];
  achievements: string[];
  skills: string[];
  talents: string[];
  itemRarities: string[];
}

/** Ids from the classic registry (throws when the catalog has no classic mode). */
export function classicSeedIds(): SeedIds {
  const loaded = loadedMode("classic");
  if (!loaded) throw new Error("seed: classic mode not in the catalog");
  const reg = loaded.registry;
  const ids = (kind: string) => reg.all<object>(kind).map(([id]) => id);
  const monsters = reg.all<MonsterProto>(KIND.monster);
  return {
    contentHash: loaded.contentHash,
    classes: ids(KIND.class),
    monsters: monsters.filter(([, m]) => !m.boss).map(([id]) => id),
    bosses: monsters.flatMap(([id, m]) => (m.boss ? [{ id, depth: m.boss.depth }] : [])),
    quests: ids(KIND.quest),
    achievements: ids(KIND.achievement),
    skills: ids(KIND.skill).filter((id) => id.startsWith("classic.skill.")),
    talents: ids(KIND.talent),
    itemRarities: [...ITEM_RARITIES],
  };
}

/** Deterministic LCG (Numerical Recipes constants), floats in [0, 1). */
export class Lcg {
  #s: number;
  constructor(seed: number) {
    this.#s = seed >>> 0;
  }
  next(): number {
    this.#s = (Math.imul(this.#s, 1664525) + 1013904223) >>> 0;
    return this.#s / 4_294_967_296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  /** Picks from [value, weight] pairs. */
  weighted<T>(xs: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of xs) total += w;
    let r = this.next() * total;
    for (const [v, w] of xs) {
      r -= w;
      if (r < 0) return v;
    }
    return xs[xs.length - 1]![0];
  }
}

/** Same labels as classic levelBand() and admin LEVEL_BANDS. */
export function seedLevelBand(level: number): string {
  if (level >= 90) return "90+";
  if (level < 10) return "1-9";
  const lo = Math.floor(level / 10) * 10;
  return `${lo}-${lo + 9}`;
}

/** Session length band (schema.ts client.session lengthBand). */
export function lengthBand(elapsedS: number): string {
  if (elapsedS < 60) return "<1m";
  if (elapsedS < 300) return "1-5m";
  if (elapsedS < 900) return "5-15m";
  if (elapsedS < 1800) return "15-30m";
  if (elapsedS < 3600) return "30-60m";
  if (elapsedS < 7200) return "1-2h";
  return "2h+";
}

const ROUTES: readonly (readonly [string, string, number])[] = [
  // route, method, weight
  ["/api/me", "GET", 22],
  ["/api/config", "GET", 14],
  ["/api/telemetry", "POST", 12],
  ["/ws/instance", "GET", 8],
  ["/ws", "GET", 6],
  ["/ws/chat", "GET", 4],
  ["/api/guest", "POST", 5],
  ["/api/market/listings", "GET", 6],
  ["/api/market/listings/:id", "POST", 2],
  ["/api/leaderboards", "GET", 5],
  ["/api/account/wallet", "GET", 6],
  ["/api/admin/overview", "GET", 1],
  ["/api/admin/players/:id", "GET", 1],
  ["/api/pay/webhook/:provider", "POST", 1],
  ["/api/other", "GET", 2],
];
const STATUSES: readonly (readonly [number, number])[] = [
  [200, 84],
  [204, 4],
  [304, 3],
  [400, 2],
  [401, 3],
  [404, 2],
  [429, 1],
  [500, 0.6],
  [503, 0.4],
];
const GEO: readonly (readonly [string, string, number])[] = [
  ["US", "NA", 26],
  ["BR", "SA", 18],
  ["DE", "EU", 9],
  ["GB", "EU", 7],
  ["FR", "EU", 5],
  ["IN", "AS", 8],
  ["JP", "AS", 5],
  ["CA", "NA", 5],
  ["MX", "NA", 5],
  ["AU", "OC", 3],
  ["ZA", "AF", 2],
  ["XX", "XX", 1],
];
const PLATFORMS: readonly (readonly [string, number])[] = [
  ["web", 55],
  ["pwa", 15],
  ["ios", 15],
  ["android", 15],
];
const MODES: readonly (readonly [string, number])[] = [
  ["classic", 82],
  ["steps", 10],
  ["duel", 8],
];
const DO_CLASSES = [
  "RelayDO",
  "ChunkDO",
  "InstanceDO",
  "CharacterDO",
  "AccountDO",
  "ChatChannelDO",
  "GuildDO",
  "MarketDO",
  "ConfigDO",
] as const;
const SYNC_SOURCES = ["account", "character", "market", "guild", "shop", "arena", "chat"] as const;
const D1_LABELS = [
  "admin.accounts",
  "admin.activity",
  "admin.heroes",
  "admin.purchases",
  "sync.apply",
] as const;
const RESYNC_CODES = ["hash_mismatch", "too_fast", "gap", "input_rejected", "bad_segment"] as const;
const ERROR_KEYS = [
  "TypeError: Cannot read properties of undefined (reading '#')",
  "WebGL context lost",
  "Failed to fetch dynamically imported module",
  "ResizeObserver loop completed with undelivered notifications",
  "NetworkError when attempting to fetch resource.",
] as const;
const CONTROLS: readonly (readonly [string, number])[] = [
  ["manual", 40],
  ["auto", 35],
  ["idle", 25],
];

interface SeedAccount {
  index: string;
  level: number;
  classId: string;
  depth: number;
}

export interface SeedOptions {
  now: number;
  days: number;
  ids: SeedIds;
  seed?: number;
}

/** Every synthetic point for the last `days` days ending at `now` (pure, deterministic). */
export function seedPoints(opts: SeedOptions): StoredPoint[] {
  const { now, ids } = opts;
  const days = clampDays(opts.days);
  const rng = new Lcg(opts.seed ?? SEED_SEED);
  const out: StoredPoint[] = [];
  const push = <M extends MetricName>(
    metric: M,
    t: number,
    blobs: BlobsOf<M>,
    doubles: DoublesOf<M>,
    index: string,
    sample = 1,
  ): void => {
    const p = toStoredPoint(metric, blobs, doubles, index, t);
    p.sample = Math.max(1, Math.floor(sample));
    out.push(p);
  };

  const accounts: SeedAccount[] = Array.from({ length: 24 }, (_, i) => {
    const level = Math.min(95, 1 + Math.floor(rng.next() ** 1.6 * 95));
    return {
      index: `seed-acc-${String(i + 1).padStart(3, "0")}`,
      level,
      classId: rng.pick(ids.classes.length > 0 ? ids.classes : ["classic.warrior"]),
      depth: Math.max(1, Math.min(30, Math.round(level / 3) + rng.int(-2, 2))),
    };
  });
  const monsters = ids.monsters.length > 0 ? ids.monsters : ["unknown"];

  const hours = days * 24;
  const end = Math.floor(now / HOUR) * HOUR;
  let sessionNo = 0;

  for (let h = hours - 1; h >= 0; h--) {
    const base = end - h * HOUR;
    const span = Math.max(1, Math.min(HOUR, now - base));
    const at = (): number => base + Math.floor(rng.next() * span);
    const hod = new Date(base).getUTCHours();
    // Diurnal curve peaking around 16:00 UTC, plus slow growth across the range.
    const diurnal = 0.35 + 0.65 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (hod - 4)) / 24));
    const growth = 0.75 + 0.25 * ((hours - h) / hours);
    const act = diurnal * growth;
    const n = (k: number): number => Math.max(0, Math.round(k * act * (0.8 + 0.4 * rng.next())));

    // ---- http.request
    for (let i = 0; i < n(10); i++) {
      const [route, method] = rng.weighted(
        ROUTES.map((r) => [[r[0], r[1]] as const, r[2]] as const),
      );
      const upgrade = route.startsWith("/ws");
      const status = upgrade ? (rng.chance(0.97) ? 101 : 401) : rng.weighted(STATUSES);
      const statusClass = status === 101 ? "101" : `${Math.floor(status / 100)}xx`;
      const [country] = rng.weighted(GEO.map((g) => [g, g[2]] as const));
      const ms = upgrade ? rng.int(2, 25) : Math.round(4 + rng.next() ** 3 * 380);
      push(
        "http.request",
        at(),
        { route, method, statusClass, country },
        { ms, status },
        "seed",
        rng.int(5, 30),
      );
    }

    // ---- websockets
    for (let i = 0; i < n(4); i++) {
      const kind = rng.weighted([
        ["presence", 35],
        ["instance", 45],
        ["chat", 20],
      ] as const);
      const mode = kind === "chat" ? "" : rng.weighted(MODES);
      const sample = rng.int(1, 4);
      push("ws.open", at(), { kind, mode }, {}, "seed", sample);
      push(
        "ws.close",
        at(),
        {
          kind,
          mode,
          code: rng.weighted([
            ["1000", 60],
            ["1001", 30],
            ["1006", 10],
          ] as const),
        },
        { durationS: Math.round(20 + rng.next() ** 2 * 5400) },
        "seed",
        sample,
      );
    }

    // ---- do.active: one point per class per hour, weight = active DO-slots
    for (const cls of DO_CLASSES) {
      const slots = Math.max(1, Math.round((cls === "ConfigDO" ? 6 : rng.int(2, 40)) * act));
      push("do.active", at(), { class: cls }, {}, `seed-do-${cls}`, slots);
    }

    // ---- sync.batch + d1.query
    for (let i = 0; i < n(4); i++) {
      const outcome = rng.weighted([
        ["ok", 95],
        ["retry", 4],
        ["dead", 0.4],
      ] as const);
      push(
        "sync.batch",
        at(),
        { source: rng.pick(SYNC_SOURCES), outcome },
        {
          records: rng.int(1, 60),
          lagMs: Math.round(40 + rng.next() ** 3 * (outcome === "ok" ? 2500 : 30_000)),
          applyMs: rng.int(3, 90),
          attempts: outcome === "ok" ? 1 : outcome === "retry" ? rng.int(2, 5) : 10,
        },
        "seed",
        rng.int(1, 5),
      );
    }
    for (let i = 0; i < n(3); i++) {
      push(
        "d1.query",
        at(),
        { label: rng.pick(D1_LABELS), outcome: rng.chance(0.99) ? "ok" : "error" },
        { ms: Math.round(1 + rng.next() ** 2 * 60), rows: rng.int(0, 400) },
        "seed",
        rng.int(1, 6),
      );
    }

    // ---- verification (verified play of a few accounts)
    for (let i = 0; i < n(3); i++) {
      const acc = rng.pick(accounts);
      const ok = rng.chance(0.97);
      const code = ok ? "ok" : rng.pick(RESYNC_CODES);
      push(
        "verify.segment",
        at(),
        { mode: "classic", outcome: code },
        { ticks: rng.int(100, 600), costMs: Math.round(1 + rng.next() * 14) },
        acc.index,
        rng.int(10, 40),
      );
      if (!ok) push("verify.resync", at(), { mode: "classic", code }, {}, acc.index);
    }

    // ---- sim.tally: one or two accounts flush their counters this hour
    for (let a = 0; a < Math.max(1, n(2)); a++) {
      const acc = rng.pick(accounts);
      if (rng.chance(0.04) && acc.level < 95) acc.level++;
      const band = seedLevelBand(acc.level);
      const t = at();
      const tally = (metric: string, k1: string, k2: string, amount: number): void => {
        if (amount > 0)
          push("sim.tally", t, { mode: "classic", metric, k1, k2 }, { amount }, acc.index);
      };
      const control = rng.weighted(CONTROLS);
      const playMs = rng.int(5, 30) * 60_000;
      tally("play.ms", control, band, playMs);
      tally("sim.ms", control, band, Math.round(playMs * (0.97 + rng.next() * 0.03)));
      let kills = 0;
      for (let i = 0; i < 3; i++) {
        const k = rng.int(4, 40);
        kills += k;
        tally(
          "kill",
          rng.pick(monsters),
          rng.weighted([
            ["normal", 80],
            ["champion", 12],
            ["unique", 6],
            ["minion", 2],
          ] as const),
          k,
        );
      }
      tally("xp", band, "kill", kills * (8 + acc.level * 6));
      tally("gold", band, "loot", kills * rng.int(2, 6 + acc.level));
      if (rng.chance(0.3)) tally("gold", band, "vendor", rng.int(20, 400));
      if (rng.chance(0.3)) {
        const depth = rng.chance(0.08) ? "town" : acc.depth > 20 ? "21+" : String(acc.depth);
        tally("death", depth, rng.chance(0.9) ? rng.pick(monsters) : "unknown", 1);
      }
      if (ids.bosses.length > 0 && rng.chance(0.25)) {
        const boss = rng.pick(ids.bosses);
        tally("boss.spawned", boss.id, String(boss.depth), 1);
        if (rng.chance(0.55)) tally("boss.killed", boss.id, String(boss.depth), 1);
      }
      if (ids.quests.length > 0 && rng.chance(0.45)) {
        const quest = rng.pick(ids.quests);
        tally("quest.accepted", quest, "", 1);
        if (rng.chance(0.72)) {
          tally("quest.done", quest, "", 1);
          if (rng.chance(0.88)) {
            tally("quest.completed", quest, "", 1);
            tally("xp", band, "quest", 100 + acc.level * 40);
            tally("gold", band, "quest", 50 + acc.level * 12);
          }
        }
      }
      if (rng.chance(0.08)) tally("level", band, acc.classId, 1);
      for (let i = 0; i < 3; i++) {
        const kind = rng.weighted([
          ["item", 60],
          ["gold", 30],
          ["potion", 10],
        ] as const);
        const rarity =
          kind === "item"
            ? rng.weighted(
                ids.itemRarities.map(
                  (r) =>
                    [
                      r,
                      (
                        { normal: 62, magic: 28, rare: 8, set: 1.2, unique: 0.8 } as Record<
                          string,
                          number
                        >
                      )[r] ?? 1,
                    ] as const,
                ),
              )
            : "normal";
        tally(
          "drop",
          rarity,
          kind,
          Math.max(1, Math.round(kills * (kind === "item" ? 0.25 : 0.15))),
        );
      }
      if (ids.achievements.length > 0 && rng.chance(0.15)) {
        tally("achievement", rng.pick(ids.achievements), "", 1);
      }
      if (ids.skills.length > 0) {
        for (let i = 0; i < 3; i++) tally("cast", rng.pick(ids.skills), "", rng.int(10, 120));
      }
      if (ids.talents.length > 0 && rng.chance(0.1)) tally("talent", rng.pick(ids.talents), "", 1);
      if (rng.chance(0.1)) {
        tally("rift", rng.chance(0.65) ? "completed" : "failed", seedLevelBand(rng.int(1, 60)), 1);
      }
      if (rng.chance(0.08)) tally("gem", rng.chance(0.6) ? "socketed" : "combined", "", 1);
    }

    // ---- offline grants
    if (rng.chance(0.3 * act + 0.05)) {
      const acc = rng.pick(accounts);
      const ms = rng.int(30, 8 * 60) * 60_000;
      const kills = Math.round((ms / 60_000) * rng.int(2, 6));
      push(
        "sim.offline",
        at(),
        { mode: "classic", levelBand: seedLevelBand(acc.level) },
        {
          ms,
          kills,
          xp: Math.round(kills * (8 + acc.level * 6) * 0.2),
          gold: kills * rng.int(1, 4),
          items: Math.round(kills * 0.05),
          levels: rng.chance(0.3) ? 1 : 0,
        },
        acc.index,
      );
    }

    // ---- chat + moderation
    for (let i = 0; i < n(4); i++) {
      push(
        "chat.message",
        at(),
        {
          channelKind: rng.weighted([
            ["global", 55],
            ["mode", 30],
            ["guild", 15],
          ] as const),
          outcome: rng.weighted([
            ["ok", 92],
            ["filtered", 3],
            ["muted", 1.5],
            ["rate_limited", 3],
            ["guard", 0.5],
          ] as const),
        },
        { chars: rng.int(2, 120) },
        "seed",
        rng.int(2, 12),
      );
    }
    if (rng.chance(0.35)) {
      const action = rng.weighted([
        ["filter", 45],
        ["report", 25],
        ["mute", 15],
        ["hide", 10],
        ["guard", 5],
      ] as const);
      const by =
        action === "report"
          ? "player"
          : action === "filter" || action === "guard"
            ? "auto"
            : "admin";
      push("mod.action", at(), { action, by }, {}, "seed");
    }

    // ---- client sessions, perf, errors
    for (let i = 0; i < n(3); i++) {
      const sid = `seed-s-${++sessionNo}`;
      const start = at();
      const env = sessionEnv(rng);
      const lengthS = Math.round(20 + rng.next() ** 2.2 * 3 * 3600);
      const mode = rng.weighted(MODES);
      const common = { ...env, build: SEED_BUILD, contentHash: ids.contentHash };
      push(
        "client.session",
        start,
        { phase: "start", ...common, mode: "", lengthBand: "" },
        { elapsedS: 0, loadMs: Math.round(700 + rng.next() ** 2 * 5000), visible: 1 },
        sid,
      );
      const beat = Math.min(start + Math.min(lengthS, 600) * 1000, now);
      push(
        "client.session",
        beat,
        { phase: "heartbeat", ...common, mode, lengthBand: "" },
        {
          elapsedS: Math.round((beat - start) / 1000),
          loadMs: 0,
          visible: rng.chance(0.85) ? 1 : 0,
        },
        sid,
      );
      if (start + lengthS * 1000 <= now) {
        push(
          "client.session",
          start + lengthS * 1000,
          { phase: "end", ...common, mode, lengthBand: lengthBand(lengthS) },
          { elapsedS: lengthS, loadMs: 0, visible: 0 },
          sid,
        );
      }
      if (rng.chance(0.25)) {
        const mobile = env.device !== "desktop";
        const p50 = mobile ? rng.int(50, 60) : rng.int(56, 60);
        const p95 = Math.max(45, p50 - rng.int(2, 10));
        push(
          "client.perf",
          beat,
          { mode, platform: env.platform, device: env.device, build: SEED_BUILD },
          {
            fpsP50: p50,
            fpsP95: p95,
            frameMsP95: Math.round(10_000 / p95) / 10,
            samples: rng.int(300, 3600),
            heapMb: mobile ? 0 : rng.int(80, 320),
          },
          sid,
        );
      }
      if (rng.chance(0.06)) {
        push(
          "client.error",
          beat,
          {
            kind: rng.weighted([
              ["error", 60],
              ["unhandledrejection", 30],
              ["render", 10],
            ] as const),
            build: SEED_BUILD,
            messageKey: rng.pick(ERROR_KEYS),
            platform: env.platform,
          },
          {},
          sid,
        );
      }
    }
  }

  // ---- players online right now (concurrent = sessions seen in the last 120 s)
  for (let i = 0; i < 5; i++) {
    const sid = `seed-live-${i + 1}`;
    const env = sessionEnv(rng);
    push(
      "client.session",
      now - rng.int(5, 100) * 1000,
      {
        phase: "heartbeat",
        ...env,
        build: SEED_BUILD,
        contentHash: ids.contentHash,
        mode: rng.weighted(MODES),
        lengthBand: "",
      },
      { elapsedS: rng.int(60, 3000), loadMs: 0, visible: 1 },
      sid,
    );
  }

  return out.sort((a, b) => a.t - b.t);
}

function sessionEnv(rng: Lcg): {
  platform: string;
  device: string;
  country: string;
  continent: string;
} {
  const platform = rng.weighted(PLATFORMS);
  const device =
    platform === "ios" || platform === "android"
      ? rng.chance(0.85)
        ? "mobile"
        : "tablet"
      : rng.chance(platform === "pwa" ? 0.7 : 0.3)
        ? "mobile"
        : "desktop";
  const [country, continent] = rng.weighted(GEO.map((g) => [g, g[2]] as const));
  return { platform, device, country, continent };
}

export function clampDays(days: number): number {
  if (!Number.isFinite(days)) return SEED_DAYS_DEFAULT;
  return Math.min(SEED_DAYS_MAX, Math.max(1, Math.floor(days)));
}

/** Metrics the seeder covers (all of schema.ts; the seed test checks it). */
export const SEEDED_METRICS = Object.keys(METRICS) as MetricName[];

export const devMetricsRoutes: RouteHandler = async (c) => {
  if (c.url.pathname !== SEED_PATH) return null;
  if (!isDevHost(c.url, c.env)) return apiError(404, "not_found", "no such endpoint");
  const admin = await requireAdmin(c.request, c.env, c.url);
  if (admin instanceof Response) return admin;
  if (c.request.method !== "POST") return apiError(405, "method_not_allowed", "use POST");
  if (!c.env.METRICS) return apiError(503, "unavailable", "METRICS is not bound");

  const raw = c.url.searchParams.get("days");
  const days = clampDays(raw === null || raw === "" ? SEED_DAYS_DEFAULT : Number(raw));
  const reset = c.url.searchParams.get("reset") === "1";
  try {
    const points = seedPoints({ now: Date.now(), days, ids: classicSeedIds() });
    const stub = c.env.METRICS.getByName(LOCAL_METRICS_NAME);
    const removed = reset ? await stub.reset(true) : 0;
    for (let i = 0; i < points.length; i += SEED_CHUNK) {
      await stub.ingest(points.slice(i, i + SEED_CHUNK));
    }
    return json({
      ok: true,
      points: points.length,
      days,
      retainedDays: Math.min(days, LOCAL_LIMITS.keepMs / DAY),
      removed,
    });
  } catch (err) {
    console.error("dev: seed-metrics failed", err);
    return apiError(503, "unavailable", "metrics stub unavailable");
  }
};

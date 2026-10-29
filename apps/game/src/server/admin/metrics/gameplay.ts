/**
 * GET /api/admin/gameplay?mode=classic (docs/design/admin-dashboard.md §2.3). OWNER: T-api-game.
 *
 * D1 heroes come from the classic_hero / leaderboard_rift read model. Every
 * sim.tally counter is verified play only (§5): the Analytics Engine sums are
 * already filtered by metric and mode, and never include client claims.
 * Sums are sample-weighted by the AnalyticsQuery implementation.
 */
import type { AdminGameplay, AdminRange, Distribution, Series, FunnelStep } from "@gamez/protocol";
import type { SeriesRow, TotalsRow } from "../../analytics/types.ts";
import {
  HOUR_MS,
  LEVEL_BANDS,
  SourceLog,
  dist,
  distOf,
  levelBandSql,
  num,
  rows,
  seriesRows,
  toSeries,
  type MetricsDeps,
} from "./util.ts";

/**
 * Live, verified read-model rows: not tombstoned and not imported (ADR 0007
 * R1: a forged local save would dominate the hero and rift stats). The same
 * rule as the leaderboards (leaderboards/query.ts RANKED).
 */
const LIVE = "_deleted = 0 AND COALESCE(imported, 0) = 0";
const TALLY = "sim.tally" as const;
const OFFLINE = "sim.offline" as const;
/** Top-N cap for every ranked list in this section. */
const TOP = 20;
/** Enough groups to sum a whole dimension (sum helpers never truncate). */
const ALL_GROUPS = 500;
/** Deepest-depth buckets: "0", "1" … "20", then "21+" (§2.3). */
const DEPTH_BANDS = ["0", ...Array.from({ length: 20 }, (_, i) => String(i + 1)), "21+"];
const CONTROLS = ["manual", "auto", "idle"] as const;

type Field = "k1" | "k2";
type Where = Partial<Record<Field, string>>;
const SUM_AMOUNT = { op: "sum", field: "amount" } as const;

/** Sum of totals or series values. */
function sum(data: readonly { value: number }[]): number {
  return data.reduce((a, r) => a + num(r.value), 0);
}

/** Totals keyed by one groupBy field. */
function byKey(data: readonly TotalsRow[], field: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of data) out.set(r.keys[field] ?? "", num(r.value));
  return out;
}

/** Depth label order: "town" first, then 1…20, "21+", anything else last. */
export function depthRank(label: string): number {
  if (label === "town") return -1;
  const n = parseInt(label, 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * Bucket width of the rift score histogram: a 1-2-5 step near max/10, never
 * below 1 (so every label is an integer range).
 */
export function histogramWidth(best: number): number {
  const raw = best / 10;
  if (raw <= 1) return 1;
  let pow = 1;
  while (pow * 10 <= raw) pow *= 10;
  const f = raw / pow;
  const mult = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return mult * pow;
}

interface HeroStats {
  total: number;
  deepest: number;
  kills: number;
  deaths: number;
  byClass: { label: string; n: number }[];
  byLevel: { label: string; n: number }[];
  byDepth: { label: string; n: number }[];
}

async function readHeroes(db: D1Database, mode: string): Promise<HeroStats> {
  const [s] = await rows<{ total: number; deepest: number; kills: number; deaths: number }>(
    db,
    `SELECT COUNT(*) AS total, COALESCE(MAX(deepest_depth), 0) AS deepest,
            COALESCE(SUM(kills), 0) AS kills, COALESCE(SUM(deaths), 0) AS deaths
     FROM classic_hero WHERE ${LIVE} AND mode = ?`,
    mode,
  );
  const byClass = await rows<{ label: string; n: number }>(
    db,
    `SELECT COALESCE(class_id, 'unknown') AS label, COUNT(*) AS n
     FROM classic_hero WHERE ${LIVE} AND mode = ? GROUP BY label`,
    mode,
  );
  const byLevel = await rows<{ label: string; n: number }>(
    db,
    `SELECT ${levelBandSql("level")} AS label, COUNT(*) AS n
     FROM classic_hero WHERE ${LIVE} AND mode = ? GROUP BY label`,
    mode,
  );
  const byDepth = await rows<{ label: string; n: number }>(
    db,
    `SELECT CASE WHEN deepest_depth >= 21 THEN '21+' WHEN deepest_depth <= 0 THEN '0'
                 ELSE CAST(deepest_depth AS TEXT) END AS label, COUNT(*) AS n
     FROM classic_hero WHERE ${LIVE} AND mode = ? GROUP BY label`,
    mode,
  );
  return {
    total: num(s?.total),
    deepest: num(s?.deepest),
    kills: num(s?.kills),
    deaths: num(s?.deaths),
    byClass: byClass.map((r) => ({ label: r.label, n: num(r.n) })),
    byLevel: byLevel.map((r) => ({ label: r.label, n: num(r.n) })),
    byDepth: byDepth.map((r) => ({ label: r.label, n: num(r.n) })),
  };
}

/** Fills every label of `order` (missing = 0), keeping the order. */
function fillOrder(
  key: string,
  label: string,
  order: readonly string[],
  counts: readonly { label: string; n: number }[],
): Distribution {
  const map = new Map(counts.map((c) => [c.label, c.n]));
  return dist(
    key,
    label,
    order.map((l) => ({ label: l, value: map.get(l) ?? 0 })),
  );
}

interface RiftStats {
  runs: number;
  completed: number;
  bestScore: number;
  scoreHistogram: Distribution;
}

/** Rift runs in range (by _updated_at); the histogram covers completed runs only. */
async function readRifts(db: D1Database, mode: string, range: AdminRange): Promise<RiftStats> {
  const [s] = await rows<{ runs: number; completed: number; best: number }>(
    db,
    `SELECT COUNT(*) AS runs,
            COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS completed,
            COALESCE(MAX(CASE WHEN completed = 1 THEN score END), 0) AS best
     FROM leaderboard_rift
     WHERE ${LIVE} AND mode = ? AND _updated_at >= ? AND _updated_at < ?`,
    mode,
    range.from,
    range.to,
  );
  const best = num(s?.best);
  const runs = num(s?.runs);
  const completed = num(s?.completed);
  if (best <= 0) {
    return {
      runs,
      completed,
      bestScore: 0,
      scoreHistogram: dist("riftScore", "Rift score", []),
    };
  }
  const width = histogramWidth(best);
  const bins = await rows<{ b: number; n: number }>(
    db,
    `SELECT CAST(score / ? AS INTEGER) AS b, COUNT(*) AS n
     FROM leaderboard_rift
     WHERE ${LIVE} AND mode = ? AND completed = 1 AND _updated_at >= ? AND _updated_at < ?
     GROUP BY b`,
    width,
    mode,
    range.from,
    range.to,
  );
  const counts = new Map(bins.map((r) => [num(r.b), num(r.n)]));
  const top = Math.floor(best / width);
  const buckets: { label: string; value: number }[] = [];
  for (let b = 0; b <= top; b++) {
    const lo = b * width;
    buckets.push({ label: `${lo}-${lo + width - 1}`, value: counts.get(b) ?? 0 });
  }
  return {
    runs,
    completed,
    bestScore: best,
    scoreHistogram: dist("riftScore", "Rift score", buckets),
  };
}

/**
 * GET /api/admin/gameplay. Every number is for `mode` (blob2 of sim.tally /
 * sim.offline, and the mode column of the D1 read model).
 */
export async function readGameplay(
  d: MetricsDeps,
  range: AdminRange,
  mode: string,
): Promise<AdminGameplay> {
  const log = new SourceLog(d);
  const from = range.from;
  const to = range.to;

  // ---- AE helpers (every read goes through SourceLog.ae) -------------------
  const tallyTotals = (metric: string, groupBy: Field[], extra: Where = {}, limit = TOP) =>
    log.ae(TALLY, [] as TotalsRow[], (aq) =>
      aq.totals({
        metric: TALLY,
        from,
        to,
        where: { mode, metric, ...extra },
        groupBy,
        value: SUM_AMOUNT,
        limit,
      }),
    );
  const tallySeries = (metric: string, groupBy: Field[], extra: Where = {}) =>
    log.ae(TALLY, [] as SeriesRow[], (aq) =>
      aq.series({
        metric: TALLY,
        from,
        to,
        bucketMs: range.bucketMs,
        where: { mode, metric, ...extra },
        groupBy,
        value: SUM_AMOUNT,
      }),
    );
  const offlineSeries = (value: { op: "count" } | { op: "sum"; field: "ms" }) =>
    log.ae(OFFLINE, [] as SeriesRow[], (aq) =>
      aq.series({
        metric: OFFLINE,
        from,
        to,
        bucketMs: range.bucketMs,
        where: { mode },
        groupBy: [],
        value,
      }),
    );
  const offlineTotal = (field: "kills" | "xp" | "gold" | "items" | "levels") =>
    log.ae(OFFLINE, [] as TotalsRow[], (aq) =>
      aq.totals({
        metric: OFFLINE,
        from,
        to,
        where: { mode },
        groupBy: [],
        value: { op: "sum", field },
      }),
    );

  // ---- D1 ------------------------------------------------------------------
  const heroStats = await log.d1(
    "classic_hero",
    {
      total: 0,
      deepest: 0,
      kills: 0,
      deaths: 0,
      byClass: [],
      byLevel: [],
      byDepth: [],
    } as HeroStats,
    () => readHeroes(d.db, mode),
  );
  const rift = await log.d1(
    "leaderboard_rift",
    {
      runs: 0,
      completed: 0,
      bestScore: 0,
      scoreHistogram: dist("riftScore", "Rift score", []),
    } as RiftStats,
    () => readRifts(d.db, mode, range),
  );

  // ---- playtime -------------------------------------------------------------
  const playByControl = await tallyTotals("play.ms", ["k1"], {}, 50);
  const playSeriesRows = await tallySeries("play.ms", ["k1"]);
  const offlineMsRows = await offlineSeries({ op: "sum", field: "ms" });
  const offlineMs = sum(offlineMsRows);
  const controlMs = byKey(playByControl, "k1");
  const ctl = (name: (typeof CONTROLS)[number]) => (controlMs.get(name) ?? 0) / HOUR_MS;
  const playtimeSeries: Series[] = toSeries(
    range,
    [
      ...seriesRows(playSeriesRows, "k1").map((r) => ({ ...r, value: r.value / HOUR_MS })),
      ...seriesRows(offlineMsRows, null, "offline").map((r) => ({
        ...r,
        value: r.value / HOUR_MS,
      })),
    ],
    { manual: "Manual", auto: "Auto", idle: "Idle", offline: "Offline" },
  );

  // ---- kills, deaths, bosses ------------------------------------------------
  const killsByMonster = distOf(
    "killsByMonster",
    "Kills by monster",
    await tallyTotals("kill", ["k1"]),
    "k1",
  );
  const killsByRarity = distOf(
    "killsByRarity",
    "Kills by rarity",
    await tallyTotals("kill", ["k2"]),
    "k2",
  );
  const killSeriesRows = await tallySeries("kill", []);
  const killTotal = sum(killSeriesRows);
  const killsSeries = toSeries(range, seriesRows(killSeriesRows, null, "kills"), {
    kills: "Kills",
  });

  const deathsByDepthRaw = await tallyTotals("death", ["k1"], {}, 50);
  const depthPairs = deathsByDepthRaw
    .map((r) => ({ label: r.keys.k1 ?? "", value: r.value }))
    .sort((a, b) => depthRank(a.label) - depthRank(b.label) || (a.label < b.label ? -1 : 1));
  const deathsByDepth = dist("deathsByDepth", "Deaths by depth", depthPairs);
  const deathsByKiller = distOf(
    "deathsByKiller",
    "Deaths by killer",
    await tallyTotals("death", ["k2"]),
    "k2",
  );

  const spawned = byKey(await tallyTotals("boss.spawned", ["k1"], {}, 50), "k1");
  const killed = byKey(await tallyTotals("boss.killed", ["k1"], {}, 50), "k1");
  const bossIds = [...new Set([...spawned.keys(), ...killed.keys()])];
  const bossRows = bossIds
    .map((monster) => {
      const s = spawned.get(monster) ?? 0;
      const k = killed.get(monster) ?? 0;
      return { monster, spawned: s, killed: k, killRate: s > 0 ? k / s : 0 };
    })
    .sort((a, b) => b.spawned - a.spawned || (a.monster < b.monster ? -1 : 1))
    .slice(0, TOP);

  // ---- quests ---------------------------------------------------------------
  const accepted = byKey(await tallyTotals("quest.accepted", ["k1"], {}, ALL_GROUPS), "k1");
  const completed = byKey(await tallyTotals("quest.completed", ["k1"], {}, ALL_GROUPS), "k1");
  const questDone = sum(await tallyTotals("quest.done", []));
  const acceptedTotal = [...accepted.values()].reduce((a, v) => a + v, 0);
  const completedTotal = [...completed.values()].reduce((a, v) => a + v, 0);
  const funnel: FunnelStep[] = [
    { label: "Accepted", value: acceptedTotal },
    { label: "Objective done", value: questDone },
    { label: "Turned in", value: completedTotal },
  ];
  const questIds = [...new Set([...accepted.keys(), ...completed.keys()])];
  const questRows = questIds
    .map((quest) => ({
      quest,
      accepted: accepted.get(quest) ?? 0,
      completed: completed.get(quest) ?? 0,
    }))
    .sort((a, b) => b.accepted - a.accepted || (a.quest < b.quest ? -1 : 1))
    .slice(0, TOP);

  // ---- progression ----------------------------------------------------------
  const achievements = distOf(
    "achievements",
    "Achievements",
    await tallyTotals("achievement", ["k1"]),
    "k1",
  );
  const skills = distOf("skills", "Skill casts", await tallyTotals("cast", ["k1"]), "k1");
  const talents = distOf("talents", "Talents learned", await tallyTotals("talent", ["k1"]), "k1");

  // ---- drops ----------------------------------------------------------------
  const dropsByRarity = distOf(
    "dropsByRarity",
    "Drops by rarity",
    await tallyTotals("drop", ["k1"], { k2: "item" }),
    "k1",
  );
  const dropsPerKill = dist(
    "dropsPerKill",
    "Drops per 100 kills",
    dropsByRarity.buckets.map((b) => ({
      label: b.label,
      value: killTotal > 0 ? (b.value / killTotal) * 100 : 0,
    })),
  );

  // ---- offline --------------------------------------------------------------
  const grantRows = await offlineSeries({ op: "count" });
  const grants = sum(grantRows);
  const offlineKills = sum(await offlineTotal("kills"));
  const offlineXp = sum(await offlineTotal("xp"));
  const offlineGold = sum(await offlineTotal("gold"));
  const offlineItems = sum(await offlineTotal("items"));
  const offlineLevels = sum(await offlineTotal("levels"));

  // ---- XP per hour by level band (online play only) -------------------------
  const xpByBand = byKey(await tallyTotals("xp", ["k1"], {}, 50), "k1");
  const playByBand = byKey(await tallyTotals("play.ms", ["k2"], {}, 50), "k2");
  const xpPerHourByBand = dist(
    "xpPerHour",
    "XP per hour",
    // Bands with no play time have no rate: they are left out (no data), not 0.
    LEVEL_BANDS.filter((band) => (playByBand.get(band) ?? 0) > 0).map((band) => ({
      label: band,
      value: (xpByBand.get(band) ?? 0) / ((playByBand.get(band) ?? 0) / HOUR_MS),
    })),
  );

  return {
    at: d.now,
    range,
    sources: log.sources,
    mode,
    heroes: {
      total: heroStats.total,
      byClass: dist(
        "class",
        "Class",
        heroStats.byClass.map((c) => ({ label: c.label, value: c.n })),
        "desc",
      ),
      byLevel: fillOrder("level", "Level", LEVEL_BANDS, heroStats.byLevel),
      byDeepestDepth: fillOrder("depth", "Deepest depth", DEPTH_BANDS, heroStats.byDepth),
      deepestDepth: heroStats.deepest,
      kills: heroStats.kills,
      deaths: heroStats.deaths,
    },
    playtimeHours: {
      manual: ctl("manual"),
      auto: ctl("auto"),
      idle: ctl("idle"),
      offline: offlineMs / HOUR_MS,
    },
    playtimeSeries,
    kills: {
      byMonster: capped(killsByMonster),
      byRarity: capped(killsByRarity),
      series: killsSeries,
    },
    deaths: {
      byDepth: deathsByDepth,
      byKiller: capped(deathsByKiller),
    },
    bosses: { rows: bossRows },
    quests: { funnel, rows: questRows },
    rifts: {
      runs: rift.runs,
      completed: rift.completed,
      scoreHistogram: rift.scoreHistogram,
      bestScore: rift.bestScore,
    },
    achievements: capped(achievements),
    skills: capped(skills),
    talents: capped(talents),
    drops: {
      byRarity: capped(dropsByRarity),
      perKill: dropsPerKill,
    },
    offline: {
      grants,
      hours: offlineMs / HOUR_MS,
      kills: offlineKills,
      xp: offlineXp,
      gold: offlineGold,
      items: offlineItems,
      levels: offlineLevels,
      series: toSeries(range, seriesRows(grantRows, null, "grants"), { grants: "Grants" }),
    },
    xpPerHourByBand,
    party: null,
  };
}

/** A distribution cut to the top-N buckets (buckets are already sorted desc). */
function capped(d: Distribution): Distribution {
  return { ...d, buckets: d.buckets.slice(0, TOP) };
}

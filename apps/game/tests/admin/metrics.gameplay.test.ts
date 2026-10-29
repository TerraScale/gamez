/**
 * readGameplay (docs/design/admin-dashboard.md §2.3) over a migrated FakeD1 and
 * a fake AnalyticsQuery that answers sim.tally / sim.offline by metric, where
 * and groupBy. Every expected number below is worked out from the fixture.
 */
import { describe, expect, it } from "vite-plus/test";
import type { AdminRange } from "@gamez/protocol";
import type {
  Analytics,
  AnalyticsQuery,
  SeriesRow,
  TotalsRow,
} from "../../src/server/analytics/types.ts";
import type { SeriesQuery, TotalsQuery } from "../../src/server/analytics/types.ts";
import type { MetricName } from "../../src/server/analytics/schema.ts";
import type { Env } from "../../src/server/contracts.ts";
import {
  depthRank,
  histogramWidth,
  readGameplay,
} from "../../src/server/admin/metrics/gameplay.ts";
import type { MetricsDeps } from "../../src/server/admin/metrics/util.ts";
import { FakeD1 } from "../leaderboards/fake-d1.ts";

const MIGRATIONS = [
  "0001_init.sql",
  "0002_leaderboards.sql",
  "0003_accounts.sql",
  "0004_guilds.sql",
  "0005_chat.sql",
  "0006_market.sql",
  "0007_shops.sql",
  "0008_arena.sql",
  "0009_economy.sql",
  "0010_admin.sql",
];

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DAY0 = Date.UTC(2026, 9, 20);
const RANGE: AdminRange = { from: DAY0, to: DAY0 + 3 * DAY, bucket: "day", bucketMs: DAY };
const NOW = DAY0 + 3 * DAY + HOUR;

// ---------------------------------------------------------------------------
// Fake Analytics Engine: points carry the AE metric name, blob fields and doubles.
// ---------------------------------------------------------------------------

type Fields = Record<string, string>;
interface Pt {
  metric: string;
  t: number;
  fields: Fields;
  values: Record<string, number>;
}
interface Call {
  fn: "totals" | "series";
  metric: string;
  from: number;
  to: number;
  where: Fields;
  groupBy: string[];
  value: unknown;
}
interface Loose {
  metric: string;
  from: number;
  to: number;
  where?: Fields;
  groupBy: string[];
  value: { op: "count" } | { op: "sum"; field: string };
  limit?: number;
  bucketMs?: number;
}

class FakeAq implements AnalyticsQuery {
  readonly calls: Call[] = [];
  constructor(
    private readonly pts: Pt[],
    readonly source: "ae" | "local" | "none" = "ae",
  ) {}

  #match(q: Loose): Pt[] {
    return this.pts.filter(
      (p) =>
        p.metric === q.metric &&
        p.t >= q.from &&
        p.t < q.to &&
        Object.entries(q.where ?? {}).every(([k, v]) => p.fields[k] === v),
    );
  }

  #value(p: Pt, value: Loose["value"]): number {
    return value.op === "count" ? 1 : (p.values[value.field] ?? 0);
  }

  #keys(p: Pt, groupBy: string[]): Fields {
    const out: Fields = {};
    for (const g of groupBy) out[g] = p.fields[g] ?? "";
    return out;
  }

  #record(fn: Call["fn"], q: Loose): void {
    this.calls.push({
      fn,
      metric: q.metric,
      from: q.from,
      to: q.to,
      where: q.where ?? {},
      groupBy: q.groupBy,
      value: q.value,
    });
  }

  async totals<M extends MetricName>(q: TotalsQuery<M>): Promise<TotalsRow[]> {
    const x = q as unknown as Loose;
    this.#record("totals", x);
    const groups = new Map<string, { keys: Fields; value: number }>();
    for (const p of this.#match(x)) {
      const keys = this.#keys(p, x.groupBy);
      const id = JSON.stringify(keys);
      const g = groups.get(id) ?? { keys, value: 0 };
      g.value += this.#value(p, x.value);
      groups.set(id, g);
    }
    return [...groups.values()]
      .sort(
        (a, b) => b.value - a.value || (JSON.stringify(a.keys) < JSON.stringify(b.keys) ? -1 : 1),
      )
      .slice(0, x.limit ?? 50);
  }

  async series<M extends MetricName>(q: SeriesQuery<M>): Promise<SeriesRow[]> {
    const x = q as unknown as Loose;
    this.#record("series", x);
    const bucketMs = x.bucketMs ?? DAY;
    const groups = new Map<string, SeriesRow>();
    for (const p of this.#match(x)) {
      const t = Math.floor(p.t / bucketMs) * bucketMs;
      const keys = this.#keys(p, x.groupBy);
      const id = `${t}|${JSON.stringify(keys)}`;
      const g = groups.get(id) ?? { t, keys, value: 0 };
      g.value += this.#value(p, x.value);
      groups.set(id, g);
    }
    return [...groups.values()];
  }

  async quantiles(): Promise<number[]> {
    return [];
  }

  async distinct(): Promise<number> {
    return 0;
  }
}

const tally = (
  t: number,
  metric: string,
  k1: string,
  k2: string,
  amount: number,
  mode = "classic",
): Pt => ({
  metric: "sim.tally",
  t,
  fields: { mode, metric, k1, k2 },
  values: { amount },
});

const offline = (
  t: number,
  levelBand: string,
  v: Record<string, number>,
  mode = "classic",
): Pt => ({
  metric: "sim.offline",
  t,
  fields: { mode, levelBand },
  values: v,
});

/** Shared fixture: every number in the assertions comes from these points. */
const POINTS: Pt[] = [
  // Playtime (wall ms by control and level band). A steps-mode row is ignored.
  tally(DAY0 + 1 * HOUR, "play.ms", "manual", "1-9", 7_200_000),
  tally(DAY0 + 2 * HOUR, "play.ms", "manual", "10-19", 3_600_000),
  tally(DAY0 + DAY + 1 * HOUR, "play.ms", "auto", "10-19", 10_800_000),
  tally(DAY0 + 2 * DAY + 4 * HOUR, "play.ms", "idle", "1-9", 3_600_000),
  tally(DAY0 + HOUR, "play.ms", "manual", "1-9", 999_999_999, "steps"),
  // XP by level band (online only).
  tally(DAY0 + 1 * HOUR, "xp", "1-9", "combat", 300),
  tally(DAY0 + 2 * HOUR, "xp", "10-19", "quest", 1_200),
  // Kills by monster (k1) and rarity (k2): 60 in total.
  tally(DAY0 + 1 * HOUR, "kill", "goblin", "common", 10),
  tally(DAY0 + 1 * HOUR, "kill", "skeleton", "common", 20),
  tally(DAY0 + DAY + 2 * HOUR, "kill", "goblin", "common", 20),
  tally(DAY0 + DAY + 2 * HOUR, "kill", "wolf", "rare", 10),
  // Deaths by depth band (k1) and killer (k2).
  tally(DAY0 + 1 * HOUR, "death", "town", "goblin", 1),
  tally(DAY0 + DAY + 1 * HOUR, "death", "3", "skeleton", 1),
  tally(DAY0 + 2 * DAY + 1 * HOUR, "death", "3", "skeleton", 1),
  tally(DAY0 + 2 * DAY + 2 * HOUR, "death", "21+", "unknown", 1),
  // Bosses: bone_king 3 of 4 killed, frost_wyrm 0 of 2.
  tally(DAY0 + DAY + 1 * HOUR, "boss.spawned", "bone_king", "20", 4),
  tally(DAY0 + DAY + 1 * HOUR, "boss.spawned", "frost_wyrm", "30", 2),
  tally(DAY0 + DAY + 1 * HOUR, "boss.killed", "bone_king", "20", 3),
  // Quest funnel: accepted 5, objective done 3, turned in 3.
  tally(DAY0 + 1 * HOUR, "quest.accepted", "q_intro", "", 3),
  tally(DAY0 + 1 * HOUR, "quest.accepted", "q_wolves", "", 2),
  tally(DAY0 + 1 * HOUR, "quest.done", "q_intro", "", 2),
  tally(DAY0 + DAY + 1 * HOUR, "quest.done", "q_wolves", "", 1),
  tally(DAY0 + 1 * HOUR, "quest.completed", "q_intro", "", 2),
  tally(DAY0 + DAY + 1 * HOUR, "quest.completed", "q_wolves", "", 1),
  // Progression.
  tally(DAY0 + 1 * HOUR, "achievement", "first_blood", "", 2),
  tally(DAY0 + 1 * HOUR, "achievement", "veteran", "", 1),
  tally(DAY0 + 1 * HOUR, "cast", "fireball", "", 7),
  tally(DAY0 + 1 * HOUR, "cast", "nova", "", 3),
  tally(DAY0 + 1 * HOUR, "talent", "brutal", "", 2),
  // Drops: only kind "item" counts for rarity. Gold drops are excluded.
  tally(DAY0 + 1 * HOUR, "drop", "common", "item", 12),
  tally(DAY0 + 1 * HOUR, "drop", "rare", "item", 4),
  tally(DAY0 + 1 * HOUR, "drop", "common", "gold", 9),
  // Offline grants: 2 grants, 3 hours, 8 kills, 60 xp, 90 gold, 3 items, 1 level.
  offline(DAY0 + DAY + 5 * HOUR, "1-9", {
    ms: 7_200_000,
    kills: 5,
    xp: 40,
    gold: 60,
    items: 2,
    levels: 1,
  }),
  offline(DAY0 + 2 * DAY + 1 * HOUR, "10-19", {
    ms: 3_600_000,
    kills: 3,
    xp: 20,
    gold: 30,
    items: 1,
    levels: 0,
  }),
  offline(
    DAY0 + 2 * DAY + 1 * HOUR,
    "1-9",
    { ms: 999_999_999, kills: 999, xp: 999, gold: 999, items: 9, levels: 9 },
    "steps",
  ),
];

const DEPTHS = ["0", ...Array.from({ length: 20 }, (_, i) => String(i + 1)), "21+"];

function insert(d1: FakeD1, table: string, row: Record<string, unknown>): void {
  const full: Record<string, unknown> = { _version: 1, _deleted: 0, _updated_at: 1, ...row };
  const cols = Object.keys(full);
  d1.db
    .prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...(cols.map((c) => full[c]) as never[]));
}

function seedD1(d1: FakeD1): void {
  // classic_hero: h4 is a tombstone, h5 plays the steps mode (both excluded).
  insert(d1, "classic_hero", {
    id: "h1",
    account_id: "a1",
    mode: "classic",
    class_id: "classic.warrior",
    level: 5,
    deepest_depth: 3,
    kills: 10,
    deaths: 1,
  });
  insert(d1, "classic_hero", {
    id: "h2",
    account_id: "a2",
    mode: "classic",
    class_id: "classic.warrior",
    level: 15,
    deepest_depth: 12,
    kills: 40,
    deaths: 3,
  });
  insert(d1, "classic_hero", {
    id: "h3",
    account_id: "a3",
    mode: "classic",
    class_id: "classic.mage",
    level: 95,
    deepest_depth: 25,
    kills: 100,
    deaths: 9,
  });
  insert(d1, "classic_hero", {
    id: "h4",
    account_id: "a4",
    mode: "classic",
    class_id: "classic.mage",
    level: 35,
    deepest_depth: 40,
    kills: 500,
    deaths: 50,
    _deleted: 1,
  });
  insert(d1, "classic_hero", {
    id: "h5",
    account_id: "a5",
    mode: "steps",
    class_id: "classic.mage",
    level: 50,
    deepest_depth: 30,
    kills: 999,
    deaths: 999,
  });
  // h6 is an imported (quarantined, ADR 0007 R1) forged hero: never in the stats.
  insert(d1, "classic_hero", {
    id: "h6",
    account_id: "a6",
    mode: "classic",
    class_id: "classic.mage",
    level: 999,
    deepest_depth: 1_000_000_000,
    kills: 1_000_000,
    deaths: 0,
    imported: 1,
  });
  // leaderboard_rift: best completed in range is 1250; r4 is out of range, r5 is
  // another mode, r6 is a tombstone (all three would change the numbers).
  const rift = {
    account_id: "acc",
    display_name: "p",
    hero_name: "h",
    class_id: "classic.warrior",
    hero_level: 1,
    rift_level: 1,
    ticks: 0,
    deaths: 0,
    run: 1,
    end_tick: 1,
  };
  insert(d1, "leaderboard_rift", {
    ...rift,
    id: "r1",
    mode: "classic",
    completed: 1,
    score: 500,
    _updated_at: DAY0 + HOUR,
  });
  insert(d1, "leaderboard_rift", {
    ...rift,
    id: "r2",
    mode: "classic",
    completed: 1,
    score: 1250,
    _updated_at: DAY0 + DAY,
  });
  insert(d1, "leaderboard_rift", {
    ...rift,
    id: "r3",
    mode: "classic",
    completed: 0,
    score: 300,
    _updated_at: DAY0 + 2 * HOUR,
  });
  insert(d1, "leaderboard_rift", {
    ...rift,
    id: "r4",
    mode: "classic",
    completed: 1,
    score: 900,
    _updated_at: DAY0 - HOUR,
  });
  insert(d1, "leaderboard_rift", {
    ...rift,
    id: "r5",
    mode: "steps",
    completed: 1,
    score: 9999,
    _updated_at: DAY0 + 3 * HOUR,
  });
  insert(d1, "leaderboard_rift", {
    ...rift,
    id: "r6",
    mode: "classic",
    completed: 1,
    score: 2000,
    _updated_at: DAY0 + DAY,
    _deleted: 1,
  });
  // r7: an imported hero's run would set the histogram width and squash the rest.
  insert(d1, "leaderboard_rift", {
    ...rift,
    id: "r7",
    mode: "classic",
    completed: 1,
    score: 99_999_999,
    _updated_at: DAY0 + DAY,
    imported: 1,
  });
}

function deps(d1: FakeD1 | null, aq: AnalyticsQuery): MetricsDeps {
  const analytics = { write() {}, flush: async () => {} } as unknown as Analytics;
  return {
    env: {} as Env,
    db: (d1 ? d1.asD1() : new FakeD1().asD1()) as D1Database,
    aq,
    analytics,
    now: NOW,
  };
}

describe("readGameplay", () => {
  it("splits playtime by control and adds granted offline time", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const out = await readGameplay(deps(d1, new FakeAq(POINTS)), RANGE, "classic");

    expect(out.playtimeHours).toEqual({ manual: 3, auto: 3, idle: 1, offline: 3 });
    const byKey = Object.fromEntries(
      out.playtimeSeries.map((s) => [s.key, s.points.map((p) => p.v)]),
    );
    expect(byKey.manual).toEqual([3, 0, 0]);
    expect(byKey.auto).toEqual([0, 3, 0]);
    expect(byKey.idle).toEqual([0, 0, 1]);
    expect(byKey.offline).toEqual([0, 2, 1]);
    expect(out.offline.hours).toBe(3);
    expect(out.offline.series[0]?.points.map((p) => p.v)).toEqual([0, 1, 1]);
  });

  it("reads kills, deaths and bosses with exact counts", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const out = await readGameplay(deps(d1, new FakeAq(POINTS)), RANGE, "classic");

    expect(out.kills.byMonster.buckets).toEqual([
      { label: "goblin", value: 30 },
      { label: "skeleton", value: 20 },
      { label: "wolf", value: 10 },
    ]);
    expect(out.kills.byRarity.buckets).toEqual([
      { label: "common", value: 50 },
      { label: "rare", value: 10 },
    ]);
    expect(out.kills.series[0]?.points.map((p) => p.v)).toEqual([30, 30, 0]);

    // Depth order: town first, then numeric, "21+" last.
    expect(out.deaths.byDepth.buckets).toEqual([
      { label: "town", value: 1 },
      { label: "3", value: 2 },
      { label: "21+", value: 1 },
    ]);
    expect(out.deaths.byKiller.buckets).toEqual([
      { label: "skeleton", value: 2 },
      { label: "goblin", value: 1 },
      { label: "unknown", value: 1 },
    ]);

    expect(out.bosses.rows).toEqual([
      { monster: "bone_king", spawned: 4, killed: 3, killRate: 0.75 },
      { monster: "frost_wyrm", spawned: 2, killed: 0, killRate: 0 },
    ]);
  });

  it("builds the quest funnel and the per-quest rows", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const out = await readGameplay(deps(d1, new FakeAq(POINTS)), RANGE, "classic");

    expect(out.quests.funnel).toEqual([
      { label: "Accepted", value: 5 },
      { label: "Objective done", value: 3 },
      { label: "Turned in", value: 3 },
    ]);
    expect(out.quests.rows).toEqual([
      { quest: "q_intro", accepted: 3, completed: 2 },
      { quest: "q_wolves", accepted: 2, completed: 1 },
    ]);
  });

  it("computes drops per 100 kills and xp per hour by level band", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const out = await readGameplay(deps(d1, new FakeAq(POINTS)), RANGE, "classic");

    // Gold drops are not items: common 12 items, rare 4 items, out of 60 kills.
    expect(out.drops.byRarity.buckets).toEqual([
      { label: "common", value: 12 },
      { label: "rare", value: 4 },
    ]);
    expect(out.drops.perKill.buckets[0]?.value).toBeCloseTo(20, 10);
    expect(out.drops.perKill.buckets[1]?.value).toBeCloseTo((4 / 60) * 100, 10);

    // 1-9: 300 xp over 3 play hours; 10-19: 1200 xp over 4 play hours.
    const xp = Object.fromEntries(out.xpPerHourByBand.buckets.map((b) => [b.label, b.value]));
    expect(xp["1-9"]).toBe(100);
    expect(xp["10-19"]).toBe(300);
    // Bands without play time are left out (no data), not shown as 0.
    expect(xp["20-29"]).toBeUndefined();
    expect(out.xpPerHourByBand.buckets).toHaveLength(2);
  });

  it("sums offline grants, achievements, skills and talents", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const out = await readGameplay(deps(d1, new FakeAq(POINTS)), RANGE, "classic");

    expect(out.offline).toMatchObject({
      grants: 2,
      hours: 3,
      kills: 8,
      xp: 60,
      gold: 90,
      items: 3,
      levels: 1,
    });
    expect(out.achievements.buckets).toEqual([
      { label: "first_blood", value: 2 },
      { label: "veteran", value: 1 },
    ]);
    expect(out.skills.buckets).toEqual([
      { label: "fireball", value: 7 },
      { label: "nova", value: 3 },
    ]);
    expect(out.talents.buckets).toEqual([{ label: "brutal", value: 2 }]);
    expect(out.party).toBeNull();
  });

  it("reads heroes and rifts from D1, filtered by mode, without tombstones or imported heroes", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    const out = await readGameplay(deps(d1, new FakeAq(POINTS)), RANGE, "classic");

    expect(out.heroes.total).toBe(3);
    expect(out.heroes.deepestDepth).toBe(25);
    expect(out.heroes.kills).toBe(150);
    expect(out.heroes.deaths).toBe(13);
    expect(out.heroes.byClass.buckets).toEqual([
      { label: "classic.warrior", value: 2 },
      { label: "classic.mage", value: 1 },
    ]);
    expect(out.heroes.byLevel.buckets.filter((b) => b.value > 0)).toEqual([
      { label: "1-9", value: 1 },
      { label: "10-19", value: 1 },
      { label: "90+", value: 1 },
    ]);
    expect(out.heroes.byLevel.buckets).toHaveLength(10);
    expect(out.heroes.byDeepestDepth.buckets.map((b) => b.label)).toEqual(DEPTHS);
    expect(out.heroes.byDeepestDepth.buckets.filter((b) => b.value > 0)).toEqual([
      { label: "3", value: 1 },
      { label: "12", value: 1 },
      { label: "21+", value: 1 },
    ]);

    // Completed runs in range only: 500, 1250 (900 is out of range, 2000 deleted).
    expect(out.rifts.runs).toBe(3);
    expect(out.rifts.completed).toBe(2);
    expect(out.rifts.bestScore).toBe(1250);
    expect(out.rifts.scoreHistogram.buckets).toEqual([
      { label: "0-199", value: 0 },
      { label: "200-399", value: 0 },
      { label: "400-599", value: 1 },
      { label: "600-799", value: 0 },
      { label: "800-999", value: 0 },
      { label: "1000-1199", value: 0 },
      { label: "1200-1399", value: 1 },
    ]);
    expect(out.sources.every((s) => s.ok)).toBe(true);
  });

  it("queries sim.tally and sim.offline with the mode, metric and range filters", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const aq = new FakeAq(POINTS);
    await readGameplay(deps(d1, aq), RANGE, "classic");

    expect(aq.calls.length).toBeGreaterThan(0);
    for (const c of aq.calls) {
      expect(c.from).toBe(RANGE.from);
      expect(c.to).toBe(RANGE.to);
      expect(c.where.mode).toBe("classic");
    }
    expect(
      aq.calls.some(
        (c) => c.metric === "sim.tally" && c.where.metric === "play.ms" && c.groupBy.includes("k1"),
      ),
    ).toBe(true);
    expect(aq.calls.some((c) => c.metric === "sim.offline")).toBe(true);
  });

  it("gives empty data and ok:false sources when the tables are not migrated", async () => {
    const d1 = new FakeD1();
    const out = await readGameplay(deps(d1, new FakeAq(POINTS)), RANGE, "classic");

    expect(out.heroes.total).toBe(0);
    expect(out.rifts.runs).toBe(0);
    const d1Sources = out.sources.filter((s) => s.kind === "d1");
    expect(d1Sources.map((s) => s.name).sort()).toEqual(["classic_hero", "leaderboard_rift"]);
    expect(d1Sources.every((s) => s.ok === false && s.note === "table not migrated")).toBe(true);
    // AE still answers in this case.
    expect(out.playtimeHours.manual).toBe(3);
  });

  it("marks AE sources ok:false and never queries when there is no analytics backend", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedD1(d1);
    const aq = new FakeAq(POINTS, "none");
    const out = await readGameplay(deps(d1, aq), RANGE, "classic");

    expect(aq.calls).toHaveLength(0);
    const ae = out.sources.filter((s) => s.name === "sim.tally" || s.name === "sim.offline");
    expect(ae).toHaveLength(2);
    expect(ae.every((s) => s.ok === false && s.note === "no analytics backend")).toBe(true);
    expect(out.playtimeHours).toEqual({ manual: 0, auto: 0, idle: 0, offline: 0 });
    // The D1 part still answers.
    expect(out.heroes.total).toBe(3);
  });
});

describe("gameplay helpers", () => {
  it("orders depth labels with town first and 21+ last", () => {
    expect(["21+", "3", "town", "1"].sort((a, b) => depthRank(a) - depthRank(b))).toEqual([
      "town",
      "1",
      "3",
      "21+",
    ]);
  });

  it("uses a 1-2-5 step near max/10 for the rift histogram", () => {
    expect(histogramWidth(1250)).toBe(200);
    expect(histogramWidth(95)).toBe(10);
    expect(histogramWidth(40)).toBe(5);
    expect(histogramWidth(5)).toBe(1);
  });
});

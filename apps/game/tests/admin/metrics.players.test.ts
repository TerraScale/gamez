/**
 * Players section (admin/metrics/players.ts): D1 over migrated tables (node:sqlite)
 * and a fake AnalyticsQuery that answers canned rows and records its queries.
 */
import { describe, expect, it } from "vite-plus/test";
import type {
  Analytics,
  AnalyticsQuery,
  AnalyticsSourceKind,
  DistinctQuery,
  QuantileQuery,
  SeriesQuery,
  SeriesRow,
  TotalsQuery,
  TotalsRow,
} from "../../src/server/analytics/types.ts";
import type { MetricName } from "../../src/server/analytics/schema.ts";
import type { Env } from "../../src/server/contracts.ts";
import type { MetricsDeps } from "../../src/server/admin/metrics/util.ts";
import { readPlayers, SESSION_BANDS } from "../../src/server/admin/metrics/players.ts";
import type { AdminRange } from "@gamez/protocol";
import { FakeD1 } from "../leaderboards/fake-d1.ts";

const DAY = 86_400_000;
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 28, 12);
/** Today as a day number (UTC). */
const T = Math.floor(NOW / DAY);
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

interface AnyQuery {
  metric: string;
  from: number;
  to: number;
  where?: Record<string, string>;
  groupBy?: string[];
  index?: string;
  limit?: number;
}

type Answer = (op: string, q: AnyQuery) => unknown;

/** Canned AnalyticsQuery: `answer` builds the rows; every call is recorded. */
class FakeAq implements AnalyticsQuery {
  readonly calls: { op: string; q: AnyQuery }[] = [];

  constructor(
    readonly source: AnalyticsSourceKind,
    private readonly answer: Answer = () => [],
  ) {}

  async totals<M extends MetricName>(q: TotalsQuery<M>): Promise<TotalsRow[]> {
    return this.run("totals", q) as TotalsRow[];
  }
  async series<M extends MetricName>(q: SeriesQuery<M>): Promise<SeriesRow[]> {
    return this.run("series", q) as SeriesRow[];
  }
  async quantiles<M extends MetricName>(q: QuantileQuery<M>): Promise<number[]> {
    return this.run("quantiles", q) as number[];
  }
  async distinct<M extends MetricName>(q: DistinctQuery<M>): Promise<number> {
    return this.run("distinct", q) as number;
  }

  private run(op: string, q: unknown): unknown {
    this.calls.push({ op, q: q as AnyQuery });
    return this.answer(op, q as AnyQuery);
  }
}

const NOOP_ANALYTICS: Analytics = {
  write() {},
  flush: async () => {},
};

function at(day: number, hours = 0): number {
  return day * DAY + hours * H;
}

function label(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

function range(fromDay: number, toDay: number): AdminRange {
  return { from: fromDay * DAY, to: toDay * DAY, bucket: "day", bucketMs: DAY };
}

function deps(d1: FakeD1, aq: FakeAq): MetricsDeps {
  return { env: {} as Env, db: d1.asD1(), aq, analytics: NOOP_ANALYTICS, now: NOW };
}

function insert(d1: FakeD1, table: string, row: Record<string, unknown>): void {
  const full: Record<string, unknown> = { _version: 1, _deleted: 0, _updated_at: 1, ...row };
  const cols = Object.keys(full);
  d1.db
    .prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...(cols.map((c) => full[c]) as never[]));
}

function account(
  d1: FakeD1,
  row: { account_id: string; display_name: string; kind: string; created_at: number } & Record<
    string,
    unknown
  >,
): void {
  insert(d1, "account_summary", row);
}

function active(d1: FakeD1, accountId: string, day: number, deleted = 0): void {
  insert(d1, "account_activity", {
    id: `${accountId}/${day}`,
    account_id: accountId,
    day,
    kind: "guest",
    first_at: day * DAY,
    _deleted: deleted,
  });
}

/**
 * Fixture (T = today):
 *   a1 guest, created T-2 10:00, active T-2, T-1, T
 *   a2 email, created T-2 11:00, registered T-1 03:00, active T-2, T
 *   a3 guest, created T-30, active T-25 (only in MAU windows)
 *   a4 guest, created T-1, DELETED (ignored everywhere), active T (deleted row)
 *   a5 guest, created T-10 05:00, active T-3 and T-8 (retention d7 of its cohort)
 */
function seed(d1: FakeD1): void {
  account(d1, {
    account_id: "a1",
    display_name: "Alpha",
    kind: "guest",
    created_at: at(T - 2, 10),
  });
  account(d1, {
    account_id: "a2",
    display_name: "Beta",
    kind: "email",
    created_at: at(T - 2, 11),
    registered_at: at(T - 1, 3),
  });
  account(d1, {
    account_id: "a3",
    display_name: "Gamma",
    kind: "guest",
    created_at: at(T - 30, 9),
  });
  account(d1, {
    account_id: "a4",
    display_name: "Deleted",
    kind: "guest",
    created_at: at(T - 1),
    _deleted: 1,
  });
  account(d1, {
    account_id: "a5",
    display_name: "Delta",
    kind: "guest",
    created_at: at(T - 10, 5),
  });

  for (const day of [T - 2, T - 1, T]) active(d1, "a1", day);
  for (const day of [T - 2, T]) active(d1, "a2", day);
  active(d1, "a3", T - 25);
  active(d1, "a4", T, 1);
  for (const day of [T - 3, T - 8]) active(d1, "a5", day);
}

function answers(op: string, q: AnyQuery): unknown {
  if (op === "series") {
    return [
      { t: q.from, keys: {}, value: 5 },
      { t: q.from + DAY, keys: {}, value: 3 },
    ];
  }
  if (op === "quantiles") return [60, 900];
  if (op === "totals") {
    const phase = q.where?.phase;
    const by = q.groupBy?.[0];
    if (phase === "end" && by === "lengthBand") {
      return [
        { keys: { lengthBand: "<1m" }, value: 2 },
        { keys: { lengthBand: "5-15m" }, value: 4 },
      ];
    }
    if (phase === "end") return [{ keys: {}, value: 6 }];
    if (by === "platform") {
      return [
        { keys: { platform: "web" }, value: 10 },
        { keys: { platform: "pwa" }, value: 4 },
      ];
    }
    if (by === "device") {
      return [
        { keys: { device: "mobile" }, value: 9 },
        { keys: { device: "desktop" }, value: 5 },
      ];
    }
    if (by === "country") {
      // Equal values: ordered by label.
      return [
        { keys: { country: "US" }, value: 7 },
        { keys: { country: "BR" }, value: 7 },
      ];
    }
    if (by === "continent") return [{ keys: { continent: "SA" }, value: 8 }];
  }
  return [];
}

function series(out: { key: string; points: { t: number; v: number }[] }[], key: string) {
  const s = out.find((x) => x.key === key);
  if (!s) throw new Error(`no series ${key}`);
  return s.points.map((p) => p.v);
}

describe("readPlayers: accounts, signups, activity", () => {
  it("counts live accounts by kind and skips tombstones", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readPlayers(deps(d1, new FakeAq("ae", answers)), range(T - 2, T + 1));
    expect(out.accounts).toEqual({ total: 4, guest: 3, registered: 1 });
    expect(out.at).toBe(NOW);
  });

  it("computes DAU, WAU and MAU per day of the range", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readPlayers(deps(d1, new FakeAq("ae", answers)), range(T - 2, T + 1));
    const byKey = Object.fromEntries(out.active.map((s) => [s.key, s]));
    expect(byKey.dau!.points).toEqual([
      { t: at(T - 2), v: 2 },
      { t: at(T - 1), v: 1 },
      { t: at(T), v: 2 },
    ]);
    // WAU: a1, a2 and a5 (T-3 is inside every window of these days).
    expect(series(out.active, "wau")).toEqual([3, 3, 3]);
    // MAU adds a3 (T-25): a1, a2, a3, a5.
    expect(series(out.active, "mau")).toEqual([4, 4, 4]);
  });

  it("starts the active series at the first tracked day (no misleading zeros before it)", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    active(d1, "z1", T - 1);
    active(d1, "z1", T);
    const out = await readPlayers(deps(d1, new FakeAq("ae", answers)), range(T - 4, T + 1));
    expect(out.activitySince).toBe(label(T - 1));
    expect(out.active.find((s) => s.key === "dau")!.points).toEqual([
      { t: at(T - 1), v: 1 },
      { t: at(T), v: 1 },
    ]);
  });

  it("buckets signups by created_at (new) and registered_at (registered)", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readPlayers(deps(d1, new FakeAq("ae", answers)), range(T - 2, T + 1));
    expect(out.signups.map((s) => s.key)).toEqual(["new", "registered"]);
    expect(out.signups[0]!.points).toEqual([
      { t: at(T - 2), v: 2 },
      { t: at(T - 1), v: 0 },
      { t: at(T), v: 0 },
    ]);
    expect(out.signups[1]!.points).toEqual([
      { t: at(T - 2), v: 0 },
      { t: at(T - 1), v: 1 },
      { t: at(T), v: 0 },
    ]);
  });
});

describe("readPlayers: retention", () => {
  it("lists cohorts newest first with exact-day shares and null in the future", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readPlayers(deps(d1, new FakeAq("ae", answers)), range(T - 10, T + 1));
    expect(out.retention).toHaveLength(11);
    expect(out.retention[0]).toEqual({ day: label(T), size: 0, d1: null, d7: null, d30: null });
    // Cohort T-1 has no accounts (a4 is deleted): an empty cohort has no retention (null).
    expect(out.retention[1]).toEqual({ day: label(T - 1), size: 0, d1: null, d7: null, d30: null });
    // Cohort T-2 = {a1, a2}; a1 is active on T-1 (d1 = 1/2); c+7 is in the future.
    expect(out.retention[2]).toEqual({ day: label(T - 2), size: 2, d1: 0.5, d7: null, d30: null });
    // Cohort T-10 = {a5}: no activity on T-9 (d1 = 0), active on T-3 (d7 = 1).
    expect(out.retention[10]).toEqual({ day: label(T - 10), size: 1, d1: 0, d7: 1, d30: null });
  });

  it("keeps at most 30 cohorts, the newest ones", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readPlayers(deps(d1, new FakeAq("ae", answers)), range(T - 39, T + 1));
    expect(out.retention).toHaveLength(30);
    expect(out.retention[0]!.day).toBe(label(T));
    expect(out.retention[29]!.day).toBe(label(T - 29));
  });
});

describe("readPlayers: sessions, platforms, countries (AE)", () => {
  it("reads session starts per bucket, length quantiles and bands, and the breakdowns", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const aq = new FakeAq("ae", answers);
    const out = await readPlayers(deps(d1, aq), range(T - 2, T + 1));

    expect(out.sessions.perBucket).toHaveLength(1);
    expect(out.sessions.perBucket[0]!.key).toBe("sessions");
    expect(series(out.sessions.perBucket, "sessions")).toEqual([5, 3, 0]);

    expect(out.sessions.lengthS).toEqual({ p50: 60, p95: 900, n: 6 });
    expect(out.sessions.lengthHistogram.buckets.map((b) => b.label)).toEqual([...SESSION_BANDS]);
    expect(out.sessions.lengthHistogram.buckets.map((b) => b.value)).toEqual([2, 0, 4, 0, 0, 0, 0]);

    expect(out.platforms.buckets).toEqual([
      { label: "web", value: 10 },
      { label: "pwa", value: 4 },
    ]);
    expect(out.devices.buckets).toEqual([
      { label: "mobile", value: 9 },
      { label: "desktop", value: 5 },
    ]);
    expect(out.countries.buckets).toEqual([
      { label: "BR", value: 7 },
      { label: "US", value: 7 },
    ]);
    expect(out.continents.buckets).toEqual([{ label: "SA", value: 8 }]);

    // Starts are filtered by phase; the country list is capped at 20.
    const starts = aq.calls.filter((c) => c.op === "totals" && c.q.where?.phase === "start");
    expect(starts.length).toBeGreaterThan(0);
    const countryCall = aq.calls.find((c) => c.q.groupBy?.[0] === "country");
    expect(countryCall?.q.limit).toBe(20);
    const ends = aq.calls.filter((c) => c.q.where?.phase === "end");
    expect(ends.every((c) => c.q.metric === "client.session")).toBe(true);
  });

  it("marks AE sources not ok when the backend is none, and keeps D1 sources ok", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readPlayers(deps(d1, new FakeAq("none")), range(T - 2, T + 1));
    expect(out.accounts.total).toBe(4);
    expect(out.platforms.buckets).toEqual([]);
    expect(out.sessions.lengthS).toEqual({ p50: 0, p95: 0, n: 0 });
    const d1Source = out.sources.find((s) => s.name === "account_summary" && s.kind === "d1");
    expect(d1Source).toEqual({ name: "account_summary", kind: "d1", ok: true });
    const aeSources = out.sources.filter((s) => s.name === "client.session");
    expect(aeSources.length).toBeGreaterThan(0);
    expect(aeSources.every((s) => !s.ok)).toBe(true);
  });
});

describe("readPlayers: missing tables", () => {
  it("answers empty data with failing sources when nothing is migrated", async () => {
    const d1 = new FakeD1();
    const out = await readPlayers(deps(d1, new FakeAq("ae", answers)), range(T - 2, T + 1));
    expect(out.accounts).toEqual({ total: 0, guest: 0, registered: 0 });
    expect(out.retention).toEqual([]);
    expect(series(out.active, "dau")).toEqual([]);
    expect(out.sources.length).toBeGreaterThan(0);
    // D1 sources fail (not migrated); the fake AE still answers, so its sources are ok.
    const d1Sources = out.sources.filter((s) => s.kind === "d1");
    expect(d1Sources.length).toBeGreaterThan(0);
    expect(d1Sources.every((s) => !s.ok)).toBe(true);
    const summary = out.sources.find((s) => s.name === "account_summary");
    expect(summary?.note).toBe("table not migrated");
  });
});

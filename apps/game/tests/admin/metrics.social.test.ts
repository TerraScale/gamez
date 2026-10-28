/**
 * readSocial (docs/design/admin-dashboard.md §2.6) over a migrated FakeD1 and a
 * fake AnalyticsQuery for chat.message and mod.action. Expected numbers come
 * from the fixture below.
 */
import { describe, expect, it } from "vite-plus/test";
import { currentSeason } from "@gamez/economy";
import type { AdminRange } from "@gamez/protocol";
import type {
  Analytics,
  AnalyticsQuery,
  SeriesQuery,
  SeriesRow,
  TotalsQuery,
  TotalsRow,
} from "../../src/server/analytics/types.ts";
import type { MetricName } from "../../src/server/analytics/schema.ts";
import type { Env } from "../../src/server/contracts.ts";
import { readSocial } from "../../src/server/admin/metrics/social.ts";
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
const SEASON = currentSeason(NOW).id;

// ---------------------------------------------------------------------------
// Fake Analytics Engine: every point counts 1 (op count).
// ---------------------------------------------------------------------------

type Fields = Record<string, string>;
interface Pt {
  metric: string;
  t: number;
  fields: Fields;
}
interface Loose {
  metric: string;
  from: number;
  to: number;
  where?: Fields;
  groupBy: string[];
  bucketMs?: number;
  limit?: number;
}

class FakeAq implements AnalyticsQuery {
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

  #keys(p: Pt, groupBy: string[]): Fields {
    const out: Fields = {};
    for (const g of groupBy) out[g] = p.fields[g] ?? "";
    return out;
  }

  async totals<M extends MetricName>(q: TotalsQuery<M>): Promise<TotalsRow[]> {
    const x = q as unknown as Loose;
    const groups = new Map<string, TotalsRow>();
    for (const p of this.#match(x)) {
      const keys = this.#keys(p, x.groupBy);
      const id = JSON.stringify(keys);
      const g = groups.get(id) ?? { keys, value: 0 };
      g.value += 1;
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
    const bucketMs = x.bucketMs ?? DAY;
    const groups = new Map<string, SeriesRow>();
    for (const p of this.#match(x)) {
      const t = Math.floor(p.t / bucketMs) * bucketMs;
      const keys = this.#keys(p, x.groupBy);
      const id = `${t}|${JSON.stringify(keys)}`;
      const g = groups.get(id) ?? { t, keys, value: 0 };
      g.value += 1;
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

const chat = (t: number, channelKind: string, outcome: string, n = 1): Pt[] =>
  Array.from({ length: n }, () => ({
    metric: "chat.message",
    t,
    fields: { channelKind, outcome },
  }));
const mod = (t: number, action: string, by: string): Pt => ({
  metric: "mod.action",
  t,
  fields: { action, by },
});

const POINTS: Pt[] = [
  ...chat(DAY0 + HOUR, "global", "ok", 3),
  ...chat(DAY0 + DAY + HOUR, "global", "ok"),
  ...chat(DAY0 + DAY + 2 * HOUR, "mode", "ok", 2),
  ...chat(DAY0 + 2 * DAY + 2 * HOUR, "guild", "ok"),
  ...chat(DAY0 + HOUR, "global", "filtered"),
  ...chat(DAY0 + DAY + 3 * HOUR, "global", "muted", 2),
  ...chat(DAY0 + 2 * DAY + 3 * HOUR, "mode", "rate_limited"),
  // Out of range: excluded.
  ...chat(DAY0 - HOUR, "global", "ok", 50),
  mod(DAY0 + HOUR, "mute", "admin"),
  mod(DAY0 + DAY + HOUR, "mute", "auto"),
  mod(DAY0 + DAY + 2 * HOUR, "hide", "admin"),
  mod(DAY0 + 2 * DAY + HOUR, "filter", "auto"),
];

function insert(d1: FakeD1, table: string, row: Record<string, unknown>): void {
  const full: Record<string, unknown> = { _version: 1, _deleted: 0, _updated_at: 1, ...row };
  const cols = Object.keys(full);
  d1.db
    .prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...(cols.map((c) => full[c]) as never[]));
}

function seed(d1: FakeD1): void {
  // Reports. Open = no verdict and a reported account (any time). Reports = filed in range.
  insert(d1, "chat_report", { id: "cr1", reported_id: "u1", verdict: null, at: DAY0 + HOUR });
  insert(d1, "chat_report", { id: "cr2", reported_id: "u1", verdict: "", at: DAY0 + DAY });
  insert(d1, "chat_report", {
    id: "cr3",
    reported_id: "u2",
    verdict: "muted",
    at: DAY0 + DAY + HOUR,
  });
  insert(d1, "chat_report", { id: "cr4", reported_id: "", verdict: null, at: DAY0 + HOUR });
  insert(d1, "chat_report", { id: "cr5", reported_id: "u3", verdict: null, at: DAY0 - HOUR });
  insert(d1, "chat_report", {
    id: "cr6",
    reported_id: "u4",
    verdict: null,
    at: DAY0 + HOUR,
    _deleted: 1,
  });

  // Guilds: sizes 1, 3, 4, 7, 12, 25 (the tombstone with 50 members is excluded).
  for (const [id, members] of [
    ["g1", 1],
    ["g2", 3],
    ["g3", 4],
    ["g4", 7],
    ["g5", 25],
    ["g6", 12],
  ] as const) {
    insert(d1, "guild_index", { guild_id: id, name: id, member_count: members });
  }
  insert(d1, "guild_index", { guild_id: "g7", name: "gone", member_count: 50, _deleted: 1 });

  // Classic heroes: level board is Cy (70), Bruno (50, xp 2000), Ana (50, xp 1000).
  const hero = (
    id: string,
    name: string,
    cls: string,
    level: number,
    xp: number,
    mode = "classic",
    extra: Record<string, unknown> = {},
  ) =>
    insert(d1, "classic_hero", {
      id,
      account_id: `acc-${id}`,
      display_name: name,
      hero_name: `${name} hero`,
      mode,
      class_id: cls,
      level,
      xp,
      ...extra,
    });
  hero("hA", "Ana", "classic.warrior", 50, 1000);
  hero("hB", "Bruno", "classic.mage", 50, 2000);
  hero("hC", "Cy", "classic.ranger", 70, 100);
  hero("hD", "Steps", "classic.mage", 99, 0, "steps");

  // Rift board: best completed run per account. Ana 1250, Dee 900; Eve never completed.
  const rift = (id: string, account: string, name: string, score: number, completed: number) =>
    insert(d1, "leaderboard_rift", {
      id,
      account_id: account,
      display_name: name,
      hero_name: `${name} hero`,
      mode: "classic",
      class_id: "classic.warrior",
      hero_level: 10,
      rift_level: 3,
      score,
      ticks: 100,
      deaths: 0,
      completed,
      run: 1,
      end_tick: score,
    });
  rift("rA1", "accA", "Ana", 800, 1);
  rift("rA2", "accA", "Ana", 1250, 1);
  rift("rD1", "accD", "Dee", 900, 1);
  rift("rE1", "accE", "Eve", 5000, 0);

  // Arena ladder for the current season (classic): Cy 1400, Ana 1100, Bruno 1050.
  const arena = (id: string, season: string, name: string, rating: number) =>
    insert(d1, "arena_rating", {
      id,
      season_id: season,
      mode: "classic",
      account_id: `acc-${id}`,
      display_name: name,
      class_id: "classic.ranger",
      rating,
    });
  arena("x1", SEASON, "Cy", 1400);
  arena("x2", SEASON, "Ana", 1100);
  arena("x3", SEASON, "Bruno", 1050);
  arena("x4", "old-season", "Old", 3000);
}

function deps(d1: FakeD1, aq: AnalyticsQuery): MetricsDeps {
  const analytics = { write() {}, flush: async () => {} } as unknown as Analytics;
  return { env: {} as Env, db: d1.asD1(), aq, analytics, now: NOW };
}

describe("readSocial", () => {
  it("counts accepted and blocked chat messages and the channel mix", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const out = await readSocial(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.chat.messages).toBe(7);
    expect(out.chat.blocked).toBe(4);
    expect(out.chat.byChannel.buckets).toEqual([
      { label: "global", value: 4 },
      { label: "mode", value: 2 },
      { label: "guild", value: 1 },
    ]);
  });

  it("builds the chat series per outcome with readable labels", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const out = await readSocial(deps(d1, new FakeAq(POINTS)), RANGE);

    const byKey = Object.fromEntries(out.chat.series.map((s) => [s.key, s]));
    expect(byKey.ok?.label).toBe("Accepted");
    expect(byKey.ok?.points.map((p) => p.v)).toEqual([3, 3, 1]);
    expect(byKey.muted?.points.map((p) => p.v)).toEqual([0, 2, 0]);
    expect(byKey.filtered?.points.map((p) => p.v)).toEqual([1, 0, 0]);
    expect(byKey.rate_limited?.points.map((p) => p.v)).toEqual([0, 0, 1]);
  });

  it("reads mod actions by kind, with the open queue and the reports filed in range", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readSocial(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.moderation.actions.buckets).toEqual([
      { label: "mute", value: 2 },
      { label: "filter", value: 1 },
      { label: "hide", value: 1 },
    ]);
    const mute = out.moderation.series.find((s) => s.key === "mute");
    expect(mute?.points.map((p) => p.v)).toEqual([1, 1, 0]);
    // Open: cr1, cr2 and cr5 (no verdict, reported account, any date). cr4 has no
    // reported account, cr6 is a tombstone, cr3 has a verdict.
    expect(out.moderation.open).toBe(3);
    // Reports in range: cr1, cr2, cr3, cr4.
    expect(out.moderation.reports).toBe(4);
  });

  it("builds the guild count, member total and size histogram", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readSocial(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.guilds.count).toBe(6);
    expect(out.guilds.members).toBe(52);
    expect(out.guilds.sizeHistogram.buckets).toEqual([
      { label: "1", value: 1 },
      { label: "2-4", value: 2 },
      { label: "5-9", value: 1 },
      { label: "10-19", value: 1 },
      { label: "20+", value: 1 },
    ]);
  });

  it("returns the top-10 boards with the wave B ordering", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readSocial(deps(d1, new FakeAq(POINTS)), RANGE);

    // Rows carry the account id so the dashboard can open the player in lookup.
    expect(out.leaderboards.level).toEqual([
      { name: "Cy", classId: "classic.ranger", value: 70, accountId: "acc-hC" },
      { name: "Bruno", classId: "classic.mage", value: 50, accountId: "acc-hB" },
      { name: "Ana", classId: "classic.warrior", value: 50, accountId: "acc-hA" },
    ]);
    // Best completed run per account: Ana 1250, Dee 900 (Eve never completed).
    expect(out.leaderboards.rift).toEqual([
      { name: "Ana", classId: "classic.warrior", value: 1250, accountId: "accA" },
      { name: "Dee", classId: "classic.warrior", value: 900, accountId: "accD" },
    ]);
    expect(out.leaderboards.arena).toEqual([
      { name: "Cy", classId: "classic.ranger", value: 1400, accountId: "acc-x1" },
      { name: "Ana", classId: "classic.ranger", value: 1100, accountId: "acc-x2" },
      { name: "Bruno", classId: "classic.ranger", value: 1050, accountId: "acc-x3" },
    ]);
  });

  it("queries chat and mod actions in AE with the range and their filters", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    const seen: { metric: string; from: number; to: number; where?: Fields }[] = [];
    const base = new FakeAq(POINTS);
    const spy: AnalyticsQuery = {
      source: "ae",
      totals: (q) => {
        seen.push({
          metric: q.metric,
          from: q.from,
          to: q.to,
          where: (q as { where?: Fields }).where,
        });
        return base.totals(q);
      },
      series: (q) => base.series(q),
      quantiles: () => base.quantiles(),
      distinct: () => base.distinct(),
    };
    await readSocial(deps(d1, spy), RANGE);

    expect(seen.every((c) => c.from === RANGE.from && c.to === RANGE.to)).toBe(true);
    expect(seen.filter((c) => c.metric === "chat.message").map((c) => c.where)).toEqual([
      undefined,
      { outcome: "ok" },
    ]);
  });

  it("gives empty data and ok:false sources when the tables are not migrated", async () => {
    const d1 = new FakeD1();
    const out = await readSocial(deps(d1, new FakeAq(POINTS)), RANGE);

    expect(out.moderation.open).toBe(0);
    expect(out.guilds.count).toBe(0);
    expect(out.leaderboards).toEqual({ level: [], rift: [], arena: [] });
    const d1Sources = out.sources.filter((s) => s.kind === "d1");
    expect(d1Sources.map((s) => s.name).sort()).toEqual([
      "arena_rating",
      "chat_report",
      "classic_hero",
      "guild_index",
      "leaderboard_rift",
    ]);
    expect(d1Sources.every((s) => s.ok === false)).toBe(true);
    // AE still answers.
    expect(out.chat.messages).toBe(7);
  });

  it("marks the AE sources ok:false and does not query when there is no analytics backend", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seed(d1);
    const out = await readSocial(deps(d1, new FakeAq(POINTS, "none")), RANGE);

    const ae = out.sources.filter((s) => s.kind === "local" || s.kind === "ae");
    expect(ae.map((s) => s.name).sort()).toEqual(["chat.message", "mod.action"]);
    expect(ae.every((s) => s.ok === false && s.note === "no analytics backend")).toBe(true);
    expect(out.chat).toMatchObject({ messages: 0, blocked: 0, series: [] });
    expect(out.moderation.actions.buckets).toEqual([]);
    // The D1 parts still answer.
    expect(out.guilds.count).toBe(6);
    expect(SEASON).toBe("2026-s1");
  });
});

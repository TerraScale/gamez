/**
 * Player lookup (admin/metrics/lookup.ts): search paging over account_summary, and
 * the detail with the live AccountDO (wallet, guild) or its D1 fallback, plus the
 * recent events from a fake AnalyticsQuery.
 */
import { currentSeason } from "@gamez/economy";
import type { AdminRange } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import type { MetricName } from "../../src/server/analytics/schema.ts";
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
import type { Env } from "../../src/server/contracts.ts";
import type { MetricsDeps } from "../../src/server/admin/metrics/util.ts";
import {
  decodeCursor,
  encodeCursor,
  readPlayer,
  SEARCH_PAGE,
  searchPlayers,
} from "../../src/server/admin/metrics/lookup.ts";
import { FakeD1 } from "../leaderboards/fake-d1.ts";

const DAY = 86_400_000;
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 28, 12);
const T = Math.floor(NOW / DAY);
const BASE = Date.UTC(2026, 0, 1);
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
}

type Answer = (op: string, q: AnyQuery) => unknown;

/** Canned AnalyticsQuery that records every query. */
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

interface AccountStub {
  wallet: () => Promise<{ balances: { coin: number; gem: number } }>;
  guild: () => Promise<unknown>;
}

/** Env with a fake ACCOUNT namespace; `calls` records every getByName. */
function envWith(stub: (id: string) => AccountStub): { env: Env; calls: string[] } {
  const calls: string[] = [];
  const env = {
    ACCOUNT: {
      getByName: (id: string) => {
        calls.push(id);
        return stub(id);
      },
    },
  } as unknown as Env;
  return { env, calls };
}

const healthyAccount = (): AccountStub => ({
  wallet: async () => ({ balances: { coin: 900, gem: 3 } }),
  guild: async () => ({ guildId: "g1", tag: "GO", role: "member" }),
});

const brokenAccount = (): AccountStub => ({
  wallet: async () => {
    throw new Error("do unreachable");
  },
  guild: async () => {
    throw new Error("do unreachable");
  },
});

function deps(d1: FakeD1, aq: FakeAq, env: Env): MetricsDeps {
  return { env, db: d1.asD1(), aq, analytics: NOOP_ANALYTICS, now: NOW };
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

function pad(i: number): string {
  return `p${String(i).padStart(2, "0")}`;
}

/** 30 "pNN" accounts (created BASE + NN*1000), plus named ones and a tombstone. */
function seedSearch(d1: FakeD1): void {
  for (let i = 0; i < 30; i++) {
    insert(d1, "account_summary", {
      account_id: pad(i),
      display_name: `Player ${i}`,
      kind: "guest",
      created_at: BASE + i * 1000,
    });
  }
  const named: [string, string, number][] = [
    ["alice-1", "Zed", BASE + 200_000],
    ["u7", "Notalice", BASE + 150_000],
    ["x-alice", "Bob", BASE + 120_000],
    ["u8", "Bob", BASE + 110_000],
    ["u9", "ALICE the Bold", BASE + 50_000],
  ];
  for (const [id, name, created] of named) {
    insert(d1, "account_summary", {
      account_id: id,
      display_name: name,
      kind: "email",
      created_at: created,
    });
  }
  insert(d1, "account_summary", {
    account_id: "pdel",
    display_name: "Gone",
    kind: "guest",
    created_at: BASE + 999_999,
    _deleted: 1,
  });
  // p29 was active on day X; the newest account's last activity is reported.
  insert(d1, "account_activity", {
    id: "p29/100",
    account_id: "p29",
    day: 100,
    kind: "guest",
    first_at: 100 * DAY,
  });
  insert(d1, "account_activity", {
    id: "p29/104",
    account_id: "p29",
    day: 104,
    kind: "guest",
    first_at: 104 * DAY,
  });
}

describe("searchPlayers", () => {
  it("answers the newest accounts first, 25 per page, with a keyset cursor", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedSearch(d1);
    const { env } = envWith(healthyAccount);
    const first = await searchPlayers(deps(d1, new FakeAq("ae"), env), "", null);

    expect(first.q).toBe("");
    expect(first.rows).toHaveLength(SEARCH_PAGE);
    expect(first.rows.slice(0, 5).map((r) => r.accountId)).toEqual([
      "alice-1",
      "u7",
      "x-alice",
      "u8",
      "u9",
    ]);
    expect(first.rows[5]!.accountId).toBe("p29");
    expect(first.rows[5]!.createdAt).toBe(BASE + 29_000);
    expect(first.rows[24]!.accountId).toBe("p10");
    // Tombstones are excluded.
    expect(first.rows.some((r) => r.accountId === "pdel")).toBe(false);
    expect(first.next).toBe(encodeCursor(BASE + 10_000, "p10"));

    const second = await searchPlayers(deps(d1, new FakeAq("ae"), env), "", first.next);
    expect(second.rows.map((r) => r.accountId)).toEqual([
      "p09",
      "p08",
      "p07",
      "p06",
      "p05",
      "p04",
      "p03",
      "p02",
      "p01",
      "p00",
    ]);
    expect(second.next).toBeNull();
  });

  it("matches an account id prefix or a case-insensitive display name substring", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedSearch(d1);
    const { env } = envWith(healthyAccount);

    const alice = await searchPlayers(deps(d1, new FakeAq("ae"), env), "alice", null);
    // alice-1 (id prefix), u7 (Notalice) and u9 (ALICE the Bold); "x-alice" is neither.
    expect(alice.rows.map((r) => r.accountId)).toEqual(["alice-1", "u7", "u9"]);
    expect(alice.next).toBeNull();

    const p1 = await searchPlayers(deps(d1, new FakeAq("ae"), env), "p1", null);
    expect(p1.rows.map((r) => r.accountId)).toEqual([
      "p19",
      "p18",
      "p17",
      "p16",
      "p15",
      "p14",
      "p13",
      "p12",
      "p11",
      "p10",
    ]);
  });

  it("reports the last activity day (day start ms) per account, 0 when none", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedSearch(d1);
    const { env } = envWith(healthyAccount);
    const out = await searchPlayers(deps(d1, new FakeAq("ae"), env), "p2", null);
    const p29 = out.rows.find((r) => r.accountId === "p29");
    expect(p29?.lastActiveDay).toBe(104 * DAY);
    const p21 = out.rows.find((r) => r.accountId === "p21");
    expect(p21?.lastActiveDay).toBe(0);
  });

  it("answers the first page for a malformed cursor and an empty result for no match", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedSearch(d1);
    const { env } = envWith(healthyAccount);
    const bad = await searchPlayers(deps(d1, new FakeAq("ae"), env), "", "not-a-cursor");
    expect(bad.rows[0]!.accountId).toBe("alice-1");
    const none = await searchPlayers(deps(d1, new FakeAq("ae"), env), "zzz-nobody", null);
    expect(none).toEqual({ q: "zzz-nobody", rows: [], next: null });
  });

  it("answers no rows when the table is not migrated", async () => {
    const d1 = new FakeD1();
    const { env } = envWith(healthyAccount);
    const out = await searchPlayers(deps(d1, new FakeAq("ae"), env), "", null);
    expect(out).toEqual({ q: "", rows: [], next: null });
  });
});

describe("cursor", () => {
  it("round-trips account ids that contain a colon", () => {
    expect(decodeCursor(encodeCursor(123, "svc:9:x"))).toEqual({
      createdAt: 123,
      accountId: "svc:9:x",
    });
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(":abc")).toBeNull();
    expect(decodeCursor("12:")).toBeNull();
  });
});

/** Fixture of one account with every detail source. */
function seedHero(d1: FakeD1): void {
  insert(d1, "account_summary", {
    account_id: "hero-1",
    display_name: "Hero One",
    kind: "email",
    created_at: (T - 5) * DAY + 8 * H,
    registered_at: (T - 4) * DAY + 9 * H,
  });
  insert(d1, "account_wallet", { account_id: "hero-1", coin: 500, gem: 7, updated_at: 1 });
  insert(d1, "classic_hero", {
    id: "hero-1-a",
    account_id: "hero-1",
    display_name: "Hero One",
    mode: "classic",
    hero_name: "Brenna",
    class_id: "classic.warrior",
    level: 12,
    deepest_depth: 9,
    kills: 40,
    deaths: 2,
    play_ticks: 72_000,
    _updated_at: 2000,
  });
  insert(d1, "classic_hero", {
    id: "hero-1-b",
    account_id: "hero-1",
    display_name: "Hero One",
    mode: "classic",
    hero_name: "Osric",
    class_id: "classic.mage",
    level: 3,
    deepest_depth: 2,
    kills: 4,
    deaths: 0,
    play_ticks: 36_000,
    _updated_at: 1000,
  });
  // Ledger: 60 rows, newest first in the detail (only the last 50 are returned).
  for (let i = 0; i < 60; i++) {
    insert(d1, "economy_ledger", {
      id: `led-${String(i).padStart(2, "0")}`,
      account_id: "hero-1",
      tx_id: `tx-${i}`,
      currency: "coin",
      amount: i,
      flow: "source",
      reason_group: "kill",
      reason: "kill.loot",
      at: BASE + i * 1000,
    });
  }
  insert(d1, "purchase", {
    id: "pur-1",
    account_id: "hero-1",
    sku: "pass.premium.2026-s1",
    provider: "stub",
    currency: "BRL",
    amount_minor: 4990,
    status: "paid",
    created_at: BASE,
    updated_at: BASE + 5,
  });
  insert(d1, "purchase", {
    id: "pur-2",
    account_id: "hero-1",
    sku: "gems.100",
    provider: "stub",
    currency: "BRL",
    amount_minor: 990,
    status: "refunded",
    created_at: BASE + 10,
    updated_at: BASE + 20,
  });
  // Reports against hero-1: two without a verdict (null and ''), one decided.
  insert(d1, "chat_report", { id: "r1", reported_id: "hero-1", at: 1, verdict: null });
  insert(d1, "chat_report", { id: "r2", reported_id: "hero-1", at: 2, verdict: "" });
  insert(d1, "chat_report", { id: "r3", reported_id: "hero-1", at: 3, verdict: "muted" });
  insert(d1, "chat_report", { id: "r4", reported_id: "someone-else", at: 4, verdict: null });
  // Arena: an old season and the current one.
  insert(d1, "arena_rating", {
    id: "old",
    season_id: "season-old",
    account_id: "hero-1",
    rating: 900,
    wins: 1,
    losses: 1,
  });
  insert(d1, "arena_rating", {
    id: "now",
    season_id: currentSeason(NOW).id,
    account_id: "hero-1",
    rating: 1200,
    wins: 3,
    losses: 1,
  });
  insert(d1, "guild_index", { guild_id: "g1", name: "Guild One", tag: "GO", member_count: 3 });
  // Active days: T-1, T-3 and T-40 (only the first two are in the last 30 days).
  for (const day of [T - 1, T - 3, T - 40]) {
    insert(d1, "account_activity", {
      id: `hero-1/${day}`,
      account_id: "hero-1",
      day,
      kind: "email",
      first_at: day * DAY,
    });
  }
}

function recentAnswers(op: string, q: AnyQuery): unknown {
  if (op === "totals" && q.metric === "sim.tally") {
    return [
      { keys: { metric: "kill" }, value: 5 },
      { keys: { metric: "xp" }, value: 1200 },
    ];
  }
  if (op === "totals" && q.metric === "verify.resync") return [{ keys: {}, value: 2 }];
  return [];
}

const RANGE: AdminRange = { from: (T - 1) * DAY, to: (T + 1) * DAY, bucket: "day", bucketMs: DAY };

describe("readPlayer", () => {
  it("returns the detail with the live wallet and guild", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedHero(d1);
    const { env, calls } = envWith(healthyAccount);
    const aq = new FakeAq("ae", recentAnswers);
    const out = await readPlayer(deps(d1, aq, env), "hero-1", RANGE);

    expect(out).not.toBeNull();
    expect(calls).toEqual(["hero-1", "hero-1"]);
    expect(out!.account).toEqual({
      accountId: "hero-1",
      displayName: "Hero One",
      kind: "email",
      createdAt: (T - 5) * DAY + 8 * H,
      lastActiveDay: (T - 1) * DAY,
      registeredAt: (T - 4) * DAY + 9 * H,
    });
    expect(out!.wallet).toEqual({ coin: 900, gem: 3, source: "live" });
    expect(out!.guild).toEqual({ guildId: "g1", name: "Guild One" });
    expect(out!.activeDays30).toBe(2);
    expect(out!.arena).toEqual({
      seasonId: currentSeason(NOW).id,
      rating: 1200,
      wins: 3,
      losses: 1,
    });
    expect(out!.reports).toEqual({ against: 3, open: 2 });
    expect(out!.at).toBe(NOW);
  });

  it("lists heroes with play hours, and the newest 50 ledger and purchase rows", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedHero(d1);
    const { env } = envWith(healthyAccount);
    const out = await readPlayer(deps(d1, new FakeAq("ae", recentAnswers), env), "hero-1", RANGE);

    expect(out!.heroes.map((h) => h.heroName)).toEqual(["Brenna", "Osric"]);
    expect(out!.heroes[0]).toMatchObject({
      mode: "classic",
      classId: "classic.warrior",
      level: 12,
      deepestDepth: 9,
      kills: 40,
      deaths: 2,
      playHours: 1,
      updatedAt: 2000,
    });
    expect(out!.heroes[1]!.playHours).toBeCloseTo(0.5, 10);

    expect(out!.ledger).toHaveLength(50);
    expect(out!.ledger[0]).toEqual({
      at: BASE + 59_000,
      currency: "coin",
      amount: 59,
      flow: "source",
      reason: "kill.loot",
    });
    expect(out!.ledger[49]!.amount).toBe(10);

    expect(out!.purchases.map((p) => p.id)).toEqual(["pur-2", "pur-1"]);
    expect(out!.purchases[0]).toEqual({
      id: "pur-2",
      sku: "gems.100",
      provider: "stub",
      currency: "BRL",
      amountMinor: 990,
      status: "refunded",
      at: BASE + 20,
    });
  });

  it("builds the recent distribution from sim.tally by metric, plus the resync bucket", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedHero(d1);
    const { env } = envWith(healthyAccount);
    const aq = new FakeAq("ae", recentAnswers);
    const out = await readPlayer(deps(d1, aq, env), "hero-1", RANGE);

    expect(out!.recent.key).toBe("recent");
    expect(out!.recent.buckets).toEqual([
      { label: "xp", value: 1200 },
      { label: "kill", value: 5 },
      { label: "resync", value: 2 },
    ]);
    const tally = aq.calls.find((c) => c.q.metric === "sim.tally");
    expect(tally?.q.index).toBe("hero-1");
    expect(tally?.q.groupBy).toEqual(["metric"]);
    const resync = aq.calls.find((c) => c.q.metric === "verify.resync");
    expect(resync?.q.index).toBe("hero-1");
    expect(out!.sources.find((s) => s.name === "sim.tally")).toEqual({
      name: "sim.tally",
      kind: "ae",
      ok: true,
    });
  });

  it("falls back to the D1 wallet and no guild when the AccountDO is unreachable", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedHero(d1);
    const { env } = envWith(brokenAccount);
    const out = await readPlayer(deps(d1, new FakeAq("ae", recentAnswers), env), "hero-1", RANGE);

    expect(out!.wallet).toEqual({ coin: 500, gem: 7, source: "d1" });
    expect(out!.guild).toBeNull();
    const live = out!.sources.filter((s) => s.kind === "live");
    expect(live.map((s) => [s.name, s.ok])).toEqual([
      ["ACCOUNT.wallet", false],
      ["ACCOUNT.guild", false],
    ]);
  });

  it("answers zero wallet with the d1 source when the account has no wallet row", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    insert(d1, "account_summary", {
      account_id: "bare",
      display_name: "Bare",
      kind: "guest",
      created_at: BASE,
    });
    const { env } = envWith(brokenAccount);
    const out = await readPlayer(deps(d1, new FakeAq("none"), env), "bare", RANGE);
    expect(out).not.toBeNull();
    expect(out!.wallet).toEqual({ coin: 0, gem: 0, source: "d1" });
    expect(out!.heroes).toEqual([]);
    expect(out!.guild).toBeNull();
    expect(out!.arena).toBeNull();
    expect(out!.recent.buckets).toEqual([{ label: "resync", value: 0 }]);
    expect(out!.sources.find((s) => s.name === "sim.tally")?.ok).toBe(false);
  });

  it("answers 404 (null) for an unknown account and never creates its DO", async () => {
    const d1 = new FakeD1();
    d1.migrate(MIGRATIONS);
    seedHero(d1);
    const { env, calls } = envWith(healthyAccount);
    const out = await readPlayer(deps(d1, new FakeAq("ae", recentAnswers), env), "nobody", RANGE);
    expect(out).toBeNull();
    expect(calls).toEqual([]);
  });

  it("answers null when the account table is not migrated", async () => {
    const d1 = new FakeD1();
    const { env } = envWith(healthyAccount);
    const out = await readPlayer(deps(d1, new FakeAq("ae", recentAnswers), env), "hero-1", RANGE);
    expect(out).toBeNull();
  });
});

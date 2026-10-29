/**
 * Admin sections A (overview, players, lookup, config): each Component rendered
 * with react-dom/server on full and empty fixtures and a fake SectionContext,
 * plus the pure helpers (status thresholds, retention text, search and detail
 * URLs, tunable validation). Effects do not run in a static render, so the
 * loading states of the self-loading sections are what the markup shows.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type {
  AdminOverview,
  AdminPlayerDetail,
  AdminPlayers,
  AdminRange,
  Distribution,
  Quantiles,
  Series,
  TunableSpec,
} from "@gamez/protocol";
import type { AdminResult } from "../../src/client/admin/api.ts";
import type { SectionContext } from "../../src/client/admin/kit/types.ts";
import {
  overviewSection,
  errorRateStatus,
  syncLagStatus,
  statusWord,
} from "../../src/client/admin/sections/overview.tsx";
import { playersSection } from "../../src/client/admin/sections/players.tsx";
import {
  AccountDetail,
  LookupView,
  formatWhen,
  lookupSearchUrl,
  lookupSection,
  playerDetailUrl,
} from "../../src/client/admin/sections/lookup.tsx";
import {
  auditActorLabel,
  ConfigView,
  configSection,
  draftsFrom,
  parseTunable,
  validateTunables,
} from "../../src/client/admin/sections/config.tsx";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 27);

const RANGE: AdminRange = { from: T0 - 6 * DAY, to: T0 + DAY, bucket: "day", bucketMs: DAY };
const QUANT_EMPTY: Quantiles = { p50: 0, p95: 0, n: 0 };
const DIST_EMPTY = (key: string, label: string): Distribution => ({ key, label, buckets: [] });

function fakeCtx(): SectionContext {
  const fail: AdminResult<never> = {
    ok: false,
    status: 0,
    code: "test",
    message: "no network in tests",
  };
  return {
    token: "test-token",
    range: { from: RANGE.from, to: RANGE.to, bucket: "auto" },
    query: `from=${RANGE.from}&to=${RANGE.to}`,
    days: 7,
    get: async () => fail,
    post: async () => fail,
    setStatus: () => {},
    reload: () => {},
    openPlayer: () => {},
  };
}

const LINE = (key: string, label: string, values: number[]): Series => ({
  key,
  label,
  points: values.map((v, i) => ({ t: RANGE.from + i * DAY, v })),
});

const OVERVIEW_FULL: AdminOverview = {
  at: T0,
  range: RANGE,
  sources: [
    { name: "account_activity", kind: "d1", ok: true },
    { name: "http.request", kind: "ae", ok: false, note: "unavailable" },
  ],
  accounts: { total: 1234, guest: 1000, registered: 234 },
  dau: 42,
  wau: 120,
  mau: 300,
  concurrent: 7,
  revenueMinor24h: { USD: 1250, BRL: 9900 },
  errorRate1h: 0.02,
  syncLagP95Ms: 1500,
  activeSeries: [LINE("dau", "DAU", [5, 9, 42])],
};

const OVERVIEW_EMPTY: AdminOverview = {
  at: T0,
  range: RANGE,
  sources: [],
  accounts: { total: 0, guest: 0, registered: 0 },
  dau: 0,
  wau: 0,
  mau: 0,
  concurrent: 0,
  revenueMinor24h: {},
  errorRate1h: 0,
  syncLagP95Ms: 0,
  activeSeries: [],
};

const DIST = (key: string, label: string, buckets: [string, number][]): Distribution => ({
  key,
  label,
  buckets: buckets.map(([l, value]) => ({ label: l, value })),
});

const PLAYERS_FULL: AdminPlayers = {
  at: T0,
  range: RANGE,
  sources: [{ name: "account_summary", kind: "d1", ok: true }],
  accounts: { total: 500, guest: 400, registered: 100 },
  signups: [LINE("new", "New accounts", [1, 2, 3]), LINE("registered", "Registered", [0, 0, 1])],
  active: [
    LINE("dau", "DAU", [3, 4, 5]),
    LINE("wau", "WAU", [9, 9, 9]),
    LINE("mau", "MAU", [12, 12, 12]),
  ],
  retention: [
    { day: "2026-10-20", size: 8, d1: 0.625, d7: 0.25, d30: null },
    { day: "2026-10-26", size: 3, d1: null, d7: null, d30: null },
  ],
  sessions: {
    perBucket: [LINE("sessions", "Sessions", [10, 20, 30])],
    lengthS: { p50: 300, p95: 1800, n: 42 },
    lengthHistogram: DIST("length", "Session length", [
      ["<1m", 4],
      ["1-5m", 20],
      ["5-15m", 18],
    ]),
  },
  platforms: DIST("platform", "Platform", [
    ["web", 80],
    ["pwa", 20],
  ]),
  devices: DIST("device", "Device", [
    ["desktop", 60],
    ["mobile", 40],
  ]),
  countries: DIST("country", "Country", [
    ["BR", 50],
    ["US", 30],
    ["XX", 2],
  ]),
  continents: DIST("continent", "Continent", [
    ["SA", 60],
    ["NA", 30],
  ]),
};

const PLAYERS_EMPTY: AdminPlayers = {
  at: T0,
  range: RANGE,
  sources: [],
  accounts: { total: 0, guest: 0, registered: 0 },
  signups: [],
  active: [],
  retention: [],
  sessions: {
    perBucket: [],
    lengthS: QUANT_EMPTY,
    lengthHistogram: DIST_EMPTY("length", "Session length"),
  },
  platforms: DIST_EMPTY("platform", "Platform"),
  devices: DIST_EMPTY("device", "Device"),
  countries: DIST_EMPTY("country", "Country"),
  continents: DIST_EMPTY("continent", "Continent"),
};

const DETAIL: AdminPlayerDetail = {
  at: T0,
  account: {
    accountId: "acc_123",
    displayName: "Morrow",
    kind: "registered",
    createdAt: Date.UTC(2026, 9, 1, 8, 15),
    lastActiveDay: T0,
    registeredAt: Date.UTC(2026, 9, 2, 9, 0),
  },
  wallet: { coin: 15000, gem: 42, source: "live" },
  heroes: [
    {
      mode: "classic",
      heroName: "Ashe",
      classId: "rogue",
      level: 12,
      deepestDepth: 7,
      kills: 340,
      deaths: 2,
      playHours: 3.5,
      updatedAt: T0,
    },
  ],
  ledger: [{ at: T0, currency: "coin", amount: -250, flow: "sink", reason: "shop buy" }],
  purchases: [
    {
      id: "p1",
      sku: "gems.100",
      provider: "stripe",
      currency: "USD",
      amountMinor: 499,
      status: "paid",
      at: T0,
    },
  ],
  reports: { against: 3, open: 1 },
  guild: null,
  arena: { seasonId: "s1", rating: 1510, wins: 12, losses: 5 },
  activeDays30: 17,
  recent: DIST("recent", "Recent events", [
    ["sim.tally", 120],
    ["resync", 1],
  ]),
  sources: [{ name: "AccountDO", kind: "live", ok: false, note: "unreachable" }],
};

const SPEC: TunableSpec = {
  key: "classic.offlineXpPct",
  label: "Offline XP",
  description: "XP while offline.",
  min: 0,
  max: 100,
  step: 1,
  default: 20,
  unit: "%",
};

describe("overview section", () => {
  it("keeps its frozen export, id, label, group and load", () => {
    expect(overviewSection.id).toBe("overview");
    expect(overviewSection.label).toBe("Overview");
    expect(overviewSection.group).toBe("Live");
    expect(overviewSection.load).not.toBeNull();
  });

  it("renders the full fixture with the headline numbers and statuses", () => {
    const Comp = overviewSection.Component;
    const html = renderToStaticMarkup(<Comp data={OVERVIEW_FULL} ctx={fakeCtx()} />);
    expect(html).toContain("1,234");
    expect(html).toContain("Guest accounts");
    expect(html).toContain("Registered accounts");
    expect(html).toContain("42");
    expect(html).toContain("USD 12.50");
    expect(html).toContain("BRL 99.00");
    expect(html).toContain("2.0%");
    expect(html).toContain("Warning");
    expect(html).toContain("Good");
    expect(html).toContain("Missing data: http.request (unavailable)");
  });

  it("renders the empty fixture without throwing", () => {
    const Comp = overviewSection.Component;
    const html = renderToStaticMarkup(<Comp data={OVERVIEW_EMPTY} ctx={fakeCtx()} />);
    expect(html).toContain("no paid purchases");
    expect(html).toContain("Error rate, 1 h");
  });

  it("shows a loading line while data is null", () => {
    const Comp = overviewSection.Component;
    expect(renderToStaticMarkup(<Comp data={null} ctx={fakeCtx()} />)).toContain(
      "Loading the overview",
    );
  });

  it("status thresholds: error rate and sync lag, with the boundaries stated in the file", () => {
    expect(errorRateStatus(0.005)).toBe("good");
    expect(errorRateStatus(0.01)).toBe("warning");
    expect(errorRateStatus(0.049)).toBe("warning");
    expect(errorRateStatus(0.05)).toBe("critical");
    expect(errorRateStatus(Number.NaN)).toBe("critical");
    expect(syncLagStatus(5000)).toBe("good");
    expect(syncLagStatus(5001)).toBe("warning");
    expect(syncLagStatus(30000)).toBe("warning");
    expect(syncLagStatus(30001)).toBe("critical");
    expect(statusWord("warning")).toBe("Warning");
  });
});

describe("players section", () => {
  it("keeps its frozen export, id, label, group and load", () => {
    expect(playersSection.id).toBe("players");
    expect(playersSection.label).toBe("Players");
    expect(playersSection.group).toBe("Players");
  });

  it("renders retention with a dash for null cells and the signup note", () => {
    const Comp = playersSection.Component;
    const html = renderToStaticMarkup(<Comp data={PLAYERS_FULL} ctx={fakeCtx()} />);
    expect(html).toContain("2026-10-20");
    expect(html).toContain("62.5%");
    expect(html).toContain("25.0%");
    expect(html).toContain("–");
    expect(html).toContain("migration 0010");
    expect(html).toContain("Session length");
    expect(html).toContain("Sessions without an end");
  });

  it("renders the empty fixture without throwing", () => {
    const Comp = playersSection.Component;
    const html = renderToStaticMarkup(<Comp data={PLAYERS_EMPTY} ctx={fakeCtx()} />);
    expect(html).toContain("Retention");
    expect(html).toContain("Continents");
  });
});

describe("lookup section", () => {
  it("keeps its frozen export, id, label, group and load (null: loads by itself)", () => {
    expect(lookupSection.id).toBe("lookup");
    expect(lookupSection.group).toBe("Players");
    expect(lookupSection.load).toBeNull();
  });

  it("builds the search URL: empty q, encoded q, and the cursor", () => {
    expect(lookupSearchUrl("")).toBe("/api/admin/players/search?q=");
    expect(lookupSearchUrl("  a b  ")).toBe("/api/admin/players/search?q=a%20b");
    expect(lookupSearchUrl("x", "1700:acc_1")).toBe(
      "/api/admin/players/search?q=x&cursor=1700%3Aacc_1",
    );
  });

  it("builds the detail URL with the range query and an encoded id", () => {
    expect(playerDetailUrl("acc_1", "from=1&to=2")).toBe("/api/admin/players/acc_1?from=1&to=2");
    expect(playerDetailUrl("a/b", "x=1")).toBe("/api/admin/players/a%2Fb?x=1");
  });

  it("formats times: 0 is a dash, a real time is UTC", () => {
    expect(formatWhen(0)).toBe("–");
    expect(formatWhen(Date.UTC(2026, 9, 28, 12, 30))).toBe("2026-10-28 12:30 UTC");
  });

  it("renders the search box in its loading state", () => {
    const html = renderToStaticMarkup(<LookupView ctx={fakeCtx()} />);
    expect(html).toContain("Account id or name");
    expect(html).toContain("Searching");
    expect(html).not.toContain("Player detail");
  });

  it("renders the account detail: wallet source, heroes, ledger, purchases and the mute action", () => {
    const html = renderToStaticMarkup(<AccountDetail detail={DETAIL} ctx={fakeCtx()} />);
    expect(html).toContain("Morrow");
    expect(html).toContain("15,000");
    expect(html).toContain("source: live (AccountDO)");
    expect(html).toContain("Ashe");
    expect(html).toContain("shop buy");
    expect(html).toContain("USD 4.99");
    expect(html).toContain("1 open");
    expect(html).toContain("Mute for 60 min");
    expect(html).toContain("Missing data: AccountDO (unreachable)");
  });
});

describe("config section", () => {
  it("shows an admin audit actor as a short id linked to lookup", () => {
    expect(auditActorLabel("admin:83e9ed46-1111-2222-3333-444455556666")).toEqual({
      label: "admin 83e9ed46",
      accountId: "83e9ed46-1111-2222-3333-444455556666",
    });
    expect(auditActorLabel("system")).toEqual({ label: "system", accountId: null });
  });

  it("keeps its frozen export, id, label, group and load (null)", () => {
    expect(configSection.id).toBe("config");
    expect(configSection.label).toBe("Flags & config");
    expect(configSection.group).toBe("Ops");
    expect(configSection.load).toBeNull();
  });

  it("renders the loading states before the flags and tunables arrive", () => {
    const html = renderToStaticMarkup(<ConfigView ctx={fakeCtx()} />);
    expect(html).toContain("Loading flags");
    expect(html).toContain("Loading tunables");
  });

  it("parses a tunable: empty, non-numeric and out-of-range are errors with the message", () => {
    expect(parseTunable(SPEC, "")).toEqual({ ok: false, error: "Offline XP: enter a number" });
    expect(parseTunable(SPEC, "abc")).toEqual({ ok: false, error: "Offline XP: enter a number" });
    expect(parseTunable(SPEC, "101")).toEqual({
      ok: false,
      error: "Offline XP: must be between 0 and 100 %",
    });
    expect(parseTunable(SPEC, "-1")).toEqual({
      ok: false,
      error: "Offline XP: must be between 0 and 100 %",
    });
  });

  it("parses a tunable: valid values pass and snap to the step", () => {
    expect(parseTunable(SPEC, " 20 ")).toEqual({ ok: true, value: 20 });
    expect(parseTunable(SPEC, "100")).toEqual({ ok: true, value: 100 });
    expect(parseTunable(SPEC, "33.4")).toEqual({ ok: true, value: 33 });
    const step5: TunableSpec = { ...SPEC, step: 5 };
    expect(parseTunable(step5, "12.6")).toEqual({ ok: true, value: 15 });
    expect(parseTunable(step5, "99")).toEqual({ ok: true, value: 100 });
  });

  it("validates every spec's draft and keys the errors by tunable", () => {
    expect(validateTunables([SPEC], { "classic.offlineXpPct": "25" })).toEqual({
      ok: true,
      values: { "classic.offlineXpPct": 25 },
    });
    expect(validateTunables([SPEC], { "classic.offlineXpPct": "250" })).toEqual({
      ok: false,
      errors: { "classic.offlineXpPct": "Offline XP: must be between 0 and 100 %" },
    });
  });

  it("drafts fall back to each spec's default when the server has no value", () => {
    expect(draftsFrom([SPEC], undefined)).toEqual({ "classic.offlineXpPct": "20" });
    expect(draftsFrom([SPEC], { "classic.offlineXpPct": 35 })).toEqual({
      "classic.offlineXpPct": "35",
    });
  });
});

/**
 * Admin sections B (gameplay, economy, monetization, social, tech): each
 * Component rendered with react-dom/server on full and empty fixtures, with a
 * fake SectionContext. Moderation actions are tested through their handlers
 * (muteAccount / hideMessage), since static markup has no clicks.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type {
  AdminEconomyDetails,
  AdminGameplay,
  AdminMonetization,
  AdminRange,
  AdminSocial,
  AdminSource,
  AdminTech,
  Distribution,
  EconomyTelemetry,
  Series,
} from "@gamez/protocol";
import type { AdminResult } from "../../src/client/admin/api.ts";
import type { SectionContext } from "../../src/client/admin/kit/index.tsx";
import {
  economySection,
  type EconomySectionData,
} from "../../src/client/admin/sections/economy.tsx";
import { gameplaySection } from "../../src/client/admin/sections/gameplay.tsx";
import { monetizationSection } from "../../src/client/admin/sections/monetization.tsx";
import {
  hideMessage,
  muteAccount,
  socialSection,
  type SocialSectionData,
} from "../../src/client/admin/sections/social.tsx";
import { techSection } from "../../src/client/admin/sections/tech.tsx";
import type { ModerationResponse } from "../../src/server/admin/moderation.ts";

const DAY = 86_400_000;
const FROM = Date.UTC(2026, 9, 21);
const RANGE: AdminRange = { from: FROM, to: FROM + 7 * DAY, bucket: "day", bucketMs: DAY };
const SOURCES: AdminSource[] = [{ name: "gameplay", kind: "ae", ok: true }];

function dist(key: string, buckets: Array<[string, number]>): Distribution {
  return { key, label: key, buckets: buckets.map(([label, value]) => ({ label, value })) };
}

function series(key: string, values: number[]): Series {
  return { key, label: key, points: values.map((v, i) => ({ t: FROM + i * DAY, v })) };
}

const ZERO_QUANTILES = { p50: 0, p95: 0, n: 0 };

function fakeCtx(postResult: AdminResult<unknown> = { ok: true, value: {} }) {
  const rec = {
    gets: [] as string[],
    posts: [] as { path: string; body: unknown }[],
    statuses: [] as string[],
    reloads: 0,
    opened: [] as string[],
  };
  async function get<T>(path: string): Promise<AdminResult<T>> {
    rec.gets.push(path);
    return { ok: false, status: 0, code: "test", message: "not used" };
  }
  async function post<T>(path: string, body: unknown): Promise<AdminResult<T>> {
    rec.posts.push({ path, body });
    return postResult as AdminResult<T>;
  }
  const ctx: SectionContext = {
    token: "test",
    range: { from: FROM, to: FROM + 7 * DAY, bucket: "day" },
    query: `from=${FROM}&to=${FROM + 7 * DAY}`,
    days: 7,
    get,
    post,
    setStatus(message: string) {
      rec.statuses.push(message);
    },
    reload() {
      rec.reloads += 1;
    },
    openPlayer(accountId: string) {
      rec.opened.push(accountId);
    },
  };
  return { ctx, rec };
}

function html(node: ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function gameplayFull(): AdminGameplay {
  return {
    at: FROM,
    range: RANGE,
    sources: SOURCES,
    mode: "classic",
    heroes: {
      total: 42,
      byClass: dist("class", [
        ["Warrior", 20],
        ["Mage", 22],
      ]),
      byLevel: dist("level", [
        ["1-9", 12],
        ["10-19", 30],
      ]),
      byDeepestDepth: dist("depth", [
        ["0", 2],
        ["5", 9],
      ]),
      deepestDepth: 14,
      kills: 9000,
      deaths: 300,
    },
    playtimeHours: { manual: 10.5, auto: 20, idle: 5, offline: 3 },
    playtimeSeries: [series("manual", [3, 4]), series("auto", [5, 6])],
    kills: {
      byMonster: dist("monster", [
        ["Hellbat", 500],
        ["Mirelurk", 120],
      ]),
      byRarity: dist("rarity", [
        ["common", 400],
        ["rare", 100],
      ]),
      series: [series("kills", [200, 300])],
    },
    deaths: {
      byDepth: dist("depth", [["5", 12]]),
      byKiller: dist("killer", [["Hellbat", 7]]),
    },
    bosses: { rows: [{ monster: "Hellbat", spawned: 8, killed: 5, killRate: 0.625 }] },
    quests: {
      funnel: [
        { label: "Accepted", value: 40 },
        { label: "Objective done", value: 25 },
        { label: "Turned in", value: 10 },
      ],
      rows: [{ quest: "First steps", accepted: 40, completed: 10 }],
    },
    rifts: {
      runs: 10,
      completed: 5,
      scoreHistogram: dist("score", [
        ["0-99", 2],
        ["100-199", 3],
      ]),
      bestScore: 180,
    },
    achievements: dist("achievement", [["first-kill", 30]]),
    skills: dist("skill", [["fireball", 12]]),
    talents: dist("talent", [["sharp", 4]]),
    drops: {
      byRarity: dist("rarity", [["common", 300]]),
      perKill: dist("perKill", [["common", 33]]),
    },
    offline: {
      grants: 4,
      hours: 12,
      kills: 60,
      xp: 3000,
      gold: 800,
      items: 9,
      levels: 2,
      series: [series("grants", [1, 3])],
    },
    xpPerHourByBand: dist("band", [["1-9", 1500]]),
    party: null,
  };
}

function gameplayEmpty(): AdminGameplay {
  return {
    at: FROM,
    range: RANGE,
    sources: [],
    mode: "classic",
    heroes: {
      total: 0,
      byClass: dist("class", []),
      byLevel: dist("level", []),
      byDeepestDepth: dist("depth", []),
      deepestDepth: 0,
      kills: 0,
      deaths: 0,
    },
    playtimeHours: { manual: 0, auto: 0, idle: 0, offline: 0 },
    playtimeSeries: [series("manual", [0, 0])],
    kills: { byMonster: dist("monster", []), byRarity: dist("rarity", []), series: [] },
    deaths: { byDepth: dist("depth", []), byKiller: dist("killer", []) },
    bosses: { rows: [] },
    quests: { funnel: [], rows: [] },
    rifts: { runs: 0, completed: 0, scoreHistogram: dist("score", []), bestScore: 0 },
    achievements: dist("achievement", []),
    skills: dist("skill", []),
    talents: dist("talent", []),
    drops: { byRarity: dist("rarity", []), perKill: dist("perKill", []) },
    offline: { grants: 0, hours: 0, kills: 0, xp: 0, gold: 0, items: 0, levels: 0, series: [] },
    xpPerHourByBand: dist("band", []),
    party: { parties: 0, avgSize: 0 },
  };
}

function economyTelemetry(full: boolean): EconomyTelemetry {
  return {
    at: FROM,
    moneySupply: { coin: full ? 1234 : 0, gem: full ? 50 : 0 },
    accounts: full ? 99 : 0,
    flows: [],
    priceIndex: [],
    market: { active: full ? 3 : 0, sold24h: 0, volume24h: 0 },
    shops: { leased: 0, auction: 0, grace: 0 },
    purchases: { paid24h: 0, revenueMinor24h: full ? { USD: 1234 } : {} },
  };
}

function economyDetails(full: boolean, failed = false): AdminEconomyDetails {
  if (!full) {
    return {
      at: FROM,
      range: RANGE,
      sources: failed ? [{ name: "economy_sale", kind: "d1", ok: false, note: "timeout" }] : [],
      goldPerHourByBand: dist("band", []),
      market: {
        sales: 0,
        volume: 0,
        taxes: 0,
        medianPrice: 0,
        series: [series("volume", [0, 0])],
        byCategory: dist("category", []),
        byRarity: dist("rarity", []),
      },
      trades: { count: 0, fees: 0, series: [] },
      shops: { rentPaid: 0, sales: 0, volume: 0, byState: dist("state", []) },
      gems: { bought: 0, spent: 0, supply: 0, series: [] },
      arena: { rewardsCoin: 0, matches: 0, players: 0, ratingHistogram: dist("rating", []) },
      faucets: dist("faucets", []),
      sinks: dist("sinks", []),
    };
  }
  return {
    at: FROM,
    range: RANGE,
    sources: SOURCES,
    goldPerHourByBand: dist("band", [["1-9", 900]]),
    market: {
      sales: 12,
      volume: 4800,
      taxes: 240,
      medianPrice: 350,
      series: [series("volume", [1000, 3800])],
      byCategory: dist("category", [["weapon", 8]]),
      byRarity: dist("rarity", [["rare", 3]]),
    },
    trades: { count: 3, fees: 30, series: [series("trades", [1, 2])] },
    shops: { rentPaid: 500, sales: 4, volume: 900, byState: dist("state", [["leased", 2]]) },
    gems: { bought: 100, spent: 40, supply: 60, series: [series("bought", [100, 0])] },
    arena: {
      rewardsCoin: 700,
      matches: 12,
      players: 5,
      ratingHistogram: dist("rating", [["1000-1099", 2]]),
    },
    faucets: dist("faucets", [["arena.reward", 700]]),
    sinks: dist("sinks", [["market.fee", 120]]),
  };
}

function monetizationFull(): AdminMonetization {
  return {
    at: FROM,
    range: RANGE,
    sources: SOURCES,
    revenueMinor: {
      USD: { stripe: 1234, stub: 0 },
      BRL: { asaas: 9900 },
      EUR: {},
    },
    revenueSeries: [series("USD", [1234, 0]), series("BRL", [0, 9900])],
    purchases: { paid: 3, refunded: 1, pending: 0, failed: 2 },
    bySku: [{ sku: "pass.premium", paid: 2, refunded: 0, revenueMinor: 2468, currency: "USD" }],
    payers: 2,
    arpuMinor: { USD: 425 },
    arppuMinor: { USD: 1000 },
    pass: { seasonId: "s3", players: 200, premium: 50, conversion: 0.25 },
  };
}

function monetizationEmpty(): AdminMonetization {
  return {
    at: FROM,
    range: RANGE,
    sources: [],
    revenueMinor: { USD: {}, BRL: {}, EUR: {} },
    revenueSeries: [],
    purchases: { paid: 0, refunded: 0, pending: 0, failed: 0 },
    bySku: [],
    payers: 0,
    arpuMinor: {},
    arppuMinor: {},
    pass: { seasonId: "s3", players: 0, premium: 0, conversion: 0 },
  };
}

function socialData(full: boolean): SocialSectionData {
  const social: AdminSocial = full
    ? {
        at: FROM,
        range: RANGE,
        sources: SOURCES,
        chat: {
          messages: 120,
          blocked: 4,
          series: [series("ok", [60, 60]), series("blocked", [1, 3])],
          byChannel: dist("channel", [["global", 100]]),
        },
        moderation: {
          open: 2,
          reports: 5,
          actions: dist("action", [["mute", 1]]),
          series: [series("reports", [2, 3])],
        },
        guilds: { count: 3, members: 17, sizeHistogram: dist("size", [["5-9", 2]]) },
        leaderboards: {
          level: [{ name: "Ana", classId: "warrior", value: 42 }],
          rift: [{ name: "Bo", classId: "mage", value: 180 }],
          arena: [{ name: "Cy", classId: "rogue", value: 1450 }],
        },
      }
    : {
        at: FROM,
        range: RANGE,
        sources: [],
        chat: { messages: 0, blocked: 0, series: [], byChannel: dist("channel", []) },
        moderation: { open: 0, reports: 0, actions: dist("action", []), series: [] },
        guilds: { count: 0, members: 0, sizeHistogram: dist("size", []) },
        leaderboards: { level: [], rift: [], arena: [] },
      };
  const moderation: ModerationResponse = full
    ? {
        at: FROM,
        accounts: [
          {
            accountId: "acc-9",
            reports: 2,
            open: 1,
            lastAt: FROM,
            samples: [
              {
                channel: "global",
                messageId: "m1",
                reason: "spam",
                text: "buy now",
                at: FROM,
                verdict: null,
              },
            ],
            verdicts: {},
          },
        ],
      }
    : { at: FROM, accounts: [] };
  return { social, moderation };
}

function techFull(): AdminTech {
  return {
    at: FROM,
    range: RANGE,
    sources: SOURCES,
    requests: [series("2xx", [900, 950]), series("5xx", [2, 1])],
    errors: [series("/api/admin/overview", [1, 0])],
    routes: [
      {
        route: "/api/admin/overview",
        requests: 500,
        errors5xx: 2,
        errors4xx: 10,
        p50Ms: 12,
        p95Ms: 90,
      },
    ],
    websockets: {
      opens: 40,
      byKind: dist("kind", [["instance", 30]]),
      durationS: { p50: 120, p95: 900, n: 40 },
      series: [series("instance", [20, 10])],
    },
    durableObjects: dist("class", [
      ["InstanceDO", 12],
      ["ChunkDO", 3],
    ]),
    verification: {
      segments: 500,
      resyncs: 2,
      byCode: dist("code", [["hash_mismatch", 2]]),
      series: [series("resync", [1, 1])],
    },
    sync: {
      batches: 50,
      records: 400,
      lagMs: { p50: 800, p95: 4000, n: 50 },
      applyMs: { p50: 12, p95: 40, n: 50 },
      dead: 1,
      retries: 3,
      series: [series("ok", [25, 25])],
    },
    d1: {
      queries: 900,
      latencyMs: { p50: 4, p95: 30, n: 900 },
      byLabel: dist("label", [["leaderboard", 300]]),
    },
    client: {
      fps: { p50: 58, p95: 30, n: 20 },
      frameMsP95: { p50: 18, p95: 40, n: 20 },
      loadMs: { p50: 900, p95: 2400, n: 20 },
      errors: [{ build: "b1", kind: "error", messageKey: "x is undefined", count: 4 }],
      builds: dist("build", [["b1", 20]]),
      contentHashes: dist("hash", [["abc123", 20]]),
    },
  };
}

function techEmpty(): AdminTech {
  return {
    at: FROM,
    range: RANGE,
    sources: [],
    requests: [],
    errors: [],
    routes: [],
    websockets: { opens: 0, byKind: dist("kind", []), durationS: ZERO_QUANTILES, series: [] },
    durableObjects: dist("class", []),
    verification: { segments: 0, resyncs: 0, byCode: dist("code", []), series: [] },
    sync: {
      batches: 0,
      records: 0,
      lagMs: ZERO_QUANTILES,
      applyMs: ZERO_QUANTILES,
      dead: 0,
      retries: 0,
      series: [],
    },
    d1: { queries: 0, latencyMs: ZERO_QUANTILES, byLabel: dist("label", []) },
    client: {
      fps: ZERO_QUANTILES,
      frameMsP95: ZERO_QUANTILES,
      loadMs: ZERO_QUANTILES,
      errors: [],
      builds: dist("build", []),
      contentHashes: dist("hash", []),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("section metadata", () => {
  it("keeps ids, labels and groups", () => {
    expect([gameplaySection.id, gameplaySection.label, gameplaySection.group]).toEqual([
      "gameplay",
      "Gameplay",
      "Game",
    ]);
    expect([economySection.id, economySection.group]).toEqual(["economy", "Business"]);
    expect([monetizationSection.id, monetizationSection.group]).toEqual([
      "monetization",
      "Business",
    ]);
    expect([socialSection.id, socialSection.group]).toEqual(["social", "Players"]);
    expect([techSection.id, techSection.group]).toEqual(["tech", "Ops"]);
  });

  it("loads gameplay in classic mode with the range query", async () => {
    const { ctx, rec } = fakeCtx();
    await gameplaySection.load?.(ctx);
    expect(rec.gets[0]).toBe(`/api/admin/gameplay?mode=classic&${ctx.query}`);
  });
});

describe("gameplay section", () => {
  it("renders the full fixture with the key numbers and texts", () => {
    const { ctx } = fakeCtx();
    const out = html(gameplaySection.Component({ data: gameplayFull(), ctx }));
    expect(out).toContain("verified play only");
    expect(out).toContain("Hellbat");
    expect(out).toContain("62.5%"); // boss kill rate 5 / 8
    expect(out).toContain("25.0%"); // quest completion 10 / 40
    expect(out).toContain("50% of runs"); // rifts 5 / 10
    expect(out).toContain("Playtime split");
    expect(out).toContain("Offline progress");
    expect(out).toContain("Drops per 100 kills");
    expect(out).toContain("XP per hour by level band");
    expect(out).not.toMatch(/NaN/);
  });

  it("shows the party empty state when parties are null", () => {
    const { ctx } = fakeCtx();
    const out = html(gameplaySection.Component({ data: gameplayFull(), ctx }));
    expect(out).toContain("Not in the game yet.");
  });

  it("shows party totals when parties exist", () => {
    const { ctx } = fakeCtx();
    const data = { ...gameplayFull(), party: { parties: 3, avgSize: 2.5 } };
    const out = html(gameplaySection.Component({ data, ctx }));
    expect(out).toContain("Average size");
    expect(out).not.toContain("Not in the game yet.");
  });

  it("renders the empty fixture without throwing and with empty states", () => {
    const { ctx } = fakeCtx();
    const out = html(gameplaySection.Component({ data: gameplayEmpty(), ctx }));
    expect(out).toContain("No data in this range yet.");
    expect(out).not.toMatch(/NaN|undefined/);
  });

  it("shows a loading line while data is null", () => {
    const { ctx } = fakeCtx();
    expect(html(gameplaySection.Component({ data: null, ctx }))).toContain("Loading gameplay");
  });
});

describe("economy section", () => {
  it("renders the wave C tiles and the details with money and counts", () => {
    const { ctx } = fakeCtx();
    const data: EconomySectionData = {
      telemetry: economyTelemetry(true),
      details: economyDetails(true),
    };
    const out = html(economySection.Component({ data, ctx }));
    expect(out).toContain("1,234"); // coin in accounts
    expect(out).toContain("USD 12.34"); // revenue 24 h, wave C tile
    expect(out).toContain("4,800"); // market volume
    expect(out).toContain("Gold per hour by level band");
    expect(out).toContain("Sinks (coin destroyed)");
    expect(out).toContain("Arena rating histogram");
    expect(out).not.toMatch(/NaN/);
  });

  it("names failed sources in the note", () => {
    const { ctx } = fakeCtx();
    const data: EconomySectionData = {
      telemetry: economyTelemetry(false),
      details: economyDetails(false, true),
    };
    const out = html(economySection.Component({ data, ctx }));
    expect(out).toContain("economy_sale");
  });

  it("renders the empty fixture without throwing", () => {
    const { ctx } = fakeCtx();
    const data: EconomySectionData = {
      telemetry: economyTelemetry(false),
      details: economyDetails(false),
    };
    const out = html(economySection.Component({ data, ctx }));
    expect(out).toContain("No data in this range yet.");
    expect(out).not.toMatch(/NaN/);
  });
});

describe("monetization section", () => {
  it("formats revenue, ARPU and ARPPU as money in minor units", () => {
    const { ctx } = fakeCtx();
    const out = html(monetizationSection.Component({ data: monetizationFull(), ctx }));
    expect(out).toContain("USD 12.34"); // stripe USD 1234
    expect(out).toContain("BRL 99.00"); // asaas BRL 9900
    expect(out).toContain("USD 24.68"); // by SKU revenue 2468
    expect(out).toContain("USD 4.25"); // ARPU 425
    expect(out).toContain("USD 10.00"); // ARPPU 1000
    expect(out).toContain("Stub (sandbox / test data)");
    expect(out).toContain("All providers");
  });

  it("shows pass conversion and the season", () => {
    const { ctx } = fakeCtx();
    const out = html(monetizationSection.Component({ data: monetizationFull(), ctx }));
    expect(out).toContain("25.0%");
    expect(out).toContain("Season s3");
  });

  it("renders the empty fixture with empty states", () => {
    const { ctx } = fakeCtx();
    const out = html(monetizationSection.Component({ data: monetizationEmpty(), ctx }));
    expect(out).toContain("No data in this range yet.");
    expect(out).toContain("Battle pass");
    expect(out).not.toMatch(/NaN/);
  });
});

describe("social section", () => {
  it("renders chat, moderation and leaderboards", () => {
    const { ctx } = fakeCtx();
    const out = html(socialSection.Component({ data: socialData(true), ctx }));
    expect(out).toContain("Mute 60 min");
    expect(out).toContain("Hide this message");
    expect(out).toContain("acc-9");
    expect(out).toContain("Guild size histogram");
    expect(out).toContain("Top levels");
    expect(out).toContain("Ana");
    expect(out).toContain("1,450");
    expect(out).not.toMatch(/NaN/);
  });

  it("renders the empty fixture without throwing", () => {
    const { ctx } = fakeCtx();
    const out = html(socialSection.Component({ data: socialData(false), ctx }));
    expect(out).toContain("No reports.");
    expect(out).toContain("No data in this range yet.");
    expect(out).not.toMatch(/NaN/);
  });

  it("mute posts the wave B body and reloads on success", async () => {
    const { ctx, rec } = fakeCtx({ ok: true, value: { ok: true, until: 1 } });
    await muteAccount(ctx, "global", "acc-9");
    expect(rec.posts).toEqual([
      {
        path: "/api/admin/mute",
        body: { channel: "global", accountId: "acc-9", minutes: 60 },
      },
    ]);
    expect(rec.statuses).toEqual(["Muted acc-9 in global for 60 minutes."]);
    expect(rec.reloads).toBe(1);
  });

  it("mute reports the failure and does not reload", async () => {
    const { ctx, rec } = fakeCtx({
      ok: false,
      status: 403,
      code: "forbidden",
      message: "Not an admin",
    });
    await muteAccount(ctx, "global", "acc-9");
    expect(rec.statuses).toEqual(["Not an admin"]);
    expect(rec.reloads).toBe(0);
  });

  it("hide posts one message id and reloads on success", async () => {
    const { ctx, rec } = fakeCtx({ ok: true, value: { ok: true, hidden: 1 } });
    await hideMessage(ctx, "global", "m1");
    expect(rec.posts).toEqual([
      { path: "/api/admin/hide", body: { channel: "global", ids: ["m1"] } },
    ]);
    expect(rec.statuses).toEqual(["Message hidden."]);
    expect(rec.reloads).toBe(1);
  });
});

describe("tech section", () => {
  it("renders requests, routes, DO activity and sync health", () => {
    const { ctx } = fakeCtx();
    const out = html(techSection.Component({ data: techFull(), ctx }));
    expect(out).toContain("/api/admin/overview");
    expect(out).toContain("p50 ms");
    expect(out).toContain("DO-slots (10 min)");
    expect(out).toContain("Dead (DLQ inflow)");
    expect(out).toContain("hash_mismatch");
    expect(out).toContain("x is undefined");
    expect(out).toContain("Content hash adoption");
    expect(out).not.toMatch(/NaN/);
  });

  it("renders the empty fixture without throwing", () => {
    const { ctx } = fakeCtx();
    const out = html(techSection.Component({ data: techEmpty(), ctx }));
    expect(out).toContain("No data in this range yet.");
    expect(out).not.toMatch(/NaN/);
  });
});

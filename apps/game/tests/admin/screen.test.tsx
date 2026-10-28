/**
 * Admin dashboard: the loader against a fake fetch, the presentational parts
 * rendered with react-dom/server on fake telemetry, the sidebar shell (layout
 * from state, range and query string, refresh fresh=1, theme attribute,
 * remembered preferences, the NotAdmin flow) and the config SDK. Effects do
 * not run in a static render, so the shell's state model is tested through
 * its pure helpers and AdminLayout; the live flow is covered by the QA runs.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ConfigResponse, EconomyTelemetry } from "@gamez/protocol";
import type { HttpClient, HttpRequest } from "../../src/client/platform/http.ts";
import type { ApiResult } from "@gamez/ui-host";
import { createConfigApi } from "../../src/client/platform/config.ts";
import {
  AdminLayout,
  AdminScreen,
  cachedAge,
  groupSections,
  resolveSection,
  type AdminLayoutProps,
} from "../../src/client/admin/index.tsx";
import {
  adminHash,
  daysOf,
  defaultPrefs,
  PREFS_KEY,
  queryOf,
  rangeOf,
  readPrefs,
  writePrefs,
  type AdminPrefs,
} from "../../src/client/admin/kit/toolbar.tsx";
import type { SectionContext, SectionDef } from "../../src/client/admin/kit/types.ts";
import { SECTIONS } from "../../src/client/admin/sections/index.ts";
import {
  adminRequest,
  checkAdmin,
  isDevHostname,
  loadAdminData,
  makeDevAdmin,
  setFlag,
  type FetchFn,
} from "../../src/client/admin/api.ts";
import {
  EconomyCharts,
  FlagsPanel,
  ModerationPanel,
  NotAdmin,
  Tiles,
} from "../../src/client/admin/dashboard.tsx";
import {
  FlowsChart,
  PriceChart,
  categorySlot,
  fmt,
  niceCeil,
  sourceTotals,
} from "../../src/client/admin/charts.tsx";
import type { ModerationResponse } from "../../src/server/admin/moderation.ts";

const TELEMETRY: EconomyTelemetry = {
  at: Date.UTC(2026, 9, 28),
  moneySupply: { coin: 12_345, gem: 67 },
  accounts: 42,
  flows: [
    { day: "2026-10-27", faucets: { "bank.deposit": 100 }, sinks: { "market.fee": 4 } },
    {
      day: "2026-10-28",
      faucets: { "arena.reward": 30, "pass.reward": 20 },
      sinks: { "shop.rent": 9 },
    },
  ],
  priceIndex: [
    { day: "2026-10-27", category: "weapon", median: 120, volume: 3 },
    { day: "2026-10-28", category: "weapon", median: 150, volume: 5 },
    { day: "2026-10-28", category: "armor", median: 60, volume: 2 },
  ],
  market: { active: 7, sold24h: 5, volume24h: 900 },
  shops: { leased: 3, auction: 1, grace: 0 },
  purchases: { paid24h: 2, revenueMinor24h: { USD: 1999 } },
};

const CONFIG: ConfigResponse = {
  flags: {
    bank: true,
    market: false,
    trade: true,
    shops: true,
    arena: true,
    pass: true,
    store: true,
  },
  seasonId: "s1",
  serverTime: 1,
};

const MODERATION: ModerationResponse = {
  at: 1,
  accounts: [
    {
      accountId: "acc-x",
      reports: 2,
      open: 1,
      lastAt: Date.UTC(2026, 9, 28),
      samples: [
        {
          channel: "global",
          messageId: "m-1",
          reason: "spam",
          text: "<b>buy gold</b>",
          at: Date.UTC(2026, 9, 28),
          verdict: null,
        },
      ],
      verdicts: { open: 1, mute: 1 },
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("loadAdminData", () => {
  it("loads telemetry, moderation and config with the bearer token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      seen.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      if (url === "/api/admin/me") return json({ admin: true, via: "env", devHost: false });
      if (url.startsWith("/api/admin/economy")) return json(TELEMETRY);
      if (url === "/api/admin/moderation") return json(MODERATION);
      return json(CONFIG);
    };
    const res = await loadAdminData(fetchFn, "tok-1", 7);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.telemetry.accounts).toBe(42);
      expect(res.value.moderation.accounts[0]?.accountId).toBe("acc-x");
      expect(res.value.config.flags.market).toBe(false);
    }
    expect(seen.map((s) => s.url)).toContain("/api/admin/economy?days=7");
    expect(seen[0]?.url).toBe("/api/admin/me");
    expect(seen.every((s) => s.auth === "Bearer tok-1")).toBe(true);
  });

  it("asks /api/admin/me first and makes no failing request for a player", async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      seen.push(url);
      return json({ admin: false, devHost: true });
    };
    const res = await loadAdminData(fetchFn, "t", 14);
    expect(res).toEqual({
      ok: false,
      status: 403,
      code: "forbidden",
      message: "admins only",
      devHost: true,
    });
    expect(seen).toEqual(["/api/admin/me"]);
  });

  it("never reads admin data from the HTTP cache", async () => {
    let cache: RequestCache | undefined;
    await adminRequest(
      async (_url, init) => {
        cache = init?.cache;
        return json(CONFIG);
      },
      "t",
      "GET",
      "/api/config",
    );
    expect(cache).toBe("no-store");
  });

  it("reports 403 from economy as not-admin", async () => {
    const fetchFn: FetchFn = async () =>
      json({ error: { code: "forbidden", message: "admins only" } }, 403);
    const res = await loadAdminData(fetchFn, "t", 14);
    expect(res).toEqual({ ok: false, status: 403, code: "forbidden", message: "admins only" });
  });

  it("maps a network failure without throwing", async () => {
    const res = await adminRequest(
      async () => {
        throw new TypeError("offline");
      },
      "t",
      "GET",
      "/api/config",
    );
    expect(res).toMatchObject({ ok: false, code: "network" });
  });

  it("falls back to the HTTP status when the body has no error", async () => {
    const res = await adminRequest(
      async () => new Response("oops", { status: 500 }),
      "",
      "GET",
      "/x",
    );
    expect(res).toMatchObject({ ok: false, status: 500, code: "http_500" });
  });

  it("posts a flag write as the flags body", async () => {
    let body: unknown = null;
    const res = await setFlag(
      async (_url, init) => {
        body = JSON.parse(typeof init?.body === "string" ? init.body : "null");
        return json(CONFIG);
      },
      "t",
      "market",
      false,
    );
    expect(body).toEqual({ flags: { market: false } });
    expect(res.ok).toBe(true);
  });

  it("calls the dev self-grant", async () => {
    let url = "";
    const res = await makeDevAdmin(async (u) => {
      url = u;
      return json({ ok: true, accountId: "a", admin: "dev" });
    }, "t");
    expect(url).toBe("/api/dev/admin/self");
    expect(res.ok).toBe(true);
  });
});

describe("isDevHostname", () => {
  it("matches the dev hosts the server uses", () => {
    expect(isDevHostname("localhost")).toBe(true);
    expect(isDevHostname("127.0.0.1")).toBe(true);
    expect(isDevHostname("mac.tail1234.ts.net")).toBe(true);
    expect(isDevHostname("gamez.example.com")).toBe(false);
  });
});

describe("dashboard rendering", () => {
  it("renders the tiles with formatted numbers", () => {
    const html = renderToStaticMarkup(<Tiles telemetry={TELEMETRY} />);
    expect(html).toContain("12,345");
    expect(html).toContain("Active listings");
    expect(html).toContain("3 / 1 / 0");
    expect(html).toContain("USD 19.99");
  });

  it("gives every chart an accessible name and a legend", () => {
    const html = renderToStaticMarkup(<EconomyCharts telemetry={TELEMETRY} />);
    expect(html).toContain('role="img"');
    expect(html).toContain("Faucets and sinks per day");
    expect(html).toContain("Median sale price per category");
    expect(html).toContain("Faucets (coin created, up)");
    expect(html).toContain("Table view");
  });

  it("breaks faucets and sinks down by source over the window", () => {
    expect(sourceTotals(TELEMETRY.flows, "faucets")).toEqual([
      { source: "bank.deposit", total: 100 },
      { source: "arena.reward", total: 30 },
      { source: "pass.reward", total: 20 },
    ]);
    expect(sourceTotals(TELEMETRY.flows, "sinks")).toEqual([
      { source: "shop.rent", total: 9 },
      { source: "market.fee", total: 4 },
    ]);
    const html = renderToStaticMarkup(<EconomyCharts telemetry={TELEMETRY} />);
    expect(html).toContain("By source");
    expect(html).toContain("arena.reward");
    expect(html).toContain("67%");
  });

  it("uses fixed palette slots per category", () => {
    expect(categorySlot("weapon")).toBe(1);
    expect(categorySlot("armor")).toBe(2);
    expect(categorySlot("other")).toBe(8);
  });

  it("renders an empty price index as text, not an empty chart", () => {
    const html = renderToStaticMarkup(<PriceChart points={[]} days={[]} />);
    expect(html).toContain("No sales in this window yet.");
    expect(html).not.toContain("<svg");
  });

  it("renders flags as text state, not colour alone", () => {
    const html = renderToStaticMarkup(
      <FlagsPanel flags={CONFIG.flags} seasonId="s1" busyFlag={null} onSet={() => {}} />,
    );
    expect(html).toContain("market");
    expect(html).toContain("Off");
    expect(html).toContain("On");
    expect(html).toContain('aria-label="Turn on market"');
    expect(html).not.toContain("Confirm:");
  });

  it("renders moderation with escaped text and a mute action", () => {
    const html = renderToStaticMarkup(
      <ModerationPanel moderation={MODERATION} busy={false} onMute={() => {}} onHide={() => {}} />,
    );
    expect(html).toContain("acc-x");
    expect(html).toContain("&lt;b&gt;buy gold&lt;/b&gt;");
    expect(html).toContain("Mute 60 min");
    expect(html).toContain("Hide this message");
  });

  it("shows the dev button only to a 403 on a dev host", () => {
    const dev = renderToStaticMarkup(
      <NotAdmin status={403} devHost busy={false} onMakeDevAdmin={() => {}} onClose={() => {}} />,
    );
    expect(dev).toContain("Make me admin (dev)");
    const prod = renderToStaticMarkup(
      <NotAdmin
        status={403}
        devHost={false}
        busy={false}
        onMakeDevAdmin={() => {}}
        onClose={() => {}}
      />,
    );
    expect(prod).not.toContain("Make me admin (dev)");
    expect(prod).toContain("Not an admin");
  });

  it("rounds axis tops up to 1, 2 or 5 times a power of ten", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(55_615)).toBe(100_000);
    expect(niceCeil(150)).toBe(200);
    expect(niceCeil(500)).toBe(500);
    expect(niceCeil(0.3)).toBeCloseTo(0.5);
  });

  it("labels the faucet and sink sides with their own extents", () => {
    const html = renderToStaticMarkup(<FlowsChart days={TELEMETRY.flows} label="flows" />);
    expect(html).toContain("+100");
    expect(html).toContain("-10");
    const noSinks = renderToStaticMarkup(
      <FlowsChart days={[{ day: "2026-10-28", faucets: { x: 30 }, sinks: {} }]} label="f" />,
    );
    expect(noSinks).toContain("+50");
    expect(noSinks).not.toMatch(/>-\d/);
  });

  it("formats numbers for the tiles", () => {
    expect(fmt(1234567.4)).toBe("1,234,567");
  });

  it("draws both charts' marks (flows: two bars on the second day)", () => {
    const html = renderToStaticMarkup(<FlowsChart days={TELEMETRY.flows} label="flows" />);
    expect((html.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(3);
    const price = renderToStaticMarkup(
      <PriceChart points={TELEMETRY.priceIndex} days={["2026-10-27", "2026-10-28"]} />,
    );
    expect((price.match(/<circle/g) ?? []).length).toBe(3);
  });
});

describe("AdminScreen shell", () => {
  it("renders the loading state with the header and the tokens", () => {
    const html = renderToStaticMarkup(
      <AdminScreen
        session={{ token: "t", accountId: "a", name: "A" }}
        platform={undefined}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Live ops");
    expect(html).toContain("Loading the dashboard");
    expect(html).toContain("--adm-cat-1");
    expect(html).toContain("Close");
    expect(html).not.toContain("tok-");
    // No section data is shown (or requested) before GET /api/admin/me answers.
    expect(html).not.toContain('aria-label="Section"');
    expect(html).not.toContain('class="adm-nav-group"');
  });

  it("accepts a deep link without throwing", () => {
    const html = renderToStaticMarkup(
      <AdminScreen
        session={{ token: "t", accountId: "a", name: "A" }}
        platform={undefined}
        onClose={() => {}}
        initialSection="lookup"
        initialArg="acc-1"
      />,
    );
    expect(html).toContain('data-testid="admin-screen"');
  });

  it("checkAdmin: admin ok, player 403 with devHost, old server (404) ok", async () => {
    const ok = await checkAdmin(async () => json({ admin: true, devHost: false }), "t");
    expect(ok.ok).toBe(true);
    const player = await checkAdmin(async () => json({ admin: false, devHost: true }), "t");
    expect(player).toMatchObject({ ok: false, status: 403, devHost: true });
    const anon = await checkAdmin(
      async () => json({ error: { code: "unauthorized", message: "log in" } }, 401),
      "",
    );
    expect(anon).toMatchObject({ ok: false, status: 401 });
    const old = await checkAdmin(async () => new Response("", { status: 404 }), "t");
    expect(old).toEqual({ ok: true, value: null });
  });
});

const NOW = Date.UTC(2026, 9, 28, 12, 30, 15);

function fakeCtx(prefs: AdminPrefs, fresh = false): SectionContext {
  const range = rangeOf(prefs, NOW);
  return {
    token: "t",
    range,
    query: queryOf(range, fresh),
    days: daysOf(range),
    get: async () => ({ ok: false, status: 0, code: "test", message: "no fetch in tests" }),
    post: async () => ({ ok: false, status: 0, code: "test", message: "no fetch in tests" }),
    setStatus: () => {},
    reload: () => {},
    openPlayer: () => {},
  };
}

/** The registry's ids, labels, groups and loads, with probe bodies (sections are built elsewhere). */
const FAKE_SECTIONS: SectionDef<unknown>[] = SECTIONS.map((s) => ({
  ...s,
  Component: ({ data }: { data: unknown }) => (
    <p className="probe">
      {s.id} body: {JSON.stringify(data)}
    </p>
  ),
}));

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;");

function layout(over: Partial<AdminLayoutProps> = {}): string {
  const prefs = over.prefs ?? defaultPrefs(NOW);
  const section = FAKE_SECTIONS.find((s) => s.id === prefs.section) ?? FAKE_SECTIONS[0]!;
  const props: AdminLayoutProps = {
    sections: FAKE_SECTIONS,
    prefs,
    section,
    gate: { state: "admin" },
    view: null,
    ctx: fakeCtx(prefs),
    arg: null,
    status: "",
    busy: false,
    devHost: true,
    onSection: () => {},
    onPrefs: () => {},
    onRange: () => {},
    onRefresh: () => {},
    onRetryGate: () => {},
    onMakeDevAdmin: () => {},
    onClose: () => {},
    ...over,
  };
  return renderToStaticMarkup(<AdminLayout {...props} />);
}

describe("sidebar shell", () => {
  it("groups the sections in sidebar order", () => {
    const groups = groupSections(SECTIONS);
    expect(groups.map((g) => g.group)).toEqual(["Live", "Players", "Game", "Business", "Ops"]);
    expect(groups.flatMap((g) => g.sections.map((s) => s.id))).toEqual(
      expect.arrayContaining(SECTIONS.map((s) => s.id)),
    );
    expect(groups.flatMap((g) => g.sections)).toHaveLength(SECTIONS.length);
  });

  it("renders the sidebar, the phone select and the toolbar for an admin", () => {
    const html = layout();
    for (const s of SECTIONS) expect(html).toContain(`>${escapeHtml(s.label)}<`);
    expect(html).toContain('aria-label="Dashboard sections"');
    expect(html).toContain('aria-current="page">Overview<');
    expect(html).toContain('<select aria-label="Section"');
    expect(html).toContain('<optgroup label="Players">');
    expect(html).toContain('aria-pressed="true">7 d<');
    expect(html).toContain("Auto-refresh");
    expect(html).toContain("Refresh");
    expect(html).toContain("Theme");
    expect(html).toContain("Close");
    expect(html).toContain("Loading overview");
  });

  it("marks the open section and shows its data", () => {
    const prefs = { ...defaultPrefs(NOW), section: "tech" };
    const html = layout({
      prefs,
      view: {
        sectionId: "tech",
        status: "ready",
        data: { at: NOW, sources: [{ name: "http.request", kind: "local", ok: true }] },
        loadedAt: NOW + 12_000,
      },
    });
    expect(html).toContain('aria-current="page">Tech health<');
    expect(html).toContain('<h1 class="adm-phone-hidden">Tech health</h1>');
    expect(html).toContain("(cached 12 s)");
    expect(html).toContain('class="adm-body" aria-busy="false"');
    expect(html).toContain("tech body: ");
  });

  it("keeps the previous data dimmed while it reloads, never another section's", () => {
    const prefs = { ...defaultPrefs(NOW), section: "tech" };
    const data = { at: NOW, sources: [] };
    const reloading = layout({ prefs, view: { sectionId: "tech", status: "loading", data } });
    expect(reloading).toContain('aria-busy="true"');
    expect(reloading).toContain("tech body: ");
    const other = layout({ prefs, view: { sectionId: "overview", status: "ready", data } });
    expect(other).not.toContain('class="adm-body"');
    expect(other).not.toContain("tech body");
    expect(other).toContain("Loading tech health");
  });

  it("shows a section error with a retry", () => {
    const html = layout({
      view: { sectionId: "overview", status: "error", data: null, error: "HTTP 500" },
    });
    expect(html).toContain("Overview could not load");
    expect(html).toContain("HTTP 500");
    expect(html).toContain("Try again");
  });

  it("renders self-loading sections without waiting for data", () => {
    const prefs = { ...defaultPrefs(NOW), section: "config" };
    const html = layout({ prefs });
    expect(html).toContain('class="adm-body"');
    expect(html).toContain("config body: null");
    expect(html).not.toContain("Loading flags &amp; config…");
  });

  it("sets the theme on the .adm root (system leaves the page's own)", () => {
    expect(layout({ prefs: { ...defaultPrefs(NOW), theme: "dark" } })).toContain(
      'data-theme="dark"',
    );
    expect(layout({ prefs: { ...defaultPrefs(NOW), theme: "light" } })).toContain(
      'data-theme="light"',
    );
    expect(layout()).not.toMatch(/<div class="adm adm-shell"[^>]*data-theme=/);
    expect(layout()).toContain('.adm[data-theme="dark"]');
  });

  it("keeps the wave C NotAdmin flow: dev self-grant on a dev host, Close, no sections", () => {
    const denied = layout({ gate: { state: "denied", status: 403, devHost: true } });
    expect(denied).toContain("Not an admin");
    expect(denied).toContain("Make me admin (dev)");
    expect(denied).not.toContain('aria-label="Section"');
    expect(denied).not.toContain("Auto-refresh");
    const prod = layout({ gate: { state: "denied", status: 403, devHost: false }, devHost: false });
    expect(prod).not.toContain("Make me admin (dev)");
    const anon = layout({ gate: { state: "denied", status: 401 } });
    expect(anon).toContain("Log in to continue");
    const broken = layout({ gate: { state: "error", message: "Network error, try again" } });
    expect(broken).toContain("Dashboard unavailable");
  });

  it("opens a deep-linked section, else the remembered one, else overview", () => {
    expect(resolveSection("lookup", "tech")).toBe("lookup");
    expect(resolveSection("nope", "tech")).toBe("tech");
    expect(resolveSection(undefined, "gone")).toBe("overview");
  });

  it("reports cache age only for stale responses", () => {
    expect(cachedAge({ at: 1000 }, 3000)).toBeNull();
    expect(cachedAge({ at: 1000 }, 31_000)).toBe(30);
    expect(cachedAge(null, 31_000)).toBeNull();
    expect(cachedAge({ at: "x" }, 31_000)).toBeNull();
  });
});

describe("range and query", () => {
  it("presets end at the load time rounded up to the minute", () => {
    const r = rangeOf({ ...defaultPrefs(NOW), preset: "24h" }, NOW);
    expect(r.to).toBe(Date.UTC(2026, 9, 28, 12, 31));
    expect(r.to - r.from).toBe(86_400_000);
    expect(r.bucket).toBe("auto");
    expect(queryOf(r)).toBe(`from=${r.from}&to=${r.to}`);
    expect(daysOf(r)).toBe(1);
    expect(daysOf(rangeOf({ ...defaultPrefs(NOW), preset: "7d" }, NOW))).toBe(7);
    expect(daysOf(rangeOf({ ...defaultPrefs(NOW), preset: "90d" }, NOW))).toBe(60);
  });

  it("adds bucket and fresh=1 (manual refresh) to the query", () => {
    const r = rangeOf({ ...defaultPrefs(NOW), preset: "30d", bucket: "day" }, NOW);
    expect(queryOf(r)).toContain("&bucket=day");
    expect(queryOf(r, true)).toMatch(/&bucket=day&fresh=1$/);
    expect(fakeCtx({ ...defaultPrefs(NOW), bucket: "hour" }, true).query).toMatch(
      /^from=\d+&to=\d+&bucket=hour&fresh=1$/,
    );
  });

  it("custom ranges cover whole UTC days, swapped when reversed, at most 90 days", () => {
    const base = { ...defaultPrefs(NOW), preset: "custom" as const };
    const r = rangeOf({ ...base, customFrom: "2026-10-01", customTo: "2026-10-07" }, NOW);
    expect(r.from).toBe(Date.UTC(2026, 9, 1));
    expect(r.to).toBe(Date.UTC(2026, 9, 8));
    expect(daysOf(r)).toBe(7);
    const swapped = rangeOf({ ...base, customFrom: "2026-10-07", customTo: "2026-10-01" }, NOW);
    expect(swapped).toEqual(r);
    const long = rangeOf({ ...base, customFrom: "2025-01-01", customTo: "2026-10-27" }, NOW);
    expect(long.to - long.from).toBe(90 * 86_400_000);
  });

  it("builds the deep-link hash", () => {
    expect(adminHash("overview")).toBe("#admin/overview");
    expect(adminHash("lookup", "acc 1/x")).toBe("#admin/lookup/acc%201%2Fx");
  });
});

describe("remembered preferences", () => {
  function memory(initial?: string) {
    const m = new Map<string, string>();
    if (initial !== undefined) m.set(PREFS_KEY, initial);
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  }

  it("round-trips section, range, refresh and theme", () => {
    const s = memory();
    const prefs: AdminPrefs = {
      ...defaultPrefs(NOW),
      section: "economy",
      preset: "custom",
      customFrom: "2026-10-01",
      customTo: "2026-10-10",
      bucket: "day",
      refreshMs: 60_000,
      theme: "dark",
    };
    writePrefs(prefs, s);
    expect(readPrefs(s, NOW)).toEqual(prefs);
  });

  it("drops bad fields and survives broken or missing storage", () => {
    const bad = memory(
      JSON.stringify({
        section: "<script>",
        preset: "1y",
        refreshMs: 7,
        theme: "neon",
        bucket: "x",
      }),
    );
    expect(readPrefs(bad, NOW)).toEqual(defaultPrefs(NOW));
    expect(readPrefs(memory("{not json"), NOW)).toEqual(defaultPrefs(NOW));
    expect(readPrefs(null, NOW)).toEqual(defaultPrefs(NOW));
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPrefs(throwing, NOW)).toEqual(defaultPrefs(NOW));
    expect(() => writePrefs(defaultPrefs(NOW), throwing)).not.toThrow();
  });
});

describe("createConfigApi", () => {
  it("reads GET /api/config through the http client", async () => {
    const calls: unknown[] = [];
    const http: HttpClient = {
      async request<T>(req: HttpRequest): Promise<ApiResult<T>> {
        calls.push(req);
        return { ok: true, value: CONFIG as unknown as T };
      },
    };
    const api = createConfigApi(http);
    const res = await api.get();
    expect(calls).toEqual([{ method: "GET", path: "/api/config" }]);
    expect(res).toEqual({ ok: true, value: CONFIG });
  });
});

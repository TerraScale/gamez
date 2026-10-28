/**
 * Admin dashboard: the loader against a fake fetch, the presentational parts
 * rendered with react-dom/server on fake telemetry, and the config SDK.
 * (Effects do not run in a static render, so the AdminScreen loading state is
 * the only shell case here; the full flow is covered by the e2e and QA runs.)
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ConfigResponse, EconomyTelemetry } from "@gamez/protocol";
import type { HttpClient, HttpRequest } from "../../src/client/platform/http.ts";
import type { ApiResult } from "@gamez/ui-host";
import { createConfigApi } from "../../src/client/platform/config.ts";
import { AdminScreen } from "../../src/client/admin/index.tsx";
import {
  adminRequest,
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
    expect(html).not.toContain("tok-");
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

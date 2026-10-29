import { describe, expect, it } from "vite-plus/test";
import { recordRequest, routeKey, statusClass } from "../../src/server/analytics/http.ts";
import { RecordingAnalytics } from "./fake.ts";

describe("routeKey", () => {
  const table: [string, string][] = [
    ["/ws", "/ws"],
    ["/ws/instance", "/ws/instance"],
    ["/ws/chat", "/ws/chat"],
    ["/api/health", "/api/health"],
    ["/api/me", "/api/me"],
    ["/api/guest", "/api/guest"],
    ["/api/auth/oauth/google/callback", "/api/auth/oauth/:provider/callback"],
    ["/api/admin/players/acc_123", "/api/admin/players/:id"],
    ["/api/admin/players/search", "/api/admin/players/search"],
    ["/api/admin/overview", "/api/admin/overview"],
    ["/api/admin/mute", "/api/admin/mute"],
    ["/api/pay/webhook/stripe", "/api/pay/webhook/:provider"],
    ["/api/pay/webhook/asaas", "/api/pay/webhook/:provider"],
    ["/api/market/buy", "/api/market/buy"],
    ["/api/market/listings/42", "/api/other"],
    ["/api/guilds/mine", "/api/guilds/mine"],
    ["/api/guilds/g-123", "/api/guilds/:id"],
    ["/api/guilds/g-123/join", "/api/guilds/:id/join"],
    ["/api/trade/t9/accept", "/api/trade/:id/accept"],
    ["/api/shops/plots/bid", "/api/shops/plots/bid"],
    ["/api/shops/classic-town/plot-3", "/api/shops/:world/:plotId"],
    ["/api/shops/classic-town/plot-3/buy", "/api/shops/:world/:plotId/:action"],
    ["/api/arena/queue/ticket-1", "/api/arena/queue/:ticket"],
    ["/api/arena/match/m1", "/api/arena/match/:id"],
    ["/api/dev/presence/stats", "/api/dev/presence/stats"],
    ["/api/nope", "/api/other"],
    ["/api/nope/deeper/still", "/api/other"],
    ["/api", "/api/other"],
    ["/api/me/", "/api/me"],
    ["/", "/app"],
    ["/assets/index-abc.js", "/app"],
    ["/admin", "/app"],
  ];
  for (const [path, key] of table) {
    it(`${path} -> ${key}`, () => {
      expect(routeKey(path)).toBe(key);
    });
  }

  it("never returns a raw id", () => {
    const keys = ["acc_1", "9999", "3f2a9c1e-0000-4000-8000-000000000001"].map((id) =>
      routeKey(`/api/admin/players/${id}`),
    );
    expect(new Set(keys)).toEqual(new Set(["/api/admin/players/:id"]));
  });
});

describe("statusClass", () => {
  it("buckets by hundreds, with 101 on its own", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(204)).toBe("2xx");
    expect(statusClass(301)).toBe("3xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(401)).toBe("4xx");
    expect(statusClass(500)).toBe("5xx");
    expect(statusClass(101)).toBe("101");
  });

  it("counts out-of-range statuses as 5xx", () => {
    expect(statusClass(100)).toBe("5xx");
    expect(statusClass(600)).toBe("5xx");
  });
});

function req(method: string, country?: string): Request {
  const r = new Request("https://gamez.test/api/me", { method: "GET" });
  return {
    method,
    url: r.url,
    cf: country === undefined ? undefined : { country },
  } as unknown as Request;
}

describe("recordRequest", () => {
  it("writes one http.request point with route, status class, country and timing", () => {
    const a = new RecordingAnalytics();
    const url = new URL("https://gamez.test/api/admin/players/acc_9");
    recordRequest(a, req("GET", "BR"), url, new Response("{}", { status: 200 }), 12.5);
    expect(a.points).toEqual([
      {
        metric: "http.request",
        blobs: {
          route: "/api/admin/players/:id",
          method: "GET",
          statusClass: "2xx",
          country: "BR",
        },
        doubles: { ms: 12.5, status: 200 },
        index: undefined,
      },
    ]);
  });

  it("uses XX when the country is missing or malformed", () => {
    const a = new RecordingAnalytics();
    const url = new URL("https://gamez.test/api/me");
    recordRequest(a, req("GET"), url, new Response(null, { status: 204 }), 1);
    recordRequest(a, req("GET", "bra zil"), url, new Response(null, { status: 204 }), 1);
    expect(a.of("http.request").map((p) => p.blobs.country)).toEqual(["XX", "XX"]);
  });

  it("counts a thrown handler (null response) as a 500", () => {
    const a = new RecordingAnalytics();
    recordRequest(a, req("POST"), new URL("https://gamez.test/api/me"), null, 3);
    const [p] = a.of("http.request");
    expect(p?.blobs.statusClass).toBe("5xx");
    expect(p?.doubles.status).toBe(500);
    expect(p?.blobs.method).toBe("POST");
  });

  it("records 101 upgrades as their own class", () => {
    const a = new RecordingAnalytics();
    recordRequest(a, req("GET"), new URL("https://gamez.test/ws"), { status: 101 } as Response, 0);
    expect(a.of("http.request")[0]?.blobs).toMatchObject({ route: "/ws", statusClass: "101" });
  });

  it("bounds the method blob", () => {
    const a = new RecordingAnalytics();
    recordRequest(a, req("PURGE"), new URL("https://gamez.test/api/me"), new Response(null), 1);
    expect(a.of("http.request")[0]?.blobs.method).toBe("OTHER");
  });

  it("never throws, even when the writer does", () => {
    const boom = {
      write() {
        throw new Error("nope");
      },
      flush: () => Promise.resolve(),
    };
    expect(() =>
      recordRequest(boom, req("GET"), new URL("https://gamez.test/api/me"), new Response(), 1),
    ).not.toThrow();
  });
});

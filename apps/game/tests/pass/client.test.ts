/**
 * The pass SDK (apps/game/src/client/platform/pass.ts) over the real HTTP
 * client, with a fake fetch: paths, methods, bearer token, bodies and errors.
 */
import { describe, expect, it } from "vite-plus/test";
import type { PassView } from "@gamez/protocol";
import { createPassApi } from "../../src/client/platform/pass.ts";
import { createHttp, type FetchFn } from "../../src/client/platform/http.ts";

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function fakeFetch(respond: (seen: Seen) => Response | Error): { fetch: FetchFn; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: FetchFn = async (input, init) => {
    const headers = new Headers(init?.headers);
    const entry: Seen = {
      url: input,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    seen.push(entry);
    const out = respond(entry);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetch, seen };
}

const VIEW: PassView = {
  seasonId: "2026-s1",
  name: "Season of Embers",
  startsAt: 1,
  endsAt: 2,
  xp: 300,
  tier: 2,
  premium: false,
  premiumSku: "pass.premium.2026-s1",
  tiers: [],
  claimed: { free: [1], premium: [] },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createPassApi", () => {
  it("GETs /api/pass with the bearer token and returns the view", async () => {
    const { fetch, seen } = fakeFetch(() => json(VIEW));
    const api = createPassApi(createHttp({ token: () => "tok-1", fetch }));
    const res = await api.view();
    expect(res).toEqual({ ok: true, value: VIEW });
    expect(seen).toEqual([
      { url: "/api/pass", method: "GET", auth: "Bearer tok-1", body: undefined },
    ]);
  });

  it("POSTs the claim body to /api/pass/claim", async () => {
    const { fetch, seen } = fakeFetch(() =>
      json({ ...VIEW, claimed: { free: [1, 2], premium: [] } }),
    );
    const api = createPassApi(createHttp({ token: () => null, fetch }));
    const res = await api.claim(2, "free");
    expect(res.ok && res.value.claimed.free).toEqual([1, 2]);
    expect(seen).toEqual([
      { url: "/api/pass/claim", method: "POST", auth: null, body: { tier: 2, track: "free" } },
    ]);
  });

  it("POSTs a premium purchase with an opId (generated when absent)", async () => {
    const { fetch, seen } = fakeFetch(() => json({ ...VIEW, premium: true }));
    const api = createPassApi(createHttp({ token: () => "t", fetch }));
    const res = await api.premium!("op-premium-1");
    expect(res.ok && res.value.premium).toBe(true);
    expect(seen[0]).toMatchObject({
      url: "/api/pass/premium",
      method: "POST",
      body: { opId: "op-premium-1" },
    });
    await api.premium!();
    const generated = (seen[1]!.body as { opId: string }).opId;
    expect(generated).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("maps a server error body to its code and message", async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { code: "too_low", message: "reach tier 3 first" } }, 400),
    );
    const api = createPassApi(createHttp({ token: () => "t", fetch }));
    expect(await api.claim(3, "free")).toEqual({
      ok: false,
      code: "too_low",
      message: "reach tier 3 first",
    });
  });

  it("maps a 403 premium refusal", async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { code: "forbidden", message: "premium needed" } }, 403),
    );
    const api = createPassApi(createHttp({ token: () => "t", fetch }));
    const res = await api.claim(1, "premium");
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("reports a network failure without throwing", async () => {
    const { fetch } = fakeFetch(() => new TypeError("offline"));
    const api = createPassApi(createHttp({ token: () => "t", fetch }));
    expect(await api.view()).toEqual({
      ok: false,
      code: "network",
      message: "Network error, try again",
    });
  });

  it("reports an unauthenticated view as unauthorized", async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { code: "unauthorized", message: "sign in first" } }, 401),
    );
    const api = createPassApi(createHttp({ token: () => null, fetch }));
    expect(await api.view()).toEqual({ ok: false, code: "unauthorized", message: "sign in first" });
  });
});

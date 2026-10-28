/**
 * ArenaApi client SDK (apps/game/src/client/platform/arena.ts) over a fake
 * fetch: paths, methods, opId generation and reuse, query encoding, error
 * mapping and the wrong-shape guard.
 */
import { describe, expect, it } from "vite-plus/test";
import { createHttp, type FetchFn } from "../../src/client/platform/http.ts";
import { createArenaApi } from "../../src/client/platform/arena.ts";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records requests and answers with the given status and body. */
function fakeFetch(answer: { status?: number; body?: unknown } | "network") {
  const sent: Sent[] = [];
  const fetch: FetchFn = async (url, init) => {
    if (answer === "network") throw new TypeError("offline");
    sent.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const status = answer.status ?? 200;
    const text = answer.body === undefined ? "" : JSON.stringify(answer.body);
    return new Response(text, { status });
  };
  return { fetch, sent };
}

function api(answer: Parameters<typeof fakeFetch>[0], token: string | null = "tok-1") {
  const f = fakeFetch(answer);
  const arena = createArenaApi(createHttp({ token: () => token, fetch: f.fetch }));
  return { arena, sent: f.sent };
}

const ticket = { ticket: "2026-s1.0123456789abcdef", status: "waiting", match: null, reason: null };
const status = {
  seasonId: "2026-s1",
  rating: 1000,
  wins: 0,
  losses: 0,
  draws: 0,
  registered: true,
  fightsLeftToday: 20,
  ticket: null,
  recent: [],
};

describe("status", () => {
  it("GETs /api/arena/status with the bearer token", async () => {
    const { arena, sent } = api({ body: status });
    const res = await arena.status();
    expect(res).toEqual({ ok: true, value: status });
    expect(sent[0]!.url).toBe("/api/arena/status");
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.headers.authorization).toBe("Bearer tok-1");
  });

  it("maps a 401 to its error code", async () => {
    const { arena } = api({
      status: 401,
      body: { error: { code: "unauthorized", message: "sign in first" } },
    });
    expect(await arena.status()).toEqual({
      ok: false,
      code: "unauthorized",
      message: "sign in first",
    });
  });

  it("answers bad_response for a body of the wrong shape", async () => {
    const { arena } = api({ body: { nope: true } });
    expect((await arena.status()).ok).toBe(false);
    expect(await arena.status()).toMatchObject({ ok: false, code: "bad_response" });
  });
});

describe("queue", () => {
  it("POSTs the given opId and mode and returns the ticket", async () => {
    const { arena, sent } = api({ status: 202, body: ticket });
    const res = await arena.queue("classic", "op-given-0001");
    expect(res).toEqual({ ok: true, value: ticket });
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url).toBe("/api/arena/queue");
    expect(sent[0]!.body).toEqual({ opId: "op-given-0001", mode: "classic" });
  });

  it("generates a valid opId when none is passed", async () => {
    const { arena, sent } = api({ status: 202, body: ticket });
    await arena.queue();
    const body = sent[0]!.body as { opId: string; mode: string };
    expect(body.opId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(body.mode).toBe("classic");
  });

  it("answers the not_eligible error of a player without a hero", async () => {
    const { arena } = api({
      status: 409,
      body: {
        error: { code: "not_eligible", message: "Play classic first: your hero fights as a ghost" },
      },
    });
    const res = await arena.queue();
    expect(res).toEqual({
      ok: false,
      code: "not_eligible",
      message: "Play classic first: your hero fights as a ghost",
    });
  });

  it("reports a network failure without throwing", async () => {
    const { arena } = api("network");
    expect(await arena.queue("classic", "op-net-000001")).toMatchObject({
      ok: false,
      code: "network",
    });
  });
});

describe("poll, match and ladder", () => {
  it("polls a ticket with its id encoded in the path", async () => {
    const matched = { ...ticket, status: "matched", match: { id: "2026-s1.aaaaaaaaaaaaaaaa" } };
    const { arena, sent } = api({ body: matched });
    const res = await arena.poll(ticket.ticket);
    expect(res.ok && res.value.status).toBe("matched");
    expect(sent[0]!.url).toBe(`/api/arena/queue/${encodeURIComponent(ticket.ticket)}`);
    expect(sent[0]!.method).toBe("GET");
  });

  it("fetches a match by id", async () => {
    const { arena, sent } = api({ body: { id: "2026-s1.aaaaaaaaaaaaaaaa", winner: "draw" } });
    const res = await arena.match("2026-s1.aaaaaaaaaaaaaaaa");
    expect(res.ok && res.value.id).toBe("2026-s1.aaaaaaaaaaaaaaaa");
    expect(sent[0]!.url).toBe("/api/arena/match/2026-s1.aaaaaaaaaaaaaaaa");
  });

  it("sends the ladder query and accepts the D1 shape", async () => {
    const ladder = { seasonId: "2026-s1", rows: [], available: false };
    const { arena, sent } = api({ body: ladder });
    const res = await arena.ladder({ mode: "classic", classId: "classic.rogue", limit: 5 });
    expect(res).toEqual({ ok: true, value: ladder });
    expect(sent[0]!.url).toBe("/api/arena/ladder?mode=classic&classId=classic.rogue&limit=5");
  });

  it("rejects a ladder body without rows", async () => {
    const { arena } = api({ body: { seasonId: "2026-s1" } });
    expect(await arena.ladder()).toMatchObject({ ok: false, code: "bad_response" });
  });
});

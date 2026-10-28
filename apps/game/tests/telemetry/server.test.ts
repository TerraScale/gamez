/**
 * POST /api/telemetry (routes/telemetry.ts): status paths, enum validation,
 * length bands, geography, no account ids in points, rate limit, touch once per hour.
 */
import { describe, expect, it } from "vite-plus/test";
import type { Analytics } from "../../src/server/analytics/index.ts";
import { signToken } from "../../src/server/auth.ts";
import { IpLimiter } from "../../src/server/auth/limiter.ts";
import type { Env } from "../../src/server/contracts.ts";
import {
  handleTelemetry,
  lengthBand,
  makeTouch,
  TouchGate,
  TOUCH_EVERY_MS,
  type TelemetryDeps,
} from "../../src/server/routes/telemetry.ts";

const SID = "abcd-1234-efgh-5678";
const SECRET = "telemetry-test-secret";
const ACCOUNT = "acc-secret-42";

interface Written {
  metric: string;
  blobs: Record<string, string | undefined>;
  doubles: Record<string, number | undefined>;
  index: string | undefined;
}

function recorder(): Analytics & { points: Written[] } {
  const points: Written[] = [];
  return {
    points,
    write(metric, blobs, doubles, index) {
      points.push({
        metric,
        blobs: { ...(blobs as Record<string, string>) },
        doubles: { ...(doubles as Record<string, number>) },
        index,
      });
    },
    flush: () => Promise.resolve(),
  };
}

function open(limiter = new IpLimiter({ burst: 1000, perSecond: 1000 })) {
  const analytics = recorder();
  const pending: Promise<unknown>[] = [];
  const touches: { request: Request; now: number }[] = [];
  const deps: TelemetryDeps = {
    analytics,
    now: () => 1_000_000,
    touch: (request, now) => {
      touches.push({ request, now });
    },
    limiter,
    waitUntil: (p) => pending.push(p),
  };
  return {
    analytics,
    touches,
    deps,
    async settle() {
      await Promise.all(pending);
    },
  };
}

function req(body: unknown, init: { method?: string; cf?: Record<string, string> } = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const request = new Request("http://localhost/api/telemetry", {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: init.method === "GET" ? undefined : text,
  });
  if (init.cf) Object.defineProperty(request, "cf", { value: init.cf });
  return request;
}

function batch(events: unknown[], extra: Record<string, unknown> = {}) {
  return { v: 1, sid: SID, build: "build-1", contentHash: "hash-1", events, ...extra };
}

describe("status paths", () => {
  it("answers 405 for non-POST", async () => {
    const t = open();
    const res = await handleTelemetry(req(undefined, { method: "GET" }), t.deps);
    expect(res.status).toBe(405);
    expect(t.analytics.points).toHaveLength(0);
  });

  it("answers 400 for an empty object and for bad JSON", async () => {
    const t = open();
    expect((await handleTelemetry(req({}), t.deps)).status).toBe(400);
    expect((await handleTelemetry(req("{nope"), t.deps)).status).toBe(400);
    expect((await handleTelemetry(req([]), t.deps)).status).toBe(400);
  });

  it("answers 400 for a wrong version, sid, build, contentHash or event count", async () => {
    const t = open();
    const cases: Record<string, unknown>[] = [
      batch([], { v: 2 }),
      batch([], { sid: "short" }),
      batch([], { sid: "has space in it!" }),
      batch([], { sid: "x".repeat(65) }),
      batch([], { build: "b".repeat(41) }),
      batch([], { contentHash: "h".repeat(65) }),
      batch(
        Array.from({ length: 21 }, () => ({
          k: "session.heartbeat",
          elapsedS: 1,
          mode: "",
          visible: true,
        })),
      ),
    ];
    for (const body of cases) {
      expect((await handleTelemetry(req(body), t.deps)).status).toBe(400);
    }
    expect(t.analytics.points).toHaveLength(0);
  });

  it("answers 413 for a body above maxBodyBytes", async () => {
    const t = open();
    const big = batch([{ k: "error", kind: "error", message: "x".repeat(9000) }]);
    expect((await handleTelemetry(req(big), t.deps)).status).toBe(413);
    expect(t.analytics.points).toHaveLength(0);
  });

  it("answers 204 for an accepted batch, and for one with only unknown events", async () => {
    const t = open();
    expect((await handleTelemetry(req(batch([{ k: "mystery" }])), t.deps)).status).toBe(204);
    expect(
      (
        await handleTelemetry(
          req(batch([{ k: "session.heartbeat", elapsedS: 5, mode: "classic", visible: true }])),
          t.deps,
        )
      ).status,
    ).toBe(204);
  });

  it("answers 204 for a batch whose events are partly invalid", async () => {
    const t = open();
    const res = await handleTelemetry(
      req(
        batch([
          { k: "session.start", loadMs: "fast" },
          { k: "perf", fpsP50: 60 },
          null,
          7,
          { k: "error", kind: "error", message: "ok" },
        ]),
      ),
      t.deps,
    );
    expect(res.status).toBe(204);
    expect(t.analytics.points.map((p) => p.metric)).toEqual(["client.error"]);
  });
});

describe("enum validation", () => {
  it("coerces unknown platform and device on session.start, and skips unknown kinds", async () => {
    const t = open();
    await handleTelemetry(
      req(batch([{ k: "session.start", platform: "toaster", device: "fridge", loadMs: 800 }])),
      t.deps,
    );
    const [p] = t.analytics.points;
    expect(p?.metric).toBe("client.session");
    expect(p?.blobs.phase).toBe("start");
    expect(p?.blobs.platform).toBe("web");
    expect(p?.blobs.device).toBe("desktop");
    expect(p?.doubles.loadMs).toBe(800);
  });

  it("keeps valid platform and device values", async () => {
    const t = open();
    await handleTelemetry(
      req(batch([{ k: "session.start", platform: "ios", device: "tablet", loadMs: 1 }])),
      t.deps,
    );
    expect(t.analytics.points[0]?.blobs.platform).toBe("ios");
    expect(t.analytics.points[0]?.blobs.device).toBe("tablet");
  });

  it("coerces an unknown error kind to error and drops invalid modes", async () => {
    const t = open();
    await handleTelemetry(
      req(
        batch([
          { k: "error", kind: "explosion", message: "boom" },
          { k: "session.heartbeat", elapsedS: 3, mode: "<script>", visible: true },
        ]),
      ),
      t.deps,
    );
    expect(t.analytics.points[0]?.blobs.kind).toBe("error");
    expect(t.analytics.points[1]?.blobs.mode).toBe("");
  });
});

describe("lengthBand", () => {
  it("maps the session length to the documented bands", () => {
    expect(lengthBand(0)).toBe("<1m");
    expect(lengthBand(59)).toBe("<1m");
    expect(lengthBand(60)).toBe("1-5m");
    expect(lengthBand(299)).toBe("1-5m");
    expect(lengthBand(300)).toBe("5-15m");
    expect(lengthBand(899)).toBe("5-15m");
    expect(lengthBand(900)).toBe("15-30m");
    expect(lengthBand(1799)).toBe("15-30m");
    expect(lengthBand(1800)).toBe("30-60m");
    expect(lengthBand(3599)).toBe("30-60m");
    expect(lengthBand(3600)).toBe("1-2h");
    expect(lengthBand(7199)).toBe("1-2h");
    expect(lengthBand(7200)).toBe("2h+");
    expect(lengthBand(90_000)).toBe("2h+");
  });

  it("is written on session.end points only", async () => {
    const t = open();
    await handleTelemetry(
      req(batch([{ k: "session.end", elapsedS: 1900, mode: "classic" }])),
      t.deps,
    );
    const [p] = t.analytics.points;
    expect(p?.blobs.phase).toBe("end");
    expect(p?.blobs.lengthBand).toBe("30-60m");
    expect(p?.doubles.elapsedS).toBe(1900);
  });
});

describe("points", () => {
  it("indexes every point by sid and never by an account id", async () => {
    const t = open();
    await handleTelemetry(
      req(
        batch([
          { k: "session.start", platform: "pwa", device: "mobile", loadMs: 1200 },
          { k: "session.heartbeat", elapsedS: 60, mode: "classic", visible: true },
          {
            k: "perf",
            mode: "classic",
            fpsP50: 60,
            fpsP95: 40,
            frameMsP95: 25,
            samples: 500,
            heapMb: 80,
          },
          { k: "error", kind: "render", message: "Cannot read x" },
        ]),
        { cf: { country: "BR", continent: "SA" } },
      ),
      t.deps,
    );
    expect(t.analytics.points.map((p) => p.metric)).toEqual([
      "client.session",
      "client.session",
      "client.perf",
      "client.error",
    ]);
    for (const p of t.analytics.points) {
      expect(p.index).toBe(SID);
      const values = [...Object.values(p.blobs), ...Object.keys(p.blobs)];
      expect(values.some((v) => typeof v === "string" && v.includes(ACCOUNT))).toBe(false);
    }
  });

  it("takes country and continent from request.cf, or XX when missing", async () => {
    const withGeo = open();
    await handleTelemetry(
      req(batch([{ k: "session.heartbeat", elapsedS: 1, mode: "", visible: false }]), {
        cf: { country: "DE", continent: "EU" },
      }),
      withGeo.deps,
    );
    expect(withGeo.analytics.points[0]?.blobs.country).toBe("DE");
    expect(withGeo.analytics.points[0]?.blobs.continent).toBe("EU");

    const noGeo = open();
    await handleTelemetry(
      req(batch([{ k: "session.heartbeat", elapsedS: 1, mode: "", visible: false }])),
      noGeo.deps,
    );
    expect(noGeo.analytics.points[0]?.blobs.country).toBe("XX");
    expect(noGeo.analytics.points[0]?.blobs.continent).toBe("XX");
  });

  it("re-truncates the error messageKey to 120 characters", async () => {
    const t = open();
    await handleTelemetry(
      req(batch([{ k: "error", kind: "error", message: "m".repeat(300) }])),
      t.deps,
    );
    expect(t.analytics.points[0]?.blobs.messageKey).toHaveLength(120);
  });
});

describe("privacy", () => {
  it("scrubs e-mails, tokens and digits from error messages server-side", async () => {
    const t = open();
    await handleTelemetry(
      req(
        batch([
          {
            k: "error",
            kind: "error",
            message: "crash for player@example.com token abcdef1234 at 555 Main St id 987654",
          },
        ]),
      ),
      t.deps,
    );
    const key = String(t.analytics.points[0]?.blobs.messageKey);
    expect(key).toBe("crash for <email> token <id> at # Main St id #");
    expect(key).not.toMatch(/\d|@/);
  });

  it("stores an unknown build label as 'other'", async () => {
    const t = open();
    await handleTelemetry(
      req(batch([{ k: "error", kind: "error", message: "x" }], { build: "has space!" })),
      t.deps,
    );
    expect(t.analytics.points[0]?.blobs.build).toBe("other");
  });
});

describe("rate limit", () => {
  it("answers 429 once the per-IP bucket is empty", async () => {
    const limiter = new IpLimiter({ burst: 2, perSecond: 0 });
    const t = open(limiter);
    const body = batch([{ k: "error", kind: "error", message: "one" }]);
    expect((await handleTelemetry(req(body), t.deps)).status).toBe(204);
    expect((await handleTelemetry(req(body), t.deps)).status).toBe(204);
    const limited = await handleTelemetry(req(body), t.deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
    expect(t.analytics.points).toHaveLength(2);
  });

  it("answers 413 (not 429) for an oversize body even when the bucket is empty", async () => {
    const limiter = new IpLimiter({ burst: 0, perSecond: 0 });
    const t = open(limiter);
    const text = JSON.stringify(batch([{ k: "error", kind: "error", message: "x".repeat(9000) }]));
    const request = new Request("http://localhost/api/telemetry", {
      method: "POST",
      headers: { "content-length": String(text.length), "cf-connecting-ip": "203.0.113.9" },
      body: text,
    });
    expect((await handleTelemetry(request, t.deps)).status).toBe(413);
  });
});

describe("touch", () => {
  const gate = () => new TouchGate();

  it("touches only on start or heartbeat, not on perf or error", async () => {
    const t = open();
    await handleTelemetry(req(batch([{ k: "error", kind: "error", message: "x" }])), t.deps);
    await handleTelemetry(
      req(
        batch([
          {
            k: "perf",
            mode: "classic",
            fpsP50: 60,
            fpsP95: 50,
            frameMsP95: 20,
            samples: 9,
            heapMb: 1,
          },
        ]),
      ),
      t.deps,
    );
    await t.settle();
    expect(t.touches).toHaveLength(0);

    await handleTelemetry(
      req(batch([{ k: "session.start", platform: "web", device: "desktop", loadMs: 5 }])),
      t.deps,
    );
    await t.settle();
    expect(t.touches).toHaveLength(1);
  });

  it("gates one touch per account per hour", () => {
    const g = gate();
    expect(g.take("a", 0)).toBe(true);
    expect(g.take("a", TOUCH_EVERY_MS - 1)).toBe(false);
    expect(g.take("b", 1)).toBe(true);
    expect(g.take("a", TOUCH_EVERY_MS)).toBe(true);
  });

  it("calls AccountDO.touchActivity once an hour for a valid token, never for an invalid one", async () => {
    const now = Date.now();
    const token = await signToken(SECRET, {
      accountId: ACCOUNT,
      name: "Guest",
      issuedAt: now,
      kind: "guest",
    });
    const calls: number[] = [];
    const env = {
      AUTH_SECRET: SECRET,
      ACCOUNT: {
        getByName: (id: string) => {
          expect(id).toBe(ACCOUNT);
          return {
            profile: async () => ({ kind: "guest" }),
            touchActivity: async (at: number) => {
              calls.push(at);
            },
          };
        },
      },
    } as unknown as Pick<Env, "AUTH_SECRET" | "ACCOUNT">;
    const touch = makeTouch(env, gate());
    const withToken = (t: string) =>
      new Request("http://localhost/api/telemetry", {
        method: "POST",
        headers: { authorization: `Bearer ${t}` },
      });

    await touch(withToken(token), now);
    await touch(withToken(token), now + 1000);
    expect(calls).toEqual([now]);
    await touch(withToken(token), now + TOUCH_EVERY_MS);
    expect(calls).toHaveLength(2);

    await touch(withToken("garbage.token"), now + 2 * TOUCH_EVERY_MS);
    await touch(
      new Request("http://localhost/api/telemetry", { method: "POST" }),
      now + 2 * TOUCH_EVERY_MS,
    );
    expect(calls).toHaveLength(2);
  });
});

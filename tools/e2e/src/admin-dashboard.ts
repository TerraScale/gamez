/**
 * Admin dashboard e2e (docs/design/admin-dashboard.md §7, §13). Called from the
 * wave C admin feature (waveC/admin.ts), which owns the admin account:
 *
 *   dashboardDenied(url, playerToken)  before the dev grant: every new admin
 *                                      endpoint is 401 anonymous, 403 for a player
 *   dashboardReads(url, adminToken, accountId)
 *                                      after the grant: client telemetry is accepted,
 *                                      the dev seeder fills the local analytics stub,
 *                                      every section answers its shape with sources,
 *                                      the cache answers hit, lookup finds the account,
 *                                      tunables validate and round-trip through /api/config
 *
 * The e2e server has private state (dev-server.ts), so seeding and the tunable
 * write never touch the live :5173 server. The tunable is restored in a finally.
 */
import { api } from "./accounts.ts";
import { check, fail } from "./report.ts";

const SECTIONS = [
  "overview",
  "players",
  "gameplay?mode=classic",
  "economy/details",
  "monetization",
  "social",
  "tech",
] as const;

const OFFLINE_XP = "classic.offlineXpPct";

interface Source {
  name: string;
  kind: string;
  ok: boolean;
  note?: string;
}

interface SectionBody {
  at?: number;
  range?: { from: number; to: number; bucketMs: number };
  sources?: Source[];
  [k: string]: unknown;
}

interface TunablesBody {
  values?: Record<string, number>;
  error?: { message?: string };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Field checks per section: the numbers the UI's first tiles read. */
function shapeOk(section: string, b: SectionBody): boolean {
  const o = (k: string) => (isObj(b[k]) ? (b[k] as Record<string, unknown>) : {});
  switch (section) {
    case "overview":
      return (
        isNum(o("accounts").total) && isNum(b.dau) && isNum(b.mau) && Array.isArray(b.activeSeries)
      );
    case "players":
      return Array.isArray(b.retention) && isObj(b.sessions) && isObj(b.platforms);
    case "gameplay?mode=classic":
      return isNum(o("heroes").total) && isObj(b.playtimeHours) && isObj(b.quests);
    case "economy/details":
      return isNum(o("market").sales) && isNum(o("gems").supply) && isObj(b.arena);
    case "monetization":
      return isObj(b.revenueMinor) && isNum(o("purchases").paid) && isObj(b.pass);
    case "social":
      return isNum(o("chat").messages) && isNum(o("guilds").count) && isObj(b.leaderboards);
    case "tech":
      return Array.isArray(b.requests) && isObj(b.sync) && isObj(b.client);
    default:
      return false;
  }
}

export async function dashboardDenied(url: string, playerToken: string): Promise<void> {
  const paths = [
    ...SECTIONS.map((s) => `/api/admin/${s}`),
    "/api/admin/players/search?q=",
    "/api/admin/players/probe-account",
    "/api/admin/tunables",
  ];
  const anon: string[] = [];
  const player: string[] = [];
  for (const p of paths) {
    const a = await api<unknown>(url, p);
    if (a.status !== 401) anon.push(`${p}=${a.status}`);
    const r = await api<unknown>(url, p, { token: playerToken });
    if (r.status !== 403) player.push(`${p}=${r.status}`);
  }
  check(anon.length === 0, `dashboard endpoints are 401 anonymous ${anon.join(" ")}`);
  check(player.length === 0, `dashboard endpoints are 403 for a player ${player.join(" ")}`);

  const write = await api<unknown>(url, "/api/admin/tunables", {
    token: playerToken,
    body: { values: { [OFFLINE_XP]: 50 } },
  });
  check(write.status === 403, `player tunable write is 403 (${write.status})`);
  const seed = await api<unknown>(url, "/api/dev/admin/seed-metrics?days=1", {
    token: playerToken,
    method: "POST",
  });
  check(seed.status === 403, `player metrics seed is 403 (${seed.status})`);
}

export async function dashboardReads(
  url: string,
  adminToken: string,
  accountId: string,
): Promise<void> {
  // Client telemetry: a bad envelope is 400, a good batch 204 (and touches the account's day).
  const bad = await fetch(`${url}/api/telemetry`, { method: "POST", body: "{}" });
  check(bad.status === 400, `POST /api/telemetry rejects a bad batch (${bad.status})`);
  const sid = `e2e-${Date.now().toString(36)}-session`;
  const good = await fetch(`${url}/api/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      v: 1,
      sid,
      build: "e2e",
      contentHash: "",
      events: [
        { k: "session.start", platform: "web", device: "desktop", loadMs: 420 },
        { k: "session.heartbeat", elapsedS: 60, mode: "classic", visible: true },
      ],
    }),
  });
  check(good.status === 204, `POST /api/telemetry accepts a session batch (${good.status})`);

  const seed = await api<{ ok?: boolean; points?: number }>(
    url,
    "/api/dev/admin/seed-metrics?days=2&reset=1",
    { token: adminToken, method: "POST" },
  );
  check(
    seed.status === 200 && seed.body.ok === true && (seed.body.points ?? 0) > 0,
    `dev seeder fills the local analytics stub (${seed.status} points=${seed.body.points ?? 0})`,
  );

  for (const s of SECTIONS) {
    const res = await api<SectionBody>(
      url,
      `/api/admin/${s}${s.includes("?") ? "&" : "?"}fresh=1`,
      {
        token: adminToken,
      },
    );
    const b = res.body ?? {};
    const failed = (b.sources ?? []).filter((x) => !x.ok).map((x) => `${x.name}:${x.note ?? ""}`);
    check(
      res.status === 200 &&
        isNum(b.at) &&
        isNum(b.range?.from) &&
        Array.isArray(b.sources) &&
        b.sources.length > 0 &&
        shapeOk(s, b),
      `GET /api/admin/${s} answers its shape (${res.status}, ${b.sources?.length ?? 0} sources)`,
    );
    check(failed.length === 0, `GET /api/admin/${s}: every source ok ${failed.join(" ")}`);
  }

  // The seeded stub gives the tech section requests; the cache answers the second read.
  const first = await fetch(`${url}/api/admin/tech`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const tech = (await first.json()) as { requests?: { points?: unknown[] }[] };
  const second = await fetch(`${url}/api/admin/tech`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  await second.arrayBuffer();
  check(
    (tech.requests ?? []).some((series) => (series.points?.length ?? 0) > 0),
    "tech: request series has points after seeding",
  );
  check(
    second.headers.get("x-admin-cache") === "hit",
    `admin read is cached (x-admin-cache ${second.headers.get("x-admin-cache")})`,
  );

  // Range parsing: a date range answers, a reversed one is still a 200 with a clamped range.
  const dated = await api<SectionBody>(url, "/api/admin/overview?from=2026-01-01&to=2026-01-07", {
    token: adminToken,
  });
  check(dated.status === 200 && isNum(dated.body.range?.from), "overview accepts a date range");

  // Player lookup: search finds the admin account, detail opens it, junk ids are refused.
  // The account_summary row reaches D1 through the outbox queue, so poll for it briefly.
  const searchPath = `/api/admin/players/search?q=${encodeURIComponent(accountId.slice(0, 8))}`;
  let search = await api<{ rows?: { accountId: string }[] }>(url, searchPath, {
    token: adminToken,
  });
  const found = () => (search.body?.rows ?? []).some((r) => r.accountId === accountId);
  for (let i = 0; i < 30 && search.status === 200 && !found(); i++) {
    await new Promise((r) => setTimeout(r, 500));
    search = await api(url, searchPath, { token: adminToken });
  }
  check(
    search.status === 200 && found(),
    `player search finds the account by id prefix (${search.status})`,
  );
  const detail = await api<{ account?: { accountId?: string }; wallet?: unknown }>(
    url,
    `/api/admin/players/${encodeURIComponent(accountId)}`,
    { token: adminToken },
  );
  check(
    detail.status === 200 &&
      detail.body.account?.accountId === accountId &&
      isObj(detail.body.wallet),
    `player detail opens the account (${detail.status})`,
  );
  const missing = await api<unknown>(url, "/api/admin/players/no-such-account", {
    token: adminToken,
  });
  check(missing.status === 404, `unknown player is 404 (${missing.status})`);
  const junk = await api<unknown>(url, "/api/admin/players/%3Cscript%3E", { token: adminToken });
  check(junk.status === 400, `malformed player id is 400 (${junk.status})`);

  // Tunables: strict validation, then a round trip that /api/config reflects, then restore.
  const before = await api<TunablesBody>(url, "/api/admin/tunables", { token: adminToken });
  const original = before.body.values?.[OFFLINE_XP];
  check(
    before.status === 200 && isNum(original),
    `GET /api/admin/tunables carries ${OFFLINE_XP} (${String(original)})`,
  );
  const outOfRange = await api<TunablesBody>(url, "/api/admin/tunables", {
    token: adminToken,
    body: { values: { [OFFLINE_XP]: 150 } },
  });
  check(outOfRange.status === 400, `tunable out of range is 400 (${outOfRange.status})`);
  const unknown = await api<TunablesBody>(url, "/api/admin/tunables", {
    token: adminToken,
    body: { values: { "classic.noSuchKnob": 1 } },
  });
  check(unknown.status === 400, `unknown tunable is 400 (${unknown.status})`);
  try {
    const set = await api<TunablesBody>(url, "/api/admin/tunables", {
      token: adminToken,
      body: { values: { [OFFLINE_XP]: 35 } },
    });
    check(
      set.status === 200 && set.body.values?.[OFFLINE_XP] === 35,
      `tunable write ${OFFLINE_XP}=35 (${set.status})`,
    );
    const cfg = await api<{ tunables?: Record<string, number> }>(url, "/api/config");
    check(cfg.body.tunables?.[OFFLINE_XP] === 35, "GET /api/config carries the new tunable");
  } catch (err) {
    fail(`tunable round trip threw: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    const restore = isNum(original) ? original : 20;
    const back = await api<TunablesBody>(url, "/api/admin/tunables", {
      token: adminToken,
      body: { values: { [OFFLINE_XP]: restore } },
    });
    check(
      back.status === 200 && back.body.values?.[OFFLINE_XP] === restore,
      `tunable restored to ${restore}`,
    );
  }
}

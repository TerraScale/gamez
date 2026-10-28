/**
 * /api/arena/* over in-memory stand-ins: the real auth (signed tokens, the
 * fake AccountDO's checkSession/profile), the real ArenaLadder behind a fake
 * ARENA namespace, a fake INSTANCE (exportBuild), and a fake D1 for the ladder.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { currentSeason } from "@gamez/economy";
import type { ArenaBuild, ArenaLadderResponse } from "@gamez/protocol";
import { signToken, type Identity } from "../../src/server/auth.ts";
import { ArenaLadder, GHOST_AFTER_MS } from "../../src/server/arena/ladder.ts";
import { arenaRoutes } from "../../src/server/routes/arena.ts";
import { resetFlagsCache } from "../../src/server/config/flags.ts";
import type { Env } from "../../src/server/contracts.ts";
import type { RouteContext } from "../../src/server/routes/types.ts";
import { Outbox } from "@gamez/sync";
import { FakeD1 } from "../leaderboards/fake-d1.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";
import { build, FakeAccounts, fightByHp, countingSeeds } from "./support.ts";

const SECRET = "arena-route-secret";
const SEASON = currentSeason(Date.now()).id;

interface World {
  env: Env;
  clock: { now: number };
  accounts: FakeAccounts;
  /** Builds exportBuild returns, by account id. */
  heroes: Map<string, ArenaBuild>;
  /** Makes exportBuild throw for every account. */
  heroFails: { on: boolean };
  d1: FakeD1;
  ladder(name: string): ArenaLadder;
}

function makeWorld(opts: { oauthStub?: "0" | "1"; d1Migrated?: boolean } = {}): World {
  const clock = { now: 1_790_900_000_000 };
  const accounts = new FakeAccounts();
  const heroes = new Map<string, ArenaBuild>();
  const heroFails = { on: false };
  const d1 = new FakeD1();
  if (opts.d1Migrated !== false) d1.migrate(["0008_arena.sql"]);

  const ladders = new Map<string, ArenaLadder>();
  const ladder = (name: string): ArenaLadder => {
    let l = ladders.get(name);
    if (!l) {
      const store = fakeSqlStore();
      const outbox = new Outbox(store.sql, `arena:${name}`);
      outbox.init();
      l = new ArenaLadder({
        store,
        accounts,
        outbox,
        clock: () => clock.now,
        seeds: countingSeeds(),
        fight: fightByHp(),
        mode: name.split(":")[0]!,
        seasonId: name.split(":").slice(1).join(":"),
      });
      l.init();
      ladders.set(name, l);
    }
    return l;
  };

  const env = {
    AUTH_SECRET: SECRET,
    OAUTH_STUB: opts.oauthStub,
    DB: d1.asD1(),
    ACCOUNT: {
      getByName: (accountId: string) => ({
        checkSession: async (sid: string) => sid === `sid-${accountId}`,
        profile: async () => null,
      }),
    },
    INSTANCE: {
      getByName: (name: string) => ({
        exportBuild: async (displayName: string) => {
          if (heroFails.on) throw new Error("instance down");
          const accountId = name.slice("classic:".length);
          const hero = heroes.get(accountId);
          return hero ? { ...hero, displayName } : null;
        },
      }),
    },
    ARENA: {
      getByName: (name: string) => {
        const l = ladder(name);
        return {
          status: async (accountId: string) => l.status(accountId),
          enqueue: async (input: { opId: string; build: ArenaBuild }) => l.enqueue(input),
          poll: async (input: { accountId: string; ticket: string }) => l.poll(input),
          match: async (id: string) => l.match(id),
          devSetBuild: async (b: ArenaBuild) => l.devSetBuild(b),
          devBuild: async (accountId: string) => l.devBuild(accountId),
        };
      },
    },
  } as unknown as Env;

  return { env, clock, accounts, heroes, heroFails, d1, ladder };
}

let world: World;
let alice: string;
let bob: string;
let guest: string;

async function tokenFor(accountId: string, kind: "guest" | "registered" = "registered") {
  const identity: Identity =
    kind === "registered"
      ? {
          accountId,
          name: `Name-${accountId}`,
          issuedAt: Date.now(),
          kind,
          sid: `sid-${accountId}`,
        }
      : { accountId, name: `Guest-${accountId}`, issuedAt: Date.now() };
  return signToken(SECRET, identity);
}

beforeEach(async () => {
  resetFlagsCache();
  world = makeWorld({ oauthStub: "0" });
  alice = await tokenFor("acc-alice");
  bob = await tokenFor("acc-bob");
  guest = await tokenFor("acc-guest", "guest");
});

/** Calls the arena routes directly. */
async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const url = new URL(`https://game.test${path}`);
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const c: RouteContext = {
    request: new Request(url, { method, headers, body }),
    env: world.env,
    url,
    ctx: {} as ExecutionContext,
  };
  const res = await arenaRoutes(c);
  if (!res) throw new Error(`no route answered ${method} ${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

const queue = (token: string, opId: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/api/arena/queue", { token, body: { opId, ...extra } });

describe("routing", () => {
  it("ignores other paths", async () => {
    const c: RouteContext = {
      request: new Request("https://game.test/api/other"),
      env: world.env,
      url: new URL("https://game.test/api/other"),
      ctx: {} as ExecutionContext,
    };
    expect(await arenaRoutes(c)).toBeNull();
  });

  it("answers 404 for an unknown arena path", async () => {
    const res = await call("GET", "/api/arena/nope", { token: alice });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/arena/queue", () => {
  it("needs a signed-in account", async () => {
    const res = await call("POST", "/api/arena/queue", { body: { opId: "op-noauth-001" } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("refuses guests with guest_forbidden", async () => {
    world.heroes.set("acc-guest", build("acc-guest"));
    const res = await queue(guest, "op-guest-0001");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("guest_forbidden");
  });

  it("answers 409 not_eligible when the account has no verified hero yet", async () => {
    const res = await queue(alice, "op-nohero-0001");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_eligible");
    expect(res.body.error.message).toBe("Play classic first: your hero fights as a ghost");
  });

  it("queues with the verified hero build: 202 waiting, replay 200 with the same ticket", async () => {
    world.heroes.set("acc-alice", build("acc-alice", { maxHp: 140 }));
    const first = await queue(alice, "op-queue-0001");
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("waiting");
    expect(first.body.ticket).toMatch(new RegExp(`^${SEASON}\\.[0-9a-f]{16}$`));

    const again = await queue(alice, "op-queue-0001");
    expect(again.status).toBe(200);
    expect(again.body.ticket).toBe(first.body.ticket);
  });

  it("validates opId and mode before touching the arena", async () => {
    world.heroes.set("acc-alice", build("acc-alice"));
    expect((await queue(alice, "short")).body.error.code).toBe("bad_request");
    const noBody = await call("POST", "/api/arena/queue", { token: alice, body: "[1]" });
    expect(noBody.status).toBe(400);
    const steps = await queue(alice, "op-steps-0001", { mode: "steps" });
    expect(steps.status).toBe(400);
    expect(steps.body.error.code).toBe("bad_request");
  });

  it("answers 503 unavailable when the hero cannot be read", async () => {
    world.heroFails.on = true;
    const res = await queue(alice, "op-down-00001");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("unavailable");
  });

  it("answers 503 disabled while the arena flag is off", async () => {
    world.heroes.set("acc-alice", build("acc-alice"));
    world.env = {
      ...world.env,
      CONFIG: {
        getByName: () => ({
          config: async () => ({
            flags: {
              bank: true,
              market: true,
              trade: true,
              shops: true,
              arena: false,
              pass: true,
              store: true,
            },
            seasonId: SEASON,
            serverTime: 0,
          }),
        }),
      },
    } as unknown as Env;
    resetFlagsCache();
    const res = await queue(alice, "op-off-000001");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("disabled");
  });
});

describe("GET /api/arena/queue/:ticket", () => {
  it("polls a waiting ticket, then the match once the ghost timer passes", async () => {
    world.heroes.set("acc-alice", build("acc-alice", { maxHp: 120 }));
    const ticket = (await queue(alice, "op-poll-00001")).body.ticket as string;

    const waiting = await call("GET", `/api/arena/queue/${ticket}`, { token: alice });
    expect(waiting.status).toBe(200);
    expect(waiting.body.status).toBe("waiting");

    world.clock.now += GHOST_AFTER_MS;
    const matched = await call("GET", `/api/arena/queue/${ticket}`, { token: alice });
    expect(matched.body.status).toBe("matched");
    expect(matched.body.match.defender.party.accountId).toBe("arena.shade");
    expect(matched.body.match.attacker.party.accountId).toBe("acc-alice");
  });

  it("hides other accounts' tickets and rejects malformed ids with 404", async () => {
    world.heroes.set("acc-alice", build("acc-alice"));
    const ticket = (await queue(alice, "op-hide-00001")).body.ticket as string;
    expect((await call("GET", `/api/arena/queue/${ticket}`, { token: bob })).status).toBe(404);
    expect((await call("GET", "/api/arena/queue/nope", { token: alice })).status).toBe(404);
    expect(
      (await call("GET", `/api/arena/queue/${SEASON}.0000000000000000`, { token: alice })).status,
    ).toBe(404);
  });

  it("needs a session", async () => {
    expect((await call("GET", "/api/arena/queue/x.y")).status).toBe(401);
  });
});

describe("GET /api/arena/status", () => {
  it("answers the caller's status; guests may read it", async () => {
    const res = await call("GET", "/api/arena/status", { token: guest });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      seasonId: SEASON,
      rating: 1000,
      registered: false,
      fightsLeftToday: 20,
      ticket: null,
      recent: [],
    });
  });

  it("refuses an unsigned caller", async () => {
    const res = await call("GET", "/api/arena/status");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/arena/match/:id", () => {
  it("returns a stored match and 404s unknown or malformed ids", async () => {
    world.heroes.set("acc-alice", build("acc-alice"));
    const ticket = (await queue(alice, "op-match-0001")).body.ticket as string;
    world.clock.now += GHOST_AFTER_MS;
    const matchId = (await call("GET", `/api/arena/queue/${ticket}`, { token: alice })).body.match
      .id as string;

    const res = await call("GET", `/api/arena/match/${matchId}`, { token: alice });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: matchId, winner: "attacker", ticks: 42 });
    expect(typeof res.body.seed).toBe("number");

    expect(
      (await call("GET", `/api/arena/match/${SEASON}.0000000000000000`, { token: alice })).status,
    ).toBe(404);
    expect((await call("GET", "/api/arena/match/not-an-id", { token: alice })).status).toBe(404);
    expect((await call("GET", `/api/arena/match/${matchId}`)).status).toBe(401);
  });
});

describe("GET /api/arena/ladder", () => {
  function insertRating(
    d1: FakeD1,
    row: { id: string; cls: string; rating: number; name?: string },
  ) {
    d1.db
      .prepare(
        `INSERT INTO arena_rating (id, season_id, mode, account_id, display_name, class_id, level, rating, wins, losses, draws, updated_at, _version, _deleted, _updated_at)
         VALUES (?, ?, 'classic', ?, ?, ?, 5, ?, 2, 1, 0, 0, 1, 0, 0)`,
      )
      .run(
        `${SEASON}/${row.id}`,
        SEASON,
        row.id,
        row.name ?? `Name ${row.id}`,
        row.cls,
        row.rating,
      );
  }

  it("answers the D1 ladder ordered by rating, cached 15 s, without auth", async () => {
    insertRating(world.d1, { id: "a", cls: "classic.warrior", rating: 1100 });
    insertRating(world.d1, { id: "b", cls: "classic.rogue", rating: 1300 });
    insertRating(world.d1, { id: "c", cls: "classic.warrior", rating: 1200 });
    const res = await call("GET", "/api/arena/ladder");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=15");
    const body = res.body as ArenaLadderResponse;
    expect(body.available).toBe(true);
    expect(body.seasonId).toBe(SEASON);
    expect(body.rows.map((r) => [r.rank, r.accountId, r.rating])).toEqual([
      [1, "b", 1300],
      [2, "c", 1200],
      [3, "a", 1100],
    ]);
  });

  it("filters by class and clamps the limit", async () => {
    insertRating(world.d1, { id: "a", cls: "classic.warrior", rating: 1100 });
    insertRating(world.d1, { id: "b", cls: "classic.rogue", rating: 1300 });
    insertRating(world.d1, { id: "c", cls: "classic.warrior", rating: 1200 });
    const rogue = (await call("GET", "/api/arena/ladder?classId=classic.rogue"))
      .body as ArenaLadderResponse;
    expect(rogue.rows.map((r) => r.accountId)).toEqual(["b"]);
    const one = (await call("GET", "/api/arena/ladder?limit=1")).body as ArenaLadderResponse;
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]!.accountId).toBe("b");
    const big = (await call("GET", "/api/arena/ladder?limit=5000")).body as ArenaLadderResponse;
    expect(big.rows).toHaveLength(3);
  });

  it("answers available: false before the table is migrated", async () => {
    world = makeWorld({ oauthStub: "0", d1Migrated: false });
    const res = await call("GET", "/api/arena/ladder");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seasonId: SEASON, rows: [], available: false });
  });

  it("rejects bad parameters with 400", async () => {
    expect((await call("GET", "/api/arena/ladder?mode=steps")).status).toBe(400);
    expect((await call("GET", "/api/arena/ladder?classId=evil%27--")).status).toBe(400);
    expect((await call("GET", "/api/arena/ladder?limit=abc")).status).toBe(400);
  });
});

describe("POST /api/dev/arena/build", () => {
  const devBuild = (token: string | undefined, b: unknown) =>
    call("POST", "/api/dev/arena/build", { token, body: { build: b } });

  it("is a 404 on production hosts", async () => {
    const res = await devBuild(alice, build("acc-alice"));
    expect(res.status).toBe(404);
  });

  it("stores the caller's override, used when the hero is missing", async () => {
    world = makeWorld({ oauthStub: "1" });
    alice = await tokenFor("acc-alice");
    const raw = build("someone-else", { maxHp: 111, name: "Dev Hero" });
    const stored = await devBuild(alice, raw);
    expect(stored.status).toBe(200);
    expect(stored.body.build).toMatchObject({
      accountId: "acc-alice",
      maxHp: 111,
      name: "Dev Hero",
    });

    const queued = await queue(alice, "op-devbuild-01");
    expect(queued.status).toBe(202);
    expect(queued.body.status).toBe("waiting");
  });

  it("rejects builds outside the arena ranges and non-POST methods", async () => {
    world = makeWorld({ oauthStub: "1" });
    alice = await tokenFor("acc-alice");
    expect((await devBuild(alice, { ...build("x"), maxHp: -5 })).status).toBe(400);
    expect((await devBuild(alice, { ...build("x"), skills: [1] })).status).toBe(400);
    expect((await devBuild(alice, build("x", { attackRate: 101 }))).status).toBe(400);
    expect((await devBuild(alice, undefined)).status).toBe(400);
    expect((await call("GET", "/api/dev/arena/build", { token: alice })).status).toBe(405);
  });

  it("needs a registered session", async () => {
    world = makeWorld({ oauthStub: "1" });
    expect((await devBuild(undefined, build("x"))).status).toBe(401);
  });
});

/**
 * Shared test helpers for the guild tests (wave B, T-guilds). Stand-ins for
 * the Durable Objects run the real logic classes (AccountSocial, GuildRoster)
 * over in-memory SQLite, and a fake D1 runs the real guild_index projection.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AccountSocial } from "../../src/server/account/social.ts";
import type { Env } from "../../src/server/contracts.ts";
import { GuildRoster } from "../../src/server/guild/roster.ts";
import { guildRoutes } from "../../src/server/routes/guilds.ts";
import { projections } from "../../src/server/projections.ts";
import { signToken, type Identity } from "../../src/server/auth.ts";
import { applyBatch, Outbox, SYNC_CURSOR_DDL } from "@gamez/sync";
import { fakeSqlStore } from "../support/fake-sql.ts";

export const SECRET = "guild-test-secret";

/** A clock the tests move by hand. */
export interface Clock {
  now: number;
  (): number;
  advance(ms: number): void;
}

export function makeClock(start = 1_800_000_000_000): Clock {
  const clock = (() => clock.now) as Clock;
  clock.now = start;
  clock.advance = (ms: number) => {
    clock.now += ms;
  };
  return clock;
}

/**
 * A fake AccountDO: the block list and guild slot over in-memory SQLite, plus
 * the two session RPCs the real authenticateRequest calls. A registered token
 * (tokenFor) carries sid `sid-<accountId>`; `revoked` closes that session.
 * `profile()` answers null, so guest tokens stay valid.
 */
export class FakeAccount {
  readonly store = fakeSqlStore();
  readonly social: AccountSocial;
  revoked = false;
  /** The next releaseGuild call throws (a crash after GuildDO.kick). */
  failReleaseOnce = false;

  constructor(now: () => number) {
    this.social = new AccountSocial(this.store, now);
    this.social.init();
  }
}

/** A fake GuildDO: roster plus outbox over in-memory SQLite. */
export class FakeGuild {
  readonly store = fakeSqlStore();
  readonly outbox: Outbox;
  readonly roster: GuildRoster;

  constructor(id: string, now: () => number) {
    this.outbox = new Outbox(this.store.sql, `guild:${id}`);
    this.outbox.init();
    this.roster = new GuildRoster({ id, store: this.store, outbox: this.outbox, now });
    this.roster.init();
  }
}

/** A D1 stand-in over node:sqlite: enough of the API for applyBatch and the route reads. */
export function fakeD1(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...more: unknown[]) => statement(sql, more),
    run: async () => {
      const res = db.prepare(sql).run(...(params as never[]));
      return { success: true, results: [], meta: { changes: Number(res.changes) } };
    },
    all: async () => ({
      success: true,
      results: db.prepare(sql).all(...(params as never[])),
      meta: {},
    }),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

/** A DatabaseSync with the wave B guild read model (migration 0004) and the sync cursor. */
export function freshReadModel(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SYNC_CURSOR_DDL);
  const migration = new URL("../../migrations/0004_guilds.sql", import.meta.url);
  db.exec(readFileSync(migration, "utf8"));
  return db;
}

export interface World {
  env: Env;
  clock: Clock;
  db: DatabaseSync;
  /** Chat channels: revoke calls seen, and a switch that makes them throw. */
  chat: { revokes: { channel: string; accountId: string; reason: string }[]; failRevoke: boolean };
  account(accountId: string): FakeAccount;
  guild(guildId: string): FakeGuild;
  /** Projects every guild outbox into the fake D1, as the sync queue would. */
  syncD1(): Promise<void>;
}

/** An environment whose ACCOUNT and GUILD bindings are the in-memory stand-ins. */
export function makeWorld(opts: { readModel?: boolean } = {}): World {
  const clock = makeClock();
  const accounts = new Map<string, FakeAccount>();
  const guilds = new Map<string, FakeGuild>();
  const db = opts.readModel === false ? new DatabaseSync(":memory:") : freshReadModel();
  const d1 = fakeD1(db);

  const account = (accountId: string): FakeAccount => {
    let acc = accounts.get(accountId);
    if (!acc) {
      acc = new FakeAccount(clock);
      accounts.set(accountId, acc);
    }
    return acc;
  };
  const guild = (guildId: string): FakeGuild => {
    let g = guilds.get(guildId);
    if (!g) {
      g = new FakeGuild(guildId, clock);
      guilds.set(guildId, g);
    }
    return g;
  };

  const chat: World["chat"] = { revokes: [], failRevoke: false };

  const env = {
    AUTH_SECRET: SECRET,
    DB: d1,
    CHAT: {
      getByName: (channel: string) => ({
        revoke: async (accountId: string, reason: string) => {
          if (chat.failRevoke) throw new Error("chat channel unavailable");
          chat.revokes.push({ channel, accountId, reason });
          return 1;
        },
      }),
    },
    ACCOUNT: {
      getByName: (accountId: string) => {
        const acc = account(accountId);
        return {
          checkSession: async (sid: string) => !acc.revoked && sid === `sid-${accountId}`,
          profile: async () => null,
          guild: async () => acc.social.guild(),
          reserveGuild: async (opId: string, guildId: string) =>
            acc.social.reserveGuild(opId, guildId),
          confirmGuild: async (opId: string, m: Parameters<AccountSocial["confirmGuild"]>[1]) =>
            acc.social.confirmGuild(opId, m),
          releaseGuild: async (opId: string, guildId: string) => {
            if (acc.failReleaseOnce) {
              acc.failReleaseOnce = false;
              throw new Error("AccountDO unavailable");
            }
            return acc.social.releaseGuild(opId, guildId);
          },
          blocks: async () => acc.social.blocks(),
        };
      },
    },
    GUILD: {
      getByName: (guildId: string) => {
        const g = guild(guildId);
        return {
          info: async () => g.roster.info(),
          create: async (i: Parameters<GuildRoster["create"]>[0]) => g.roster.create(i),
          join: async (i: Parameters<GuildRoster["join"]>[0]) => g.roster.join(i),
          leave: async (i: Parameters<GuildRoster["leave"]>[0]) => g.roster.leave(i),
          kick: async (i: Parameters<GuildRoster["kick"]>[0]) => g.roster.kick(i),
        };
      },
    },
  } as unknown as Env;

  return {
    env,
    clock,
    db,
    chat,
    account,
    guild,
    async syncD1() {
      for (const [id, g] of guilds) {
        await g.outbox.flush({
          send: (batch) =>
            applyBatch(d1, { source: `guild:${id}`, records: batch.records }, projections).then(
              () => undefined,
            ),
        });
      }
    },
  };
}

/**
 * A signed token. `kind` "registered" carries a session id (auth.ts v2 tokens);
 * omitted or "guest" signs a token without `kind`, which authenticates as a guest.
 */
export async function tokenFor(
  accountId: string,
  name: string,
  kind: "guest" | "registered" = "guest",
): Promise<string> {
  // A guest token leaves `kind` out, like a v1 token: missing kind means guest.
  const identity: Identity =
    kind === "registered"
      ? { accountId, name, issuedAt: Date.now(), kind, sid: `sid-${accountId}` }
      : { accountId, name, issuedAt: Date.now() };
  return signToken(SECRET, identity);
}

/** Calls the guild route directly (no socket, no Worker). */
export async function call(
  world: World,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const url = new URL(`https://game.test${path}`);
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const request = new Request(url, { method, headers, body });
  const res = await guildRoutes({
    request,
    env: world.env,
    url,
    ctx: {} as ExecutionContext,
  });
  if (!res) throw new Error(`no route answered ${method} ${path}`);
  return { status: res.status, body: await res.json() };
}

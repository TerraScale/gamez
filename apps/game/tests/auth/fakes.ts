/**
 * In-memory IdentityDO / AccountDO namespaces for the auth tests: the real
 * logic classes (IdentityStore, AccountProfileStore) on node:sqlite behind
 * getByName(), with async RPC-like wrappers and a shared fake clock.
 */
import type { AccountKind, AccountView, AuthProvider } from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { AccountProfileStore } from "../../src/server/account/profile.ts";
import { IdentityStore } from "../../src/server/auth/identity-store.ts";
import type { Env, IdentityApi } from "../../src/server/contracts.ts";
import type { RouteContext } from "../../src/server/routes/types.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

export const SECRET = "test-secret";

export class Clock {
  t = 1_800_000_000_000;
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export class FakeAccount {
  readonly store = fakeSqlStore();
  readonly outbox: Outbox;
  readonly profileStore: AccountProfileStore;
  calls = 0;

  constructor(
    readonly accountId: string,
    now: () => number,
  ) {
    this.outbox = new Outbox(this.store.sql, `account:${accountId}`);
    this.outbox.init();
    this.profileStore = new AccountProfileStore(this.store, accountId, this.outbox, now);
    this.profileStore.init();
  }

  async ensure(input: { kind: AccountKind; displayName: string }) {
    this.calls++;
    return this.profileStore.ensure(input);
  }
  async profile() {
    this.calls++;
    return this.profileStore.profile();
  }
  async view(): Promise<AccountView | null> {
    const p = this.profileStore.profile();
    if (!p) return null;
    return {
      accountId: p.accountId,
      displayName: p.displayName,
      kind: p.kind,
      identities: p.identities.map((i) =>
        i.email !== null ? { provider: i.provider, email: i.email } : { provider: i.provider },
      ),
      guildId: null,
      guildTag: null,
      createdAt: p.createdAt,
    };
  }
  async setDisplayName(name: string) {
    return this.profileStore.setDisplayName(name);
  }
  async addIdentity(identity: { provider: AuthProvider; subject: string; email: string | null }) {
    return this.profileStore.addIdentity(identity);
  }
  async openSession(userAgent: string) {
    return this.profileStore.openSession(userAgent);
  }
  async checkSession(sid: string) {
    this.calls++;
    return this.profileStore.checkSession(sid);
  }
  async closeSession(sid: string) {
    this.profileStore.closeSession(sid);
  }
}

export class FakeIdentity implements IdentityApi {
  readonly inner: IdentityStore;
  constructor(now: () => number) {
    this.inner = new IdentityStore(fakeSqlStore(), { now, rehashIterations: 1000 });
  }
  async get() {
    return this.inner.get();
  }
  async claim(input: Parameters<IdentityApi["claim"]>[0]) {
    return this.inner.claim(input);
  }
  checkPassword(password: string) {
    return this.inner.checkPassword(password);
  }
}

export interface FakeWorld {
  env: Env;
  clock: Clock;
  accounts: Map<string, FakeAccount>;
  identities: Map<string, FakeIdentity>;
}

export function fakeWorld(vars: Partial<Env> = {}): FakeWorld {
  const clock = new Clock();
  const accounts = new Map<string, FakeAccount>();
  const identities = new Map<string, FakeIdentity>();
  const env = {
    AUTH_SECRET: SECRET,
    ACCOUNT: {
      getByName(name: string) {
        let a = accounts.get(name);
        if (!a) accounts.set(name, (a = new FakeAccount(name, clock.now)));
        return a;
      },
    },
    IDENTITY: {
      getByName(name: string) {
        let i = identities.get(name);
        if (!i) identities.set(name, (i = new FakeIdentity(clock.now)));
        return i;
      },
    },
    ...vars,
  } as unknown as Env;
  return { env, clock, accounts, identities };
}

/** A RouteContext for authRoutes. */
export function ctxFor(env: Env, request: Request): RouteContext {
  return {
    request,
    env,
    url: new URL(request.url),
    ctx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  };
}

export function req(
  path: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${opts.origin ?? "http://localhost:5173"}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

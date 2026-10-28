/**
 * Test stand-ins for the arena ladder (wave-C.md §6.3): an in-memory account
 * gateway with idempotent txIds and injected faults, a fake fight that makes
 * the stronger max hp win, deterministic seeds and a clock the tests move.
 * The ladder logic runs unchanged over FakeSqlStorage.
 */
import type { ArenaBuild, ArenaWinner, NoticeInput } from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import type {
  AccountGateway,
  VaultPutResult,
  VaultTakeResult,
  WalletTxC,
  WalletTxResult,
} from "../../src/server/contracts.ts";
import { ArenaLadder, type FightFn } from "../../src/server/arena/ladder.ts";
import type { SeedSource } from "../../src/server/arena/seeds.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

export const SEASON = "2026-s1";
export const T0 = 1_790_900_000_000;

/** A classic-like build with sane defaults; `patch` overrides any field. */
export function build(accountId: string, patch: Partial<ArenaBuild> = {}): ArenaBuild {
  return {
    mode: "classic",
    accountId,
    name: `Hero ${accountId}`,
    displayName: `Name-${accountId}`,
    classId: "classic.warrior",
    level: 5,
    appearance: "unit.hero",
    maxHp: 100,
    dmgMin: 5,
    dmgMax: 9,
    attackRate: 10,
    armor: 2,
    resist: 0,
    critPct: 5,
    moveSpeed: 3,
    skills: [],
    power: 50,
    sourceHash: "src-1",
    ...patch,
  };
}

/** Deterministic uint32 sequence (an LCG); the same start gives the same ids. */
export function countingSeeds(start = 7): SeedSource {
  let s = start >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/** The stronger max hp wins (equal = draw). Records every call. */
export function fightByHp(calls: { seed: number }[] = []): FightFn {
  return (a, b, seed) => {
    calls.push({ seed });
    const winner: ArenaWinner =
      a.maxHp > b.maxHp ? "attacker" : a.maxHp < b.maxHp ? "defender" : "draw";
    return { winner, ticks: 42, contentHash: "test-hash" };
  };
}

export interface Faults {
  /** Next N walletTx calls throw before applying. */
  walletTxFail: number;
  /** Next N walletTx calls apply, then throw (the response is lost). */
  walletTxLost: number;
  addSeasonXpFail: number;
  notifyFail: number;
}

/** AccountGateway over memory: credits are applied once per (account, txId). */
export class FakeAccounts implements AccountGateway {
  readonly balances = new Map<string, number>();
  readonly txs = new Map<string, { amount: number; applications: number }>();
  readonly xp = new Map<string, number>();
  readonly xpTxs = new Set<string>();
  readonly notices = new Map<string, NoticeInput[]>();
  readonly faults: Faults = {
    walletTxFail: 0,
    walletTxLost: 0,
    addSeasonXpFail: 0,
    notifyFail: 0,
  };

  balance(accountId: string): number {
    return this.balances.get(accountId) ?? 0;
  }

  /** How many times the coin credit txId was actually applied (must be 1). */
  applications(accountId: string, txId: string): number {
    return this.txs.get(`${accountId}|${txId}`)?.applications ?? 0;
  }

  async wallet(accountId: string) {
    return { balances: { coin: this.balance(accountId), gem: 0 } } as never;
  }

  async walletTx(accountId: string, tx: WalletTxC): Promise<WalletTxResult> {
    if (this.faults.walletTxFail > 0) {
      this.faults.walletTxFail--;
      throw new Error("walletTx: unavailable");
    }
    const key = `${accountId}|${tx.txId}`;
    const seen = this.txs.get(key);
    if (seen) {
      return { ok: true, balance: this.balance(accountId), replayed: true };
    }
    this.txs.set(key, { amount: tx.amount, applications: 1 });
    this.balances.set(accountId, this.balance(accountId) + tx.amount);
    if (this.faults.walletTxLost > 0) {
      this.faults.walletTxLost--;
      throw new Error("walletTx: response lost");
    }
    return { ok: true, balance: this.balance(accountId), replayed: false };
  }

  async vaultGet(): Promise<null> {
    return null;
  }

  async vaultTake(): Promise<VaultTakeResult> {
    return { ok: false, code: "not_found" };
  }

  async vaultPut(): Promise<VaultPutResult> {
    return { ok: false, code: "bad_item" };
  }

  async notify(accountId: string, notice: NoticeInput): Promise<void> {
    if (this.faults.notifyFail > 0) {
      this.faults.notifyFail--;
      throw new Error("notify: unavailable");
    }
    const list = this.notices.get(accountId) ?? [];
    if (!list.some((n) => n.id === notice.id)) list.push(notice);
    this.notices.set(accountId, list);
  }

  async addSeasonXp(accountId: string, txId: string, xp: number): Promise<void> {
    if (this.faults.addSeasonXpFail > 0) {
      this.faults.addSeasonXpFail--;
      throw new Error("addSeasonXp: unavailable");
    }
    const key = `${accountId}|${txId}`;
    if (this.xpTxs.has(key)) return;
    this.xpTxs.add(key);
    this.xp.set(accountId, (this.xp.get(accountId) ?? 0) + xp);
  }
}

export interface Harness {
  store: ReturnType<typeof fakeSqlStore>;
  accounts: FakeAccounts;
  clock: { now: number; advance(ms: number): void };
  calls: { seed: number }[];
  /** A ladder over the same storage and gateway (a restart: a new instance). */
  ladder(opts?: { fight?: FightFn; seeds?: SeedSource }): ArenaLadder;
  /** The current ladder instance. */
  current: ArenaLadder;
  outbox: Outbox;
  restart(opts?: { fight?: FightFn; seeds?: SeedSource }): ArenaLadder;
}

/** A fresh ladder for SEASON "classic" over in-memory storage. */
export function harness(opts: { fight?: FightFn; seeds?: SeedSource } = {}): Harness {
  const store = fakeSqlStore();
  const accounts = new FakeAccounts();
  const clock = {
    now: T0,
    advance(ms: number) {
      this.now += ms;
    },
  };
  const calls: { seed: number }[] = [];
  const outbox = new Outbox(store.sql, `arena:classic:${SEASON}`);
  outbox.init();

  const make = (o: { fight?: FightFn; seeds?: SeedSource }) => {
    const ladder = new ArenaLadder({
      store,
      accounts,
      outbox,
      clock: () => clock.now,
      seeds: o.seeds ?? countingSeeds(),
      fight: o.fight ?? fightByHp(calls),
      mode: "classic",
      seasonId: SEASON,
    });
    ladder.init();
    return ladder;
  };

  const h: Harness = {
    store,
    accounts,
    clock,
    calls,
    outbox,
    current: make(opts),
    ladder: (o = {}) => make({ ...opts, ...o }),
    restart: (o = {}) => {
      h.current = make({ ...opts, ...o });
      return h.current;
    },
  };
  return h;
}

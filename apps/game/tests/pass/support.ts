/**
 * Test support for the battle pass (wave C, T-pass): an in-memory AccountDO
 * assembled from the real economy, vault and pass classes, with a recording
 * notices stand-in (AccountNotices is owned by T-escrow and may still be a stub).
 */
import { Outbox } from "@gamez/sync";
import { AccountEconomy } from "../../src/server/account/economy.ts";
import { AccountPass } from "../../src/server/account/pass.ts";
import { AccountVault } from "../../src/server/account/vault.ts";
import type { AccountNotices } from "../../src/server/account/notices.ts";
import type { NoticeInput } from "@gamez/protocol";
import { fakeSqlStore } from "../support/fake-sql.ts";

/** 2026-10-01T00:00:00Z: the first instant of season 2026-s1. */
export const S1_START = 1_790_812_800_000;

/** Records notify() calls like AccountNotices does (idempotent by id). */
export class RecordingNotices {
  readonly all: NoticeInput[] = [];
  readonly ids = new Set<string>();
  notify(notice: NoticeInput): void {
    if (this.ids.has(notice.id)) return;
    this.ids.add(notice.id);
    this.all.push(notice);
  }
  /** Ids of the pass.tier notices, in arrival order. */
  tierIds(): string[] {
    return this.all.filter((n) => n.kind === "pass.tier").map((n) => n.id);
  }
}

export interface FakeAccount {
  now: { value: number };
  store: ReturnType<typeof fakeSqlStore>;
  economy: AccountEconomy;
  vault: AccountVault;
  notices: RecordingNotices;
  pass: AccountPass;
}

/** One AccountDO worth of state, reopenable on the same store (a restart). */
export function fakeAccount(store = fakeSqlStore(), notices = new RecordingNotices()): FakeAccount {
  const now = { value: S1_START + 1_000 };
  const clock = () => now.value;
  const economy = new AccountEconomy(store, clock);
  economy.init();
  const outbox = new Outbox(store.sql, "account:test");
  outbox.init();
  const vault = new AccountVault(store, economy, outbox, "acct-test", clock);
  const pass = new AccountPass(store, economy, vault, notices as unknown as AccountNotices, clock);
  pass.init();
  return { now, store, economy, vault, notices, pass };
}

/** The AccountDO RPC surface the pass routes call, over a fake account. */
export function fakeStub(acct: FakeAccount) {
  return {
    pass: async () => acct.pass.view(),
    walletTx: async (tx: Parameters<AccountVault["walletTx"]>[0]) => acct.vault.walletTx(tx),
    grantEntitlement: async (g: Parameters<AccountEconomy["grantEntitlement"]>[0]) =>
      acct.economy.grantEntitlement(g),
    claimPassReward: async (tier: number, track: "free" | "premium") =>
      acct.pass.claim(tier, track),
    addSeasonXp: async (txId: string, xp: number, reason: string) =>
      acct.pass.addXp(txId, xp, reason),
    seasonProgress: async (source: string, total: number) =>
      acct.pass.seasonProgress(source, total),
  };
}

/**
 * In-memory AccountGateway for wave C DO logic tests (wave-C.md §1.1 rule 8).
 * OWNER: T-escrow; shared test support for market, shops, arena, trade.
 *
 * Every account is the REAL AccountDO logic (AccountEconomy + AccountVault +
 * AccountNotices on an in-memory node:sqlite store, with an Outbox), so the
 * semantics are exactly AccountDO's: idempotent by txId (a replay returns the
 * first result with replayed: true), balances never negative, vault_full at
 * VAULT_MAX_ITEMS, ledger + account_wallet outbox rows per applied wallet tx.
 *
 *   const gw = new FakeGateway();
 *   gw.seed("alice", { coin: 500, items: [testItem("sword")] });
 *   gw.failNext("vaultTake", { code: "not_found" });     // next vaultTake answers that
 *   gw.failNext("walletTx", "throw", { txId: /:fee$/ });  // throws BEFORE applying
 *   gw.failNext("vaultPut", "throwAfter");                // applies, then throws (lost reply)
 *   gw.balance("alice"); gw.vault("alice"); gw.noticesOf("alice"); gw.ledger("alice");
 *
 * Extra (not in AccountGateway): linkTrade/openTrades (the EscrowDO uses them
 * through env.ACCOUNT) and profile registration for route fakes.
 */
import {
  type NoticeInput,
  type NoticesResponse,
  type VaultItem,
  type VaultItemInput,
  type WalletView,
} from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { AccountEconomy } from "../../src/server/account/economy.ts";
import { AccountNotices } from "../../src/server/account/notices.ts";
import { AccountVault, vaultFullNotice } from "../../src/server/account/vault.ts";
import type {
  AccountGateway,
  EconomyLedgerPayload,
  VaultPutResult,
  VaultTakeResult,
  WalletTxC,
  WalletTxResult,
  VaultPutOptions,
} from "../../src/server/contracts.ts";
import { fakeSqlStore } from "./fake-sql.ts";

export type GatewayMethod = keyof AccountGateway | "linkTrade";

/**
 * How an injected failure behaves:
 * - `{ code }`: answer `{ ok: false, code }` (walletTx/vaultTake/vaultPut) without applying;
 *   for methods without a result shape (wallet, vaultGet, notify, …) it throws.
 * - `"throw"`: throw before applying (the call never reached the account).
 * - `"throwAfter"`: apply, then throw (the reply was lost; a retry must replay).
 */
export type FailMode = { code: string } | "throw" | "throwAfter";

export interface FailFilter {
  accountId?: string;
  /** Matches the txId (walletTx/vaultTake/vaultPut/addSeasonXp) or notice id (notify). */
  txId?: string | RegExp;
}

export interface FakeAccount {
  accountId: string;
  economy: AccountEconomy;
  vault: AccountVault;
  notices: AccountNotices;
  outbox: Outbox;
  /** Season xp grants by txId (addSeasonXp). */
  seasonXp: Map<string, { xp: number; reason: string }>;
  /** Set by register(); routes use it as AccountDO.profile(). */
  profile: { displayName: string; kind: "guest" | "registered" } | null;
}

export interface GatewayCall {
  method: GatewayMethod;
  accountId: string;
  key: string | null;
  outcome: "ok" | "failed" | "threw";
}

interface PendingFailure {
  method: GatewayMethod;
  mode: FailMode;
  filter: FailFilter;
}

/** A tradable test item ("sword" -> itemId "test.weapon.sword"). */
export function testItem(name: string, over: Partial<VaultItemInput> = {}): VaultItemInput {
  return {
    itemId: `test.weapon.${name}`,
    origin: "classic",
    count: 1,
    universal: false,
    tradable: true,
    summary: {
      name: name.slice(0, 60),
      rarity: "magic",
      level: 5,
      category: "weapon",
      slot: "weapon",
      icon: "item.sword",
      lines: ["+3 Strength"],
    },
    data: JSON.stringify({ name }),
    ...over,
  };
}

export class FakeGateway implements AccountGateway {
  readonly #accounts = new Map<string, FakeAccount>();
  readonly #failures: PendingFailure[] = [];
  readonly calls: GatewayCall[] = [];
  #seedSeq = 0;

  constructor(readonly now: () => number = () => 1_700_000_000_000) {}

  /** The account's real logic objects (created on first use, like AccountDO.getByName). */
  account(accountId: string): FakeAccount {
    let a = this.#accounts.get(accountId);
    if (!a) {
      const store = fakeSqlStore();
      const outbox = new Outbox(store.sql, `account:${accountId}`);
      const economy = new AccountEconomy(store, this.now);
      const vault = new AccountVault(store, economy, outbox, accountId, this.now);
      const notices = new AccountNotices(store, this.now);
      // Like AccountDO: a delivery the full vault refused tells the player once per spell.
      vault.onWaitStarted = (txId) => notices.notify(vaultFullNotice(txId));
      outbox.init();
      economy.init();
      vault.init();
      notices.init();
      a = { accountId, economy, vault, notices, outbox, seasonXp: new Map(), profile: null };
      this.#accounts.set(accountId, a);
    }
    return a;
  }

  /** Account ids touched so far, sorted. */
  accounts(): string[] {
    return [...this.#accounts.keys()].sort();
  }

  /** Marks an account as existing with a profile (route fakes answer profile() from it). */
  register(
    accountId: string,
    displayName = accountId,
    kind: "guest" | "registered" = "registered",
  ): FakeAccount {
    const a = this.account(accountId);
    a.profile = { displayName, kind };
    return a;
  }

  /** Test setup that bypasses failure injection: coin/gem as faucet credits, items put in the vault. */
  seed(
    accountId: string,
    s: { coin?: number; gem?: number; items?: VaultItemInput[] },
  ): VaultItem[] {
    const a = this.account(accountId);
    for (const currency of ["coin", "gem"] as const) {
      const amount = s[currency];
      if (amount)
        a.vault.walletTx({
          txId: `seed:${++this.#seedSeq}`,
          currency,
          amount,
          reason: "dev.seed",
          flow: "faucet",
        });
    }
    const out: VaultItem[] = [];
    for (const item of s.items ?? []) {
      const r = a.vault.vaultPut(`seed:${++this.#seedSeq}`, item);
      if (!r.ok) throw new Error(`seed vaultPut failed: ${r.code}`);
      out.push(r.item);
    }
    return out;
  }

  /** Queues a failure for the next call of `method` matching `filter`. */
  failNext(method: GatewayMethod, mode: FailMode, filter: FailFilter = {}): void {
    this.#failures.push({ method, mode, filter });
  }

  /** Failures queued but not yet triggered. */
  pendingFailures(): number {
    return this.#failures.length;
  }

  clearFailures(): void {
    this.#failures.length = 0;
  }

  // ---- inspect ------------------------------------------------------------

  balance(accountId: string, currency: "coin" | "gem" = "coin"): number {
    return this.account(accountId).economy.balanceOf(currency);
  }

  vault(accountId: string): VaultItem[] {
    return this.account(accountId).vault.vault();
  }

  noticesOf(accountId: string): NoticesResponse {
    return this.account(accountId).notices.notices(null);
  }

  /** economy_ledger outbox payloads of the account, oldest first. */
  ledger(accountId: string): EconomyLedgerPayload[] {
    return this.account(accountId)
      .outbox.pending(100_000)
      .filter((r) => r.table === "economy_ledger")
      .map((r) => r.payload as EconomyLedgerPayload);
  }

  /** Sum of coin (or gem) over the given accounts. */
  totalCoin(accountIds: readonly string[], currency: "coin" | "gem" = "coin"): number {
    return accountIds.reduce((s, id) => s + this.balance(id, currency), 0);
  }

  /** −Σ amount of flow "sink" ledger rows over the accounts (fees burnt, net of refunds). */
  sunk(accountIds: readonly string[]): number {
    let total = 0;
    for (const id of accountIds)
      for (const row of this.ledger(id)) if (row.flow === "sink") total -= row.amount;
    return total;
  }

  // ---- AccountGateway ------------------------------------------------------

  async wallet(accountId: string): Promise<WalletView> {
    return this.#run("wallet", accountId, null, () => this.account(accountId).economy.wallet());
  }

  async walletTx(accountId: string, tx: WalletTxC): Promise<WalletTxResult> {
    return this.#run(
      "walletTx",
      accountId,
      tx.txId,
      () => this.account(accountId).vault.walletTx(tx),
      (code) => ({
        ok: false,
        code: code as "insufficient_funds",
        balance: this.balance(accountId),
      }),
    );
  }

  async vaultGet(accountId: string, uid: string): Promise<VaultItem | null> {
    return this.#run("vaultGet", accountId, uid, () => this.account(accountId).vault.vaultGet(uid));
  }

  async vaultTake(accountId: string, txId: string, uid: string): Promise<VaultTakeResult> {
    return this.#run(
      "vaultTake",
      accountId,
      txId,
      () => this.account(accountId).vault.vaultTake(txId, uid),
      (code) => ({ ok: false, code: code as "not_found" }),
    );
  }

  async vaultPut(
    accountId: string,
    txId: string,
    item: VaultItemInput,
    opts?: VaultPutOptions,
  ): Promise<VaultPutResult> {
    return this.#run(
      "vaultPut",
      accountId,
      txId,
      () => this.account(accountId).vault.vaultPut(txId, item, opts),
      (code) => ({ ok: false, code: code as "vault_full" }),
    );
  }

  async notify(accountId: string, notice: NoticeInput): Promise<void> {
    return this.#run("notify", accountId, notice.id, () =>
      this.account(accountId).notices.notify(notice),
    );
  }

  async addSeasonXp(accountId: string, txId: string, xp: number, reason: string): Promise<void> {
    return this.#run("addSeasonXp", accountId, txId, () => {
      const a = this.account(accountId);
      if (!a.seasonXp.has(txId)) a.seasonXp.set(txId, { xp, reason });
    });
  }

  // ---- extras the EscrowDO uses through env.ACCOUNT -----------------------

  async linkTrade(accountId: string, tradeId: string, open: boolean): Promise<void> {
    return this.#run("linkTrade", accountId, tradeId, () =>
      this.account(accountId).notices.linkTrade(tradeId, open),
    );
  }

  openTrades(accountId: string): string[] {
    return this.account(accountId).notices.openTrades();
  }

  // ---- internals ------------------------------------------------------------

  #takeFailure(method: GatewayMethod, accountId: string, key: string | null): FailMode | null {
    const i = this.#failures.findIndex((f) => {
      if (f.method !== method) return false;
      if (f.filter.accountId !== undefined && f.filter.accountId !== accountId) return false;
      const want = f.filter.txId;
      if (want === undefined) return true;
      if (key === null) return false;
      return typeof want === "string" ? want === key : want.test(key);
    });
    if (i < 0) return null;
    const [f] = this.#failures.splice(i, 1);
    return f!.mode;
  }

  #run<T>(
    method: GatewayMethod,
    accountId: string,
    key: string | null,
    apply: () => T,
    failed?: (code: string) => T,
  ): T {
    const mode = this.#takeFailure(method, accountId, key);
    const log = (outcome: GatewayCall["outcome"]) =>
      this.calls.push({ method, accountId, key, outcome });
    if (mode === "throw") {
      log("threw");
      throw new Error(`injected ${method} failure (before apply)`);
    }
    if (mode !== null && mode !== "throwAfter") {
      if (!failed) {
        log("threw");
        throw new Error(`injected ${method} failure: ${mode.code}`);
      }
      log("failed");
      return failed(mode.code);
    }
    const out = apply();
    if (mode === "throwAfter") {
      log("threw");
      throw new Error(`injected ${method} failure (after apply)`);
    }
    const ok = !(
      out &&
      typeof out === "object" &&
      "ok" in out &&
      (out as { ok: boolean }).ok === false
    );
    log(ok ? "ok" : "failed");
    return out;
  }
}

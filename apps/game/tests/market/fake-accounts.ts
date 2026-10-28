/**
 * In-memory AccountDO stand-in for the market tests (T-market). Mirrors the
 * contract rules the market relies on:
 *   - walletTx and vault put/take are idempotent by txId (a replay returns the
 *     first result, flagged replayed);
 *   - failures (insufficient funds, vault full, item missing) are NOT recorded,
 *     like AccountEconomy.applyWalletTx;
 *   - every applied wallet change is kept in `flows` for conservation checks.
 *
 * `hooks.before` runs before every call and may await (to hold a call open,
 * for the busy test) or throw (to crash it, for the re-drive test).
 */
import type { NoticeInput, VaultItem, VaultItemInput, WalletView } from "@gamez/protocol";
import type {
  AccountGateway,
  VaultPutResult,
  VaultTakeResult,
  WalletTxC,
  WalletTxResult,
} from "../../src/server/contracts.ts";

export type Op = "walletTx" | "vaultGet" | "vaultTake" | "vaultPut" | "notify";

export interface CallInfo {
  op: Op;
  accountId: string;
  /** txId of wallet and vault writes. */
  txId?: string;
  /** Notice id of notify(). */
  noticeId?: string;
}

export interface Flow {
  accountId: string;
  txId: string;
  amount: number;
  flow: string;
  reason: string;
}

export class FakeAccounts implements AccountGateway {
  readonly balances = new Map<string, number>();
  readonly vaults = new Map<string, Map<string, VaultItem>>();
  readonly notices = new Map<string, NoticeInput[]>();
  readonly flows: Flow[] = [];
  /** Vault capacity (VAULT_MAX_ITEMS in production). */
  vaultMax = 200;
  /** Optional fault or hold, run before every call. */
  before: ((call: CallInfo) => Promise<void> | void) | null = null;

  readonly #wallet = new Map<string, WalletTxResult & { ok: true }>();
  readonly #vaultTx = new Map<string, { ok: true; item: VaultItem }>();
  #uid = 0;

  // ---- setup and inspection (not part of the gateway)

  /** Puts coin and items into an account's wallet and vault (a dev grant). */
  grant(accountId: string, coin: number, items: VaultItemInput[] = []): VaultItem[] {
    if (coin > 0) this.balances.set(accountId, this.coin(accountId) + coin);
    return items.map((it) => this.#addItem(accountId, it));
  }

  coin(accountId: string): number {
    return this.balances.get(accountId) ?? 0;
  }

  vaultOf(accountId: string): VaultItem[] {
    return [...(this.vaults.get(accountId)?.values() ?? [])];
  }

  noticesOf(accountId: string): NoticeInput[] {
    return this.notices.get(accountId) ?? [];
  }

  /** Coin created by grants (sum of faucet flows). */
  faucetTotal(): number {
    return this.flows.filter((f) => f.flow === "faucet").reduce((n, f) => n + f.amount, 0);
  }

  /** Coin destroyed (sinks), net of sink refunds: the telemetry convention (signed deltas). */
  sinkNet(): number {
    const net = this.flows.filter((f) => f.flow === "sink").reduce((n, f) => n + f.amount, 0);
    return net === 0 ? 0 : -net;
  }

  /** Sum of all wallets. */
  walletSum(): number {
    let n = 0;
    for (const v of this.balances.values()) n += v;
    return n;
  }

  // ---- AccountGateway

  async wallet(accountId: string): Promise<WalletView> {
    return { balances: { coin: this.coin(accountId), gem: 0 } };
  }

  async walletTx(accountId: string, tx: WalletTxC): Promise<WalletTxResult> {
    await this.before?.({ op: "walletTx", accountId, txId: tx.txId });
    const key = `${accountId}|${tx.txId}`;
    const prior = this.#wallet.get(key);
    if (prior) return { ok: true, balance: prior.balance, replayed: true };
    const current = this.coin(accountId);
    const next = current + tx.amount;
    if (next < 0) return { ok: false, code: "insufficient_funds", balance: current };
    this.balances.set(accountId, next);
    const applied: WalletTxResult & { ok: true } = { ok: true, balance: next, replayed: false };
    this.#wallet.set(key, applied);
    this.flows.push({
      accountId,
      txId: tx.txId,
      amount: tx.amount,
      flow: tx.flow ?? "transfer",
      reason: tx.reason,
    });
    return applied;
  }

  async vaultGet(accountId: string, uid: string): Promise<VaultItem | null> {
    await this.before?.({ op: "vaultGet", accountId });
    return this.vaults.get(accountId)?.get(uid) ?? null;
  }

  async vaultTake(accountId: string, txId: string, uid: string): Promise<VaultTakeResult> {
    await this.before?.({ op: "vaultTake", accountId, txId });
    const key = `${accountId}|${txId}`;
    const prior = this.#vaultTx.get(key);
    if (prior) return { ok: true, item: prior.item, replayed: true };
    const vault = this.vaults.get(accountId);
    const item = vault?.get(uid);
    if (!vault || !item) return { ok: false, code: "not_found" };
    vault.delete(uid);
    this.#vaultTx.set(key, { ok: true, item });
    return { ok: true, item, replayed: false };
  }

  async vaultPut(accountId: string, txId: string, input: VaultItemInput): Promise<VaultPutResult> {
    await this.before?.({ op: "vaultPut", accountId, txId });
    const key = `${accountId}|${txId}`;
    const prior = this.#vaultTx.get(key);
    if (prior) return { ok: true, item: prior.item, replayed: true };
    const size = this.vaults.get(accountId)?.size ?? 0;
    if (size >= this.vaultMax) return { ok: false, code: "vault_full" };
    const item = this.#addItem(accountId, input);
    this.#vaultTx.set(key, { ok: true, item });
    return { ok: true, item, replayed: false };
  }

  async notify(accountId: string, notice: NoticeInput): Promise<void> {
    await this.before?.({ op: "notify", accountId, noticeId: notice.id });
    const list = this.notices.get(accountId) ?? [];
    if (list.some((n) => n.id === notice.id)) return;
    list.push(notice);
    this.notices.set(accountId, list);
  }

  async addSeasonXp(): Promise<void> {}

  /** The AccountDO RPC surface of one account (what env.ACCOUNT.getByName returns). */
  stub(accountId: string) {
    return {
      vaultGet: (uid: string) => this.vaultGet(accountId, uid),
      vaultTake: (txId: string, uid: string) => this.vaultTake(accountId, txId, uid),
      vaultPut: (txId: string, item: VaultItemInput) => this.vaultPut(accountId, txId, item),
      walletTx: (tx: WalletTxC) => this.walletTx(accountId, tx),
      wallet: () => this.wallet(accountId),
      notify: (notice: NoticeInput) => this.notify(accountId, notice),
      addSeasonXp: () => Promise.resolve(),
    };
  }

  #addItem(accountId: string, input: VaultItemInput): VaultItem {
    const uid = `u${++this.#uid}`;
    const item: VaultItem = { ...input, uid };
    let vault = this.vaults.get(accountId);
    if (!vault) {
      vault = new Map();
      this.vaults.set(accountId, vault);
    }
    vault.set(uid, item);
    return item;
  }
}

/**
 * Direct trade between two accounts: the EscrowDO logic (wave-C.md §3.3).
 * OWNER: T-escrow. do/escrow.ts is a thin adapter around TradeEscrow.
 *
 * States: open -> committing -> done | failed; open -> cancelled (either side,
 * or expiry TRADE_TTL_MS after creation, run from the alarm).
 *
 * Offers are snapshots of vault items (tradable required, at most
 * TRADE_MAX_ITEMS) plus coin (soft-checked against the wallet, fee included).
 * Any change of a side's offer bumps that side's version and clears both
 * accepts. An accept names the [aVersion, bVersion] pair it saw; when both
 * sides accepted the current pair the trade commits.
 *
 * Commit = a saga whose every step is idempotent by txId and persisted as
 * "started" BEFORE the call (so a crash re-drives exactly that call, which
 * replays if it had applied):
 *   1. custody from each side: coin   walletTx(-coin, "trade:<id>:<s>:coin", transfer)
 *                              fee    walletTx(-fee,  "trade:<id>:<s>:fee", sink, "trade.fee:<id>")
 *                              items  vaultTake("trade:<id>:<s>:take:<uid>")
 *   2. a custody step answering a failure -> compensate every completed custody
 *      step back to its owner (":refund", ":refund-fee", ":return:<uid>") -> failed
 *   3. deliver to the other side: items vaultPut(":give:<uid>"), coin walletTx(":recv") -> done
 *   4. tasks: notices (trade.done / trade.cancelled) and linkTrade(false) on both.
 * A compensation or delivery step that answers a failure (vault_full) or any
 * call that throws is retried from the alarm with backoff: custody holds the
 * value meanwhile, so nothing is ever lost or duplicated.
 *
 * The DO is single-threaded but awaits interleave: offer/accept/cancel answer
 * "busy" while committing, every state change is a synchronous
 * load-modify-save, and one drive() runs at a time.
 */
import { tradeFee } from "@gamez/economy";
import {
  type EconomyErrorCode,
  TRADE_MAX_ITEMS,
  TRADE_TTL_MS,
  type NoticeInput,
  type Party,
  type TradeOffer,
  type TradeSide,
  type TradeStatus,
  type TradeView,
  type VaultItem,
  type VaultItemInput,
} from "@gamez/protocol";
import type {
  AccountGateway,
  EconResult,
  EconomyFlow,
  SqlStore,
  VaultPutResult,
  VaultTakeResult,
  WalletTxResult,
} from "../contracts.ts";

/** AccountGateway plus the trade index of AccountDO (linkTrade). */
export interface TradeAccounts extends AccountGateway {
  linkTrade(accountId: string, tradeId: string, open: boolean): Promise<void>;
}

export interface EscrowEnv {
  now: () => number;
  /** Sets (replaces) the DO alarm; null = none needed. */
  setAlarm: (at: number | null) => Promise<void> | void;
}

export const TRADE_ID_RE = /^t[0-9a-f]{24}$/;
const MAX_COIN = 1_000_000_000;
const MAX_UID = 128;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60 * 60_000;

type StepKind = "coin" | "fee" | "take" | "refund" | "refund-fee" | "return" | "recv" | "give";

/** One idempotent account call of the saga. */
export interface SagaStep {
  txId: string;
  /** Whose offer the step belongs to. */
  side: TradeSide;
  kind: StepKind;
  /** Account called. */
  account: string;
  op: "walletTx" | "vaultTake" | "vaultPut";
  /** walletTx: signed amount, flow, reason. */
  amount?: number;
  flow?: EconomyFlow;
  reason?: string;
  /** vaultTake: the uid; vaultPut: the uid it came from. */
  uid?: string;
  /** vaultTake: the item taken (set when done); vaultPut: the item to put. */
  item?: VaultItem;
  state: "todo" | "started" | "done" | "failed";
}

/** A notice or index update owed to an account (retried until done). */
export interface TradeTask {
  key: string;
  account: string;
  kind: "link" | "notify";
  open?: boolean;
  notice?: NoticeInput;
  done: boolean;
}

export interface TradeState {
  id: string;
  a: Party;
  b: Party;
  offers: Record<TradeSide, TradeOffer>;
  accepted: Record<TradeSide, [number, number] | null>;
  status: TradeStatus;
  reason: string | null;
  createdAt: number;
  expiresAt: number;
  saga: {
    phase: "custody" | "compensate" | "deliver" | "settled";
    custody: SagaStep[];
    compensation: SagaStep[];
    delivery: SagaStep[];
    /** Code of the custody failure that triggered compensation. */
    failure: string | null;
  } | null;
  tasks: TradeTask[];
  /** Retry bookkeeping for drive(). */
  attempts: number;
  retryAt: number | null;
  /** Why the last drive stopped early, shown in the view ("vault_full", "retrying"); null when healthy. */
  blocked: string | null;
  /** Full message of the last drive error (internal; never shown to players). */
  lastError?: string | null;
}

const SIDES: readonly TradeSide[] = ["a", "b"];
const other = (s: TradeSide): TradeSide => (s === "a" ? "b" : "a");

type Failure = { ok: false; code: EconomyErrorCode; message: string };
function fail(code: EconomyErrorCode, message: string): Failure {
  return { ok: false, code, message };
}

function isVersionPair(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
  );
}

function samePair(x: [number, number] | null, y: [number, number] | null): boolean {
  return x !== null && y !== null && x[0] === y[0] && x[1] === y[1];
}

function toInput(item: VaultItem): VaultItemInput {
  const { uid: _uid, ...rest } = item;
  return rest;
}

function isParty(p: unknown): p is Party {
  if (!p || typeof p !== "object") return false;
  const { accountId, displayName } = p as Party;
  return (
    typeof accountId === "string" &&
    accountId.length > 0 &&
    accountId.length <= 80 &&
    typeof displayName === "string" &&
    displayName.length <= 64
  );
}

/** A compensation/delivery step answered a failure: retry later. `code` is shown to the parties. */
class Blocked extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class TradeEscrow {
  #driving: Promise<void> | null = null;

  constructor(
    readonly store: SqlStore,
    readonly accounts: TradeAccounts,
    readonly env: EscrowEnv,
  ) {}

  init(): void {
    this.store.sql.exec(`CREATE TABLE IF NOT EXISTS trade (
      k INTEGER PRIMARY KEY CHECK (k = 1),
      state TEXT NOT NULL
    )`);
  }

  /** The persisted state (tests and the DO adapter). */
  state(): TradeState | null {
    const row = this.store.sql
      .exec<{ state: string }>("SELECT state FROM trade WHERE k = 1")
      .toArray()[0];
    return row ? (JSON.parse(row.state) as TradeState) : null;
  }

  #save(st: TradeState): void {
    this.store.sql.exec(
      "INSERT INTO trade (k, state) VALUES (1, ?) ON CONFLICT (k) DO UPDATE SET state = excluded.state",
      JSON.stringify(st),
    );
  }

  /** Synchronous load-modify-save (never awaits: no interleaving inside). */
  #mutate<T>(fn: (st: TradeState) => T): { st: TradeState; out: T } | null {
    return this.store.transactionSync(() => {
      const st = this.state();
      if (!st) return null;
      const out = fn(st);
      this.#save(st);
      return { st, out };
    });
  }

  // ---- RPCs -----------------------------------------------------------------

  async open(input: { tradeId: string; a: Party; b: Party }): Promise<EconResult<TradeView>> {
    if (
      !input ||
      typeof input.tradeId !== "string" ||
      !TRADE_ID_RE.test(input.tradeId) ||
      !isParty(input.a) ||
      !isParty(input.b)
    )
      return fail("bad_request", "tradeId and both parties required");
    if (input.a.accountId === input.b.accountId)
      return fail("bad_request", "you cannot trade with yourself");
    const now = this.env.now();
    const existing = this.state();
    if (existing) {
      if (existing.a.accountId !== input.a.accountId || existing.b.accountId !== input.b.accountId)
        return fail("conflict", "this trade id belongs to another trade");
      await this.#expireIfDue();
      await this.drive();
      return { ok: true, value: this.#view(this.state()!), replayed: true };
    }
    const empty = (): TradeOffer => ({ coin: 0, items: [], version: 0 });
    const id = input.tradeId;
    const a = { accountId: input.a.accountId, displayName: input.a.displayName };
    const b = { accountId: input.b.accountId, displayName: input.b.displayName };
    const st: TradeState = {
      id,
      a,
      b,
      offers: { a: empty(), b: empty() },
      accepted: { a: null, b: null },
      status: "open",
      reason: null,
      createdAt: now,
      expiresAt: now + TRADE_TTL_MS,
      saga: null,
      tasks: [
        { key: "link:a", account: a.accountId, kind: "link", open: true, done: false },
        { key: "link:b", account: b.accountId, kind: "link", open: true, done: false },
        {
          key: "invite",
          account: b.accountId,
          kind: "notify",
          notice: {
            id: `trade:${id}:invite`,
            kind: "trade.invite",
            text: `${a.displayName.slice(0, 40)} wants to trade with you`,
            data: { tradeId: id, from: a.accountId, fromName: a.displayName },
            at: now,
          },
          done: false,
        },
      ],
      attempts: 0,
      retryAt: null,
      blocked: null,
    };
    this.store.transactionSync(() => this.#save(st));
    await this.drive();
    return { ok: true, value: this.#view(this.state()!) };
  }

  async view(accountId: string): Promise<TradeView | null> {
    const st = this.state();
    if (!st || this.#sideOf(st, accountId) === null) return null;
    await this.#expireIfDue();
    return this.#view(this.state()!);
  }

  async offer(input: {
    accountId: string;
    coin: number;
    uids: string[];
  }): Promise<EconResult<TradeView>> {
    const coin = input?.coin;
    const uids = input?.uids;
    if (typeof coin !== "number" || !Number.isSafeInteger(coin) || coin < 0 || coin > MAX_COIN)
      return fail("bad_request", "coin: integer 0..1e9");
    if (
      !Array.isArray(uids) ||
      !uids.every((u) => typeof u === "string" && u.length > 0 && u.length <= MAX_UID)
    )
      return fail("bad_request", "uids: list of vault item uids");
    if (uids.length > TRADE_MAX_ITEMS)
      return fail("too_many", `at most ${TRADE_MAX_ITEMS} items per side`);
    if (new Set(uids).size !== uids.length) return fail("bad_request", "duplicate uid");

    const pre = await this.#gate(input.accountId);
    if (!pre.ok) return pre;
    const { st, side } = pre.value;
    const current = st.offers[side];
    const same =
      current.coin === coin &&
      current.items.length === uids.length &&
      current.items.every((it, i) => it.uid === uids[i]);
    if (same) return { ok: true, value: this.#view(st), replayed: true };

    // Snapshots (awaits: the state may change meanwhile; re-checked below).
    const items: VaultItem[] = [];
    for (const uid of uids) {
      const item = await this.accounts.vaultGet(input.accountId, uid);
      if (!item) return fail("not_found", `item ${uid} is not in your vault`);
      if (!item.tradable) return fail("not_tradable", `${item.summary.name} cannot be traded`);
      items.push(item);
    }
    if (coin > 0) {
      const balance = (await this.accounts.wallet(input.accountId)).balances.coin;
      const fee = tradeFee(coin);
      if (coin + fee > balance)
        return fail("insufficient_funds", `you need ${coin + fee} coin (fee ${fee} included)`);
    }

    const done = this.#mutate((s): EconResult<null> => {
      const g = this.#gateSync(s, input.accountId);
      if (!g.ok) return g;
      const prev = s.offers[side];
      s.offers[side] = { coin, items, version: prev.version + 1 };
      s.accepted = { a: null, b: null };
      return { ok: true, value: null };
    });
    if (!done) return fail("not_found", "no such trade");
    if (!done.out.ok) return done.out;
    return { ok: true, value: this.#view(done.st) };
  }

  async accept(input: {
    accountId: string;
    versions: [number, number];
  }): Promise<EconResult<TradeView>> {
    const versions = input?.versions;
    if (!isVersionPair(versions)) return fail("bad_request", "versions: [aVersion, bVersion]");
    const st0 = this.state();
    const side0 = st0 ? this.#sideOf(st0, input.accountId) : null;
    if (!st0 || side0 === null) return fail("not_found", "no such trade");
    // A replayed accept is a no-op whatever happened since (committing, done…).
    if (samePair(st0.accepted[side0], versions))
      return { ok: true, value: this.#view(st0), replayed: true };

    const pre = await this.#gate(input.accountId);
    if (!pre.ok) return pre;
    const res = this.#mutate((s): EconResult<boolean> => {
      const g = this.#gateSync(s, input.accountId);
      if (!g.ok) return g;
      const side = g.value;
      const pair: [number, number] = [s.offers.a.version, s.offers.b.version];
      if (!samePair(pair, versions))
        return fail("conflict", "the offer changed: review it and accept again");
      const empty = SIDES.every((x) => s.offers[x].coin === 0 && s.offers[x].items.length === 0);
      if (empty) return fail("bad_request", "nothing offered yet");
      s.accepted[side] = pair;
      if (!samePair(s.accepted[other(side)], pair)) return { ok: true, value: false };
      this.#startCommit(s);
      return { ok: true, value: true };
    });
    if (!res) return fail("not_found", "no such trade");
    if (!res.out.ok) return res.out;
    if (res.out.value) await this.drive();
    return { ok: true, value: this.#view(this.state()!) };
  }

  async cancel(accountId: string): Promise<EconResult<TradeView>> {
    const st0 = this.state();
    const side0 = st0 ? this.#sideOf(st0, accountId) : null;
    if (!st0 || side0 === null) return fail("not_found", "no such trade");
    if (st0.status === "cancelled") return { ok: true, value: this.#view(st0), replayed: true };
    const pre = await this.#gate(accountId);
    if (!pre.ok) return pre;
    const res = this.#mutate((s): EconResult<null> => {
      const g = this.#gateSync(s, accountId);
      if (!g.ok) return g;
      this.#finish(s, "cancelled", `cancelled_by_${g.value}`);
      return { ok: true, value: null };
    });
    if (!res) return fail("not_found", "no such trade");
    if (!res.out.ok) return res.out;
    await this.drive();
    return { ok: true, value: this.#view(this.state()!) };
  }

  /** DO alarm: expiry while open, saga re-drive after a crash, task retries. */
  async alarm(): Promise<void> {
    if (!this.state()) return;
    await this.#expireIfDue();
    await this.drive();
    await this.#reschedule();
  }

  /**
   * Runs pending saga steps and tasks until done, blocked or a call throws
   * (then the alarm retries with backoff). One drive at a time.
   */
  drive(): Promise<void> {
    if (this.#driving) return this.#driving;
    this.#driving = this.#driveLoop().finally(() => {
      this.#driving = null;
    });
    return this.#driving;
  }

  // ---- internals ------------------------------------------------------------

  async #driveLoop(): Promise<void> {
    // Each round either finishes the work, adds tasks (once) or throws; the
    // bound only guards against a corrupted state looping forever.
    for (let round = 0; round < 8; round++) {
      const st = this.state();
      if (!st || !this.#hasWork(st)) break;
      try {
        if (st.status === "committing") await this.#runSaga();
        await this.#runTasks();
        this.#mutate((s) => {
          s.attempts = 0;
          s.retryAt = null;
          s.blocked = null;
          s.lastError = null;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.#mutate((s) => {
          s.attempts += 1;
          s.retryAt =
            this.env.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (s.attempts - 1));
          s.blocked = err instanceof Blocked ? err.code : "retrying";
          s.lastError = msg.slice(0, 300);
        });
        break;
      }
    }
    await this.#reschedule();
  }

  #hasWork(st: TradeState): boolean {
    return st.status === "committing" || st.tasks.some((t) => !t.done);
  }

  async #reschedule(): Promise<void> {
    const st = this.state();
    let at: number | null = null;
    if (st) {
      if (this.#hasWork(st)) at = st.retryAt ?? this.env.now();
      if (st.status === "open") at = at === null ? st.expiresAt : Math.min(at, st.expiresAt);
    }
    await this.env.setAlarm(at);
  }

  async #expireIfDue(): Promise<void> {
    const res = this.#mutate((s) => {
      if (s.status !== "open" || this.env.now() < s.expiresAt) return false;
      this.#finish(s, "cancelled", "expired");
      return true;
    });
    if (res?.out) await this.drive();
  }

  /** Party + status checks before an offer/accept/cancel (also expires a due trade). */
  async #gate(accountId: string): Promise<EconResult<{ st: TradeState; side: TradeSide }>> {
    const st0 = this.state();
    if (!st0 || this.#sideOf(st0, accountId) === null) return fail("not_found", "no such trade");
    await this.#expireIfDue();
    const st = this.state()!;
    const g = this.#gateSync(st, accountId);
    return g.ok ? { ok: true, value: { st, side: g.value } } : g;
  }

  #gateSync(st: TradeState, accountId: string): EconResult<TradeSide> {
    const side = this.#sideOf(st, accountId);
    if (side === null) return fail("not_found", "no such trade");
    if (st.status === "committing") return fail("busy", "the trade is being settled");
    if (st.status !== "open")
      return fail(st.reason === "expired" ? "expired" : "closed", `the trade is ${st.status}`);
    return { ok: true, value: side };
  }

  #sideOf(st: TradeState, accountId: string): TradeSide | null {
    if (accountId === st.a.accountId) return "a";
    if (accountId === st.b.accountId) return "b";
    return null;
  }

  #party(st: TradeState, side: TradeSide): Party {
    return side === "a" ? st.a : st.b;
  }

  #startCommit(st: TradeState): void {
    const id = st.id;
    const custody: SagaStep[] = [];
    for (const s of SIDES) {
      const owner = this.#party(st, s).accountId;
      const offer = st.offers[s];
      if (offer.coin > 0) {
        custody.push({
          txId: `trade:${id}:${s}:coin`,
          side: s,
          kind: "coin",
          account: owner,
          op: "walletTx",
          amount: -offer.coin,
          flow: "transfer",
          reason: `trade:${id}`,
          state: "todo",
        });
        custody.push({
          txId: `trade:${id}:${s}:fee`,
          side: s,
          kind: "fee",
          account: owner,
          op: "walletTx",
          amount: -tradeFee(offer.coin),
          flow: "sink",
          reason: `trade.fee:${id}`,
          state: "todo",
        });
      }
      for (const item of offer.items) {
        custody.push({
          txId: `trade:${id}:${s}:take:${item.uid}`,
          side: s,
          kind: "take",
          account: owner,
          op: "vaultTake",
          uid: item.uid,
          state: "todo",
        });
      }
    }
    st.status = "committing";
    st.saga = { phase: "custody", custody, compensation: [], delivery: [], failure: null };
  }

  /** open/committing -> terminal: queue notices and close the index on both sides. */
  #finish(st: TradeState, status: "done" | "failed" | "cancelled", reason: string | null): void {
    st.status = status;
    st.reason = reason;
    if (st.saga) st.saga.phase = "settled";
    const at = this.env.now();
    for (const s of SIDES) {
      const me = this.#party(st, s);
      const them = this.#party(st, other(s));
      const text =
        status === "done"
          ? `Trade with ${them.displayName.slice(0, 40)} completed`
          : status === "failed"
            ? `Trade with ${them.displayName.slice(0, 40)} failed (${reason ?? "error"})`
            : reason === "expired"
              ? `Trade with ${them.displayName.slice(0, 40)} expired`
              : `Trade with ${them.displayName.slice(0, 40)} was cancelled`;
      st.tasks.push({
        key: `notify:${s}:${status}`,
        account: me.accountId,
        kind: "notify",
        notice: {
          id: `trade:${st.id}:${status}`,
          kind: status === "done" ? "trade.done" : "trade.cancelled",
          text,
          data: { tradeId: st.id, status, reason, with: them.accountId },
          at,
        },
        done: false,
      });
      st.tasks.push({
        key: `unlink:${s}`,
        account: me.accountId,
        kind: "link",
        open: false,
        done: false,
      });
    }
  }

  async #runTasks(): Promise<void> {
    for (;;) {
      const st = this.state();
      const task = st?.tasks.find((t) => !t.done);
      if (!st || !task) return;
      if (task.kind === "link")
        await this.accounts.linkTrade(task.account, st.id, task.open ?? false);
      else if (task.notice) await this.accounts.notify(task.account, task.notice);
      this.#mutate((s) => {
        const t = s.tasks.find((x) => x.key === task.key);
        if (t) t.done = true;
      });
    }
  }

  async #runSaga(): Promise<void> {
    for (;;) {
      const st = this.state();
      if (!st || st.status !== "committing" || !st.saga) return;
      const saga = st.saga;
      const phase = saga.phase;
      const list =
        phase === "custody"
          ? saga.custody
          : phase === "compensate"
            ? saga.compensation
            : phase === "deliver"
              ? saga.delivery
              : [];
      const step = list.find((s) => s.state === "todo" || s.state === "started");
      if (!step) {
        this.#mutate((s) => this.#advance(s));
        continue;
      }
      // Persist BEFORE the call: a crash re-drives exactly this call (same txId).
      this.#mutate((s) => {
        const x = this.#stepOf(s, phase, step.txId);
        if (x) x.state = "started";
      });
      const r = await this.#call(step);
      if (r.ok) {
        this.#mutate((s) => {
          const x = this.#stepOf(s, phase, step.txId);
          if (!x) return;
          x.state = "done";
          if (step.op === "vaultTake" && r.item) x.item = r.item;
        });
        continue;
      }
      if (phase === "custody") {
        this.#mutate((s) => {
          const x = this.#stepOf(s, phase, step.txId);
          if (!x || !s.saga) return;
          x.state = "failed";
          s.saga.failure = r.code;
          s.saga.phase = "compensate";
          s.saga.compensation = this.#compensationOf(s);
        });
        continue;
      }
      // Compensation/delivery answered a failure (vault_full…): nothing was
      // applied; keep the value in custody and retry later.
      this.#mutate((s) => {
        const x = this.#stepOf(s, phase, step.txId);
        if (x) x.state = "todo";
      });
      throw new Blocked(r.code, `${step.kind} for ${step.account}: ${r.code}`);
    }
  }

  #stepOf(st: TradeState, phase: string, txId: string): SagaStep | undefined {
    const saga = st.saga;
    if (!saga) return undefined;
    const list =
      phase === "custody"
        ? saga.custody
        : phase === "compensate"
          ? saga.compensation
          : saga.delivery;
    return list.find((s) => s.txId === txId);
  }

  /** The current phase has no step left: move on. */
  #advance(st: TradeState): void {
    const saga = st.saga;
    if (!saga) return;
    if (saga.phase === "custody") {
      saga.phase = "deliver";
      saga.delivery = this.#deliveryOf(st);
    } else if (saga.phase === "deliver") {
      this.#finish(st, "done", null);
    } else if (saga.phase === "compensate") {
      this.#finish(st, "failed", saga.failure ?? "failed");
    }
  }

  /** Undo of every completed custody step, newest first. */
  #compensationOf(st: TradeState): SagaStep[] {
    const id = st.id;
    const out: SagaStep[] = [];
    for (const c of [...(st.saga?.custody ?? [])].reverse()) {
      if (c.state !== "done") continue;
      if (c.kind === "coin")
        out.push({
          txId: `trade:${id}:${c.side}:refund`,
          side: c.side,
          kind: "refund",
          account: c.account,
          op: "walletTx",
          amount: -(c.amount ?? 0),
          flow: "transfer",
          reason: `trade:${id}`,
          state: "todo",
        });
      else if (c.kind === "fee")
        out.push({
          txId: `trade:${id}:${c.side}:refund-fee`,
          side: c.side,
          kind: "refund-fee",
          account: c.account,
          op: "walletTx",
          amount: -(c.amount ?? 0),
          flow: "sink",
          reason: `trade.fee:${id}`,
          state: "todo",
        });
      else if (c.kind === "take" && c.item)
        out.push({
          txId: `trade:${id}:${c.side}:return:${c.uid}`,
          side: c.side,
          kind: "return",
          account: c.account,
          op: "vaultPut",
          uid: c.uid,
          item: c.item,
          state: "todo",
        });
    }
    return out;
  }

  /** Everything in custody goes to the other side: items first, then coin. */
  #deliveryOf(st: TradeState): SagaStep[] {
    const id = st.id;
    const out: SagaStep[] = [];
    for (const s of SIDES) {
      const to = this.#party(st, other(s)).accountId;
      for (const c of st.saga?.custody ?? []) {
        if (c.side !== s || c.kind !== "take" || !c.item) continue;
        out.push({
          txId: `trade:${id}:${s}:give:${c.uid}`,
          side: s,
          kind: "give",
          account: to,
          op: "vaultPut",
          uid: c.uid,
          item: c.item,
          state: "todo",
        });
      }
    }
    for (const s of SIDES) {
      const coin = st.saga?.custody.find((c) => c.side === s && c.kind === "coin");
      if (!coin) continue;
      out.push({
        txId: `trade:${id}:${s}:recv`,
        side: s,
        kind: "recv",
        account: this.#party(st, other(s)).accountId,
        op: "walletTx",
        amount: -(coin.amount ?? 0),
        flow: "transfer",
        reason: `trade:${id}`,
        state: "todo",
      });
    }
    return out;
  }

  async #call(
    step: SagaStep,
  ): Promise<{ ok: true; item?: VaultItem } | { ok: false; code: string }> {
    if (step.op === "walletTx") {
      const r: WalletTxResult = await this.accounts.walletTx(step.account, {
        txId: step.txId,
        currency: "coin",
        amount: step.amount ?? 0,
        reason: step.reason ?? "trade",
        flow: step.flow ?? "transfer",
      });
      return r.ok ? { ok: true } : { ok: false, code: r.code };
    }
    if (step.op === "vaultTake") {
      const r: VaultTakeResult = await this.accounts.vaultTake(
        step.account,
        step.txId,
        step.uid ?? "",
      );
      return r.ok ? { ok: true, item: r.item } : { ok: false, code: r.code };
    }
    if (!step.item) return { ok: false, code: "bad_item" };
    // Puts are deliveries or compensations, retried while the vault is full.
    const r: VaultPutResult = await this.accounts.vaultPut(
      step.account,
      step.txId,
      toInput(step.item),
      { waiting: true },
    );
    return r.ok ? { ok: true, item: r.item } : { ok: false, code: r.code };
  }

  #view(st: TradeState): TradeView {
    return {
      id: st.id,
      a: st.a,
      b: st.b,
      offers: st.offers,
      accepted: st.accepted,
      status: st.status,
      reason: st.status === "committing" && st.blocked ? `pending: ${st.blocked}` : st.reason,
      fees: { a: tradeFee(st.offers.a.coin), b: tradeFee(st.offers.b.coin) },
      createdAt: st.createdAt,
      expiresAt: st.expiresAt,
    };
  }
}

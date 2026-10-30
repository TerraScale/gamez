/**
 * Auction house shard (wave-C.md §4): the rules behind MarketDO. OWNER: T-market.
 *
 * One MarketBook = one shard "<scope>:<category>". Listings hold their item in
 * custody (the seller's vault row is taken when the listing is created) and the
 * top bid in custody (the bidder's coin is debited while it leads). Every money
 * or item move is an idempotent AccountDO call with a txId derived from the
 * listing id, so a retried step never applies twice.
 *
 * Sagas: each user operation (list, bid, buy, cancel) and each alarm-driven
 * expiry is a saga persisted in `mk_listing.busy_json` before its first gateway
 * call. That persisted lock makes a concurrent op on the same listing answer
 * "busy", and the alarm (tick) re-drives any saga that stopped mid-way.
 * Steps run in order; a step persists the next step before the call that
 * follows it, so a crash re-runs at most the step that was in flight.
 *
 * One driver per listing (ADR 0007 R7): `#drive` keeps the in-flight promise
 * per listing, so a user request and the alarm never run the same saga at once.
 * Every write that moves a saga on (save, finish, release) is a compare-and-set
 * on the busy_json the step started from; a step whose write changes nothing
 * stops without further side effects (another driver moved the saga on).
 *
 * Failure policy: a saga is released (lock dropped, error returned) only while
 * no money or item has moved. Once a debit or a take has happened, the saga
 * only moves forward or retries.
 *
 * Rows with status "pending" (a list saga still running) are never projected
 * to D1 and never returned by get().
 */
import {
  isAmount,
  listingFee,
  marketEligible,
  marketShard,
  MARKET_DURATIONS_H,
  MARKET_MAX_ACTIVE_PER_ACCOUNT,
  MARKET_MAX_PRICE,
  minNextBid,
  salesTax,
  shardOfListing,
} from "@gamez/economy";
import {
  isOpId,
  type EconomyErrorCode,
  type ListingStatus,
  type MarketListing,
  type NoticeKind,
  type Party,
  type VaultItemInput,
  type VaultItem,
} from "@gamez/protocol";
import type { Outbox } from "@gamez/sync";
import type {
  AccountGateway,
  EconResult,
  EconomySalePayload,
  MarketListingPayload,
  SqlStore,
  WalletTxResult,
} from "../contracts.ts";

const HOUR_MS = 3_600_000;
/** A bid within this window of the end pushes the end out to now + this. */
export const ANTI_SNIPE_MS = 5 * 60_000;
/** A busy saga is re-driven by the alarm once it has been idle this long. */
export const RESUME_AFTER_MS = 5_000;
/** Retry delay for an expiry or a stuck saga that failed to advance. */
export const RETRY_MS = 30_000;
const NOTICE_MAX = 140;

/** Row of mk_listing (SELECT *). */
type Row = {
  id: string;
  seq: number;
  status: string;
  seller_id: string;
  seller_name: string;
  item_json: string | null;
  buyout: number | null;
  start_bid: number | null;
  top_bid: number | null;
  top_bidder_id: string | null;
  top_bidder_name: string | null;
  bids: number;
  fee: number;
  created_at: number;
  ends_at: number;
  sold_for: number | null;
  /** Bumped when a buy saga aborted after its debit, so its txIds are fresh. */
  gen: number;
  busy_json: string | null;
};

type OpRow = { fp: string; listing_id: string; done: number };

type Kind = "list" | "bid" | "buy" | "cancel" | "expire";

interface ErrInfo {
  code: EconomyErrorCode;
  message: string;
}

/** The persisted saga (busy_json). */
interface Saga {
  kind: Kind;
  /** Op-table key written on success ("bid:<opId>"); null for expiry. */
  opKey: string | null;
  step: string;
  /** The actor: list seller, bidder, buyer; expiry: the top bidder (sale) or null. */
  party: Party | null;
  /** Bid amount, or the price of a buy/sale. */
  amount: number;
  durationH: number;
  /** list: the vault uid being listed. */
  uid: string;
  /** The failure to report once the saga is released. */
  err: ErrInfo | null;
  /** expire: a sale could not be delivered, so the top bid is refunded and the item returned. */
  fallback: boolean;
  /** Epoch ms of the last persisted step. */
  at: number;
}

export type Outcome =
  | { kind: "done"; listing: MarketListing }
  | { kind: "failed"; err: ErrInfo }
  | { kind: "retry"; reason: string };

export interface ListInput {
  opId: string;
  seller: Party;
  uid: string;
  buyout: number | null;
  startBid: number | null;
  durationH: number;
}

type Result<T> = EconResult<T>;

function fail(
  code: EconomyErrorCode,
  message: string,
): { ok: false; code: EconomyErrorCode; message: string } {
  return { ok: false, code, message };
}

function saga(kind: Kind, step: string, fields: Partial<Saga> = {}): Saga {
  return {
    kind,
    opKey: null,
    step,
    party: null,
    amount: 0,
    durationH: 0,
    uid: "",
    err: null,
    fallback: false,
    at: 0,
    ...fields,
  };
}

function clip(text: string): string {
  return text.length <= NOTICE_MAX ? text : `${text.slice(0, NOTICE_MAX - 3)}...`;
}

function walletError(r: Extract<WalletTxResult, { ok: false }>): ErrInfo {
  if (r.code === "insufficient_funds")
    return { code: "insufficient_funds", message: "not enough coin" };
  if (r.code === "conflict")
    return { code: "conflict", message: "this payment id was already used for another payment" };
  return { code: "internal", message: "the wallet rejected the transaction" };
}

/** The item as the market holds it (VaultItemInput, data kept for returns). */
function inputOf(item: VaultItem | VaultItemInput): VaultItemInput {
  return {
    itemId: item.itemId,
    count: item.count,
    origin: item.origin,
    universal: item.universal,
    tradable: item.tradable,
    summary: item.summary,
    data: item.data,
  };
}

/** Why an item cannot be listed in this shard, or null when it can. */
export function itemProblem(item: VaultItemInput, shard: string): ErrInfo | null {
  if (!item.tradable) return { code: "not_tradable", message: "this item cannot be traded" };
  if (!marketEligible(item.summary))
    return {
      code: "not_eligible",
      message: "only level 10+ gear, gems, materials and cosmetics can be listed",
    };
  if (marketShard(item) !== shard)
    return { code: "wrong_origin", message: "this item belongs to another auction house" };
  return null;
}

function publicItem(item: VaultItemInput): MarketListing["item"] {
  return {
    itemId: item.itemId,
    count: item.count,
    origin: item.origin,
    universal: item.universal,
    tradable: item.tradable,
    summary: item.summary,
  };
}

function toResult(out: Outcome): Result<MarketListing> {
  if (out.kind === "done") return { ok: true, value: out.listing };
  if (out.kind === "failed") return { ok: false, code: out.err.code, message: out.err.message };
  return fail("unavailable", "the market is settling this listing, try again shortly");
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mk_listing (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    seller_name TEXT NOT NULL,
    item_json TEXT,
    buyout INTEGER,
    start_bid INTEGER,
    top_bid INTEGER,
    top_bidder_id TEXT,
    top_bidder_name TEXT,
    bids INTEGER NOT NULL DEFAULT 0,
    fee INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    ends_at INTEGER NOT NULL DEFAULT 0,
    sold_for INTEGER,
    gen INTEGER NOT NULL DEFAULT 0,
    busy_json TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS mk_listing_status ON mk_listing (status, ends_at)",
  "CREATE INDEX IF NOT EXISTS mk_listing_seller ON mk_listing (seller_id, status)",
  `CREATE TABLE IF NOT EXISTS mk_op (
    op_key TEXT PRIMARY KEY,
    fp TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    done INTEGER NOT NULL,
    at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS mk_op_listing ON mk_op (listing_id)",
  "CREATE TABLE IF NOT EXISTS mk_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
];

export class MarketBook {
  /** The in-flight drive of each listing (one driver per listing). */
  readonly #driving = new Map<string, Promise<Outcome>>();

  constructor(
    readonly store: SqlStore,
    readonly gateway: AccountGateway,
    readonly outbox: Outbox,
    readonly shard: string,
    readonly now: () => number = Date.now,
  ) {}

  init(): void {
    for (const sql of SCHEMA) this.store.sql.exec(sql);
  }

  // ---- public operations ---------------------------------------------------

  /** Puts a vault item up for sale (fee sink, item in custody). Idempotent by opId. */
  async list(input: ListInput): Promise<Result<MarketListing>> {
    const { opId, seller, uid, buyout, startBid, durationH } = input;
    if (!isOpId(opId)) return fail("bad_request", "opId: 8-64 chars [A-Za-z0-9_-]");
    if (typeof uid !== "string" || uid.length < 1 || uid.length > 128)
      return fail("bad_request", "uid must be a vault item id");
    if (buyout === null && startBid === null)
      return fail("bad_request", "set a buyout or a start bid");
    if (buyout !== null && !isAmount(buyout, MARKET_MAX_PRICE))
      return fail("bad_request", "buyout must be a whole number of coin");
    if (startBid !== null && !isAmount(startBid, MARKET_MAX_PRICE))
      return fail("bad_request", "start bid must be a whole number of coin");
    if (buyout !== null && startBid !== null && startBid > buyout)
      return fail("bad_request", "the start bid cannot be above the buyout");
    if (!(MARKET_DURATIONS_H as readonly number[]).includes(durationH))
      return fail("bad_request", "duration must be 12, 24 or 48 hours");

    const opKey = `list:${opId}`;
    const fp = `list|${uid}|${buyout}|${startBid}|${durationH}`;
    const replay = this.#checkOp(opKey, fp);
    if (replay) return replay;

    const active =
      this.#all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM mk_listing WHERE seller_id = ? AND status IN ('active', 'pending')",
        seller.accountId,
      )[0]?.n ?? 0;
    if (active >= MARKET_MAX_ACTIVE_PER_ACCOUNT)
      return fail(
        "too_many",
        `at most ${MARKET_MAX_ACTIVE_PER_ACCOUNT} active listings per market`,
      );

    const id = this.#allocId();
    const now = this.now();
    const s = saga("list", "validate", { opKey, party: seller, uid, durationH, at: now });
    this.store.transactionSync(() => {
      this.store.sql.exec(
        `INSERT INTO mk_listing (id, seq, status, seller_id, seller_name, item_json, buyout, start_bid,
           top_bid, top_bidder_id, top_bidder_name, bids, fee, created_at, ends_at, sold_for, gen, busy_json)
         VALUES (?, ?, 'pending', ?, ?, NULL, ?, ?, NULL, NULL, NULL, 0, ?, ?, 0, NULL, 0, ?)`,
        id,
        seqOf(id),
        seller.accountId,
        seller.displayName,
        buyout,
        startBid,
        listingFee(buyout, startBid),
        now,
        JSON.stringify(s),
      );
      this.store.sql.exec(
        "INSERT INTO mk_op (op_key, fp, listing_id, done, at) VALUES (?, ?, ?, 0, ?)",
        opKey,
        fp,
        id,
        now,
      );
    });
    return toResult(await this.#driveOwn(id));
  }

  /** Bids (or buys, when the amount reaches the buyout). Idempotent by opId. */
  async bid(input: {
    opId: string;
    bidder: Party;
    listingId: string;
    amount: number;
  }): Promise<Result<MarketListing>> {
    const { opId, bidder, listingId, amount } = input;
    if (!isOpId(opId)) return fail("bad_request", "opId: 8-64 chars [A-Za-z0-9_-]");
    if (!isAmount(amount, MARKET_MAX_PRICE))
      return fail("bad_request", "amount must be a whole number of coin");
    const opKey = `bid:${opId}`;
    const fp = `bid|${listingId}|${amount}`;
    const open = this.#openRow(listingId, opKey, fp);
    if (!open.ok) return open.res;
    const row = open.row;

    if (row.seller_id === bidder.accountId)
      return fail("forbidden", "you cannot bid on your own listing");
    if (row.status !== "active") return fail("closed", "this listing is over");
    if (row.ends_at <= this.now()) return fail("expired", "this listing has ended");
    if (row.buyout !== null && amount >= row.buyout) return this.#lockBuy(row, bidder, opKey, fp);
    if (row.start_bid === null) return fail("too_low", `buy it now for ${row.buyout ?? 0} coin`);
    const min = minNextBid(row.top_bid, row.start_bid);
    if (amount < min) return fail("too_low", `the next bid must be at least ${min} coin`);

    this.#lock(listingId, saga("bid", "debit", { opKey, party: bidder, amount }), opKey, fp);
    return toResult(await this.#driveOwn(listingId));
  }

  /** Buys at the buyout price. Idempotent by opId. */
  async buy(input: {
    opId: string;
    buyer: Party;
    listingId: string;
  }): Promise<Result<MarketListing>> {
    const { opId, buyer, listingId } = input;
    if (!isOpId(opId)) return fail("bad_request", "opId: 8-64 chars [A-Za-z0-9_-]");
    const opKey = `buy:${opId}`;
    const fp = `buy|${listingId}`;
    const open = this.#openRow(listingId, opKey, fp);
    if (!open.ok) return open.res;
    const row = open.row;
    if (row.seller_id === buyer.accountId)
      return fail("forbidden", "you cannot buy your own listing");
    if (row.status !== "active") return fail("closed", "this listing is over");
    if (row.ends_at <= this.now()) return fail("expired", "this listing has ended");
    if (row.buyout === null)
      return fail("bad_request", "this listing is auction only: bid instead");
    return this.#lockBuy(row, buyer, opKey, fp);
  }

  /** Seller takes the item back; only with no bids. The listing fee is kept. */
  async cancel(input: {
    opId: string;
    accountId: string;
    listingId: string;
  }): Promise<Result<MarketListing>> {
    const { opId, accountId, listingId } = input;
    if (!isOpId(opId)) return fail("bad_request", "opId: 8-64 chars [A-Za-z0-9_-]");
    const opKey = `cancel:${opId}`;
    const fp = `cancel|${listingId}`;
    const open = this.#openRow(listingId, opKey, fp);
    if (!open.ok) return open.res;
    const row = open.row;
    if (row.seller_id !== accountId) return fail("forbidden", "only the seller can cancel");
    if (row.status !== "active") return fail("closed", "this listing is over");
    if (row.ends_at <= this.now()) return fail("expired", "this listing has ended");
    if (row.bids > 0) return fail("conflict", "a listing with bids cannot be cancelled");
    const seller = { accountId: row.seller_id, displayName: row.seller_name };
    this.#lock(listingId, saga("cancel", "return", { opKey, party: seller }), opKey, fp);
    return toResult(await this.#driveOwn(listingId));
  }

  /** The public view of a settled listing, or null (unknown, other shard or pending). */
  get(listingId: string): MarketListing | null {
    if (!this.#owns(listingId)) return null;
    const row = this.#row(listingId);
    return row && row.status !== "pending" ? this.#view(row) : null;
  }

  /**
   * Alarm work: re-drives busy sagas that went quiet and expires listings whose
   * end time has passed. Each listing is isolated; one failure never stops the rest.
   */
  async tick(): Promise<void> {
    const now = this.now();
    const busy = this.#all<{ id: string; busy_json: string }>(
      "SELECT id, busy_json FROM mk_listing WHERE busy_json IS NOT NULL ORDER BY id",
    );
    for (const b of busy) {
      const s = JSON.parse(b.busy_json) as Saga;
      if (now - s.at < RESUME_AFTER_MS) continue;
      await this.#guarded(b.id, () => this.#drive(b.id));
    }
    const due = this.#all<Row>(
      "SELECT * FROM mk_listing WHERE status = 'active' AND busy_json IS NULL AND ends_at <= ? ORDER BY ends_at ASC, id ASC LIMIT 20",
      now,
    );
    for (const row of due) {
      await this.#guarded(row.id, () => this.#expire(row));
    }
  }

  /** The next time the alarm has work, or null when there is none. */
  nextWake(now: number): number | null {
    const wakes: number[] = [];
    for (const b of this.#all<{ busy_json: string }>(
      "SELECT busy_json FROM mk_listing WHERE busy_json IS NOT NULL",
    )) {
      const s = JSON.parse(b.busy_json) as Saga;
      wakes.push(s.at + RESUME_AFTER_MS > now ? s.at + RESUME_AFTER_MS : now + RETRY_MS);
    }
    const next = this.#all<{ t: number | null }>(
      "SELECT MIN(ends_at) AS t FROM mk_listing WHERE status = 'active' AND busy_json IS NULL",
    )[0]?.t;
    if (next !== null && next !== undefined) wakes.push(next <= now ? now + RETRY_MS : next);
    return wakes.length > 0 ? Math.min(...wakes) : null;
  }

  // ---- saga engine ---------------------------------------------------------

  /**
   * Drives the listing's saga, or joins the drive already running for it: one
   * driver per listing, so the alarm and a user request never run it twice.
   */
  #drive(id: string): Promise<Outcome> {
    const running = this.#driving.get(id);
    if (running) return running;
    const p = this.#driveLoop(id).finally(() => {
      if (this.#driving.get(id) === p) this.#driving.delete(id);
    });
    this.#driving.set(id, p);
    return p;
  }

  /**
   * Drives a saga the caller just locked. A drive still winding down from the
   * previous saga (it already ended) is awaited first, so the new saga is the
   * one driven and its outcome the one answered.
   */
  async #driveOwn(id: string): Promise<Outcome> {
    const running = this.#driving.get(id);
    if (running) await running.catch(() => undefined);
    return this.#drive(id);
  }

  /** Runs steps until the saga finishes, fails, or must wait for a retry. */
  async #driveLoop(id: string): Promise<Outcome> {
    for (let i = 0; i < 64; i++) {
      const row = this.#row(id);
      if (!row) return { kind: "failed", err: { code: "not_found", message: "no such listing" } };
      if (!row.busy_json) {
        if (row.status === "pending") return { kind: "retry", reason: "lock lost" };
        return { kind: "done", listing: this.#view(row) };
      }
      const out = await this.#step(id, row, row.busy_json);
      if (out) return out;
    }
    return { kind: "retry", reason: "saga did not converge" };
  }

  /**
   * Expiry of a listing whose end time has passed (no opId, no caller). The
   * lock is taken only if the listing is still active and unlocked (a user saga
   * may have locked it during an earlier await of the same tick).
   */
  async #expire(due: Row): Promise<Outcome> {
    const claimed = this.store.transactionSync((): boolean => {
      const row = this.#row(due.id);
      if (!row || row.status !== "active" || row.busy_json !== null || row.ends_at > this.now()) {
        return false;
      }
      const top = row.top_bidder_id !== null && row.top_bid !== null;
      const s = saga("expire", top ? "deliver" : "return", {
        party: top
          ? { accountId: row.top_bidder_id ?? "", displayName: row.top_bidder_name ?? "" }
          : null,
        amount: top ? (row.top_bid ?? 0) : 0,
        at: this.now(),
      });
      return this.#cas(
        "UPDATE mk_listing SET busy_json = ? WHERE id = ? AND busy_json IS NULL RETURNING id",
        JSON.stringify(s),
        row.id,
      );
    });
    if (!claimed) return { kind: "retry", reason: "listing is no longer due" };
    return this.#drive(due.id);
  }

  /**
   * Runs one step of the saga stored as `from` (the exact busy_json read). Every
   * save/finish/release below is a compare-and-set on `from`.
   */
  async #step(id: string, row: Row, from: string): Promise<Outcome | null> {
    const s = JSON.parse(from) as Saga;
    const t = (base: string): string => (row.gen > 0 ? `${base}.${row.gen}` : base);
    const seller: Party = { accountId: row.seller_id, displayName: row.seller_name };
    const item = (): VaultItemInput => JSON.parse(row.item_json ?? "null") as VaultItemInput;
    const name = (): string => item().summary.name;

    switch (s.step) {
      // ---- list
      case "validate": {
        const got = await this.gateway.vaultGet(seller.accountId, s.uid);
        if (!got) {
          return this.#release(
            id,
            from,
            s,
            { code: "not_found", message: "that item is not in your vault" },
            false,
          );
        }
        const input = inputOf(got);
        const problem = itemProblem(input, this.shard);
        if (problem) return this.#release(id, from, s, problem, false);
        return this.#save(id, from, { ...s, step: "fee" }, JSON.stringify(input));
      }
      case "fee": {
        const r = await this.gateway.walletTx(seller.accountId, {
          txId: `mk:${id}:fee`,
          currency: "coin",
          amount: -row.fee,
          reason: `market.fee:${id}`,
          flow: "sink",
        });
        if (!r.ok) return this.#release(id, from, s, walletError(r), false);
        return this.#save(id, from, { ...s, step: "take" });
      }
      case "take": {
        const r = await this.gateway.vaultTake(seller.accountId, `mk:${id}:take`, s.uid);
        if (!r.ok) {
          return this.#save(id, from, {
            ...s,
            step: "refund",
            err: { code: "not_found", message: "that item is no longer in your vault" },
          });
        }
        const input = inputOf(r.item);
        const problem = itemProblem(input, this.shard);
        if (problem)
          return this.#save(
            id,
            from,
            { ...s, step: "return", err: problem },
            JSON.stringify(input),
          );
        return this.#save(id, from, { ...s, step: "activate" }, JSON.stringify(input));
      }
      case "activate": {
        const now = this.now();
        return this.#finish(
          id,
          from,
          s,
          () =>
            this.store.sql.exec(
              "UPDATE mk_listing SET status = 'active', created_at = ?, ends_at = ?, busy_json = NULL WHERE id = ?",
              now,
              now + s.durationH * HOUR_MS,
              id,
            ),
          null,
        );
      }

      // ---- bid
      case "refund-prev": {
        const prev: Party = {
          accountId: row.top_bidder_id ?? "",
          displayName: row.top_bidder_name ?? "",
        };
        const r = await this.gateway.walletTx(prev.accountId, {
          txId: `mk:${id}:refund:${row.bids}`,
          currency: "coin",
          amount: row.top_bid ?? 0,
          reason: `market.refund:${id}`,
          flow: "transfer",
        });
        if (!r.ok) return { kind: "retry", reason: "outbid refund pending" };
        if (prev.accountId !== partyOf(s).accountId) {
          await this.#notify(prev.accountId, `market:${id}:outbid:${row.bids}`, "market.outbid", {
            text: `You were outbid on ${name()}. ${row.top_bid ?? 0} coin is back in your wallet.`,
            listingId: id,
            amount: row.top_bid ?? 0,
          });
        }
        return this.#save(id, from, { ...s, step: "commit-bid" });
      }
      case "commit-bid": {
        const now = this.now();
        const ends = row.ends_at - now < ANTI_SNIPE_MS ? now + ANTI_SNIPE_MS : row.ends_at;
        const bidder = partyOf(s);
        return this.#finish(
          id,
          from,
          s,
          () =>
            this.store.sql.exec(
              `UPDATE mk_listing SET top_bid = ?, top_bidder_id = ?, top_bidder_name = ?,
                 bids = bids + 1, ends_at = ?, busy_json = NULL WHERE id = ?`,
              s.amount,
              bidder.accountId,
              bidder.displayName,
              ends,
              id,
            ),
          null,
        );
      }

      // ---- buy (also the sale of an expiring listing with a top bid)
      case "debit": {
        // Bid debit (buy's debit is the "buy" branch below, same step name).
        const who = partyOf(s);
        if (s.kind === "bid") {
          const r = await this.gateway.walletTx(who.accountId, {
            txId: `mk:${id}:bid:${row.bids + 1}`,
            currency: "coin",
            amount: -s.amount,
            reason: `market.bid:${id}`,
            flow: "transfer",
          });
          if (!r.ok) return this.#release(id, from, s, walletError(r), false);
          return this.#save(id, from, {
            ...s,
            step: row.top_bidder_id ? "refund-prev" : "commit-bid",
          });
        }
        const r = await this.gateway.walletTx(who.accountId, {
          txId: t(`mk:${id}:buy`),
          currency: "coin",
          amount: -s.amount,
          reason: `market.buy:${id}`,
          flow: "transfer",
        });
        if (!r.ok) return this.#release(id, from, s, walletError(r), false);
        return this.#save(id, from, { ...s, step: "deliver" });
      }
      case "deliver": {
        const who = partyOf(s);
        const r = await this.gateway.vaultPut(who.accountId, t(`mk:${id}:deliver`), item());
        if (r.ok)
          return this.#save(id, from, { ...s, step: s.kind === "buy" ? "refund-top" : "proceeds" });
        if (s.kind === "buy") {
          return this.#save(id, from, {
            ...s,
            step: "undo",
            err: { code: "vault_full", message: "the buyer's vault cannot take this item" },
          });
        }
        return this.#save(id, from, { ...s, step: "refund-fallback", fallback: true });
      }
      case "undo": {
        // The buy could not be delivered: the debit goes back, under a fresh gen.
        const who = partyOf(s);
        const r = await this.gateway.walletTx(who.accountId, {
          txId: `${t(`mk:${id}:buy`)}:refund`,
          currency: "coin",
          amount: s.amount,
          reason: `market.buy:${id}`,
          flow: "transfer",
        });
        if (!r.ok) return { kind: "retry", reason: "buy refund pending" };
        return this.#release(
          id,
          from,
          s,
          s.err ?? { code: "internal", message: "buy aborted" },
          true,
        );
      }
      case "refund-top": {
        if (row.top_bidder_id !== null) {
          const top: Party = {
            accountId: row.top_bidder_id,
            displayName: row.top_bidder_name ?? "",
          };
          const r = await this.gateway.walletTx(top.accountId, {
            txId: `mk:${id}:refund:${row.bids}`,
            currency: "coin",
            amount: row.top_bid ?? 0,
            reason: `market.refund:${id}`,
            flow: "transfer",
          });
          if (!r.ok) return { kind: "retry", reason: "bid refund pending" };
          if (top.accountId !== partyOf(s).accountId) {
            await this.#notify(top.accountId, `market:${id}:outbid:${row.bids}`, "market.outbid", {
              text: `${name()} was bought out. Your ${row.top_bid ?? 0} coin bid is back in your wallet.`,
              listingId: id,
              amount: row.top_bid ?? 0,
            });
          }
        }
        return this.#save(id, from, { ...s, step: "proceeds" });
      }
      case "proceeds": {
        const r = await this.gateway.walletTx(seller.accountId, {
          txId: t(`mk:${id}:proceeds`),
          currency: "coin",
          amount: s.amount,
          reason: `market.sale:${id}`,
          flow: "transfer",
        });
        if (!r.ok) return { kind: "retry", reason: "sale proceeds pending" };
        return this.#save(id, from, { ...s, step: "tax" });
      }
      case "tax": {
        const tax = salesTax(s.amount);
        const r = await this.gateway.walletTx(seller.accountId, {
          txId: t(`mk:${id}:tax`),
          currency: "coin",
          amount: -tax,
          reason: `market.tax:${id}`,
          flow: "sink",
        });
        if (!r.ok) return { kind: "retry", reason: "sales tax pending" };
        return this.#save(id, from, { ...s, step: "notify" });
      }
      case "notify": {
        const winner = partyOf(s);
        const tax = salesTax(s.amount);
        await this.#notify(seller.accountId, `market:${id}:sold`, "market.sold", {
          text: clip(`${name()} sold for ${s.amount} coin (${tax} sales tax).`),
          listingId: id,
          amount: s.amount,
        });
        await this.#notify(winner.accountId, `market:${id}:won`, "market.won", {
          text: clip(`You won ${name()} for ${s.amount} coin.`),
          listingId: id,
          amount: s.amount,
        });
        return this.#save(id, from, { ...s, step: "commit-sold" });
      }
      case "commit-sold": {
        const winner = partyOf(s);
        const it = item();
        const tax = salesTax(s.amount);
        const sale: EconomySalePayload = {
          saleId: `mk:${id}`,
          venue: "market",
          scope: this.shard.slice(0, this.shard.indexOf(":")),
          category: it.summary.category,
          itemId: it.itemId,
          name: it.summary.name,
          rarity: it.summary.rarity,
          level: it.summary.level,
          price: s.amount,
          tax,
          sellerId: seller.accountId,
          buyerId: winner.accountId,
          at: this.now(),
        };
        return this.#finish(
          id,
          from,
          s,
          () =>
            this.store.sql.exec(
              `UPDATE mk_listing SET status = 'sold', sold_for = ?, top_bid = ?, top_bidder_id = ?,
                 top_bidder_name = ?, busy_json = NULL WHERE id = ?`,
              s.amount,
              s.amount,
              winner.accountId,
              winner.displayName,
              id,
            ),
          sale,
        );
      }

      // ---- cancel and expiry without a sale
      case "return": {
        // Only a cancel or an un-sold expiry may give up here: no money moved.
        // Every other return is held and retried, so it is listed as waiting.
        const givesUp = s.kind === "cancel" || (s.kind === "expire" && !s.fallback);
        const r = await this.gateway.vaultPut(seller.accountId, `mk:${id}:return`, item(), {
          waiting: !givesUp,
        });
        if (!r.ok) {
          if (givesUp) {
            return this.#release(
              id,
              from,
              s,
              { code: "unavailable", message: "your vault cannot take the item back yet" },
              false,
            );
          }
          return { kind: "retry", reason: "item return pending" };
        }
        if (s.kind === "list") return this.#save(id, from, { ...s, step: "refund" });
        if (s.kind === "cancel") return this.#save(id, from, { ...s, step: "commit-cancel" });
        return this.#save(id, from, { ...s, step: "notify-expired" });
      }
      case "commit-cancel": {
        return this.#finish(
          id,
          from,
          s,
          () =>
            this.store.sql.exec(
              "UPDATE mk_listing SET status = 'cancelled', busy_json = NULL WHERE id = ?",
              id,
            ),
          null,
        );
      }
      case "notify-expired": {
        await this.#notify(seller.accountId, `market:${id}:expired`, "market.expired", {
          text: clip(`${name()} expired unsold and is back in your vault.`),
          listingId: id,
          amount: 0,
        });
        return this.#save(id, from, { ...s, step: "commit-expired" });
      }
      case "commit-expired": {
        return this.#finish(
          id,
          from,
          s,
          () =>
            this.store.sql.exec(
              `UPDATE mk_listing SET status = 'expired', top_bid = NULL, top_bidder_id = NULL,
                 top_bidder_name = NULL, busy_json = NULL WHERE id = ?`,
              id,
            ),
          null,
        );
      }
      case "refund-fallback": {
        // The top bidder's vault could not take the item: refund the bid, return the item.
        const top: Party = {
          accountId: row.top_bidder_id ?? "",
          displayName: row.top_bidder_name ?? "",
        };
        const r = await this.gateway.walletTx(top.accountId, {
          txId: `mk:${id}:refund:${row.bids}`,
          currency: "coin",
          amount: row.top_bid ?? 0,
          reason: `market.refund:${id}`,
          flow: "transfer",
        });
        if (!r.ok) return { kind: "retry", reason: "fallback refund pending" };
        await this.#notify(top.accountId, `market:${id}:refunded`, "market.expired", {
          text: clip(
            `${name()} could not be delivered. Your ${row.top_bid ?? 0} coin bid is refunded.`,
          ),
          listingId: id,
          amount: row.top_bid ?? 0,
        });
        return this.#save(id, from, { ...s, step: "return" });
      }

      // ---- list, after a failed take: the fee goes back
      case "refund": {
        const r = await this.gateway.walletTx(seller.accountId, {
          txId: `mk:${id}:fee:refund`,
          currency: "coin",
          amount: row.fee,
          reason: `market.fee:${id}`,
          flow: "sink",
        });
        if (!r.ok) return { kind: "retry", reason: "fee refund pending" };
        return this.#release(
          id,
          from,
          s,
          s.err ?? { code: "internal", message: "listing aborted" },
          false,
        );
      }
      default:
        throw new Error(`market: unknown saga step ${s.step}`);
    }
  }

  // ---- helpers -------------------------------------------------------------

  /**
   * Persists the next saga state (the lock) and optionally the item, only if the
   * listing still holds `from` (compare-and-set). Returns null (keep going), or
   * the stale outcome when another driver moved the saga on: the step stops.
   */
  #save(id: string, from: string, s: Saga, itemJson?: string): Outcome | null {
    s.at = this.now();
    const saved =
      itemJson === undefined
        ? this.#cas(
            "UPDATE mk_listing SET busy_json = ? WHERE id = ? AND busy_json = ? RETURNING id",
            JSON.stringify(s),
            id,
            from,
          )
        : this.#cas(
            "UPDATE mk_listing SET busy_json = ?, item_json = ? WHERE id = ? AND busy_json = ? RETURNING id",
            JSON.stringify(s),
            itemJson,
            id,
            from,
          );
    return saved ? null : this.#stale(id, s);
  }

  /** Runs an UPDATE ... RETURNING; true when it changed a row. */
  #cas(sql: string, ...args: unknown[]): boolean {
    return this.store.sql.exec(sql, ...args).toArray().length > 0;
  }

  /** True when the listing still holds exactly the saga `from` (call inside a transaction). */
  #holds(id: string, from: string): boolean {
    return (
      this.#all<{ busy_json: string | null }>(
        "SELECT busy_json FROM mk_listing WHERE id = ?",
        id,
      )[0]?.busy_json === from
    );
  }

  /**
   * The answer of a step whose compare-and-set failed: another driver moved the
   * saga on. A finished op answers its listing; anything else asks to retry.
   */
  #stale(id: string, s: Saga): Outcome {
    console.warn(`market: listing ${id} saga ${s.kind}/${s.step} was moved on by another driver`);
    if (s.opKey !== null) {
      const op = this.#all<{ done: number }>("SELECT done FROM mk_op WHERE op_key = ?", s.opKey)[0];
      const row = this.#row(id);
      if (op?.done === 1 && row) return { kind: "done", listing: this.#view(row) };
    }
    return { kind: "retry", reason: "another driver moved this saga on" };
  }

  /** Takes the lock for a new user saga and records its op, in one transaction. */
  #lock(id: string, s: Saga, opKey: string, fp: string): void {
    this.store.transactionSync(() => {
      s.at = this.now();
      this.store.sql.exec(
        "UPDATE mk_listing SET busy_json = ? WHERE id = ?",
        JSON.stringify(s),
        id,
      );
      this.store.sql.exec(
        "INSERT INTO mk_op (op_key, fp, listing_id, done, at) VALUES (?, ?, ?, 0, ?)",
        opKey,
        fp,
        id,
        this.now(),
      );
    });
  }

  #lockBuy(row: Row, buyer: Party, opKey: string, fp: string): Promise<Result<MarketListing>> {
    const price = row.buyout ?? 0;
    this.#lock(row.id, saga("buy", "debit", { opKey, party: buyer, amount: price }), opKey, fp);
    return this.#driveOwn(row.id).then(toResult);
  }

  /** Common guard of bid/buy/cancel: replay, existence, shard, lock. */
  #openRow(
    listingId: string,
    opKey: string,
    fp: string,
  ): { ok: true; row: Row } | { ok: false; res: Result<MarketListing> } {
    if (!this.#owns(listingId)) return { ok: false, res: fail("not_found", "no such listing") };
    const replay = this.#checkOp(opKey, fp);
    if (replay) return { ok: false, res: replay };
    const row = this.#row(listingId);
    if (!row || row.status === "pending")
      return { ok: false, res: fail("not_found", "no such listing") };
    if (row.busy_json)
      return { ok: false, res: fail("busy", "this listing is being updated, try again") };
    return { ok: true, row };
  }

  /** A finished op with the same opId replays its listing; a busy one or a changed request is refused. */
  #checkOp(opKey: string, fp: string): Result<MarketListing> | null {
    const op = this.#all<OpRow>(
      "SELECT fp, listing_id, done FROM mk_op WHERE op_key = ?",
      opKey,
    )[0];
    if (!op) return null;
    if (op.fp !== fp) return fail("conflict", "this opId was already used for another request");
    if (!op.done) return fail("busy", "this request is still running");
    const row = this.#row(op.listing_id);
    if (!row) return fail("not_found", "no such listing");
    return { ok: true, value: this.#view(row), replayed: true };
  }

  /**
   * Ends a saga successfully: state change, op done, outbox rows, all in one
   * transaction, and only if the listing still holds `from` (compare-and-set).
   */
  #finish(
    id: string,
    from: string,
    s: Saga,
    mutate: () => void,
    sale: EconomySalePayload | null,
  ): Outcome {
    return this.store.transactionSync((): Outcome => {
      if (!this.#holds(id, from)) return this.#stale(id, s);
      mutate();
      if (s.opKey !== null) {
        this.store.sql.exec("UPDATE mk_op SET done = 1 WHERE op_key = ?", s.opKey);
      }
      const row = this.#row(id);
      if (!row) return { kind: "failed", err: { code: "internal", message: "listing vanished" } };
      const listing = this.#view(row);
      this.outbox.append("market_listing", id, "upsert", {
        listing,
      } satisfies MarketListingPayload);
      if (sale) this.outbox.append("economy_sale", sale.saleId, "upsert", sale);
      return { kind: "done", listing };
    });
  }

  /**
   * Ends a saga that has not moved money: drops the lock, drops a pending
   * listing, deletes its op; only if the listing still holds `from`.
   */
  #release(id: string, from: string, s: Saga, err: ErrInfo, bumpGen: boolean): Outcome {
    return this.store.transactionSync((): Outcome => {
      if (!this.#holds(id, from)) return this.#stale(id, s);
      if (s.kind === "list") {
        this.store.sql.exec("DELETE FROM mk_listing WHERE id = ?", id);
      } else if (bumpGen) {
        this.store.sql.exec(
          "UPDATE mk_listing SET busy_json = NULL, gen = gen + 1 WHERE id = ?",
          id,
        );
      } else {
        this.store.sql.exec("UPDATE mk_listing SET busy_json = NULL WHERE id = ?", id);
      }
      this.store.sql.exec("DELETE FROM mk_op WHERE listing_id = ? AND done = 0", id);
      return { kind: "failed", err };
    });
  }

  async #notify(
    accountId: string,
    id: string,
    kind: NoticeKind,
    p: { text: string; listingId: string; amount: number },
  ): Promise<void> {
    await this.gateway.notify(accountId, {
      id,
      kind,
      text: clip(p.text),
      data: { listingId: p.listingId, amount: p.amount },
    });
  }

  async #guarded(id: string, fn: () => Promise<Outcome>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.error(`market: listing ${id} could not advance`, err);
    }
  }

  #allocId(): string {
    const seq = this.store.transactionSync(() => {
      this.store.sql.exec("INSERT OR IGNORE INTO mk_meta (k, v) VALUES ('seq', 0)");
      this.store.sql.exec("UPDATE mk_meta SET v = v + 1 WHERE k = 'seq'");
      return this.#all<{ v: number }>("SELECT v FROM mk_meta WHERE k = 'seq'")[0]?.v ?? 0;
    });
    return `${this.shard}/${seq}`;
  }

  #owns(listingId: string): boolean {
    return shardOfListing(listingId) === this.shard;
  }

  #row(id: string): Row | null {
    return this.#all<Row>("SELECT * FROM mk_listing WHERE id = ?", id)[0] ?? null;
  }

  #view(row: Row): MarketListing {
    const input = JSON.parse(row.item_json ?? "null") as VaultItemInput | null;
    if (!input) throw new Error(`market: listing ${row.id} has no item`);
    return {
      id: row.id,
      shard: this.shard,
      seller: { accountId: row.seller_id, displayName: row.seller_name },
      item: publicItem(input),
      buyout: row.buyout,
      startBid: row.start_bid,
      topBid: row.top_bid,
      topBidder:
        row.top_bidder_id === null
          ? null
          : { accountId: row.top_bidder_id, displayName: row.top_bidder_name ?? "" },
      bids: row.bids,
      fee: row.fee,
      createdAt: row.created_at,
      endsAt: row.ends_at,
      status: row.status as ListingStatus,
      soldFor: row.sold_for,
    };
  }

  #all<T extends Record<string, string | number | null | ArrayBuffer>>(
    sql: string,
    ...args: unknown[]
  ): T[] {
    return this.store.sql.exec<T>(sql, ...args).toArray();
  }
}

function partyOf(s: Saga): Party {
  if (!s.party) throw new Error(`market: saga ${s.kind}/${s.step} has no party`);
  return s.party;
}

/** The sequence number of a listing id "<shard>/<seq>". */
function seqOf(id: string): number {
  return Number(id.slice(id.lastIndexOf("/") + 1));
}

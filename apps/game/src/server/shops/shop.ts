/**
 * ShopDO logic (wave-C.md §5.3): one player shop on a leased plot, named
 * "<world>/<plotId>". OWNER: T-shops.
 *
 * Custody, not holds: stocked items leave the owner's vault (vaultTake) and
 * return to it on unstock, on lease end or on repossession. The buyer's coin
 * goes through a transfer debit, the item through vaultPut, and the owner's
 * earnings wait in the shop (gross, tax) until claimed or the lease closes.
 *
 * Busy lock: an entry's state ("taking", "buying", "unstocking") is the lock of
 * the saga that moves it; other operations on it answer "busy". A lease close
 * waits for busy entries, so an item is never returned while a sale is in flight.
 *
 * Every saga persists its step before each outbound call and every outbound
 * call is idempotent by txId (opId-derived), so drive() re-runs them safely.
 *
 * One driver per saga (ADR 0007 R6): `#run` keeps the in-flight promise per op
 * key (returns and payouts per entry / payout number), so a repeated request
 * and the alarm's drive() join the running saga instead of starting another.
 * Every transition that books value (earnings, stock, refunds) is also a
 * compare-and-set on the op's step and the entry's lock inside its transaction:
 * a stale driver books nothing and answers the stored outcome.
 */
import { isAmount, shopTax } from "@gamez/economy";
import {
  SHOP_MAX_STOCK,
  type EconomyErrorCode,
  type NoticeInput,
  type Party,
  type ShopEntry,
  type ShopView,
  type VaultItem,
} from "@gamez/protocol";
import type { Outbox } from "@gamez/sync";
import type {
  AccountGateway,
  EconResult,
  EconomySalePayload,
  ShopApi,
  SqlStore,
} from "../contracts.ts";
import type { Clock } from "./clock.ts";
import { execSql, patchRow, queryRows, type SqlValue } from "./sql.ts";
import {
  defaultShopName,
  saleScope,
  SHOP_DEFAULT_APPEARANCE,
  validAppearance,
  validShopName,
  withoutUid,
} from "./validate.ts";

export interface ShopBookDeps {
  world: string;
  plotId: string;
  store: SqlStore;
  outbox: Outbox;
  gateway: AccountGateway;
  clock: Clock;
  /** The PlotAuctionDO of the world: the shopkeeper fixture must be refreshed. */
  plots: { refreshFixture(plotId: string): Promise<void> };
}

type LeaseRow = {
  lease_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  ends_at: number;
  name: string | null;
  appearance: string;
  open: number;
  closing: number;
  close_reason: string | null;
  gross: number;
  tax: number;
  fixture_dirty: number;
  seq: number;
};

type EntryRow = {
  entry_id: string;
  n: number;
  lease_id: string;
  owner_id: string;
  state: string;
  op_id: string | null;
  uid: string;
  price: number;
  item_json: string | null;
  /** The opId of the buy or unstock saga holding this entry (busy lock). */
  busy_op: string | null;
  buyer_json: string | null;
};

type OpRow = {
  op_key: string;
  state: string;
  step: string;
  payload: string;
  error_code: string | null;
  error_message: string | null;
};

type PayoutRow = {
  n: number;
  lease_id: string;
  owner_id: string;
  gross: number;
  tax: number;
  state: string;
};

interface StockPayload {
  entryId: string;
  uid: string;
  owner: Party;
}
interface BuyPayload {
  entryId: string;
  itemName: string;
  price: number;
  buyer: Party;
  owner: Party;
}
interface UnstockPayload {
  entryId: string;
  owner: Party;
}
interface ClaimPayload {
  n: number;
}

const BACKOFF_MS = 5_000;
const OK: EconResult<null> = { ok: true, value: null };
const RETURN_RETRY_MS = 60_000;

export class ShopBook implements ShopApi {
  readonly #d: ShopBookDeps;
  readonly #pfx: string;
  #backoffUntil = 0;
  /** In-flight sagas by key (op key, "return:<entryId>", "payout:<n>"). */
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(deps: ShopBookDeps) {
    this.#d = deps;
    this.#pfx = `shop:${deps.world}/${deps.plotId}`;
  }

  /** Creates the tables (idempotent). */
  init(): void {
    const s = this.#d.store;
    execSql(
      s,
      `CREATE TABLE IF NOT EXISTS shop_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        lease_id TEXT,
        owner_id TEXT,
        owner_name TEXT,
        ends_at INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        appearance TEXT NOT NULL DEFAULT 'unit.hero',
        open INTEGER NOT NULL DEFAULT 0,
        closing INTEGER NOT NULL DEFAULT 0,
        close_reason TEXT,
        gross INTEGER NOT NULL DEFAULT 0,
        tax INTEGER NOT NULL DEFAULT 0,
        fixture_dirty INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL DEFAULT 0
      )`,
    );
    execSql(
      s,
      `CREATE TABLE IF NOT EXISTS shop_entries (
        entry_id TEXT PRIMARY KEY,
        n INTEGER NOT NULL,
        lease_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        state TEXT NOT NULL,
        op_id TEXT,
        uid TEXT NOT NULL,
        price INTEGER NOT NULL,
        item_json TEXT,
        busy_op TEXT,
        buyer_json TEXT
      )`,
    );
    execSql(
      s,
      `CREATE TABLE IF NOT EXISTS shop_ops (
        op_key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        step TEXT NOT NULL,
        payload TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        at INTEGER NOT NULL DEFAULT 0
      )`,
    );
    execSql(
      s,
      `CREATE TABLE IF NOT EXISTS shop_payouts (
        n INTEGER PRIMARY KEY,
        lease_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        gross INTEGER NOT NULL,
        tax INTEGER NOT NULL,
        state TEXT NOT NULL
      )`,
    );
    execSql(s, "INSERT OR IGNORE INTO shop_lease (id) VALUES (1)");
  }

  // ---- ShopApi ------------------------------------------------------------------

  async view(viewerId: string | null): Promise<ShopView | null> {
    const l = this.#lease();
    if (l.lease_id === null) return null;
    return this.#shopView(l, viewerId);
  }

  /** The PlotAuctionDO starts a lease. Idempotent by leaseId, also after the lease closed. */
  async openLease(input: {
    leaseId: string;
    world: string;
    plotId: string;
    owner: Party;
    endsAt: number;
  }): Promise<void> {
    if (input.world !== this.#d.world || input.plotId !== this.#d.plotId) {
      throw new Error(`lease for ${input.world}/${input.plotId} sent to ${this.#pfx}`);
    }
    const key = `open:${input.leaseId}`;
    if (this.#op(key) !== null) return;
    const l = this.#lease();
    // A new lease waits until the previous one is fully closed (PlotAuctionDO retries).
    if (l.lease_id !== null) throw new Error(`${this.#pfx} still holds lease ${l.lease_id}`);
    this.#tx(() => {
      this.#setLease({
        lease_id: input.leaseId,
        owner_id: input.owner.accountId,
        owner_name: input.owner.displayName,
        ends_at: input.endsAt,
        name: defaultShopName(this.#d.plotId),
        appearance: SHOP_DEFAULT_APPEARANCE,
        open: 0,
        closing: 0,
        close_reason: null,
        gross: 0,
        tax: 0,
      });
      this.#insertOp(key, "done", "open", "{}");
    });
  }

  /**
   * The lease ends ("ended") or is repossessed. Stock returns to the owner's
   * vault, earnings are paid out, the shop closes. Idempotent by leaseId.
   */
  async closeLease(input: { leaseId: string; reason: "ended" | "repossessed" }): Promise<void> {
    const l = this.#lease();
    if (l.lease_id !== input.leaseId) return;
    if (l.closing === 0) {
      this.#tx(() => this.#setLease({ closing: 1, open: 0, close_reason: input.reason }));
    }
    await this.drive();
  }

  async configure(input: {
    accountId: string;
    name?: string;
    appearance?: string;
    open?: boolean;
  }): Promise<EconResult<ShopView>> {
    const l = this.#lease();
    if (l.lease_id === null) return fail("not_found", "this plot has no shop");
    if (l.owner_id !== input.accountId)
      return fail("forbidden", "only the shop owner can change it");
    if (l.closing === 1) return fail("closed", "this lease is ending");
    const patch: Record<string, SqlValue> = {};
    if (input.name !== undefined) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!validShopName(name)) {
        return fail("bad_request", "name: 3-24 characters of letters, digits, space, ' _ -");
      }
      patch.name = name;
    }
    if (input.appearance !== undefined) {
      if (typeof input.appearance !== "string" || !validAppearance(input.appearance)) {
        return fail("bad_request", "appearance must be unit.hero or unit.hero.<look>");
      }
      patch.appearance = input.appearance;
    }
    if (input.open !== undefined) {
      if (typeof input.open !== "boolean") return fail("bad_request", "open must be true or false");
      patch.open = input.open ? 1 : 0;
    }
    if (Object.keys(patch).length > 0) {
      this.#tx(() => this.#setLease({ ...patch, fixture_dirty: 1 }));
      await this.drive();
    }
    return this.#okView(input.accountId);
  }

  async stock(input: {
    opId: string;
    accountId: string;
    uid: string;
    price: number;
  }): Promise<EconResult<ShopView>> {
    const key = `stock:${input.opId}`;
    const prior = this.#op(key);
    if (prior !== null && payloadOf<StockPayload>(prior).uid !== input.uid) {
      return fail("bad_request", "this opId was used for another item");
    }
    const replay = this.#replay(key, input.accountId);
    if (replay) return replay;
    const l = this.#lease();
    if (l.lease_id === null) return fail("not_found", "this plot has no shop");
    if (l.owner_id !== input.accountId)
      return fail("forbidden", "only the shop owner can stock it");
    if (l.closing === 1) return fail("closed", "this lease is ending");
    if (!isAmount(input.price))
      return fail("bad_request", "price must be a positive whole number of coin");
    if (typeof input.uid !== "string" || input.uid === "" || input.uid.length > 128) {
      return fail("bad_request", "uid is required");
    }
    if (this.#op(key) === null) {
      let item: VaultItem | null;
      try {
        item = await this.#d.gateway.vaultGet(input.accountId, input.uid);
      } catch (err) {
        return this.#unavailable(err);
      }
      if (!item) return fail("not_found", "that item is not in your vault");
      if (!item.tradable) return fail("not_tradable", "this item cannot be traded");
      const started = this.#tx((): Failure | null => {
        const cur = this.#lease();
        if (cur.lease_id !== l.lease_id || cur.closing === 1)
          return fail("closed", "this lease is ending");
        if (this.#op(key) !== null) return null;
        if (this.#countStock(l.lease_id ?? "") >= SHOP_MAX_STOCK) {
          return fail("too_many", `a shop holds at most ${SHOP_MAX_STOCK} items`);
        }
        const n = this.#nextSeq();
        const entryId = `e${n}`;
        const owner: Party = { accountId: input.accountId, displayName: l.owner_name ?? "" };
        execSql(
          this.#d.store,
          `INSERT INTO shop_entries (entry_id, n, lease_id, owner_id, state, op_id, uid, price, item_json)
           VALUES (?, ?, ?, ?, 'taking', ?, ?, ?, NULL)`,
          entryId,
          n,
          l.lease_id ?? "",
          input.accountId,
          input.opId,
          input.uid,
          input.price,
        );
        const payload: StockPayload = { entryId, uid: input.uid, owner };
        this.#insertOp(key, "pending", "take", JSON.stringify(payload));
        return null;
      });
      if (started) return started;
    }
    return this.#after(await this.#guard(() => this.#run(key)), input.accountId);
  }

  async unstock(input: {
    opId: string;
    accountId: string;
    entryId: string;
  }): Promise<EconResult<ShopView>> {
    const key = `unstock:${input.opId}`;
    const replay = this.#replay(key, input.accountId);
    if (replay) return replay;
    const l = this.#lease();
    if (l.lease_id === null) return fail("not_found", "this plot has no shop");
    if (l.owner_id !== input.accountId) return fail("forbidden", "only the shop owner can unstock");
    const started = this.#tx((): Failure | null => {
      const op = this.#op(key);
      if (op !== null) {
        if (payloadOf<UnstockPayload>(op).entryId !== input.entryId) {
          return fail("bad_request", "this opId was used for another item");
        }
        return null;
      }
      const e = this.#entry(input.entryId);
      if (e === null || e.lease_id !== l.lease_id)
        return fail("not_found", "no such item in this shop");
      if (e.state !== "listed")
        return fail("busy", "that item is being bought or taken off the shelf");
      this.#setEntry(e.entry_id, { state: "unstocking", busy_op: input.opId });
      const payload: UnstockPayload = {
        entryId: e.entry_id,
        owner: { accountId: input.accountId, displayName: l.owner_name ?? "" },
      };
      this.#insertOp(key, "pending", "start", JSON.stringify(payload));
      return null;
    });
    if (started) return started;
    return this.#after(await this.#guard(() => this.#run(key)), input.accountId);
  }

  async buy(input: { opId: string; buyer: Party; entryId: string }): Promise<EconResult<ShopView>> {
    const key = `buy:${input.opId}`;
    const replay = this.#replay(key, input.buyer.accountId);
    if (replay) return replay;
    const l = this.#lease();
    if (l.lease_id === null) return fail("not_found", "this plot has no shop");
    if (l.owner_id === input.buyer.accountId)
      return fail("forbidden", "you cannot buy from your own shop");
    if (l.closing === 1 || l.open === 0) return fail("closed", "this shop is closed");
    const started = this.#tx((): Failure | null => {
      const op = this.#op(key);
      if (op !== null) {
        if (payloadOf<BuyPayload>(op).entryId !== input.entryId) {
          return fail("bad_request", "this opId was used for another purchase");
        }
        return null;
      }
      const cur = this.#lease();
      if (cur.lease_id !== l.lease_id || cur.closing === 1 || cur.open === 0) {
        return fail("closed", "this shop is closed");
      }
      const e = this.#entry(input.entryId);
      if (e === null || e.lease_id !== cur.lease_id)
        return fail("not_found", "no such item in this shop");
      if (e.state !== "listed" || e.item_json === null) {
        return fail("busy", "that item is being bought or taken off the shelf");
      }
      const item = JSON.parse(e.item_json) as VaultItem;
      this.#setEntry(e.entry_id, {
        state: "buying",
        busy_op: input.opId,
        buyer_json: JSON.stringify(input.buyer),
      });
      const payload: BuyPayload = {
        entryId: e.entry_id,
        itemName: item.summary.name,
        price: e.price,
        buyer: input.buyer,
        owner: { accountId: cur.owner_id ?? "", displayName: cur.owner_name ?? "" },
      };
      this.#insertOp(key, "pending", "start", JSON.stringify(payload));
      return null;
    });
    if (started) return started;
    return this.#after(await this.#guard(() => this.#run(key)), input.buyer.accountId);
  }

  /** Moves the owner's earnings (gross) to the account and the tax to the sink. */
  async claim(input: { opId: string; accountId: string }): Promise<EconResult<ShopView>> {
    const key = `claim:${input.opId}`;
    const replay = this.#replay(key, input.accountId);
    if (replay) return replay;
    const l = this.#lease();
    if (l.lease_id === null) return fail("not_found", "this plot has no shop");
    if (l.owner_id !== input.accountId) return fail("forbidden", "only the shop owner can claim");
    // Starts the payout in one transaction; "nothing" = no earnings, nothing to pay.
    const started = this.#tx((): Failure | "nothing" | null => {
      if (this.#op(key) !== null) return null;
      const cur = this.#lease();
      if (cur.lease_id === null) return fail("not_found", "this plot has no shop");
      if (cur.gross === 0 && cur.tax === 0) return "nothing";
      const n = this.#nextSeq();
      execSql(
        this.#d.store,
        `INSERT INTO shop_payouts (n, lease_id, owner_id, gross, tax, state) VALUES (?, ?, ?, ?, ?, 'pending')`,
        n,
        cur.lease_id,
        input.accountId,
        cur.gross,
        cur.tax,
      );
      this.#setLease({ gross: 0, tax: 0 });
      const payload: ClaimPayload = { n };
      this.#insertOp(key, "pending", "payout", JSON.stringify(payload));
      return null;
    });
    if (started === "nothing") return this.#okView(input.accountId);
    if (started !== null) return started;
    return this.#after(await this.#guard(() => this.#run(key)), input.accountId);
  }

  async fixture(): Promise<{
    owner: Party;
    name: string;
    appearance: string;
    open: boolean;
  } | null> {
    const l = this.#lease();
    if (l.lease_id === null) return null;
    return {
      owner: { accountId: l.owner_id ?? "", displayName: l.owner_name ?? "" },
      name: l.name ?? defaultShopName(this.#d.plotId),
      appearance: l.appearance,
      open: l.open === 1 && l.closing === 0,
    };
  }

  // ---- driving ------------------------------------------------------------------

  /**
   * Re-runs every pending saga, finishes a close once its busy entries are
   * done, returns stock, pays out earnings and refreshes the fixture. Errors
   * stop the run and back off; the alarm drives again.
   */
  async drive(): Promise<void> {
    try {
      for (const key of this.#pendingOpKeys()) {
        await this.#run(key);
      }
      this.#finishClose();
      for (const e of this.#returningEntries()) {
        await this.#serial(`return:${e.entry_id}`, () => this.#runReturn(e.entry_id));
      }
      for (const p of this.#pendingPayouts()) {
        await this.#serial(`payout:${p.n}`, () => this.#runPayout(p.n));
      }
      if (this.#lease().fixture_dirty === 1) {
        await this.#d.plots.refreshFixture(this.#d.plotId);
        this.#tx(() => this.#setLease({ fixture_dirty: 0 }));
      }
    } catch (err) {
      console.error(`${this.#pfx}: drive failed`, err);
      this.#backoffUntil = this.#d.clock.now() + BACKOFF_MS;
    }
  }

  /** Epoch ms of the next drive() with work, or null when nothing is pending. */
  nextWakeAt(): number | null {
    const pending =
      this.#pendingOpKeys().length > 0 ||
      this.#lease().fixture_dirty === 1 ||
      this.#returningEntries().length > 0 ||
      this.#pendingPayouts().length > 0;
    if (!pending) return null;
    return Math.max(this.#d.clock.now(), this.#backoffUntil);
  }

  /**
   * Runs one saga to its end (or its failure), or joins the run already in
   * flight for the same op key. Throws only on outbound failures.
   */
  #run(key: string): Promise<EconResult<null>> {
    return this.#serial(key, () => this.#runOnce(key));
  }

  /** One in-flight run per key: a second caller gets the running promise. */
  #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.#running.get(key);
    if (running) return running as Promise<T>;
    const p = fn().finally(() => {
      if (this.#running.get(key) === p) this.#running.delete(key);
    });
    this.#running.set(key, p);
    return p;
  }

  async #runOnce(key: string): Promise<EconResult<null>> {
    const op = this.#op(key);
    if (op === null) return fail("not_found", "no such operation");
    if (op.state === "done") return { ok: true, value: null, replayed: true };
    if (op.state === "failed")
      return fail(op.error_code ?? "internal", op.error_message ?? "failed");
    const kind = key.slice(0, key.indexOf(":"));
    switch (kind) {
      case "stock":
        return this.#runStock(key, op);
      case "buy":
        return this.#runBuy(key, op);
      case "unstock":
        return this.#runUnstock(key, op);
      case "claim":
        return this.#runClaim(key, op);
      default:
        throw new Error(`unknown shop operation ${key}`);
    }
  }

  async #runStock(key: string, op: OpRow): Promise<EconResult<null>> {
    const p = payloadOf<StockPayload>(op);
    const e = this.#entry(p.entryId);
    if (e === null || e.state !== "taking") {
      this.#tx(() => this.#opDone(key));
      return OK;
    }
    const r = await this.#d.gateway.vaultTake(
      p.owner.accountId,
      `${this.#pfx}:stock:${opIdOf(key)}`,
      p.uid,
    );
    const opId = opIdOf(key);
    if (!r.ok) {
      const moved = this.#tx(() => {
        if (!this.#holds(key, "take", p.entryId, "taking", opId, "op_id")) return true;
        this.#removeEntry(p.entryId);
        this.#opFail(key, "not_found", "that item is no longer in your vault");
        return false;
      });
      return moved ? this.#outcome(key) : fail("not_found", "that item is no longer in your vault");
    }
    const moved = this.#tx(() => {
      if (!this.#holds(key, "take", p.entryId, "taking", opId, "op_id")) return true;
      this.#setEntry(p.entryId, {
        state: "listed",
        item_json: JSON.stringify(r.item),
        busy_op: null,
      });
      this.#opDone(key);
      return false;
    });
    return moved ? this.#outcome(key) : OK;
  }

  async #runBuy(key: string, op: OpRow): Promise<EconResult<null>> {
    const p = payloadOf<BuyPayload>(op);
    const opId = opIdOf(key);
    const gw = this.#d.gateway;
    let step = op.step;
    if (step === "start") {
      const res = await gw.walletTx(p.buyer.accountId, {
        txId: `${this.#pfx}:buy:${opId}`,
        currency: "coin",
        amount: -p.price,
        reason: `shop.buy:${this.#d.world}/${this.#d.plotId}`,
        flow: "transfer",
      });
      if (!res.ok) {
        // Definite refusals (nothing was debited) end the saga; anything else retries.
        const refused: Record<string, string> = {
          insufficient_funds: "not enough coin for this item",
          conflict: "this purchase id was already used for another payment",
        };
        const message = refused[res.code];
        if (message === undefined) throw new Error(`buy debit failed: ${res.code}`);
        const moved = this.#tx(() => {
          if (!this.#advance(key, "start", null)) return true;
          this.#releaseEntry(p.entryId, opId);
          this.#opFail(key, res.code, message);
          return false;
        });
        if (moved) return this.#outcome(key);
        return fail(res.code, message);
      }
      if (!this.#tx(() => this.#advance(key, "start", "debited"))) return this.#outcome(key);
      step = "debited";
    }
    if (step === "debited") {
      const e = this.#entry(p.entryId);
      if (e === null || e.item_json === null)
        throw new Error(`${key}: entry ${p.entryId} is missing`);
      const item = JSON.parse(e.item_json) as VaultItem;
      const v = await gw.vaultPut(
        p.buyer.accountId,
        `${this.#pfx}:deliver:${opId}`,
        withoutUid(item),
      );
      if (v.ok) {
        const now = this.#d.clock.now();
        const booked = this.#tx((): boolean => {
          // Compare-and-set: book only from "debited", with the entry still held by this op.
          const cur = this.#entry(p.entryId);
          if (cur === null || cur.busy_op !== opId || cur.state !== "buying") return false;
          if (!this.#advance(key, "debited", "notify")) return false;
          this.#removeEntry(p.entryId);
          const l = this.#lease();
          this.#setLease({ gross: l.gross + p.price, tax: l.tax + shopTax(p.price) });
          const sale: EconomySalePayload = {
            saleId: `${this.#pfx}:${opId}`,
            venue: "shop",
            scope: saleScope(item),
            category: item.summary.category,
            itemId: item.itemId,
            name: item.summary.name,
            rarity: item.summary.rarity,
            level: item.summary.level,
            price: p.price,
            tax: shopTax(p.price),
            sellerId: p.owner.accountId,
            buyerId: p.buyer.accountId,
            at: now,
          };
          this.#d.outbox.append("economy_sale", sale.saleId, "upsert", sale);
          return true;
        });
        if (!booked) return this.#outcome(key);
        step = "notify";
      } else {
        if (!this.#tx(() => this.#advance(key, "debited", "refund"))) return this.#outcome(key);
        step = "refund";
      }
    }
    if (step === "refund") {
      const r = await gw.walletTx(p.buyer.accountId, {
        txId: `${this.#pfx}:refund:${opId}`,
        currency: "coin",
        amount: p.price,
        reason: `shop.buy:${this.#d.world}/${this.#d.plotId}`,
        flow: "transfer",
      });
      if (!r.ok) throw new Error(`buy refund failed: ${r.code}`);
      const moved = this.#tx(() => {
        if (!this.#advance(key, "refund", null)) return true;
        this.#releaseEntry(p.entryId, opId);
        this.#opFail(key, "vault_full", "the buyer has no room in the vault");
        return false;
      });
      if (moved) return this.#outcome(key);
      return fail("vault_full", "the buyer has no room in the vault");
    }
    // step "notify": the sale is booked; tell the owner (idempotent by id).
    const notice: NoticeInput = {
      id: `${this.#pfx}:sold:${opId}`,
      kind: "shop.sold",
      text: `${p.buyer.displayName} bought ${p.itemName} for ${p.price} coin`.slice(0, 140),
      data: { world: this.#d.world, plotId: this.#d.plotId, entryId: p.entryId, price: p.price },
    };
    await gw.notify(p.owner.accountId, notice);
    const finished = this.#tx((): boolean => {
      if (!this.#advance(key, "notify", null)) return false;
      this.#opDone(key);
      return true;
    });
    return finished ? OK : this.#outcome(key);
  }

  async #runUnstock(key: string, op: OpRow): Promise<EconResult<null>> {
    const p = payloadOf<UnstockPayload>(op);
    const e = this.#entry(p.entryId);
    if (e === null || e.state !== "unstocking" || e.item_json === null) {
      this.#tx(() => this.#opDone(key));
      return OK;
    }
    const item = JSON.parse(e.item_json) as VaultItem;
    const v = await this.#d.gateway.vaultPut(
      p.owner.accountId,
      `${this.#pfx}:unstock:${opIdOf(key)}`,
      withoutUid(item),
    );
    const opId = opIdOf(key);
    if (!v.ok) {
      const moved = this.#tx(() => {
        if (!this.#holds(key, "start", p.entryId, "unstocking", opId, "busy_op")) return true;
        this.#releaseEntry(p.entryId, opId);
        this.#opFail(key, "vault_full", "your vault is full");
        return false;
      });
      return moved ? this.#outcome(key) : fail("vault_full", "your vault is full");
    }
    const moved = this.#tx(() => {
      if (!this.#holds(key, "start", p.entryId, "unstocking", opId, "busy_op")) return true;
      this.#removeEntry(p.entryId);
      this.#opDone(key);
      return false;
    });
    return moved ? this.#outcome(key) : OK;
  }

  async #runClaim(key: string, op: OpRow): Promise<EconResult<null>> {
    const p = payloadOf<ClaimPayload>(op);
    await this.#serial(`payout:${p.n}`, () => this.#runPayout(p.n));
    this.#tx(() => this.#opDone(key));
    return OK;
  }

  /** Pays one payout: gross credited (transfer), tax debited (sink). Idempotent by n. */
  async #runPayout(n: number): Promise<void> {
    const pay = queryRows<PayoutRow>(this.#d.store, "SELECT * FROM shop_payouts WHERE n = ?", n)[0];
    if (!pay || pay.state === "done") return;
    const w = `${this.#d.world}/${this.#d.plotId}`;
    if (pay.gross > 0) {
      const r = await this.#d.gateway.walletTx(pay.owner_id, {
        txId: `${this.#pfx}:claim:${n}`,
        currency: "coin",
        amount: pay.gross,
        reason: `shop.claim:${w}`,
        flow: "transfer",
      });
      if (!r.ok) throw new Error(`claim credit failed: ${r.code}`);
    }
    if (pay.tax > 0) {
      const r = await this.#d.gateway.walletTx(pay.owner_id, {
        txId: `${this.#pfx}:tax:${n}`,
        currency: "coin",
        amount: -pay.tax,
        reason: `shop.tax:${w}`,
        flow: "sink",
      });
      if (!r.ok) throw new Error(`shop tax failed: ${r.code}`);
    }
    this.#tx(() =>
      execSql(
        this.#d.store,
        "UPDATE shop_payouts SET state = 'done' WHERE n = ? AND state = 'pending'",
        n,
      ),
    );
  }

  /** Returns one stock entry of a closed lease to its owner's vault. A full vault waits. */
  async #runReturn(entryId: string): Promise<boolean> {
    const e = this.#entry(entryId);
    if (e === null || e.state !== "returning") return true;
    if (e.item_json === null) {
      this.#tx(() => this.#removeEntry(e.entry_id));
      return true;
    }
    const item = JSON.parse(e.item_json) as VaultItem;
    const v = await this.#d.gateway.vaultPut(
      e.owner_id,
      `${this.#pfx}:return:${e.entry_id}`,
      withoutUid(item),
    );
    if (!v.ok) {
      this.#backoffUntil = this.#d.clock.now() + RETURN_RETRY_MS;
      return false;
    }
    this.#tx(() => {
      if (this.#entry(e.entry_id)?.state === "returning") this.#removeEntry(e.entry_id);
    });
    return true;
  }

  /**
   * The close completes once no sale, purchase or unstock of the lease is in
   * flight: listed stock becomes "returning", earnings become a payout, the
   * lease is cleared. Returns and payouts then run from drive().
   */
  #finishClose(): void {
    const l = this.#lease();
    if (l.lease_id === null || l.closing === 0) return;
    const busy = queryRows<{ n: number }>(
      this.#d.store,
      "SELECT COUNT(*) AS n FROM shop_entries WHERE lease_id = ? AND state IN ('taking', 'buying', 'unstocking')",
      l.lease_id,
    )[0];
    if (busy && busy.n > 0) return;
    const leaseId = l.lease_id;
    const ownerId = l.owner_id ?? "";
    this.#tx(() => {
      execSql(
        this.#d.store,
        "UPDATE shop_entries SET state = 'returning' WHERE lease_id = ? AND state = 'listed'",
        leaseId,
      );
      if (l.gross > 0 || l.tax > 0) {
        const n = this.#nextSeq();
        execSql(
          this.#d.store,
          `INSERT INTO shop_payouts (n, lease_id, owner_id, gross, tax, state) VALUES (?, ?, ?, ?, ?, 'pending')`,
          n,
          leaseId,
          ownerId,
          l.gross,
          l.tax,
        );
      }
      this.#setLease({
        lease_id: null,
        owner_id: null,
        owner_name: null,
        name: null,
        appearance: SHOP_DEFAULT_APPEARANCE,
        open: 0,
        closing: 0,
        close_reason: null,
        gross: 0,
        tax: 0,
        fixture_dirty: 1,
      });
    });
  }

  // ---- helpers ------------------------------------------------------------------

  /** Converts a finished saga into the HTTP-facing result (the shop view on success). */
  #after(r: EconResult<null>, viewer: string): EconResult<ShopView> {
    if (!r.ok) return r;
    const v = this.#okView(viewer);
    return r.replayed && v.ok ? { ...v, replayed: true } : v;
  }

  /** A saga that already completed (replay) answers its stored outcome. */
  #replay(key: string, viewer: string): EconResult<ShopView> | null {
    const op = this.#op(key);
    if (op === null || op.state === "pending") return null;
    if (op.state === "failed")
      return fail(op.error_code ?? "internal", op.error_message ?? "failed");
    const v = this.#okView(viewer);
    return v.ok ? { ...v, replayed: true } : v;
  }

  #okView(viewer: string): EconResult<ShopView> {
    const l = this.#lease();
    if (l.lease_id === null) return fail("not_found", "this plot has no shop");
    return { ok: true, value: this.#shopView(l, viewer) };
  }

  #shopView(l: LeaseRow, viewerId: string | null): ShopView {
    const owner = l.owner_id ?? "";
    const stock: ShopEntry[] = this.#entries(l.lease_id ?? "")
      .filter((e) => e.state === "listed" || e.state === "buying" || e.state === "unstocking")
      .filter((e) => e.item_json !== null)
      .map((e) => ({
        entryId: e.entry_id,
        item: withoutData(JSON.parse(e.item_json ?? "{}") as VaultItem),
        price: e.price,
      }));
    return {
      plotId: this.#d.plotId,
      world: this.#d.world,
      owner: { accountId: owner, displayName: l.owner_name ?? "" },
      name: l.name ?? defaultShopName(this.#d.plotId),
      appearance: l.appearance,
      open: l.open === 1 && l.closing === 0,
      stock,
      earnings: viewerId !== null && viewerId === owner ? l.gross - l.tax : null,
      leaseEndsAt: l.ends_at,
    };
  }

  /** Runs an outbound-touching saga; a failed call answers "unavailable" (the alarm retries). */
  async #guard(fn: () => Promise<EconResult<null>>): Promise<EconResult<null>> {
    try {
      return await fn();
    } catch (err) {
      return this.#unavailable(err);
    }
  }

  #unavailable(err: unknown): { ok: false; code: EconomyErrorCode; message: string } {
    console.error(`${this.#pfx}: call failed`, err);
    return fail("unavailable", "the shop is busy, try again");
  }

  #countStock(leaseId: string): number {
    return (
      queryRows<{ n: number }>(
        this.#d.store,
        "SELECT COUNT(*) AS n FROM shop_entries WHERE lease_id = ? AND state != 'returning'",
        leaseId,
      )[0]?.n ?? 0
    );
  }

  #pendingOpKeys(): string[] {
    return queryRows<{ op_key: string }>(
      this.#d.store,
      "SELECT op_key FROM shop_ops WHERE state = 'pending' ORDER BY at, op_key",
    ).map((r) => r.op_key);
  }

  #returningEntries(): EntryRow[] {
    return queryRows<EntryRow>(
      this.#d.store,
      "SELECT * FROM shop_entries WHERE state = 'returning' ORDER BY n",
    );
  }

  #pendingPayouts(): PayoutRow[] {
    return queryRows<PayoutRow>(
      this.#d.store,
      "SELECT * FROM shop_payouts WHERE state = 'pending' ORDER BY n",
    );
  }

  #nextSeq(): number {
    return this.#d.store.sql
      .exec<{ seq: number }>("UPDATE shop_lease SET seq = seq + 1 WHERE id = 1 RETURNING seq")
      .one().seq;
  }

  #lease(): LeaseRow {
    const r = queryRows<LeaseRow>(this.#d.store, "SELECT * FROM shop_lease WHERE id = 1")[0];
    if (!r) throw new Error(`${this.#pfx}: init() was not called`);
    return r;
  }

  #setLease(patch: Record<string, SqlValue>): void {
    patchRow(this.#d.store, "shop_lease", "id", 1, patch);
  }

  #entry(id: string): EntryRow | null {
    return (
      queryRows<EntryRow>(this.#d.store, "SELECT * FROM shop_entries WHERE entry_id = ?", id)[0] ??
      null
    );
  }

  #entries(leaseId: string): EntryRow[] {
    return queryRows<EntryRow>(
      this.#d.store,
      "SELECT * FROM shop_entries WHERE lease_id = ? ORDER BY n",
      leaseId,
    );
  }

  #setEntry(id: string, patch: Record<string, SqlValue>): void {
    patchRow(this.#d.store, "shop_entries", "entry_id", id, patch);
  }

  #removeEntry(id: string): void {
    execSql(this.#d.store, "DELETE FROM shop_entries WHERE entry_id = ?", id);
  }

  /** Gives a busy entry back to the shelf, when `opId` is the saga holding it. */
  #releaseEntry(id: string, opId: string): void {
    const e = this.#entry(id);
    if (e === null || e.busy_op !== opId) return;
    this.#setEntry(id, { state: "listed", busy_op: null, buyer_json: null });
  }

  #op(key: string): OpRow | null {
    return (
      queryRows<OpRow>(this.#d.store, "SELECT * FROM shop_ops WHERE op_key = ?", key)[0] ?? null
    );
  }

  #insertOp(key: string, state: "pending" | "done", step: string, payload: string): void {
    execSql(
      this.#d.store,
      "INSERT INTO shop_ops (op_key, state, step, payload, at) VALUES (?, ?, ?, ?, ?)",
      key,
      state,
      step,
      payload,
      this.#d.clock.now(),
    );
  }

  #opDone(key: string): void {
    execSql(this.#d.store, "UPDATE shop_ops SET state = 'done' WHERE op_key = ?", key);
  }

  #opFail(key: string, code: string, message: string): void {
    execSql(
      this.#d.store,
      "UPDATE shop_ops SET state = 'failed', error_code = ?, error_message = ? WHERE op_key = ?",
      code,
      message,
      key,
    );
  }

  /**
   * Compare-and-set on a pending op's step: moves it from `from` to `to` (or
   * leaves the step when `to` is null, a pure check) only while the op is still
   * pending at `from`. Call inside the transaction that books the step's effects.
   */
  #advance(key: string, from: string, to: string | null): boolean {
    const op = this.#op(key);
    if (op === null || op.state !== "pending" || op.step !== from) return false;
    if (to !== null) {
      execSql(this.#d.store, "UPDATE shop_ops SET step = ? WHERE op_key = ?", to, key);
    }
    return true;
  }

  /**
   * True while the op is pending at `step` and the entry is still in `state`,
   * held by this op (`lockCol` = the column naming the op). Call inside a transaction.
   */
  #holds(
    key: string,
    step: string,
    entryId: string,
    state: string,
    opId: string,
    lockCol: "op_id" | "busy_op",
  ): boolean {
    if (!this.#advance(key, step, null)) return false;
    const e = this.#entry(entryId);
    return e !== null && e.state === state && e[lockCol] === opId;
  }

  /** The stored outcome of an op another driver moved on (a stale step books nothing). */
  #outcome(key: string): EconResult<null> {
    const op = this.#op(key);
    if (op === null) return fail("not_found", "no such operation");
    if (op.state === "done") return { ok: true, value: null, replayed: true };
    if (op.state === "failed")
      return fail(op.error_code ?? "internal", op.error_message ?? "failed");
    return fail("unavailable", "the shop is busy, try again");
  }

  #tx<T>(fn: () => T): T {
    return this.#d.store.transactionSync(fn);
  }
}

/** A failed result; assignable to EconResult of any value type. */
type Failure = { ok: false; code: EconomyErrorCode; message: string };

function fail(code: string, message: string): Failure {
  return { ok: false, code: code as EconomyErrorCode, message };
}

function payloadOf<T>(op: OpRow): T {
  return JSON.parse(op.payload) as T;
}

/** The opId of an op key "<kind>:<opId>". */
function opIdOf(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

function withoutData(item: VaultItem): Omit<VaultItem, "data"> {
  const { data: _data, ...rest } = item;
  return rest;
}

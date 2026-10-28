/**
 * PlotAuctionDO logic (wave-C.md §5.1-5.2, §5.4): lease auctions for the shop
 * plots of one presence world, rent at paidUntil, grace, repossession, and the
 * shopkeeper fixtures pushed to the world's chunk. OWNER: T-shops.
 *
 * Rules that hold the state machine together:
 * - Every state change is persisted before an outbound call; a call that fails
 *   leaves the plot in a state the next drive() picks up again.
 * - Every outbound call is idempotent (txIds and leaseIds derive from ids that
 *   are persisted before the call: bid no, rent period, lease seq).
 * - A transition re-reads the row inside its sync transaction and does nothing
 *   when another drive already moved the plot on (rent_seq / lease_id guards).
 * - A bid holds the plot's lock (bid_json) from the first debit to the top-bid
 *   update, so no other bid or auction end can interleave.
 */
import {
  PLOT_AUCTION_MS,
  PLOT_LEASE_MS,
  PLOT_MIN_BID,
  PLOTS_PER_ACCOUNT,
  RENT_GRACE_MS,
  RENT_PERIOD_MS,
  RENT_RETRY_MS,
  isAmount,
  minNextBid,
  plotRent,
} from "@gamez/economy";
import type {
  EconomyErrorCode,
  EntityState,
  NoticeInput,
  Party,
  PlotState,
  PlotView,
  TilePos,
} from "@gamez/protocol";
import type { Outbox } from "@gamez/sync";
import { plotsOf, shopFixtureId } from "../../shared/plots.ts";
import type {
  AccountGateway,
  ChunkFixtureApi,
  EconResult,
  PlotAuctionApi,
  ShopApi,
  ShopIndexPayload,
  SqlStore,
} from "../contracts.ts";
import type { Clock } from "./clock.ts";
import { execSql, patchRow, queryRows, type SqlValue } from "./sql.ts";
import { fixtureTag } from "./validate.ts";

export interface PlotBookDeps {
  world: string;
  store: SqlStore;
  outbox: Outbox;
  gateway: AccountGateway;
  clock: Clock;
  /** The ShopDO of a plot, named "<world>/<plotId>". */
  shops: (plotId: string) => ShopApi;
  /** The world's chunk (shopkeeper fixtures); null when the world has none. */
  chunk: ChunkFixtureApi | null;
}

/** One row per plot of the world. */
type PlotRow = {
  plot_id: string;
  state: string;
  auction_started: number;
  auction_ends: number;
  auction_bids: number;
  top_bid: number | null;
  top_bidder_id: string | null;
  top_bidder_name: string | null;
  top_bid_no: number | null;
  bid_seq: number;
  lease_seq: number;
  rent_seq: number;
  lease_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  lease_started: number;
  lease_ends: number;
  rent: number;
  paid_until: number;
  grace_until: number | null;
  retry_at: number | null;
  shop_name: string | null;
  stock_count: number;
  shop_open: number;
  /** JSON BidLock while a bid is in progress (the plot's lock), else null. */
  bid_json: string | null;
  /** 1 while the shop must still be opened on the ShopDO. */
  pend_open: number;
  /** JSON PendingNotice still to be sent, else null. */
  pend_notice: string | null;
};

type OpRow = {
  op_key: string;
  state: string;
  plot_id: string;
  amount: number;
  error_code: string | null;
  error_message: string | null;
};

interface BidLock {
  opId: string;
  /** Bid number (monotonic per plot): the txId suffix of its debit. */
  no: number;
  bidder: Party;
  amount: number;
  /** The top bid this one replaces (refunded), or null. */
  prev: { accountId: string; displayName: string; bid: number; no: number } | null;
  step: "start" | "debited";
}

interface PendingNotice {
  to: string;
  notice: NoticeInput;
}

const MAX_ROUNDS = 5000;
const BACKOFF_MS = 5_000;

export class PlotBook implements PlotAuctionApi {
  readonly #d: PlotBookDeps;
  readonly #ids: string[];
  #offset = 0;
  #backoffUntil = 0;

  constructor(deps: PlotBookDeps) {
    this.#d = deps;
    this.#ids = plotsOf(deps.world).map((p) => p.id);
  }

  /** Creates the tables and one auction per plot (idempotent). */
  init(): void {
    const s = this.#d.store;
    execSql(
      s,
      `CREATE TABLE IF NOT EXISTS plot_state (
        plot_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'auction',
        auction_started INTEGER NOT NULL DEFAULT 0,
        auction_ends INTEGER NOT NULL DEFAULT 0,
        auction_bids INTEGER NOT NULL DEFAULT 0,
        top_bid INTEGER,
        top_bidder_id TEXT,
        top_bidder_name TEXT,
        top_bid_no INTEGER,
        bid_seq INTEGER NOT NULL DEFAULT 0,
        lease_seq INTEGER NOT NULL DEFAULT 0,
        rent_seq INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT,
        owner_id TEXT,
        owner_name TEXT,
        lease_started INTEGER NOT NULL DEFAULT 0,
        lease_ends INTEGER NOT NULL DEFAULT 0,
        rent INTEGER NOT NULL DEFAULT 0,
        paid_until INTEGER NOT NULL DEFAULT 0,
        grace_until INTEGER,
        retry_at INTEGER,
        shop_name TEXT,
        stock_count INTEGER NOT NULL DEFAULT 0,
        shop_open INTEGER NOT NULL DEFAULT 0,
        bid_json TEXT,
        pend_open INTEGER NOT NULL DEFAULT 0,
        pend_notice TEXT
      )`,
    );
    execSql(
      s,
      `CREATE TABLE IF NOT EXISTS plot_ops (
        op_key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        plot_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        at INTEGER NOT NULL DEFAULT 0
      )`,
    );
    execSql(
      s,
      `CREATE TABLE IF NOT EXISTS plot_meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )`,
    );
    this.#offset = Number(this.#meta("offset") ?? "0");
    const now = this.#now();
    for (const id of this.#ids) {
      execSql(
        s,
        `INSERT OR IGNORE INTO plot_state (plot_id, state, auction_started, auction_ends)
         VALUES (?, 'auction', ?, ?)`,
        id,
        now,
        now + PLOT_AUCTION_MS,
      );
    }
  }

  // ---- PlotAuctionApi -------------------------------------------------------

  async plots(): Promise<PlotView[]> {
    await this.drive();
    return this.#ids.map((id) => this.#view(this.#row(id)));
  }

  async bid(input: {
    opId: string;
    bidder: Party;
    plotId: string;
    amount: number;
  }): Promise<EconResult<PlotView>> {
    const { opId, bidder, plotId, amount } = input;
    if (!this.#ids.includes(plotId)) return fail("not_found", "no such plot");
    const key = `bid:${opId}`;
    const existing = this.#op(key);
    if (existing !== null) {
      if (existing.plot_id !== plotId || existing.amount !== amount) {
        return fail("bad_request", "this opId was used for another bid");
      }
      if (existing.state === "done")
        return { ok: true, value: this.#viewOf(plotId), replayed: true };
      if (existing.state === "failed")
        return fail(existing.error_code ?? "internal", existing.error_message ?? "bid failed");
    } else {
      await this.drive();
      const invalid = this.#bidProblem(this.#row(plotId), bidder, amount);
      if (invalid) return invalid;
      this.#tx(() => {
        const r = this.#row(plotId);
        const no = r.bid_seq + 1;
        const prev =
          r.top_bidder_id !== null && r.top_bid !== null && r.top_bid_no !== null
            ? {
                accountId: r.top_bidder_id,
                displayName: r.top_bidder_name ?? r.top_bidder_id,
                bid: r.top_bid,
                no: r.top_bid_no,
              }
            : null;
        const lock: BidLock = { opId, no, bidder, amount, prev, step: "start" };
        this.#set(plotId, { bid_seq: no, bid_json: JSON.stringify(lock) });
        execSql(
          this.#d.store,
          `INSERT INTO plot_ops (op_key, state, plot_id, amount, at) VALUES (?, 'pending', ?, ?, ?)`,
          key,
          plotId,
          amount,
          this.#now(),
        );
      });
    }
    await this.drive();
    const after = this.#op(key);
    if (after === null || after.state === "pending") {
      return fail("unavailable", "the bid is being processed, try again");
    }
    if (after.state === "failed")
      return fail(after.error_code ?? "internal", after.error_message ?? "bid failed");
    return { ok: true, value: this.#viewOf(plotId), replayed: false };
  }

  /** The shop's look, name or open flag changed (or a shop opened): push the fixtures again. */
  async refreshFixture(plotId: string): Promise<void> {
    if (!this.#ids.includes(plotId)) return;
    this.#tx(() => this.#setMeta("fixtures_dirty", "1"));
    try {
      await this.#pushFixtures();
    } catch (err) {
      this.#backoff("fixture push", err);
    }
  }

  /** Dev hosts only: moves the clock forward and runs every due step. */
  async devAdvance(ms: number): Promise<PlotView[]> {
    if (Number.isSafeInteger(ms) && ms > 0) {
      this.#offset += ms;
      this.#tx(() => this.#setMeta("offset", String(this.#offset)));
    }
    return this.plots();
  }

  // ---- driving --------------------------------------------------------------

  /**
   * Runs every step that is due (or pending) until nothing progresses. Errors
   * stop the run and back off; the alarm drives again.
   */
  async drive(): Promise<void> {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let progressed = false;
      try {
        for (const id of this.#ids) {
          if (await this.#stepPlot(id)) progressed = true;
        }
        if (this.#meta("fixtures_dirty") === "1") {
          await this.#pushFixtures();
          progressed = true;
        }
      } catch (err) {
        this.#backoff("drive", err);
        return;
      }
      if (!progressed) return;
    }
  }

  /**
   * Epoch ms of the next time drive() has work (a due timer, pending step or
   * back-off end); null when nothing is scheduled. The DO adapter sets the alarm.
   */
  nextWakeAt(): number | null {
    const now = this.#now();
    const times: number[] = [];
    for (const id of this.#ids) {
      const r = this.#row(id);
      if (r.bid_json !== null || r.pend_open === 1 || r.pend_notice !== null) times.push(now);
      if (r.state === "auction") {
        times.push(r.auction_ends);
      } else {
        times.push(r.lease_ends);
        if (r.state === "grace") {
          if (r.grace_until !== null) times.push(r.grace_until);
          if (r.retry_at !== null) times.push(r.retry_at);
        } else {
          times.push(r.paid_until);
        }
      }
    }
    if (this.#meta("fixtures_dirty") === "1") times.push(now);
    if (times.length === 0) return null;
    return Math.max(Math.min(...times), this.#backoffUntil) - this.#offset;
  }

  async #stepPlot(id: string): Promise<boolean> {
    const r = this.#row(id);
    if (r.bid_json !== null) return this.#stepBid(r);
    if (r.pend_open === 1) return this.#openShop(r);
    if (r.pend_notice !== null) return this.#sendPending(r);
    const now = this.#now();
    if (r.state === "auction") {
      if (now < r.auction_ends) return false;
      return this.#endAuction(id, now);
    }
    if (now >= r.lease_ends) return this.#endLease(r, "ended", now);
    if (r.state === "grace" && r.grace_until !== null && now >= r.grace_until) {
      return this.#endLease(r, "repossessed", now);
    }
    const due = r.state === "grace" ? r.retry_at : r.paid_until;
    if (due !== null && now >= due) return this.#charge(r, now);
    return false;
  }

  // ---- auction end and lease start -----------------------------------------

  #endAuction(id: string, now: number): boolean {
    return this.#tx(() => {
      const cur = this.#row(id);
      if (cur.state !== "auction" || cur.auction_ends > now || cur.bid_json !== null) return false;
      if (cur.top_bidder_id === null || cur.top_bid === null) {
        // No bid: the auction starts again.
        this.#set(id, {
          auction_started: now,
          auction_ends: now + PLOT_AUCTION_MS,
          auction_bids: 0,
        });
        this.#publish(id);
        return true;
      }
      // The winning bid is already burnt (sink); its first period is prepaid.
      const leaseSeq = cur.lease_seq + 1;
      const w = this.#d.world;
      const leaseId = `${w}/${id}/${leaseSeq}`;
      const notice: NoticeInput = {
        id: `plot:${w}/${id}:won:${leaseSeq}`,
        kind: "plot.won",
        text: `You won plot ${id} in ${w} for ${cur.top_bid} coin`,
        data: { world: w, plotId: id, leaseId, bid: cur.top_bid },
      };
      const pending: PendingNotice = { to: cur.top_bidder_id, notice };
      this.#set(id, {
        state: "leased",
        lease_seq: leaseSeq,
        lease_id: leaseId,
        owner_id: cur.top_bidder_id,
        owner_name: cur.top_bidder_name ?? cur.top_bidder_id,
        lease_started: now,
        lease_ends: now + PLOT_LEASE_MS,
        rent: plotRent(cur.top_bid),
        paid_until: now + RENT_PERIOD_MS,
        grace_until: null,
        retry_at: null,
        top_bid: null,
        top_bidder_id: null,
        top_bidder_name: null,
        top_bid_no: null,
        auction_bids: 0,
        shop_name: null,
        stock_count: 0,
        shop_open: 0,
        pend_open: 1,
        pend_notice: JSON.stringify(pending),
      });
      this.#setMeta("fixtures_dirty", "1");
      this.#publish(id);
      return true;
    });
  }

  async #openShop(r: PlotRow): Promise<boolean> {
    const id = r.plot_id;
    if (r.lease_id === null || r.owner_id === null) {
      this.#tx(() => this.#set(id, { pend_open: 0 }));
      return true;
    }
    await this.#d.shops(id).openLease({
      leaseId: r.lease_id,
      world: this.#d.world,
      plotId: id,
      owner: { accountId: r.owner_id, displayName: r.owner_name ?? r.owner_id },
      endsAt: r.lease_ends,
    });
    return this.#tx(() => {
      const cur = this.#row(id);
      if (cur.lease_id !== r.lease_id || cur.pend_open !== 1) return false;
      this.#set(id, { pend_open: 0 });
      this.#setMeta("fixtures_dirty", "1");
      return true;
    });
  }

  async #sendPending(r: PlotRow): Promise<boolean> {
    if (r.pend_notice === null) return false;
    const pending = JSON.parse(r.pend_notice) as PendingNotice;
    await this.#d.gateway.notify(pending.to, pending.notice);
    return this.#tx(() => {
      const cur = this.#row(r.plot_id);
      if (cur.pend_notice !== r.pend_notice) return false;
      this.#set(r.plot_id, { pend_notice: null });
      return true;
    });
  }

  // ---- rent, grace, repossession, lease end ---------------------------------

  /** Charges the next rent period; insufficient funds starts or continues the grace. */
  async #charge(r: PlotRow, now: number): Promise<boolean> {
    const id = r.plot_id;
    const w = this.#d.world;
    if (r.lease_id === null || r.owner_id === null) return false;
    const leaseId = r.lease_id;
    const n = r.rent_seq + 1;
    const res = await this.#d.gateway.walletTx(r.owner_id, {
      txId: `plot:${w}/${id}:rent:${n}`,
      currency: "coin",
      amount: -r.rent,
      reason: `shop.rent:${w}/${id}`,
      flow: "sink",
    });
    if (res.ok) {
      return this.#tx(() => {
        const cur = this.#row(id);
        if (cur.lease_id !== leaseId || cur.rent_seq !== n - 1) return false;
        // Each charge buys the period after the due date, so a clock jump charges
        // every missed period in turn (grace is shorter than a period, so this is
        // always in the future after a payment during grace).
        this.#set(id, {
          state: "leased",
          rent_seq: n,
          paid_until: cur.paid_until + RENT_PERIOD_MS,
          grace_until: null,
          retry_at: null,
        });
        this.#publish(id);
        return true;
      });
    }
    if (res.code !== "insufficient_funds") throw new Error(`rent charge failed: ${res.code}`);
    return this.#tx(() => {
      const cur = this.#row(id);
      if (cur.lease_id !== leaseId || cur.rent_seq !== n - 1) return false;
      if (cur.state === "leased") {
        const graceUntil = now + RENT_GRACE_MS;
        const notice: NoticeInput = {
          id: `plot:${w}/${id}:rent_due:${n}`,
          kind: "shop.rent_due",
          text: `Rent for plot ${id} is unpaid. Pay within 24 hours or lose the plot`,
          data: { world: w, plotId: id, leaseId },
        };
        const pending: PendingNotice = { to: cur.owner_id ?? "", notice };
        this.#set(id, {
          state: "grace",
          grace_until: graceUntil,
          retry_at: Math.min(now + RENT_RETRY_MS, graceUntil),
          pend_notice: JSON.stringify(pending),
        });
        this.#publish(id);
      } else {
        this.#set(id, {
          retry_at: Math.min(now + RENT_RETRY_MS, cur.grace_until ?? now + RENT_RETRY_MS),
        });
      }
      return true;
    });
  }

  /** Lease over (ended) or grace over (repossessed): the shop returns its stock and closes. */
  async #endLease(r: PlotRow, reason: "ended" | "repossessed", now: number): Promise<boolean> {
    const id = r.plot_id;
    const w = this.#d.world;
    if (r.lease_id === null || r.owner_id === null) return false;
    const leaseId = r.lease_id;
    await this.#d.shops(id).closeLease({ leaseId, reason });
    return this.#tx(() => {
      const cur = this.#row(id);
      if (cur.lease_id !== leaseId) return false;
      const notice: NoticeInput =
        reason === "ended"
          ? {
              id: `shop:${w}/${id}:ended:${leaseId}`,
              kind: "shop.lease_ended",
              text: `Your lease on plot ${id} ended. Your stock is back in your vault`,
              data: { world: w, plotId: id, leaseId },
            }
          : {
              id: `shop:${w}/${id}:repossessed:${leaseId}`,
              kind: "shop.repossessed",
              text: `Plot ${id} was repossessed for unpaid rent. Your stock is back in your vault`,
              data: { world: w, plotId: id, leaseId },
            };
      const pending: PendingNotice = { to: cur.owner_id ?? "", notice };
      this.#set(id, {
        state: "auction",
        lease_id: null,
        owner_id: null,
        owner_name: null,
        lease_started: 0,
        lease_ends: 0,
        rent: 0,
        paid_until: 0,
        grace_until: null,
        retry_at: null,
        shop_name: null,
        stock_count: 0,
        shop_open: 0,
        pend_open: 0,
        pend_notice: JSON.stringify(pending),
        auction_started: now,
        auction_ends: now + PLOT_AUCTION_MS,
        auction_bids: 0,
        top_bid: null,
        top_bidder_id: null,
        top_bidder_name: null,
        top_bid_no: null,
      });
      this.#setMeta("fixtures_dirty", "1");
      this.#publish(id);
      return true;
    });
  }

  // ---- bids -------------------------------------------------------------------

  /** The reason a bid cannot start now (null when it can). */
  #bidProblem(r: PlotRow, bidder: Party, amount: number): EconResult<PlotView> | null {
    if (r.bid_json !== null) return fail("busy", "another bid is being processed on this plot");
    if (r.state !== "auction" || this.#now() >= r.auction_ends) {
      return fail("closed", "this plot is not up for auction");
    }
    if (!isAmount(amount))
      return fail("bad_request", "amount must be a positive whole number of coin");
    const min = Math.max(PLOT_MIN_BID, minNextBid(r.top_bid, PLOT_MIN_BID));
    if (amount < min) return fail("too_low", `the next bid must be at least ${min} coin`);
    if (this.#plotsHeldBy(bidder.accountId, r.plot_id) >= PLOTS_PER_ACCOUNT) {
      return fail("too_many", "one plot per account");
    }
    return null;
  }

  /** Plots (other than `except`) the account leases, tops or is bidding on right now. */
  #plotsHeldBy(accountId: string, except: string): number {
    let n = 0;
    for (const id of this.#ids) {
      if (id === except) continue;
      const r = this.#row(id);
      const leased = r.state !== "auction" && r.owner_id === accountId;
      const top = r.state === "auction" && r.top_bidder_id === accountId;
      const locking =
        r.bid_json !== null && (JSON.parse(r.bid_json) as BidLock).bidder.accountId === accountId;
      if (leased || top || locking) n++;
    }
    return n;
  }

  async #stepBid(r: PlotRow): Promise<boolean> {
    if (r.bid_json === null) return false;
    const b = JSON.parse(r.bid_json) as BidLock;
    const id = r.plot_id;
    const w = this.#d.world;
    const key = `bid:${b.opId}`;
    if (b.step === "start") {
      const res = await this.#d.gateway.walletTx(b.bidder.accountId, {
        txId: `plot:${w}/${id}:bid:${b.no}`,
        currency: "coin",
        amount: -b.amount,
        reason: `plot.bid:${w}/${id}`,
        flow: "sink",
      });
      if (!res.ok) {
        if (res.code !== "insufficient_funds") throw new Error(`bid debit failed: ${res.code}`);
        return this.#tx(() => {
          const cur = this.#row(id);
          if (cur.bid_json !== r.bid_json) return false;
          this.#set(id, { bid_json: null });
          this.#opFinish(key, "failed", "insufficient_funds", "not enough coin for this bid");
          return true;
        });
      }
      return this.#advanceBid(r, { ...b, step: "debited" });
    }
    // debited: refund the replaced top bid (sink back), tell its owner, take the top.
    if (b.prev !== null) {
      const res = await this.#d.gateway.walletTx(b.prev.accountId, {
        txId: `plot:${w}/${id}:refund:${b.prev.no}`,
        currency: "coin",
        amount: b.prev.bid,
        reason: `plot.bid:${w}/${id}`,
        flow: "sink",
      });
      if (!res.ok) throw new Error(`bid refund failed: ${res.code}`);
      await this.#d.gateway.notify(b.prev.accountId, {
        id: `plot:${w}/${id}:outbid:${b.no}`,
        kind: "plot.outbid",
        text: `You were outbid on plot ${id} in ${w} (new top bid ${b.amount} coin)`,
        data: { world: w, plotId: id, bid: b.amount },
      });
    }
    return this.#tx(() => {
      const cur = this.#row(id);
      if (cur.bid_json !== r.bid_json) return false;
      this.#set(id, {
        top_bid: b.amount,
        top_bidder_id: b.bidder.accountId,
        top_bidder_name: b.bidder.displayName,
        top_bid_no: b.no,
        auction_bids: cur.auction_bids + 1,
        bid_json: null,
      });
      this.#opFinish(key, "done", null, null);
      this.#publish(id);
      return true;
    });
  }

  #advanceBid(r: PlotRow, next: BidLock): boolean {
    return this.#tx(() => {
      const cur = this.#row(r.plot_id);
      if (cur.bid_json !== r.bid_json) return false;
      this.#set(r.plot_id, { bid_json: JSON.stringify(next) });
      return true;
    });
  }

  // ---- fixtures and index -------------------------------------------------------

  /**
   * Pushes one EntityState per leased plot (shopkeeper ghosts) to the world's
   * chunk, and refreshes each plot's index row. Clears the dirty flag first so a
   * change made during the awaits marks it again.
   */
  async #pushFixtures(): Promise<void> {
    this.#tx(() => this.#setMeta("fixtures_dirty", "0"));
    try {
      const list: EntityState[] = [];
      for (const id of this.#ids) {
        const r = this.#row(id);
        if (r.state === "auction" || r.lease_id === null) continue;
        const fixture = await this.#d.shops(id).fixture();
        if (!fixture) continue;
        const shop = await this.#d.shops(id).view(null);
        const stockCount = shop ? shop.stock.length : 0;
        list.push({
          id: shopFixtureId(id),
          kind: "shopkeeper",
          name: shop?.name ?? fixture.name,
          appearance: fixture.appearance,
          pos: this.#pos(id),
          path: [],
          pathStartedAt: 0,
          speed: 0,
          tag: fixtureTag(fixture.owner.displayName, fixture.open),
        });
        this.#tx(() => {
          this.#set(id, {
            shop_name: fixture.name,
            stock_count: stockCount,
            shop_open: fixture.open ? 1 : 0,
          });
          this.#publish(id);
        });
      }
      if (this.#d.chunk) await this.#d.chunk.setFixtures("shops", list);
    } catch (err) {
      this.#tx(() => this.#setMeta("fixtures_dirty", "1"));
      throw err;
    }
  }

  /** Queues the plot's index row (outbox shop_index); call inside a transaction. */
  #publish(id: string): void {
    const r = this.#row(id);
    const payload: ShopIndexPayload = {
      plot: this.#view(r),
      stockCount: r.stock_count,
      open: r.shop_open === 1,
    };
    this.#d.outbox.append("shop_index", `${this.#d.world}/${id}`, "upsert", payload);
  }

  // ---- views and storage helpers ----------------------------------------------

  #view(r: PlotRow): PlotView {
    const base = { id: r.plot_id, world: this.#d.world, pos: this.#pos(r.plot_id) };
    if (r.state === "auction") {
      return {
        ...base,
        state: "auction",
        auction: {
          startedAt: r.auction_started,
          endsAt: r.auction_ends,
          minBid: PLOT_MIN_BID,
          topBid: r.top_bid,
          topBidder:
            r.top_bidder_id === null
              ? null
              : { accountId: r.top_bidder_id, displayName: r.top_bidder_name ?? r.top_bidder_id },
          bids: r.auction_bids,
        },
        lease: null,
        shopName: null,
      };
    }
    return {
      ...base,
      state: r.state as PlotState,
      auction: null,
      lease: {
        owner: { accountId: r.owner_id ?? "", displayName: r.owner_name ?? "" },
        startedAt: r.lease_started,
        endsAt: r.lease_ends,
        rent: r.rent,
        paidUntil: r.paid_until,
        graceUntil: r.grace_until,
      },
      shopName: r.shop_name,
    };
  }

  #viewOf(plotId: string): PlotView {
    return this.#view(this.#row(plotId));
  }

  #pos(id: string): TilePos {
    const spec = plotsOf(this.#d.world).find((p) => p.id === id);
    return spec ? spec.pos : { x: 0, y: 0 };
  }

  #row(id: string): PlotRow {
    const r = queryRows<PlotRow>(
      this.#d.store,
      "SELECT * FROM plot_state WHERE plot_id = ?",
      id,
    )[0];
    if (!r) throw new Error(`no plot ${id} in ${this.#d.world}`);
    return r;
  }

  #op(key: string): OpRow | null {
    return (
      queryRows<OpRow>(this.#d.store, "SELECT * FROM plot_ops WHERE op_key = ?", key)[0] ?? null
    );
  }

  #opFinish(
    key: string,
    state: "done" | "failed",
    code: string | null,
    message: string | null,
  ): void {
    execSql(
      this.#d.store,
      "UPDATE plot_ops SET state = ?, error_code = ?, error_message = ? WHERE op_key = ?",
      state,
      code,
      message,
      key,
    );
  }

  #set(id: string, patch: Record<string, SqlValue>): void {
    patchRow(this.#d.store, "plot_state", "plot_id", id, patch);
  }

  #meta(k: string): string | null {
    return (
      queryRows<{ v: string }>(this.#d.store, "SELECT v FROM plot_meta WHERE k = ?", k)[0]?.v ??
      null
    );
  }

  #setMeta(k: string, v: string): void {
    execSql(
      this.#d.store,
      `INSERT INTO plot_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      k,
      v,
    );
  }

  #tx<T>(fn: () => T): T {
    return this.#d.store.transactionSync(fn);
  }

  #now(): number {
    return this.#d.clock.now() + this.#offset;
  }

  #backoff(what: string, err: unknown): void {
    console.error(`plots ${this.#d.world}: ${what} failed`, err);
    this.#backoffUntil = this.#now() + BACKOFF_MS;
  }
}

/** A failed EconResult; `code` is one of EconomyErrorCode (callers pass the literal). */
function fail<T = never>(code: string, message: string): EconResult<T> {
  return { ok: false, code: code as EconomyErrorCode, message };
}

/**
 * MarketDO (wave-C.md §4): one auction house shard "<scope>:<category>".
 * OWNER: T-market. A thin adapter: storage, alarm and RPC here; the rules live
 * in market/book.ts (MarketBook), the same way do/account.ts delegates.
 */
import type { MarketListing, Party } from "@gamez/protocol";
import { Outbox, type ReplicationBatch } from "@gamez/sync";
import { DurableObject } from "cloudflare:workers";
import { accountGateway } from "../economy/gateway.ts";
import { sqlStoreOf, type EconResult, type Env, type MarketApi } from "../contracts.ts";
import { MarketBook, type ListInput } from "../market/book.ts";

const FLUSH_BATCH = 200;
/** Outbox rows left after a write are flushed this soon (the alarm drains them). */
const FLUSH_SOON_MS = 2_000;

export class MarketDO extends DurableObject<Env> implements MarketApi {
  readonly #outbox: Outbox;
  readonly #book: MarketBook;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const shard = ctx.id.name ?? ctx.id.toString();
    this.#outbox = new Outbox(ctx.storage.sql, `market:${shard}`);
    this.#book = new MarketBook(sqlStoreOf(ctx.storage), accountGateway(env), this.#outbox, shard);
    void ctx.blockConcurrencyWhile(async () => {
      this.#outbox.init();
      this.#book.init();
    });
  }

  async list(input: ListInput): Promise<EconResult<MarketListing>> {
    return this.#mutate(() => this.#book.list(input));
  }

  async bid(input: {
    opId: string;
    bidder: Party;
    listingId: string;
    amount: number;
  }): Promise<EconResult<MarketListing>> {
    return this.#mutate(() => this.#book.bid(input));
  }

  async buy(input: {
    opId: string;
    buyer: Party;
    listingId: string;
  }): Promise<EconResult<MarketListing>> {
    return this.#mutate(() => this.#book.buy(input));
  }

  async cancel(input: {
    opId: string;
    accountId: string;
    listingId: string;
  }): Promise<EconResult<MarketListing>> {
    return this.#mutate(() => this.#book.cancel(input));
  }

  async get(listingId: string): Promise<MarketListing | null> {
    return this.#book.get(listingId);
  }

  async alarm(): Promise<void> {
    try {
      await this.#book.tick();
    } catch (err) {
      console.error("market: tick failed", err);
    }
    const sink = {
      send: async (batch: ReplicationBatch) => {
        await this.env.SYNC_QUEUE.send(batch);
      },
    };
    await this.#outbox.flush(sink, FLUSH_BATCH);
    await this.#arm();
  }

  /** Runs one operation; a saga that throws answers "unavailable" and the alarm finishes it. */
  async #mutate<T>(fn: () => Promise<EconResult<T>>): Promise<EconResult<T>> {
    try {
      return await fn();
    } catch (err) {
      console.error("market: operation threw; the alarm will finish it", err);
      return { ok: false, code: "unavailable", message: "the market is busy, try again" };
    } finally {
      await this.#arm();
    }
  }

  /** Sets the one DO alarm to the earliest of: saga/expiry work, an outbox flush. */
  async #arm(): Promise<void> {
    const now = Date.now();
    const wakes: number[] = [];
    const work = this.#book.nextWake(now);
    if (work !== null) wakes.push(work);
    if (this.#outbox.size() > 0) wakes.push(now + FLUSH_SOON_MS);
    if (wakes.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...wakes));
  }
}

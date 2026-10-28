/**
 * Test doubles for the market routes (T-market): a D1 over node:sqlite that
 * applies the real 0006 migration and the real projection (applyBatch), and a
 * MARKET namespace that hands out one real MarketBook per shard.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { MarketListing } from "@gamez/protocol";
import { Outbox, applyBatch, SYNC_CURSOR_DDL, type ReplicationBatch } from "@gamez/sync";
import { projections, marketListing } from "../../src/server/projections.ts";
import type { MarketApi, MarketListingPayload } from "../../src/server/contracts.ts";
import { MarketBook, type ListInput } from "../../src/server/market/book.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";
import type { FakeAccounts } from "./fake-accounts.ts";
import type { Clock } from "./harness.ts";

type Bound = { sql: string; params: unknown[] };

/** The D1 statement API the market code and applyBatch use, over node:sqlite. */
export class FakeD1 {
  readonly db = new DatabaseSync(":memory:");

  /** Applies migrations from apps/game/migrations, in the given order. */
  migrate(names: string[]): this {
    const dir = join(import.meta.dirname, "..", "..", "migrations");
    for (const name of names) this.db.exec(readFileSync(join(dir, name), "utf8"));
    this.db.exec(SYNC_CURSOR_DDL);
    return this;
  }

  asD1(): D1Database {
    const db = this.db;
    const stmt = (sql: string, params: unknown[]) => ({
      sql,
      params,
      bind: (...more: unknown[]) => stmt(sql, more),
      run: async () => {
        const r = db.prepare(sql).run(...(params as never[]));
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
      all: async () => ({
        success: true,
        results: db.prepare(sql).all(...(params as never[])),
        meta: {},
      }),
      first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    });
    return {
      prepare: (sql: string) => stmt(sql, []),
      batch: async (statements: Bound[]) => {
        const out: unknown[] = [];
        db.exec("BEGIN");
        try {
          for (const s of statements) {
            const r = db.prepare(s.sql).run(...(s.params as never[]));
            out.push({ success: true, meta: { changes: Number(r.changes) } });
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return out;
      },
    } as unknown as D1Database;
  }
}

/** Applies one outbox batch to D1 with the production projections. */
export async function project(d1: FakeD1, outbox: Outbox): Promise<void> {
  const records = outbox.pending(500);
  if (records.length === 0) return;
  const batch: ReplicationBatch = { source: outbox.source, records };
  await applyBatch(d1.asD1(), batch, projections);
  await outbox.flush({ send: async () => {} }, 500);
}

/** A MARKET namespace: one real MarketBook per shard over fake storage. */
export class FakeMarket {
  readonly shards = new Map<string, { book: MarketBook; outbox: Outbox }>();

  constructor(
    readonly accounts: FakeAccounts,
    readonly clock: Clock,
  ) {}

  /** The DO-shaped stub for `shard`, creating the shard on first use. */
  getByName(shard: string): MarketApi {
    const s = this.#shard(shard);
    const { book } = s;
    return {
      list: (input: ListInput) => book.list(input),
      bid: (input: {
        opId: string;
        bidder: { accountId: string; displayName: string };
        listingId: string;
        amount: number;
      }) => book.bid(input),
      buy: (input: {
        opId: string;
        buyer: { accountId: string; displayName: string };
        listingId: string;
      }) => book.buy(input),
      cancel: (input: { opId: string; accountId: string; listingId: string }) => book.cancel(input),
      get: async (listingId: string): Promise<MarketListing | null> => book.get(listingId),
    } as unknown as MarketApi;
  }

  outboxOf(shard: string): Outbox {
    return this.#shard(shard).outbox;
  }

  #shard(shard: string): { book: MarketBook; outbox: Outbox } {
    let s = this.shards.get(shard);
    if (!s) {
      const store = fakeSqlStore();
      const outbox = new Outbox(store.sql, `market:${shard}`);
      outbox.init();
      const book = new MarketBook(store, this.accounts, outbox, shard, this.clock.now);
      book.init();
      s = { book, outbox };
      this.shards.set(shard, s);
    }
    return s;
  }
}

/** Row of a settled listing as the projection writes it (for search fixtures). */
export function projectRow(listing: MarketListing): Record<string, unknown> {
  const payload: MarketListingPayload = { listing };
  return {
    id: listing.id,
    ...marketListing.toRow(payload),
    _version: 1,
    _deleted: 0,
    _updated_at: 1,
  };
}

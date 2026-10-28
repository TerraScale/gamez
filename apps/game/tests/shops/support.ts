/**
 * Shared harness for the shop tests (wave-C.md §5): a PlotBook and one ShopBook
 * per plot, wired like the DOs but with a fake clock, the real account logic
 * (FakeGateway, T-escrow), a fake chunk and an in-memory outbox per book.
 */
import type { EntityState, Party } from "@gamez/protocol";
import { Outbox, type OutboxRecord } from "@gamez/sync";
import type { ChunkFixtureApi, ShopApi } from "../../src/server/contracts.ts";
import { PlotBook } from "../../src/server/shops/plots.ts";
import { ShopBook } from "../../src/server/shops/shop.ts";
import { FakeGateway } from "../support/fake-gateway.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";
import type { WalletTxC } from "../../src/server/contracts.ts";

export const WORLD = "classic-town";
export const T0 = 1_700_000_000_000;

/** A clock the tests move by hand. */
export class FakeClock {
  t = T0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** FakeGateway with a hook awaited before every walletTx (to interleave sagas). */
export class HookedGateway extends FakeGateway {
  hook: ((accountId: string, txId: string) => Promise<void>) | null = null;

  override async walletTx(accountId: string, tx: WalletTxC) {
    if (this.hook) await this.hook(accountId, tx.txId);
    return super.walletTx(accountId, tx);
  }
}

/** The world's chunk: remembers the last fixtures pushed per group. */
export class FakeChunk implements ChunkFixtureApi {
  readonly pushes: { group: string; fixtures: EntityState[] }[] = [];
  readonly groups = new Map<string, EntityState[]>();
  async setFixtures(group: string, fixtures: EntityState[]): Promise<void> {
    this.pushes.push({ group, fixtures });
    this.groups.set(group, fixtures);
  }
  shops(): EntityState[] {
    return this.groups.get("shops") ?? [];
  }
}

export class Harness {
  readonly clock = new FakeClock();
  readonly gw = new HookedGateway(() => this.clock.now());
  readonly chunk = new FakeChunk();
  readonly plotOutbox: Outbox;
  readonly plots: PlotBook;
  readonly #shops = new Map<string, ShopBook>();
  readonly #shopOutboxes = new Map<string, Outbox>();

  constructor() {
    const store = fakeSqlStore();
    this.plotOutbox = new Outbox(store.sql, `plots:${WORLD}`);
    this.plotOutbox.init();
    this.plots = new PlotBook({
      world: WORLD,
      store,
      outbox: this.plotOutbox,
      gateway: this.gw,
      clock: this.clock,
      shops: (plotId) => this.shop(plotId),
      chunk: this.chunk,
    });
    this.plots.init();
  }

  /** The ShopDO of a plot, created on first use (as getByName does). */
  shop(plotId: string): ShopBook {
    let book = this.#shops.get(plotId);
    if (!book) {
      const store = fakeSqlStore();
      const outbox = new Outbox(store.sql, `shop:${WORLD}/${plotId}`);
      outbox.init();
      this.#shopOutboxes.set(plotId, outbox);
      book = new ShopBook({
        world: WORLD,
        plotId,
        store,
        outbox,
        gateway: this.gw,
        clock: this.clock,
        plots: { refreshFixture: (id) => this.plots.refreshFixture(id) },
      });
      book.init();
      this.#shops.set(plotId, book);
    }
    return book;
  }

  shopApi(plotId: string): ShopApi {
    return this.shop(plotId);
  }

  shopOutbox(plotId: string): Outbox {
    this.shop(plotId);
    return this.#shopOutboxes.get(plotId)!;
  }

  /** Pending outbox records of a table, across the plot book and every shop. */
  outboxRows(table: string): OutboxRecord[] {
    const all = [this.plotOutbox, ...this.#shopOutboxes.values()];
    return all.flatMap((o) => o.pending(100_000)).filter((r) => r.table === table);
  }

  /** The Party of an account (its display name is the test's choice). */
  party(accountId: string, displayName = accountId): Party {
    return { accountId, displayName };
  }
}

/** Ids of every account the harness touched. */
export function touched(h: Harness): string[] {
  return h.gw.accounts();
}

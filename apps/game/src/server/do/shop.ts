/**
 * ShopDO (wave-C.md §5.3): one player shop on a leased plot, name
 * "<world>/<plotId>". OWNER: T-shops. Thin adapter over shops/shop.ts: storage,
 * the alarm (re-drives sagas, flushes the outbox to the sync queue) and RPC.
 */
import type { Party, ShopView } from "@gamez/protocol";
import { Outbox, type ReplicationBatch } from "@gamez/sync";
import { DurableObject } from "cloudflare:workers";
import { analyticsFor } from "../analytics/index.ts";
import { markDoActive } from "../analytics/do-active.ts";
import { sqlStoreOf, type EconResult, type Env, type ShopApi } from "../contracts.ts";
import { accountGateway } from "../economy/gateway.ts";
import { systemClock } from "../shops/clock.ts";
import { ShopBook } from "../shops/shop.ts";

const FLUSH_BATCH = 200;
const OUTBOX_DELAY_MS = 2_000;

export class ShopDO extends DurableObject<Env> implements ShopApi {
  readonly #book: ShopBook;
  readonly #outbox: Outbox;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "ShopDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    const name = ctx.id.name ?? "";
    const cut = name.lastIndexOf("/");
    const world = cut > 0 ? name.slice(0, cut) : name;
    const plotId = cut > 0 ? name.slice(cut + 1) : "";
    this.#outbox = new Outbox(ctx.storage.sql, `shop:${name}`);
    this.#book = new ShopBook({
      world,
      plotId,
      store: sqlStoreOf(ctx.storage),
      outbox: this.#outbox,
      gateway: accountGateway(env),
      clock: systemClock,
      plots: { refreshFixture: (id) => env.PLOTS.getByName(world).refreshFixture(id) },
    });
    void ctx.blockConcurrencyWhile(async () => {
      this.#outbox.init();
      this.#book.init();
    });
  }

  async alarm(): Promise<void> {
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "ShopDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    await this.#book.drive();
    await this.#outbox.flush(
      {
        send: async (batch: ReplicationBatch) => {
          await this.env.SYNC_QUEUE.send(batch);
        },
      },
      FLUSH_BATCH,
    );
    await this.#arm();
  }

  async view(viewerId: string | null): Promise<ShopView | null> {
    return this.#book.view(viewerId);
  }

  async openLease(input: {
    leaseId: string;
    world: string;
    plotId: string;
    owner: Party;
    endsAt: number;
  }): Promise<void> {
    await this.#book.openLease(input);
    await this.#arm();
  }

  async closeLease(input: { leaseId: string; reason: "ended" | "repossessed" }): Promise<void> {
    await this.#book.closeLease(input);
    await this.#arm();
  }

  async configure(input: {
    accountId: string;
    name?: string;
    appearance?: string;
    open?: boolean;
  }): Promise<EconResult<ShopView>> {
    const r = await this.#book.configure(input);
    await this.#arm();
    return r;
  }

  async stock(input: {
    opId: string;
    accountId: string;
    uid: string;
    price: number;
  }): Promise<EconResult<ShopView>> {
    const r = await this.#book.stock(input);
    await this.#arm();
    return r;
  }

  async unstock(input: {
    opId: string;
    accountId: string;
    entryId: string;
  }): Promise<EconResult<ShopView>> {
    const r = await this.#book.unstock(input);
    await this.#arm();
    return r;
  }

  async buy(input: { opId: string; buyer: Party; entryId: string }): Promise<EconResult<ShopView>> {
    const r = await this.#book.buy(input);
    await this.#arm();
    return r;
  }

  async claim(input: { opId: string; accountId: string }): Promise<EconResult<ShopView>> {
    const r = await this.#book.claim(input);
    await this.#arm();
    return r;
  }

  async fixture() {
    return this.#book.fixture();
  }

  /** Sets the alarm for the next pending work or outbox flush (earliest wins). */
  async #arm(): Promise<void> {
    const wakes: number[] = [];
    const next = this.#book.nextWakeAt();
    if (next !== null) wakes.push(next);
    if (this.#outbox.size() > 0) wakes.push(Date.now() + OUTBOX_DELAY_MS);
    if (wakes.length === 0) return;
    const at = Math.min(...wakes);
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }
}

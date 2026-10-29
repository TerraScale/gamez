/**
 * PlotAuctionDO (wave-C.md §5): shop plot lease auctions and rent for one
 * presence world (name = world id, "classic-town"). OWNER: T-shops. Thin adapter
 * over shops/plots.ts: storage, the alarm (lease timers, rent, outbox flush) and RPC.
 */
import type { Party, PlotView } from "@gamez/protocol";
import { Outbox, type ReplicationBatch } from "@gamez/sync";
import { DurableObject } from "cloudflare:workers";
import { analyticsFor } from "../analytics/index.ts";
import { markDoActive } from "../analytics/do-active.ts";
import { sqlStoreOf, type EconResult, type Env, type PlotAuctionApi } from "../contracts.ts";
import { accountGateway } from "../economy/gateway.ts";
import { presenceWorld } from "../../shared/worlds.ts";
import { systemClock } from "../shops/clock.ts";
import { PlotBook } from "../shops/plots.ts";

const FLUSH_BATCH = 200;
const OUTBOX_DELAY_MS = 2_000;

export class PlotAuctionDO extends DurableObject<Env> implements PlotAuctionApi {
  readonly #book: PlotBook;
  readonly #outbox: Outbox;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "PlotAuctionDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    const world = ctx.id.name ?? "classic-town";
    const presence = presenceWorld(world);
    this.#outbox = new Outbox(ctx.storage.sql, `plots:${world}`);
    this.#book = new PlotBook({
      world,
      store: sqlStoreOf(ctx.storage),
      outbox: this.#outbox,
      gateway: accountGateway(env),
      clock: systemClock,
      shops: (plotId) => env.SHOP.getByName(`${world}/${plotId}`),
      chunk: presence ? env.CHUNK.getByName(presence.chunk) : null,
    });
    void ctx.blockConcurrencyWhile(async () => {
      this.#outbox.init();
      this.#book.init();
    });
  }

  async alarm(): Promise<void> {
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "PlotAuctionDO",
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

  async plots(): Promise<PlotView[]> {
    const plots = await this.#book.plots();
    await this.#arm();
    return plots;
  }

  async bid(input: {
    opId: string;
    bidder: Party;
    plotId: string;
    amount: number;
  }): Promise<EconResult<PlotView>> {
    const r = await this.#book.bid(input);
    await this.#arm();
    return r;
  }

  async refreshFixture(plotId: string): Promise<void> {
    await this.#book.refreshFixture(plotId);
    await this.#arm();
  }

  /** Dev hosts only (the route checks isDevHost): moves the clock forward and runs due work. */
  async devAdvance(ms: number): Promise<PlotView[]> {
    const plots = await this.#book.devAdvance(ms);
    await this.#arm();
    return plots;
  }

  /** Sets the alarm for the next timer, pending step or outbox flush (earliest wins). */
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

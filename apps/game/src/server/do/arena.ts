/**
 * ArenaDO (wave-C.md §6.3): the async PvP ladder of one mode and season,
 * named "<mode>:<seasonId>". This class only adapts storage and RPC to
 * arena/ladder.ts (the logic, tested with fakes) and flushes the outbox
 * (arena_rating rows) to the sync queue from the alarm.
 */
import { fight } from "@gamez/mode-arena";
import { Outbox, type ReplicationBatch } from "@gamez/sync";
import type { ArenaBuild, ArenaMatch, ArenaStatus, ArenaTicket } from "@gamez/protocol";
import { DurableObject } from "cloudflare:workers";
import { analyticsFor } from "../analytics/index.ts";
import { markDoActive } from "../analytics/do-active.ts";
import { accountGateway } from "../economy/gateway.ts";
import { ArenaLadder } from "../arena/ladder.ts";
import { cryptoSeed } from "../arena/seeds.ts";
import { sqlStoreOf, type ArenaApi, type EconResult, type Env } from "../contracts.ts";

const FLUSH_BATCH = 200;
/** Delay before unsent outbox rows (arena_rating) are flushed to the sync queue. */
const FLUSH_MS = 1000;

export class ArenaDO extends DurableObject<Env> implements ArenaApi {
  readonly #outbox: Outbox;
  readonly #ladder: ArenaLadder;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "ArenaDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    const name = ctx.id.name ?? "classic:";
    const [mode = "classic", ...rest] = name.split(":");
    const seasonId = rest.join(":");
    this.#outbox = new Outbox(ctx.storage.sql, `arena:${name}`);
    this.#ladder = new ArenaLadder({
      store: sqlStoreOf(ctx.storage),
      accounts: accountGateway(env),
      outbox: this.#outbox,
      clock: () => Date.now(),
      seeds: cryptoSeed,
      fight: (a, b, seed) => fight(a, b, seed),
      mode,
      seasonId,
    });
    void ctx.blockConcurrencyWhile(async () => {
      this.#outbox.init();
      this.#ladder.init();
    });
  }

  /**
   * The next time the alarm must run: the outbox flush, a waiting ticket's
   * re-check or the earliest reward retry (backoff), whichever comes first.
   */
  #wakeAt(): number | null {
    const ladder = this.#ladder.nextWakeAt();
    const flush = this.#outbox.size() > 0 ? Date.now() + FLUSH_MS : null;
    if (ladder === null) return flush;
    return flush === null ? ladder : Math.min(ladder, flush);
  }

  /** Moves the alarm earlier when there is work due before it (never later). */
  async #schedule(): Promise<void> {
    const wake = this.#wakeAt();
    if (wake === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > wake) await this.ctx.storage.setAlarm(wake);
  }

  async alarm(): Promise<void> {
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "ArenaDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    await this.#ladder.work();
    const sink = {
      send: async (batch: ReplicationBatch) => {
        await this.env.SYNC_QUEUE.send(batch);
      },
    };
    await this.#outbox.flush(sink, FLUSH_BATCH);
    const wake = this.#wakeAt();
    if (wake !== null) await this.ctx.storage.setAlarm(wake);
  }

  async register(build: ArenaBuild): Promise<ArenaStatus> {
    const status = this.#ladder.register(build);
    await this.#schedule();
    return status;
  }

  async status(accountId: string): Promise<ArenaStatus> {
    return this.#ladder.status(accountId);
  }

  async enqueue(input: { opId: string; build: ArenaBuild }): Promise<EconResult<ArenaTicket>> {
    const res = await this.#ladder.enqueue(input);
    await this.#schedule();
    return res;
  }

  async poll(input: { accountId: string; ticket: string }): Promise<ArenaTicket | null> {
    const ticket = await this.#ladder.poll(input);
    await this.#schedule();
    return ticket;
  }

  async match(id: string): Promise<ArenaMatch | null> {
    return this.#ladder.match(id);
  }

  /** Dev hosts only (route checks isDevHost): the build used instead of exportBuild. */
  async devSetBuild(build: ArenaBuild): Promise<void> {
    this.#ladder.devSetBuild(build);
  }

  async devBuild(accountId: string): Promise<ArenaBuild | null> {
    return this.#ladder.devBuild(accountId);
  }
}

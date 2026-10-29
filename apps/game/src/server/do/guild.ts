/**
 * GuildDO (wave-B.md §6): one guild — info, roster, roles — and its
 * "guild_index" outbox rows. Name: the guild id (guildSlug of the name), so
 * names are unique by construction. OWNER: T-guilds.
 *
 * Logic lives in guild/roster.ts; this class adapts storage and RPC, and
 * flushes the outbox to the sync queue from alarm() (AGENTS.md §11).
 */
import type { GuildInfo } from "@gamez/protocol";
import { Outbox, type ReplicationBatch } from "@gamez/sync";
import { DurableObject } from "cloudflare:workers";
import { analyticsFor } from "../analytics/index.ts";
import { markDoActive } from "../analytics/do-active.ts";
import { GuildRoster } from "../guild/roster.ts";
import { sqlStoreOf, type GuildApi, type Env } from "../contracts.ts";

const FLUSH_BATCH = 200;

export class GuildDO extends DurableObject<Env> implements GuildApi {
  readonly #outbox: Outbox;
  readonly #roster: GuildRoster;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "GuildDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    const id = ctx.id.name ?? ctx.id.toString();
    this.#outbox = new Outbox(ctx.storage.sql, `guild:${id}`);
    this.#roster = new GuildRoster({
      id,
      store: sqlStoreOf(ctx.storage),
      outbox: this.#outbox,
    });
    void ctx.blockConcurrencyWhile(async () => {
      this.#outbox.init();
      this.#roster.init();
    });
  }

  async #flushSoon(): Promise<void> {
    if (this.#outbox.size() > 0) await this.#outbox.scheduleFlush(this.ctx.storage);
  }

  async alarm(): Promise<void> {
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "GuildDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    const sink = {
      send: async (batch: ReplicationBatch) => {
        await this.env.SYNC_QUEUE.send(batch);
      },
    };
    await this.#outbox.flush(sink, FLUSH_BATCH);
    if (this.#outbox.size() > 0) await this.#outbox.scheduleFlush(this.ctx.storage, 0);
  }

  async info(): Promise<GuildInfo | null> {
    return this.#roster.info();
  }

  async create(input: Parameters<GuildApi["create"]>[0]): ReturnType<GuildApi["create"]> {
    const res = this.#roster.create(input);
    await this.#flushSoon();
    return res;
  }

  async join(input: Parameters<GuildApi["join"]>[0]): ReturnType<GuildApi["join"]> {
    const res = this.#roster.join(input);
    await this.#flushSoon();
    return res;
  }

  async leave(input: Parameters<GuildApi["leave"]>[0]): ReturnType<GuildApi["leave"]> {
    const res = this.#roster.leave(input);
    await this.#flushSoon();
    return res;
  }

  async kick(input: Parameters<GuildApi["kick"]>[0]): ReturnType<GuildApi["kick"]> {
    const res = this.#roster.kick(input);
    await this.#flushSoon();
    return res;
  }
}

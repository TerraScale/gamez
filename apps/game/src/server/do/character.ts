import type { TilePos } from "@gamez/protocol";
import { Outbox, type ReplicationBatch } from "@gamez/sync";
import { DurableObject } from "cloudflare:workers";
import { analyticsFor } from "../analytics/index.ts";
import { markDoActive } from "../analytics/do-active.ts";
import type { CharacterApi, CharacterRecord, CharacterSummary, Env, ModeId } from "../contracts.ts";

/** Max records per queue message; keeps each message well under the 128 KB limit. */
const FLUSH_BATCH = 200;

interface CharacterRow extends Record<string, SqlStorageValue> {
  id: string;
  account_id: string;
  mode: string;
  name: string;
  appearance: string;
  x: number;
  y: number;
  created_at: number;
  updated_at: number;
}

/**
 * Authoritative state of one character in one mode. Name: "<accountId>:<mode>".
 * Every change writes the row and an outbox record in one transaction; an
 * alarm drains the outbox to the sync queue, which projects into D1.
 */
export class CharacterDO extends DurableObject<Env> implements CharacterApi {
  #sql = this.ctx.storage.sql;
  #row: CharacterRow | null = null;
  #outbox: Outbox | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "CharacterDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    void ctx.blockConcurrencyWhile(async () => {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS character (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        name TEXT NOT NULL,
        appearance TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      this.#row =
        this.#sql.exec<CharacterRow>("SELECT * FROM character LIMIT 1").toArray()[0] ?? null;
      if (this.#row) this.#outbox = this.#openOutbox(this.#row.id);
    });
  }

  async getOrCreate(
    accountId: string,
    mode: ModeId,
    spawn: TilePos,
    name: string,
  ): Promise<CharacterRecord> {
    if (!this.#row) {
      const now = Date.now();
      const row: CharacterRow = {
        id: `${accountId}:${mode}`,
        account_id: accountId,
        mode,
        name,
        appearance: "unit.hero",
        x: spawn.x,
        y: spawn.y,
        created_at: now,
        updated_at: now,
      };
      const outbox = this.#openOutbox(row.id);
      this.ctx.storage.transactionSync(() => {
        this.#sql.exec(
          "INSERT INTO character (id, account_id, mode, name, appearance, x, y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          row.id,
          row.account_id,
          row.mode,
          row.name,
          row.appearance,
          row.x,
          row.y,
          row.created_at,
          row.updated_at,
        );
        outbox.append("character_summary", row.id, "upsert", summaryOf(row));
      });
      this.#row = row;
      this.#outbox = outbox;
      await outbox.scheduleFlush(this.ctx.storage);
    }
    return recordOf(this.#row);
  }

  async savePosition(pos: TilePos): Promise<void> {
    const row = this.#row;
    const outbox = this.#outbox;
    if (!row || !outbox) throw new Error("character does not exist");
    if (row.x === pos.x && row.y === pos.y) return;
    const next: CharacterRow = { ...row, x: pos.x, y: pos.y, updated_at: Date.now() };
    this.ctx.storage.transactionSync(() => {
      this.#sql.exec(
        "UPDATE character SET x = ?, y = ?, updated_at = ? WHERE id = ?",
        next.x,
        next.y,
        next.updated_at,
        next.id,
      );
      outbox.append("character_summary", next.id, "upsert", summaryOf(next));
    });
    this.#row = next;
    await outbox.scheduleFlush(this.ctx.storage);
  }

  /** Drains the outbox into the sync queue. A throw makes the runtime retry the alarm. */
  async alarm(): Promise<void> {
    markDoActive(
      analyticsFor(this.env, (p) => this.ctx.waitUntil(p)),
      "CharacterDO",
      this.ctx.id.name ?? this.ctx.id.toString(),
      Date.now(),
    );
    const outbox = this.#outbox;
    if (!outbox) return;
    const sink = {
      send: async (batch: ReplicationBatch) => {
        await this.env.SYNC_QUEUE.send(batch);
      },
    };
    await outbox.flush(sink, FLUSH_BATCH);
    // Records appended while the flush was in flight need another alarm.
    if (outbox.size() > 0) await outbox.scheduleFlush(this.ctx.storage, 0);
  }

  #openOutbox(id: string): Outbox {
    const outbox = new Outbox(this.#sql, `character:${id}`);
    outbox.init();
    return outbox;
  }
}

function recordOf(row: CharacterRow): CharacterRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    mode: row.mode,
    name: row.name,
    appearance: row.appearance,
    pos: { x: row.x, y: row.y },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function summaryOf(row: CharacterRow): CharacterSummary {
  return {
    characterId: row.id,
    accountId: row.account_id,
    mode: row.mode,
    name: row.name,
    x: row.x,
    y: row.y,
  };
}

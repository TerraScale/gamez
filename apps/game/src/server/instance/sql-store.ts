/**
 * InstanceStore on Durable Object SQLite: one row with the sim snapshot and
 * one row per player with the last applied action seq.
 */
import type { SimSnapshot } from "@gamez/kernel";
import type { InstanceStore, StoredInstance } from "./host.ts";

interface InstanceRow extends Record<string, SqlStorageValue> {
  instance_id: string;
  seed: number;
  snapshot: string;
}

interface PlayerRow extends Record<string, SqlStorageValue> {
  account_id: string;
  last_seq: number;
}

export class SqlInstanceStore implements InstanceStore {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS instance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      instance_id TEXT NOT NULL,
      seed INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS player (
      account_id TEXT PRIMARY KEY,
      last_seq INTEGER NOT NULL
    )`);
  }

  load(): StoredInstance | null {
    const row = this.#storage.sql
      .exec<InstanceRow>("SELECT instance_id, seed, snapshot FROM instance WHERE id = 1")
      .toArray()[0];
    if (!row) return null;
    try {
      return {
        instanceId: row.instance_id,
        seed: row.seed,
        snapshot: JSON.parse(row.snapshot) as SimSnapshot,
      };
    } catch {
      return null;
    }
  }

  players(): Map<string, number> {
    const rows = this.#storage.sql
      .exec<PlayerRow>("SELECT account_id, last_seq FROM player")
      .toArray();
    return new Map(rows.map((r) => [r.account_id, r.last_seq]));
  }

  save(instance: StoredInstance, player?: { accountId: string; lastSeq: number }): void {
    const snapshot = JSON.stringify(instance.snapshot);
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        `INSERT INTO instance (id, instance_id, seed, snapshot, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET instance_id = excluded.instance_id, seed = excluded.seed,
           snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
        instance.instanceId,
        instance.seed,
        snapshot,
        Date.now(),
      );
      if (player) {
        this.#storage.sql.exec(
          `INSERT INTO player (account_id, last_seq) VALUES (?, ?)
           ON CONFLICT (account_id) DO UPDATE SET last_seq = excluded.last_seq`,
          player.accountId,
          player.lastSeq,
        );
      }
    });
  }
}

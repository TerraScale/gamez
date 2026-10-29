import {
  applyBatch,
  type ApplyResult,
  type ProjectionMap,
  type ReplicationBatch,
} from "@gamez/sync";
import type { SyncMessageSample } from "./analytics/sync.ts";
import type { Env } from "./contracts.ts";
import { projections } from "./projections.ts";

/** Dead-letter queue for `gamez-sync`. Drained by a second consumer in cloudflare.config.ts. */
export const SYNC_DLQ_QUEUE = "gamez-sync-dlq";

/**
 * D1 statements one invocation may spend. A message costs `records + 1`
 * statements (one per record, plus the cursor). D1's per-invocation query limit
 * is 1000 on the paid plan and 50 on the free plan (see docs/deploy.md).
 */
export const SYNC_STATEMENT_BUDGET = 800;
/** Retry delay for a message skipped because the invocation's budget ran out. */
export const SYNC_BUDGET_RETRY_SECONDS = 2;
/** Backoff base: a failed apply retries after min(base * 2^(attempts-1), cap). */
export const SYNC_RETRY_BASE_SECONDS = 10;
export const SYNC_RETRY_CAP_SECONDS = 900;
/** Retry delay for a failed DLQ re-apply. */
export const SYNC_DLQ_RETRY_SECONDS = 900;
/**
 * Delivery attempts after which a failing sync message is "dead" (sent to the
 * DLQ). Mirrors maxRetries of the gamez-sync consumer in cloudflare.config.ts.
 */
export const SYNC_MAX_RETRIES = 10;

export interface SyncConsumerDeps {
  applyBatch: (
    db: D1Database,
    batch: ReplicationBatch,
    projections: ProjectionMap,
  ) => Promise<ApplyResult>;
  projections: ProjectionMap;
  /**
   * Admin instrumentation (analytics/sync.ts), called once per applied or
   * failed message of the main queue, before it is acked or retried. Never
   * called for budget-skipped messages or DLQ re-applies (the dashboard shows
   * DLQ inflow as outcome "dead" on the main queue). Must not throw.
   */
  record?: (sample: SyncMessageSample) => void;
}

export const defaultSyncDeps: SyncConsumerDeps = { applyBatch, projections };

/** Exponential backoff for a message on its `attempts`th delivery (1-based). */
export function retryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(SYNC_RETRY_BASE_SECONDS * 2 ** exponent, SYNC_RETRY_CAP_SECONDS);
}

/**
 * Applies one queue batch of ReplicationBatch messages to D1.
 *
 * - Each message is acked after it applies, or retried with exponential backoff.
 * - Once this invocation has spent SYNC_STATEMENT_BUDGET statements, the
 *   remaining messages are retried after a short delay without being applied.
 * - On the DLQ queue, a failure is logged at error level with its source and
 *   record count, and the message is retried after SYNC_DLQ_RETRY_SECONDS.
 */
export async function consumeSyncBatch(
  batch: MessageBatch<ReplicationBatch>,
  env: Pick<Env, "DB">,
  deps: SyncConsumerDeps = defaultSyncDeps,
): Promise<void> {
  const isDlq = batch.queue === SYNC_DLQ_QUEUE;
  let spent = 0;
  let budgetSpent = false;
  for (const msg of batch.messages) {
    const cost = msg.body.records.length + 1;
    if (budgetSpent || (spent > 0 && spent + cost > SYNC_STATEMENT_BUDGET)) {
      budgetSpent = true;
      msg.retry({ delaySeconds: SYNC_BUDGET_RETRY_SECONDS });
      continue;
    }
    spent += cost;
    const started = Date.now();
    const sample = (ok: boolean, rows: number): void => {
      if (isDlq || !deps.record) return;
      const now = Date.now();
      deps.record({
        source: typeof msg.body.source === "string" ? msg.body.source : "",
        records: msg.body.records.length,
        enqueuedAt: msg.timestamp instanceof Date ? msg.timestamp.getTime() : started,
        now,
        applyMs: now - started,
        attempts: msg.attempts,
        rows,
        ok,
        maxRetries: SYNC_MAX_RETRIES,
      });
    };
    try {
      const res = await deps.applyBatch(env.DB, msg.body, deps.projections);
      if (res.unknown > 0) console.warn("sync: records without projection", msg.body.source, res);
      sample(true, res.applied);
      msg.ack();
    } catch (err) {
      sample(false, 0);
      if (isDlq) {
        console.error("sync: DLQ apply failed", {
          source: msg.body.source,
          records: msg.body.records.length,
          attempts: msg.attempts,
          err,
        });
        msg.retry({ delaySeconds: SYNC_DLQ_RETRY_SECONDS });
      } else {
        console.error("sync: apply failed", msg.body.source, err);
        msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
      }
    }
  }
}

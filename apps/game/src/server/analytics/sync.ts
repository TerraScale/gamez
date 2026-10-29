/**
 * Sync consumer instrumentation (docs/design/admin-dashboard.md §2.7, §3):
 * one "sync.batch" point per queue message and one "d1.query" point labelled
 * "sync.apply". Called from the queue handler in server/index.ts before the
 * message is acked or retried, so it never changes that decision.
 */
import type { Analytics } from "./types.ts";

export type SyncOutcome = "ok" | "retry" | "dead";

export interface SyncMessageSample {
  /** body.source as sent (for example "character:<accountId>:classic"). */
  source: string;
  /** body.records.length. */
  records: number;
  /** message.timestamp (enqueue time), epoch ms. */
  enqueuedAt: number;
  /** Clock now, epoch ms. */
  now: number;
  /** Wall time of applyBatch, ms (also measured on failure). */
  applyMs: number;
  /** message.attempts. */
  attempts: number;
  /** Rows applied by D1 (0 on failure). */
  rows: number;
  /** True when applyBatch resolved (the message is acked). */
  ok: boolean;
  /** Failures at or past this many attempts are "dead" (sent to the DLQ). */
  maxRetries: number;
}

/**
 * The source blob: the prefix before the first ":" (for example "character",
 * "chat"). Bounded to the DO kinds the code creates. Empty becomes "unknown".
 */
export function syncSource(source: string): string {
  const cut = source.indexOf(":");
  const head = cut < 0 ? source : source.slice(0, cut);
  return head.length > 0 ? head : "unknown";
}

/**
 * Outcome of one delivery. A success is "ok". A failure is "dead" when this
 * delivery is the one that exhausts the retries (the message leaves the queue
 * for the DLQ), otherwise "retry".
 */
export function syncOutcome(ok: boolean, attempts: number, maxRetries: number): SyncOutcome {
  if (ok) return "ok";
  return attempts >= maxRetries ? "dead" : "retry";
}

/** Enqueue-to-apply lag in ms, clamped at 0 (queue and Worker clocks can disagree). */
export function syncLagMs(enqueuedAt: number, now: number): number {
  const lag = now - enqueuedAt;
  return Number.isFinite(lag) && lag > 0 ? lag : 0;
}

/** Writes "sync.batch" and "d1.query" (label "sync.apply") for one message. Never throws. */
export function recordSyncMessage(analytics: Analytics, s: SyncMessageSample): void {
  try {
    const outcome = syncOutcome(s.ok, s.attempts, s.maxRetries);
    analytics.write(
      "sync.batch",
      { source: syncSource(s.source), outcome },
      {
        records: s.records,
        lagMs: syncLagMs(s.enqueuedAt, s.now),
        applyMs: s.applyMs,
        attempts: s.attempts,
      },
    );
    analytics.write(
      "d1.query",
      { label: "sync.apply", outcome: s.ok ? "ok" : "error" },
      { ms: s.applyMs, rows: s.ok ? s.rows : 0 },
    );
  } catch {
    // Instrumentation never changes the ack or retry of the message.
  }
}

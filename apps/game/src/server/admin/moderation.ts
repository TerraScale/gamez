/**
 * Moderation queue read (wave-C.md §9.3). OWNER: T-admin. Groups the chat
 * reports (chat_report, written by the chat outbox) by the reported account.
 * Display only; mute and hide go through the wave B endpoints.
 */
import { isMissingTable } from "../leaderboards/read.ts";

export const MODERATION_ACCOUNTS_LIMIT = 100;
export const MODERATION_SAMPLES = 3;
/** Recent report rows read to build the samples and verdict tallies. */
export const MODERATION_ROW_LIMIT = 1000;

export interface ModerationSample {
  channel: string | null;
  messageId: string | null;
  reason: string | null;
  text: string | null;
  at: number;
  verdict: string | null;
}

export interface ModerationAccount {
  accountId: string;
  /** All reports against this account. */
  reports: number;
  /** Reports without a verdict yet. */
  open: number;
  lastAt: number;
  /** Newest reports (up to MODERATION_SAMPLES). */
  samples: ModerationSample[];
  /** Verdict -> count over the recent reports read (null verdict counted as "open"). */
  verdicts: Record<string, number>;
}

export interface ModerationResponse {
  at: number;
  accounts: ModerationAccount[];
}

interface GroupRow {
  accountId: string;
  reports: number;
  open: number;
  lastAt: number;
}

interface ReportRow {
  accountId: string;
  channel: string | null;
  messageId: string | null;
  reason: string | null;
  text: string | null;
  at: number;
  verdict: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Accounts with reports, newest report first. A missing table answers an empty queue. */
export async function readModeration(db: D1Database, now: number): Promise<ModerationResponse> {
  try {
    const groups = (
      await db
        .prepare(
          `SELECT reported_id AS accountId, COUNT(*) AS reports,
                  SUM(CASE WHEN verdict IS NULL OR verdict = '' THEN 1 ELSE 0 END) AS open,
                  MAX(at) AS lastAt
           FROM chat_report
           WHERE _deleted = 0 AND reported_id IS NOT NULL AND reported_id <> ''
           GROUP BY reported_id
           ORDER BY lastAt DESC
           LIMIT ?`,
        )
        .bind(MODERATION_ACCOUNTS_LIMIT)
        .all<GroupRow>()
    ).results;
    if (groups.length === 0) return { at: now, accounts: [] };

    const ids = groups.map((g) => g.accountId);
    const marks = ids.map(() => "?").join(", ");
    const rows = (
      await db
        .prepare(
          `SELECT reported_id AS accountId, channel, message_id AS messageId, reason, text,
                  at, verdict
           FROM chat_report
           WHERE _deleted = 0 AND reported_id IN (${marks})
           ORDER BY at DESC
           LIMIT ${MODERATION_ROW_LIMIT}`,
        )
        .bind(...ids)
        .all<ReportRow>()
    ).results;

    const byAccount = new Map<string, ModerationAccount>();
    for (const g of groups) {
      byAccount.set(g.accountId, {
        accountId: g.accountId,
        reports: Number(g.reports) || 0,
        open: Number(g.open) || 0,
        lastAt: Number(g.lastAt) || 0,
        samples: [],
        verdicts: {},
      });
    }
    for (const r of rows) {
      const acc = byAccount.get(r.accountId);
      if (!acc) continue;
      const verdict = str(r.verdict) ?? "";
      const key = verdict === "" ? "open" : verdict;
      acc.verdicts[key] = (acc.verdicts[key] ?? 0) + 1;
      if (acc.samples.length < MODERATION_SAMPLES) {
        acc.samples.push({
          channel: str(r.channel),
          messageId: str(r.messageId),
          reason: str(r.reason),
          text: str(r.text),
          at: Number(r.at) || 0,
          verdict: str(r.verdict),
        });
      }
    }
    return { at: now, accounts: [...byAccount.values()] };
  } catch (err) {
    if (!isMissingTable(err)) console.error("admin: moderation query failed", err);
    return { at: now, accounts: [] };
  }
}

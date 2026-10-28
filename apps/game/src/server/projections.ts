import type { Projection, ProjectionMap, SqlValue } from "@gamez/sync";
import type {
  AccountSummaryPayload,
  CharacterSummary,
  ChatReportPayload,
  GuildIndexPayload,
  ReportEnvelope,
} from "./contracts.ts";

/**
 * D1 read-model projections (tables live in migrations/). CONTRACT (wave B):
 * table and column names are fixed by migrations 0002-0005; builders report
 * needed changes instead of editing (a new column needs a new migration).
 */
export const characterSummary: Projection<CharacterSummary> = {
  table: "character_summary",
  pkColumn: "character_id",
  toRow: (p) => ({
    account_id: p.accountId,
    mode: p.mode,
    name: p.name,
    x: p.x,
    y: p.y,
  }),
};

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const flag = (v: unknown): number => (v === true || v === 1 ? 1 : 0);

function envelopeColumns(p: ReportEnvelope): Record<string, SqlValue> {
  return {
    account_id: p.accountId,
    display_name: p.displayName,
    mode: p.mode,
    imported: p.imported ? 1 : 0,
  };
}

/**
 * Classic hero summary, from the classic ClientDrivenPolicy.reports() row
 * { table: "classic_hero", key: "hero", data: ClassicHeroReport }.
 */
export const classicHero: Projection<ReportEnvelope> = {
  table: "classic_hero",
  pkColumn: "id",
  toRow: (p) => ({
    ...envelopeColumns(p),
    hero_name: str(p.data.heroName),
    class_id: str(p.data.classId),
    level: num(p.data.level),
    xp: num(p.data.xp),
    deepest_depth: num(p.data.deepestDepth),
    rift_best_level: num(p.data.riftBestLevel),
    rift_best_score: num(p.data.riftBestScore),
    play_ticks: num(p.data.playTicks),
    kills: num(p.data.kills),
    deaths: num(p.data.deaths),
  }),
};

/** One rift run, from { table: "leaderboard_rift", key: "run:<n>", data: ClassicRiftReport }. */
export const leaderboardRift: Projection<ReportEnvelope> = {
  table: "leaderboard_rift",
  pkColumn: "id",
  toRow: (p) => ({
    ...envelopeColumns(p),
    hero_name: str(p.data.heroName),
    class_id: str(p.data.classId),
    hero_level: num(p.data.heroLevel),
    rift_level: num(p.data.riftLevel),
    score: num(p.data.score),
    ticks: num(p.data.ticks),
    deaths: num(p.data.deaths),
    completed: flag(p.data.completed),
    run: num(p.data.run),
    end_tick: num(p.data.endTick),
  }),
};

export const accountSummary: Projection<AccountSummaryPayload> = {
  table: "account_summary",
  pkColumn: "account_id",
  toRow: (p) => ({ display_name: p.displayName, kind: p.kind, created_at: p.createdAt }),
};

export const guildIndex: Projection<GuildIndexPayload> = {
  table: "guild_index",
  pkColumn: "guild_id",
  toRow: (p) => ({
    name: p.name,
    tag: p.tag,
    open: p.open ? 1 : 0,
    member_count: p.memberCount,
    leader_id: p.leaderId,
    created_at: p.createdAt,
  }),
};

export const chatReport: Projection<ChatReportPayload> = {
  table: "chat_report",
  pkColumn: "id",
  toRow: (p) => ({
    channel: p.channel,
    message_id: p.messageId,
    reporter_id: p.reporterId,
    reported_id: p.reportedId,
    reason: p.reason,
    text: p.text,
    at: p.at,
    verdict: p.verdict,
  }),
};

export const projections: ProjectionMap = {
  [characterSummary.table]: characterSummary,
  [classicHero.table]: classicHero,
  [leaderboardRift.table]: leaderboardRift,
  [accountSummary.table]: accountSummary,
  [guildIndex.table]: guildIndex,
  [chatReport.table]: chatReport,
};

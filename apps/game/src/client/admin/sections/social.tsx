/**
 * Admin section "Social" (docs/design/admin-dashboard.md §2.6, §10.3). OWNER: T-ui-sections-b.
 * Chat volume and blocks, moderation (the wave C queue with mute and hide),
 * guilds, and three top-10 leaderboards.
 */
import { useState } from "react";
import type { AdminSocial, Distribution, Series } from "@gamez/protocol";
import type { ModerationResponse } from "../../../server/admin/moderation.ts";
import { ModerationPanel } from "../dashboard.tsx";
import {
  DataTable,
  DistributionChart,
  Panel,
  SourcesNote,
  StatTile,
  TimeSeriesChart,
  defineSection,
} from "../kit/index.tsx";
import type { DataColumn, SectionContext } from "../kit/index.tsx";

export interface SocialSectionData {
  social: AdminSocial;
  moderation: ModerationResponse;
}

type LeaderRow = AdminSocial["leaderboards"]["level"][number];

export const socialSection = defineSection<SocialSectionData>({
  id: "social",
  label: "Social",
  group: "Players",
  load: async (ctx) => {
    const [social, moderation] = await Promise.all([
      ctx.get<AdminSocial>(`/api/admin/social?${ctx.query}`),
      ctx.get<ModerationResponse>("/api/admin/moderation"),
    ]);
    if (!social.ok) return social;
    if (!moderation.ok) return moderation;
    return { ok: true, value: { social: social.value, moderation: moderation.value } };
  },
  Component: ({ data, ctx }) =>
    data ? <SocialView data={data} ctx={ctx} /> : <p className="adm-muted">Loading social…</p>,
});

/** Mute an account in a channel for 60 minutes (wave B endpoint, via the admin proxy). */
export async function muteAccount(
  ctx: SectionContext,
  channel: string,
  accountId: string,
): Promise<void> {
  const res = await ctx.post<{ ok: boolean; until: number }>("/api/admin/mute", {
    channel,
    accountId,
    minutes: 60,
  });
  if (res.ok) {
    ctx.setStatus(`Muted ${accountId} in ${channel} for 60 minutes.`);
    ctx.reload();
  } else {
    ctx.setStatus(res.message);
  }
}

/** Hide one chat message (wave B endpoint, via the admin proxy). */
export async function hideMessage(
  ctx: SectionContext,
  channel: string,
  messageId: string,
): Promise<void> {
  const res = await ctx.post<{ ok: boolean; hidden: number }>("/api/admin/hide", {
    channel,
    ids: [messageId],
  });
  if (res.ok) {
    ctx.setStatus("Message hidden.");
    ctx.reload();
  } else {
    ctx.setStatus(res.message);
  }
}

function hasData(dist: Distribution): boolean {
  return dist.buckets.some((b) => b.value > 0);
}

function seriesHasData(series: Series[]): boolean {
  return series.some((s) => s.points.some((p) => p.v > 0));
}

function Empty() {
  return <p className="adm-muted">No data in this range yet.</p>;
}

function DistPanel({
  title,
  hint,
  dist,
  csvName,
}: {
  title: string;
  hint?: string;
  dist: Distribution;
  csvName: string;
}) {
  return (
    <Panel title={title} hint={hint}>
      {hasData(dist) ? <DistributionChart dist={dist} csvName={csvName} /> : <Empty />}
    </Panel>
  );
}

/** The wave C moderation queue, with busy state around each action. */
function ModerationBlock({
  moderation,
  ctx,
}: {
  moderation: ModerationResponse;
  ctx: SectionContext;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModerationPanel
      moderation={moderation}
      busy={busy}
      onMute={(accountId, channel) => {
        void run(() => muteAccount(ctx, channel, accountId));
      }}
      onHide={(channel, messageId) => {
        void run(() => hideMessage(ctx, channel, messageId));
      }}
    />
  );
}

const LEADER_COLUMNS: DataColumn<LeaderRow>[] = [
  { key: "name", label: "Name", value: (r) => r.name },
  { key: "classId", label: "Class", value: (r) => r.classId },
  { key: "value", label: "Value", value: (r) => r.value, align: "right" },
];

/**
 * Player links for leaderboard rows that carry an accountId. The table cells
 * stay plain text (the kit cannot render links); the links sit under the table.
 */
function LeaderLinks({ rows, ctx }: { rows: LeaderRow[]; ctx: SectionContext }) {
  const linkable = rows.flatMap((r) => {
    const id = r.accountId;
    return id ? [{ name: r.name || id, id }] : [];
  });
  if (linkable.length === 0) return null;
  return (
    <div className="adm-row" aria-label="Open player">
      {linkable.map((l) => (
        <button key={l.id} type="button" onClick={() => ctx.openPlayer(l.id)}>
          Open {l.name}
        </button>
      ))}
    </div>
  );
}

function Leaderboard({
  title,
  rows,
  csvName,
  ctx,
}: {
  title: string;
  rows: LeaderRow[];
  csvName: string;
  ctx: SectionContext;
}) {
  return (
    <Panel title={title} hint="Top 10.">
      {rows.length > 0 ? (
        <>
          <DataTable caption={title} columns={LEADER_COLUMNS} rows={rows} csvName={csvName} />
          <LeaderLinks rows={rows} ctx={ctx} />
        </>
      ) : (
        <Empty />
      )}
    </Panel>
  );
}

function SocialView({ data, ctx }: { data: SocialSectionData; ctx: SectionContext }) {
  const s = data.social;
  const bucketMs = s.range.bucketMs;
  const hasChat = seriesHasData(s.chat.series);
  return (
    <>
      <SourcesNote sources={s.sources} />

      <Panel title="Chat" hint="Chat messages sent and blocked in the range.">
        <div className="adm-tiles" aria-label="Chat totals">
          <StatTile label="Messages" value={s.chat.messages} />
          <StatTile
            label="Blocked"
            value={s.chat.blocked}
            status={s.chat.blocked > 0 ? "warning" : undefined}
          />
        </div>
        {hasChat ? (
          <TimeSeriesChart
            title="Chat per bucket"
            series={s.chat.series}
            kind="line"
            bucketMs={bucketMs}
            csvName="social-chat"
            emptyText="No chat in this range."
          />
        ) : (
          <Empty />
        )}
      </Panel>
      <DistPanel title="Chat by channel" dist={s.chat.byChannel} csvName="social-chat-channel" />

      <Panel title="Moderation" hint="Open reports, reports in the range and actions taken.">
        <div className="adm-tiles" aria-label="Moderation totals">
          <StatTile
            label="Open reports"
            value={s.moderation.open}
            status={s.moderation.open > 0 ? "warning" : "good"}
          />
          <StatTile label="Reports in range" value={s.moderation.reports} />
        </div>
      </Panel>
      <div className="adm-grid two">
        <DistPanel
          title="Moderation actions"
          dist={s.moderation.actions}
          csvName="social-mod-actions"
        />
        <Panel title="Reports per bucket">
          {seriesHasData(s.moderation.series) ? (
            <TimeSeriesChart
              title="Reports per bucket"
              series={s.moderation.series}
              kind="bar"
              bucketMs={bucketMs}
              csvName="social-mod-series"
              emptyText="No reports in this range."
            />
          ) : (
            <Empty />
          )}
        </Panel>
      </div>
      <ModerationBlock moderation={data.moderation} ctx={ctx} />

      <Panel title="Guilds" hint="Guilds that still exist.">
        <div className="adm-tiles" aria-label="Guild totals">
          <StatTile label="Guilds" value={s.guilds.count} />
          <StatTile label="Members" value={s.guilds.members} />
        </div>
      </Panel>
      <DistPanel
        title="Guild size histogram"
        dist={s.guilds.sizeHistogram}
        csvName="social-guild-size"
      />

      <div className="adm-grid two">
        <Leaderboard
          title="Top levels"
          rows={s.leaderboards.level}
          csvName="social-top-level"
          ctx={ctx}
        />
        <Leaderboard
          title="Top rifts"
          rows={s.leaderboards.rift}
          csvName="social-top-rift"
          ctx={ctx}
        />
      </div>
      <Leaderboard
        title="Top arena ratings"
        rows={s.leaderboards.arena}
        csvName="social-top-arena"
        ctx={ctx}
      />
    </>
  );
}

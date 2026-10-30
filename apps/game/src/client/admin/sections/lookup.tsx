/**
 * Admin section "Player lookup" (docs/design/admin-dashboard.md §2.8, §10.3). OWNER: T-ui-sections-a.
 * Loads by itself (load null). Search: debounced 300 ms against
 * GET /api/admin/players/search; a row opens GET /api/admin/players/<id>.
 * Support actions are the existing ones only: mute in a channel
 * (POST /api/admin/mute, 60 minutes, confirm step).
 *
 * Opening on an account: the shell's deep link passes no arg to the section
 * component, so `LookupView` takes `initialAccountId` and can be mounted by
 * whoever knows the account (the default export opens with none).
 */
import { useEffect, useRef, useState } from "react";
import type {
  AdminPlayerDetail,
  AdminPlayerRow,
  AdminPlayerSearch,
  AdminSourceKind,
} from "@gamez/protocol";
import { MUTE_MINUTES } from "../api.ts";
import {
  DataTable,
  defineSection,
  DistributionChart,
  Panel,
  SourcesNote,
  StatTile,
  type DataColumn,
  type SectionContext,
  adminRouteArg,
} from "../kit/index.tsx";

export const SEARCH_DEBOUNCE_MS = 300;
export const DEFAULT_MUTE_CHANNEL = "global";

/** `/api/admin/players/search?q=<q>[&cursor=<cursor>]`. An empty q lists the newest accounts. */
export function lookupSearchUrl(q: string, cursor?: string | null): string {
  const base = `/api/admin/players/search?q=${encodeURIComponent(q.trim())}`;
  return cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
}

/** `/api/admin/players/<accountId>?<range query>`. */
export function playerDetailUrl(accountId: string, query: string): string {
  return `/api/admin/players/${encodeURIComponent(accountId)}?${query}`;
}

/** UTC "YYYY-MM-DD HH:MM", or "–" for 0 / invalid times. */
export function formatWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "–";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

interface SearchState {
  rows: AdminPlayerRow[];
  next: string | null;
  status: "loading" | "ready" | "error";
  error?: string;
}

interface DetailState {
  status: "idle" | "loading" | "ready" | "error";
  detail?: AdminPlayerDetail;
  error?: string;
}

export function LookupView({
  ctx,
  initialAccountId = null,
}: {
  ctx: SectionContext;
  initialAccountId?: string | null;
}) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState<SearchState>({ rows: [], next: null, status: "loading" });
  const [selected, setSelected] = useState<string | null>(initialAccountId);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  const generation = useRef(0);

  useEffect(() => {
    if (initialAccountId) setSelected(initialAccountId);
  }, [initialAccountId]);

  // Debounced search. Each run bumps the generation so late answers are dropped.
  useEffect(() => {
    const mine = ++generation.current;
    setSearch((s) => ({ ...s, status: "loading" }));
    const timer = setTimeout(() => {
      void ctx.get<AdminPlayerSearch>(lookupSearchUrl(input)).then((r) => {
        if (mine !== generation.current) return;
        setSearch(
          r.ok
            ? { rows: r.value.rows, next: r.value.next, status: "ready" }
            : { rows: [], next: null, status: "error", error: r.message },
        );
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, ctx.token]);

  // Detail of the selected account, refetched when the range changes.
  useEffect(() => {
    if (!selected) {
      setDetail({ status: "idle" });
      return;
    }
    let live = true;
    setDetail({ status: "loading" });
    void ctx.get<AdminPlayerDetail>(playerDetailUrl(selected, ctx.query)).then((r) => {
      if (!live) return;
      setDetail(
        r.ok ? { status: "ready", detail: r.value } : { status: "error", error: r.message },
      );
    });
    return () => {
      live = false;
    };
  }, [selected, ctx.query, ctx.token]);

  const loadMore = async () => {
    if (!search.next) return;
    const mine = generation.current;
    const r = await ctx.get<AdminPlayerSearch>(lookupSearchUrl(input, search.next));
    if (mine !== generation.current) return;
    if (r.ok) {
      setSearch((s) => ({
        rows: [...s.rows, ...r.value.rows],
        next: r.value.next,
        status: "ready",
      }));
    } else {
      ctx.setStatus(`Could not load more results: ${r.message}`);
    }
  };

  return (
    <div className="adm-grid">
      <Panel
        title="Find a player"
        hint="Search by account id (prefix) or display name. Empty search lists the newest accounts."
        wide
      >
        <label htmlFor="adm-lookup-q">Account id or name</label>
        <div>
          <input
            id="adm-lookup-q"
            type="search"
            value={input}
            placeholder="e.g. a1b2 or Morrow"
            autoComplete="off"
            onChange={(e) => setInput(e.target.value)}
            style={{ minHeight: 44, width: "100%", maxWidth: 420, boxSizing: "border-box" }}
          />
        </div>
        <SearchResults
          search={search}
          onOpen={(id) => setSelected(id)}
          onMore={() => void loadMore()}
        />
      </Panel>
      {selected ? (
        <DetailPanel
          accountId={selected}
          detail={detail}
          ctx={ctx}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function SearchResults({
  search,
  onOpen,
  onMore,
}: {
  search: SearchState;
  onOpen: (accountId: string) => void;
  onMore: () => void;
}) {
  if (search.status === "loading" && search.rows.length === 0) {
    return (
      <p className="adm-muted" role="status">
        Searching…
      </p>
    );
  }
  if (search.status === "error") {
    return (
      <p role="alert" className="adm-muted">
        Search failed: {search.error ?? "try again"}
      </p>
    );
  }
  if (search.rows.length === 0) {
    return <p className="adm-muted">No accounts match.</p>;
  }
  return (
    <div>
      <div className="adm-table-wrap">
        <table>
          <caption>Accounts ({search.rows.length} shown)</caption>
          <thead>
            <tr>
              <th>Name</th>
              <th>Account</th>
              <th>Kind</th>
              <th>Created</th>
              <th>Last active</th>
              <th>
                <span className="adm-muted">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {search.rows.map((r) => (
              <tr key={r.accountId}>
                <td>{r.displayName || "(no name)"}</td>
                <td className="adm-mono">{r.accountId}</td>
                <td>{r.kind}</td>
                <td>{formatWhen(r.createdAt)}</td>
                <td>{formatWhen(r.lastActiveDay)}</td>
                <td>
                  <button
                    type="button"
                    style={{ minHeight: 44, minWidth: 44 }}
                    aria-label={`Open ${r.displayName || r.accountId}`}
                    onClick={() => onOpen(r.accountId)}
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {search.next ? (
        <button type="button" style={{ minHeight: 44, marginTop: 8 }} onClick={onMore}>
          Load more
        </button>
      ) : null}
    </div>
  );
}

function DetailPanel({
  accountId,
  detail,
  ctx,
  onClose,
}: {
  accountId: string;
  detail: DetailState;
  ctx: SectionContext;
  onClose: () => void;
}) {
  return (
    <Panel title="Player detail" hint={`Account ${accountId}`} wide>
      <button type="button" style={{ minHeight: 44, marginBottom: 12 }} onClick={onClose}>
        Back to results
      </button>
      {detail.status === "loading" || detail.status === "idle" ? (
        <p className="adm-muted" role="status">
          Loading player…
        </p>
      ) : null}
      {detail.status === "error" ? (
        <p role="alert" className="adm-muted">
          Could not load this player: {detail.error ?? "try again"}
        </p>
      ) : null}
      {detail.status === "ready" && detail.detail ? (
        <AccountDetail detail={detail.detail} ctx={ctx} />
      ) : null}
    </Panel>
  );
}

const HERO_COLUMNS: readonly DataColumn<AdminPlayerDetail["heroes"][number]>[] = [
  { key: "mode", label: "Mode", value: (h) => h.mode },
  { key: "hero", label: "Hero", value: (h) => h.heroName },
  { key: "class", label: "Class", value: (h) => h.classId },
  { key: "level", label: "Level", value: (h) => h.level, format: "int", align: "right" },
  { key: "depth", label: "Deepest", value: (h) => h.deepestDepth, format: "int", align: "right" },
  { key: "kills", label: "Kills", value: (h) => h.kills, format: "int", align: "right" },
  { key: "deaths", label: "Deaths", value: (h) => h.deaths, format: "int", align: "right" },
  { key: "play", label: "Play time", value: (h) => h.playHours, format: "h", align: "right" },
  { key: "updated", label: "Updated", value: (h) => formatWhen(h.updatedAt) },
];

const LEDGER_COLUMNS: readonly DataColumn<AdminPlayerDetail["ledger"][number]>[] = [
  { key: "at", label: "When", value: (l) => formatWhen(l.at) },
  { key: "currency", label: "Currency", value: (l) => l.currency },
  { key: "amount", label: "Amount", value: (l) => l.amount, format: "int", align: "right" },
  { key: "flow", label: "Flow", value: (l) => l.flow },
  { key: "reason", label: "Reason", value: (l) => l.reason },
];

const PURCHASE_COLUMNS: readonly DataColumn<AdminPlayerDetail["purchases"][number]>[] = [
  { key: "at", label: "When", value: (p) => formatWhen(p.at) },
  { key: "sku", label: "SKU", value: (p) => p.sku },
  { key: "provider", label: "Provider", value: (p) => p.provider },
  {
    key: "amount",
    label: "Amount",
    value: (p) => `${p.currency} ${(p.amountMinor / 100).toFixed(2)}`,
    align: "right",
  },
  { key: "status", label: "Status", value: (p) => p.status },
  { key: "reason", label: "Reason", value: (p) => p.failReason ?? "" },
];

const SOURCE_WORD: Record<AdminSourceKind, string> = {
  d1: "D1 read model",
  ae: "Analytics Engine",
  local: "local stub",
  live: "live (AccountDO)",
};

/** Presentational account card, tables and support actions (no fetching besides the mute). */
export function AccountDetail({ detail, ctx }: { detail: AdminPlayerDetail; ctx: SectionContext }) {
  const a = detail.account;
  return (
    <div className="adm-grid">
      <SourcesNote sources={detail.sources} />
      <section aria-label="Account" className="adm-tiles">
        <StatTile label="Name" value={a.displayName || "(no name)"} hint={a.kind} />
        <StatTile label="Created" value={formatWhen(a.createdAt)} />
        <StatTile
          label="Registered"
          value={a.registeredAt ? formatWhen(a.registeredAt) : "–"}
          hint={a.registeredAt ? undefined : "no date (before migration 0010 or guest)"}
        />
        <StatTile label="Last active" value={formatWhen(a.lastActiveDay)} />
        <StatTile label="Days active, last 30" value={detail.activeDays30} format="int" />
      </section>
      <section aria-label="Wallet" className="adm-tiles">
        <StatTile
          label="Coin"
          value={detail.wallet.coin}
          format="int"
          hint={`source: ${SOURCE_WORD[detail.wallet.source] ?? detail.wallet.source}`}
        />
        <StatTile label="Gems" value={detail.wallet.gem} format="int" />
        <StatTile
          label="Reports against"
          value={detail.reports.against}
          hint={`${detail.reports.open} open`}
        />
        <StatTile
          label="Guild"
          value={detail.guild ? detail.guild.name : "–"}
          hint={detail.guild ? detail.guild.guildId : "none or unreachable"}
        />
        <StatTile
          label="Arena"
          value={detail.arena ? detail.arena.rating : "–"}
          hint={
            detail.arena
              ? `${detail.arena.seasonId} · ${detail.arena.wins}W ${detail.arena.losses}L`
              : "not rated this season"
          }
        />
      </section>
      <Panel title="Heroes" hint="Classic runs (play time = ticks / 20 / 3600).">
        <DataTable
          caption="Heroes"
          columns={[...HERO_COLUMNS]}
          rows={detail.heroes}
          csvName="player-heroes"
        />
      </Panel>
      <Panel title="Ledger" hint="Last 50 economy entries, newest first.">
        <DataTable
          caption="Ledger"
          columns={[...LEDGER_COLUMNS]}
          rows={detail.ledger}
          csvName="player-ledger"
        />
      </Panel>
      <Panel title="Purchases" hint="Last 50 purchases, newest first.">
        <DataTable
          caption="Purchases"
          columns={[...PURCHASE_COLUMNS]}
          rows={detail.purchases}
          csvName="player-purchases"
        />
      </Panel>
      <Panel title="Recent events" hint="Server events of this account in the range, by metric.">
        <DistributionChart dist={detail.recent} format="int" share csvName="player-recent" />
      </Panel>
      <MutePanel accountId={a.accountId} name={a.displayName} ctx={ctx} />
    </div>
  );
}

/** Mute in a channel for MUTE_MINUTES (existing endpoint), with a confirm step. */
export function MutePanel({
  accountId,
  name,
  ctx,
}: {
  accountId: string;
  name: string;
  ctx: SectionContext;
}) {
  const [channel, setChannel] = useState(DEFAULT_MUTE_CHANNEL);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const cleanChannel = channel.trim();
  const canAsk = cleanChannel.length > 0 && !busy;

  const confirm = async () => {
    setBusy(true);
    const r = await ctx.post<{ ok: true; until: number }>("/api/admin/mute", {
      channel: cleanChannel,
      accountId,
      minutes: MUTE_MINUTES,
    });
    setBusy(false);
    setAsking(false);
    if (r.ok) {
      ctx.setStatus(`Muted ${name || accountId} in ${cleanChannel} for ${MUTE_MINUTES} minutes.`);
    } else {
      ctx.setStatus(`Mute failed: ${r.message}`);
    }
  };

  return (
    <Panel title="Support actions" hint="Mute uses the existing moderation endpoint.">
      <div className="adm-row">
        <label htmlFor="adm-mute-channel">Channel</label>
        <input
          id="adm-mute-channel"
          type="text"
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
            setAsking(false);
          }}
          style={{ minHeight: 44, minWidth: 160 }}
        />
        {asking ? (
          <div className="adm-confirm" role="group" aria-label="Confirm mute">
            <p>
              Mute {name || accountId} in {cleanChannel} for {MUTE_MINUTES} minutes?
            </p>
            <div className="adm-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="adm-danger"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy ? "Muting…" : `Confirm: mute ${MUTE_MINUTES} min`}
              </button>
              <button type="button" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={!canAsk}
            style={{ minHeight: 44 }}
            onClick={() => setAsking(true)}
          >
            Mute for {MUTE_MINUTES} min…
          </button>
        )}
      </div>
    </Panel>
  );
}

export const lookupSection = defineSection<null>({
  id: "lookup",
  label: "Player lookup",
  group: "Players",
  load: null,
  // The shell writes #admin/lookup/<id> before mounting and remounts on a new id.
  Component: ({ ctx }) => <LookupView ctx={ctx} initialAccountId={adminRouteArg("lookup")} />,
});

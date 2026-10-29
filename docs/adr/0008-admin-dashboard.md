# ADR 0008: Admin dashboard: Analytics Engine + D1 read model + a local stub

- Status: accepted (admin dashboard)
- Date: 2026-10-28

The wave C live-ops page (ADR 0006 §9) becomes a dashboard of nine sections: overview, players,
player lookup, social, gameplay, economy, monetization, tech health, and flags & config. The
contract, metric definitions and ownership are in
[`docs/design/admin-dashboard.md`](../design/admin-dashboard.md). This ADR records the decisions
and what is still unverified.

## 1. Two stores, chosen per number

- **High-volume events go to Workers Analytics Engine.** That covers HTTP requests, sockets, DO
  activity, sync batches, chat, moderation, client telemetry and verified sim tallies. There is one
  dataset, `gamez_events`, and its column layout is fixed per metric (`analytics/schema.ts`). Writes
  are fire-and-forget and add no request latency. Every query weights by `_sample_interval`, so
  AE's adaptive sampling does not bias counts, sums or quantiles.
- **Exact business numbers come from the D1 read model** through the existing outbox (ADR 0002).
  That covers accounts, daily activity, purchases, the ledger, heroes and the battle pass. Migration
  0010 adds `account_activity` (one row per account per UTC day), `pass_progress` and
  `account_summary.registered_at`. Gameplay never reads them.
- **Live DO RPC** is used only for one player's wallet and guild in lookup. It is called only after
  the account's D1 summary exists, so lookup never creates a DO.

Rejected alternatives: D1 for raw events (write amplification on a single SQLite, and no sampling),
and an external analytics SaaS (PII and a third party in the request path).

## 2. Local dev reads a MetricsDO stub through the same interface

There are no AE SQL credentials locally (undeclared secrets do not reach `env`, docs/secrets.md).
Points therefore also go to a per-isolate buffer that flushes to `MetricsDO "local"`. The flush
happens at 50 points, on `flush()`, and 100 ms after the first buffered point. The stub serves the
same `AnalyticsQuery` shapes over SQLite and keeps 14 days and at most 200 000 rows, using indexes
`(b1,t)`, `(idx,t)` and `(t)`; the last keeps pruning cheap. Above 200 points/s per isolate it
samples 1-in-N with weight N.

`POST /api/dev/admin/seed-metrics` (dev hosts and admins only) writes deterministic synthetic
points, each with an index starting `seed`, so `reset=1` removes only seeds. Every section shows
its sources as chips ("D1", "local stub", "Analytics Engine", "live"), so stub data is never
mistaken for production data.

**Unverified:** the AE SQL dialect (`FORMAT JSON`, `GROUP BY` on aliases, `toDateTime(int)`,
`intDiv(toUInt32(timestamp), S) * S`, `quantileExactWeighted`, 64-bit numbers returned as strings)
is pinned by unit tests against recorded SQL strings and a fake fetch only. It has to be checked
once with real `ANALYTICS_ACCOUNT_ID` / `ANALYTICS_API_TOKEN`.

## 3. Gameplay metrics come from verified segments only

Kills, deaths, bosses, quests, drops, casts, play time and XP/gold rates are folded **on the
server** while it replays verified segments. The kernel `replaySegment` gets an `onEvents` observer,
`SimTally` buffers the events, and `ModeAnalytics.fold` turns them into keys. A segment that fails
verification contributes nothing. Offline grants are a separate `sim.offline` point and are kept
out of the per-hour rates, so XP/h measures online play only.

`ModeAnalytics` is pure, server-only and outside `contentHash`, and a mode opts in through
`ClientDrivenPolicy.analytics`. Counters live in memory per instance, so a DO eviction loses at
most 5 minutes of counters (`due()`). That is acceptable for analytics, and the UI says so.

Additions to the §3 table, made while building: `verify.segments` and `verify.resyncs` (counts per
outcome or code, because the aggregated `verify.*` points cannot be counted with `count`), depth
_bands_ for `death` and the boss metrics, the class id as k2 of `level`, and positive amounts only
for `gold`.

## 4. Client telemetry is anonymous and bounded

`POST /api/telemetry` accepts batches keyed by a random id per page load, never an account id. It
carries session start, heartbeat and end events, perf for 25 % of sessions (fps p50/p95 from a
preallocated 600-frame ring), and normalised errors capped at 5 per minute. The server enforces a
per-IP token bucket (hashed IP, never stored), 8 KB and 20 events per request. Country and
continent come from `request.cf` only. A valid token touches the account's activity day at most
once an hour per isolate, which is how DAU counts guests.

## 5. Admin API: per-section endpoints, cached, sources listed

The endpoints are `GET /api/admin/<section>` (`overview`, `players`, `gameplay`,
`economy/details`, `monetization`, `social`, `tech`), plus player search/detail and the tunables
GET/POST. All are admin-only through `requireAdmin` (`ADMIN_ACCOUNT_IDS`, or dev admins on dev
hosts) and take a range of `from`, `to` and `bucket`, clamped to 90 days and 400 buckets.

Each isolate caches responses for 30 s, and `fresh=1` bypasses the cache. A failed source never
fails the request: the section returns empty data and marks that source `ok: false`. The wave C
endpoints are unchanged.

## 6. Tunables next to the flags

ConfigDO stores numeric tunables (`TUNABLES` in protocol `admin.ts`) beside the feature flags,
along with an audit trail. Writes are validated strictly on the route and clamped and step-rounded
in the store. The first tunable is `classic.offlineXpPct` (0..100, default 20). The verified host
reads it from the config when granting offline progress (`classicOfflinePayload`), so the admin
control changes the XP an idle hero earns while away.

## 7. UI: hand-rolled SVG, no chart library

The kit is about 1 500 lines: tiles, line, bar and stacked time series, distributions, funnels and
sortable tables with CSV export. It uses pixel-unit SVG, colour tokens with dark and light
variants, and status shown as an icon plus a word. The wave C charts had already proved the
pattern, and a chart library would cost more than the kit on the 375 px phone budget for no
feature we need.

Deep links use `#admin/<section>[/<arg>]`. The preferences (section, range, refresh, theme) live
in localStorage behind try/catch.

## 8. Populations are chosen so ratios stay within bounds (after QA)

Ratios divide numbers from different tables, so each denominator is defined to contain its
numerator: ARPU uses active accounts UNION payers (ARPPU ≥ ARPU), pass conversion uses pass players
UNION premium holders, and premium holders include paid premium purchases as well as
`pass_progress.premium` (conversion ≤ 1). Series that depend on a read model which started recording
recently (account_activity) begin at its first day instead of showing zeros. Details and tests:
design §14 "Fixes after the QA round".

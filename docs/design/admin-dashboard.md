# Admin dashboard: every number about the game

- Status: built and integrated (ADR 0008). §14 lists what changed while building and what is still open
- Extends wave C live ops (ADR 0006 §9, `docs/design/wave-C.md` §9). Nothing there is replaced:
  `GET /api/admin/{me,economy,flags,moderation}`, `POST /api/admin/{flags,mute,hide}`,
  `POST /api/dev/admin/self`, `GET /api/config` keep their shapes and behaviour.

The dashboard answers four questions: who plays (players), what they do (gameplay, economy,
monetization, social), whether the platform is healthy (tech) and what we can change (player
lookup, flags, tunables). This document is the contract for the parallel builders: the metric
catalogue with exact definitions, where each number is stored, the event schemas, the API, the UI,
privacy, sampling and rate limits, the local-dev story, and the test plan.

---

## 0. Decisions in one screen

| Decision                     | Choice                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| High-volume events           | **Workers Analytics Engine**, one dataset `gamez_events`, fixed column layout per metric (`analytics/schema.ts`)                                                                                                         |
| Exact business aggregates    | **D1 read model** through the existing outbox (accounts, activity, purchases, ledger, heroes, pass)                                                                                                                      |
| Live state                   | **DO RPC** at read time, only for one player in lookup (wallet, guild)                                                                                                                                                   |
| Querying AE                  | AE SQL API with `ANALYTICS_ACCOUNT_ID` + `ANALYTICS_API_TOKEN` (optional secrets)                                                                                                                                        |
| Local dev                    | **MetricsDO "local"**: same columns in DO SQLite, written automatically when the AE SQL credentials are absent; same `AnalyticsQuery` interface; dev-only seeder for synthetic points                                    |
| Client telemetry             | `POST /api/telemetry`, batched, random per-load session id, perf sampled 25 %, session/error events unsampled, per-IP token bucket, no PII                                                                               |
| Sim metrics (kills, bosses…) | folded **on the server from verified segments only** (`replaySegment` `onEvents` observer → `SimTally` → `sim.tally` points); a mode opts in with `ClientDrivenPolicy.analytics: ModeAnalytics` (classic first)          |
| Retention / DAU              | D1 `account_activity`, one row per account per UTC day, written by AccountDO at most once a day                                                                                                                          |
| Admin API                    | `/api/admin/<section>` GETs, admin-only (`requireAdmin`), range `from/to/bucket`, per-isolate 30 s cache (`fresh=1` bypass), every response lists its `sources`                                                          |
| UI                           | existing React admin (`#admin`) becomes a sidebar app of 9 sections; hand-rolled SVG chart kit (no chart library: the wave C charts already prove the pattern, and the budget is the 375 px phone); CSV from every table |
| Config                       | numeric **tunables** next to the flags in ConfigDO (`TUNABLES` registry), starting with `classic.offlineXpPct` (default 20)                                                                                              |

---

## 1. Ownership and parallel tasks

Contract files (architect, frozen: change only on purpose, tell the integrator):

| File                                                                                                        | What                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/protocol/src/admin.ts`                                                                            | every admin API response type, telemetry wire types, `TUNABLES`                       |
| `packages/protocol/src/economy.ts` (`ConfigResponse.tunables?`)                                             | public config carries tunables                                                        |
| `packages/kernel/src/replay.ts` (`ReplayOptions.onEvents`) + `types.ts` (`ModeAnalytics`, `AnalyticsTally`) | verified-event observer, mode analytics hooks (implemented + tested)                  |
| `apps/game/src/server/analytics/schema.ts`, `analytics/types.ts`                                            | metric catalogue, column layout, writer/query interfaces, MetricsApi                  |
| `apps/game/src/server/admin/metrics/util.ts`, `range.ts`, `cache.ts`                                        | reader helpers (`SourceLog`, `toSeries`, `dist`…), range parsing, cache               |
| `apps/game/src/server/routes/admin-metrics.ts`                                                              | dispatch of every new admin endpoint (implemented)                                    |
| `apps/game/src/server/contracts.ts`                                                                         | `Env` (METRICS, ANALYTICS, ANALYTICS\_\*), `ConfigApi.tunables/setTunables`, payloads |
| `apps/game/migrations/0010_admin.sql`                                                                       | `account_activity`, `pass_progress`, `account_summary.registered_at`                  |
| `apps/game/src/client/admin/kit/types.ts`, `sections/index.ts`                                              | chart kit props, `SectionDef`/`SectionContext`, sidebar order                         |
| `apps/game/cloudflare.config.ts`                                                                            | `MetricsDO` export, `METRICS` + `ANALYTICS` bindings                                  |

Stubs (signature frozen, body owned by a builder) are marked `CONTRACT STUB` in their header.

| Task             | Model | Owns                                                                                                                                                                                                                                                                      |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-analytics-core | opus  | `server/analytics/{index,local-store,ae-sql,query-local}.ts`, `server/do/metrics.ts`, `server/routes/dev-metrics.ts`, `tests/analytics/{core,local-store,ae-sql,seed}.test.ts`                                                                                            |
| T-sim-analytics  | haiku | `server/analytics/sim-tally.ts`, `modules/classic/src/platform/analytics.ts`, `tests/analytics/sim-tally.test.ts`, `modules/classic/tests/platform.analytics.test.ts`                                                                                                     |
| T-instrument     | haiku | `server/analytics/{http,ws,do-active,sync}.ts`, `server/index.ts`, `server/do/{relay,chunk,chat,guild,market,shop,arena,escrow,plots,character,identity}.ts`, `server/chat/{host,moderation}.ts`, `server/routes/chat.ts`, `tests/analytics/{http,ws,sync}.test.ts`       |
| T-projections    | haiku | `migrations/0010_admin.sql`, `server/projections.ts`, `server/account/{activity,profile,pass}.ts`, `server/do/account.ts`, `tests/account/activity.test.ts`, `tests/projections.admin.test.ts`                                                                            |
| T-telemetry      | haiku | `server/routes/telemetry.ts`, `client/telemetry/**`, `tests/telemetry/**`                                                                                                                                                                                                 |
| T-api-players    | haiku | `server/admin/metrics/{players,lookup}.ts`, `tests/admin/metrics.players.test.ts`, `tests/admin/metrics.lookup.test.ts`                                                                                                                                                   |
| T-api-game       | haiku | `server/admin/metrics/{gameplay,economy,monetization,social}.ts`, `tests/admin/metrics.{gameplay,economy,monetization,social}.test.ts`                                                                                                                                    |
| T-api-tech       | haiku | `server/admin/metrics/{overview,tech,tunables}.ts`, `server/admin/flags-store.ts`, `server/do/config.ts`, `tests/admin/metrics.{overview,tech}.test.ts`, `tests/admin/tunables.test.ts`, `tests/admin/flags-store.test.ts`                                                |
| T-ui-shell       | opus  | `client/admin/{index.tsx,api.ts,styles.ts,dashboard.tsx,charts.tsx}`, `client/admin/kit/index.tsx`, `client/admin/kit/*.tsx` (new), `client/app/{App.tsx,fragments.ts}` (admin deep link only), `tests/admin/{screen,kit}.test.tsx`, `tests/client/app.fragments.test.ts` |
| T-ui-sections-a  | haiku | `client/admin/sections/{overview,players,lookup,config}.tsx`, `tests/admin/sections.a.test.tsx`                                                                                                                                                                           |
| T-ui-sections-b  | haiku | `client/admin/sections/{gameplay,economy,monetization,social,tech}.tsx`, `tests/admin/sections.b.test.tsx`                                                                                                                                                                |

Paths are relative to `apps/game/` unless they start with `modules/` or `packages/`.

**Off limits for every builder** (other workflows edit them right now): `modules/classic/src/auto/**`,
`modules/classic/src/platform/policy.ts`, `modules/classic/src/content/balance.ts`, the classic client
sync/persist (`modules/classic/src/client/**`), `apps/game/src/server/instance/**`,
`apps/game/src/server/do/instance.ts`, `apps/game/src/client/render/**`,
`packages/ui-host/src/render.ts`, classic settings/scene. Call sites needed there are listed in §11
for the integrator.

Gate for each builder: `node_modules/.bin/vp check` with 0 errors in your files, your tests pass
(`node_modules/.bin/vp test run apps/game/tests/<yours>` etc.), UI tasks attach a QA screenshot of
`http://localhost:5173/#admin` at 375 px and 1280 px (tools/qa). Never kill anything on :5173/:5174.
Report honestly, including what you could not verify.

---

## 2. Metric catalogue

Notation. **D1** = read model table. **AE** = analytics point (metric name from `schema.ts`; on dev
the local stub). **Live** = DO RPC at read time. Every AE number is sample-weighted
(`SUM(_sample_interval)` for counts, `SUM(_sample_interval * doubleN)` for sums). Days are UTC;
`day = floor(ms / 86 400 000)`. "Range" = the request's `[from, to)`.

### 2.1 Overview (`GET /api/admin/overview`, owner T-api-tech)

| Field             | Definition                                                                                                                             | Source       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `accounts`        | rows of `account_summary` with `_deleted = 0`; `guest` = `kind = 'guest'`, `registered` = the rest                                     | D1           |
| `dau`             | distinct `account_id` in `account_activity` with `day = today`                                                                         | D1           |
| `wau` / `mau`     | distinct `account_id` with `day` in `[today-6, today]` / `[today-29, today]`                                                           | D1           |
| `concurrent`      | distinct `index1` (session id) of `client.session` points with phase `start` or `heartbeat` in the last 120 s (`CONCURRENT_WINDOW_MS`) | AE (approx.) |
| `revenueMinor24h` | Σ `purchase.amount_minor` with `status = 'paid'` and `updated_at >= now - 24 h`, per currency                                          | D1           |
| `errorRate1h`     | `http.request` count with `statusClass = '5xx'` ÷ all `http.request` count, last hour (0 when no requests)                             | AE           |
| `syncLagP95Ms`    | p95 of `sync.batch.lagMs`, last hour                                                                                                   | AE           |
| `activeSeries`    | one series `dau`: DAU per day of the range                                                                                             | D1           |

### 2.2 Players (`GET /api/admin/players`, owner T-api-players)

| Field                      | Definition                                                                                                                                                                                                                                            | Source |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `accounts`                 | as overview                                                                                                                                                                                                                                           | D1     |
| `signups`                  | series `new`: accounts by `created_at` bucket; series `registered`: by `registered_at` bucket (null for guests and for accounts registered before migration 0010 — noted in the UI)                                                                   | D1     |
| `active`                   | per **day** of the range (independent of bucket): series `dau`, `wau` (trailing 7 days ending that day), `mau` (trailing 30)                                                                                                                          | D1     |
| `retention`                | one cohort per day of the range (newest first, at most 30): `size` = accounts with `floor(created_at/day) = c`; `dN` = share of the cohort with an `account_activity` row on day `c + N` (exact day, classic definition); `null` when `c + N > today` | D1     |
| `sessions.perBucket`       | series `sessions`: `client.session` phase `start` count per bucket                                                                                                                                                                                    | AE     |
| `sessions.lengthS`         | p50/p95 of `elapsedS` over phase `end` points                                                                                                                                                                                                         | AE     |
| `sessions.lengthHistogram` | phase `end` count by `lengthBand` in the fixed order `<1m, 1-5m, 5-15m, 15-30m, 30-60m, 1-2h, 2h+`                                                                                                                                                    | AE     |
| `platforms` / `devices`    | phase `start` count by `platform` / `device`                                                                                                                                                                                                          | AE     |
| `countries` / `continents` | phase `start` count by `country` / `continent` (Cloudflare `request.cf`; `"XX"` when unknown), top 20 countries                                                                                                                                       | AE     |

A **session** is one page load of the game client: `start` when the app is ready, `heartbeat` every
60 s while the page is open, `end` on `pagehide` (sendBeacon). Sessions without an `end` (crash,
killed tab) count in `perBucket` but not in the length stats; the UI says so.

### 2.3 Gameplay (`GET /api/admin/gameplay?mode=classic`, owner T-api-game)

All `sim.tally` counters come from **verified** play only (§5): a segment that fails verification
contributes nothing. `mode` filters `blob2`.

| Field                   | Definition                                                                                                                                                                              | Source |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `heroes.total`          | `classic_hero` rows, `_deleted = 0`, `mode = ?`                                                                                                                                         | D1     |
| `heroes.byClass`        | count by `class_id`                                                                                                                                                                     | D1     |
| `heroes.byLevel`        | count by `levelBandSql(level)` in `LEVEL_BANDS` order                                                                                                                                   | D1     |
| `heroes.byDeepestDepth` | count by `deepest_depth`: `0`, `1` … `20` each, then `21+`                                                                                                                              | D1     |
| `heroes.deepestDepth`   | `MAX(deepest_depth)`; `kills`/`deaths` = Σ columns (lifetime, not range)                                                                                                                | D1     |
| `playtimeHours`         | Σ `sim.tally` amount for metric `play.ms` grouped by `k1` (control) ÷ 3 600 000 → `manual`/`auto`/`idle`; `offline` = Σ `sim.offline.ms` ÷ 3 600 000                                    | AE     |
| `playtimeSeries`        | `play.ms` per bucket by control, in hours, plus series `offline`                                                                                                                        | AE     |
| `kills.byMonster`       | metric `kill`, Σ amount by `k1` (monster registry id), top 20                                                                                                                           | AE     |
| `kills.byRarity`        | metric `kill` by `k2` (monster rarity)                                                                                                                                                  | AE     |
| `kills.series`          | metric `kill` per bucket (one series `kills`)                                                                                                                                           | AE     |
| `deaths.byDepth`        | metric `death` by `k1` (depth at death: `"town"`, `"1"`…`"20"`, `"21+"`)                                                                                                                | AE     |
| `deaths.byKiller`       | metric `death` by `k2` (killer monster id, `"unknown"`), top 20                                                                                                                         | AE     |
| `bosses.rows`           | per boss monster id: `spawned` = metric `boss.spawned` by k1, `killed` = metric `boss.killed` by k1, `killRate = killed / spawned` (0 when none spawned)                                | AE     |
| `quests.funnel`         | `Accepted` = Σ `quest.accepted`, `Objective done` = Σ `quest.done`, `Turned in` = Σ `quest.completed`                                                                                   | AE     |
| `quests.rows`           | per quest id (k1): accepted, completed                                                                                                                                                  | AE     |
| `rifts`                 | `leaderboard_rift` rows with `_updated_at` in range: `runs`, `completed` (= `completed = 1`), `scoreHistogram` (completed runs, score buckets of width `niceCeil(max/10)`), `bestScore` | D1     |
| `achievements`          | metric `achievement` by k1 (achievement id)                                                                                                                                             | AE     |
| `skills`                | metric `cast` by k1 (skill id); `talents` = metric `talent` by k1                                                                                                                       | AE     |
| `drops.byRarity`        | metric `drop` by k1 (item rarity) — only `kind = item` drops (k2)                                                                                                                       | AE     |
| `drops.perKill`         | per rarity: `drop` ÷ total `kill` × 100 ("drops per 100 kills")                                                                                                                         | AE     |
| `offline`               | `sim.offline`: `grants` = count, `hours` = Σms ÷ 3.6e6, `kills/xp/gold/items/levels` = Σ doubles; `series` = grants per bucket                                                          | AE     |
| `xpPerHourByBand`       | per level band: Σ metric `xp` with k1 = band ÷ (Σ `play.ms` with k2 = band ÷ 3.6e6); offline XP is excluded (it is in `offline.xp`)                                                     | AE     |
| `party`                 | `null` (no parties in the game yet; the UI shows "not in the game yet")                                                                                                                 | —      |

### 2.4 Economy details (`GET /api/admin/economy/details`, owner T-api-game)

The wave C endpoint (`/api/admin/economy?days=`) keeps money supply, faucets vs sinks per day, the
price index, market/shop tiles and 24 h purchases.

| Field               | Definition                                                                                                                                                                                                                                    | Source |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `goldPerHourByBand` | per level band: Σ `sim.tally` metric `gold` (k1 = band) ÷ play hours of that band (as `xpPerHourByBand`)                                                                                                                                      | AE     |
| `market`            | `economy_sale` with `venue = 'market'`, `at` in range: `sales` count, `volume` Σprice, `taxes` Σtax, `medianPrice`, `series` (volume per bucket), `byCategory`, `byRarity` (count)                                                            | D1     |
| `trades`            | `economy_ledger` in range: `count` = distinct `reason` (`trade:<id>`) with `reason_group = 'trade'` and `flow = 'transfer'` (item-only trades have no coin rows); `fees` = −Σ amount with `reason_group = 'trade.fee'`; series = count/bucket | D1     |
| `shops`             | `rentPaid` = −Σ ledger amount `reason = 'shop.rent'`; `sales`/`volume` from `economy_sale venue = 'shop'`; `byState` from `shop_index` (now, not range)                                                                                       | D1     |
| `gems`              | currency `gem` ledger rows in range: `bought` = Σ amount `reason = 'store.gems'` (>0), `spent` = −Σ amount with `flow = 'sink'`; `supply` = Σ `account_wallet.gem`; series bought/spent                                                       | D1     |
| `arena`             | `rewardsCoin` = Σ ledger `reason = 'arena.reward'` in range; for the current season in `arena_rating`: `players` = rows, `matches` = Σ(wins+losses+draws) ÷ 2, `ratingHistogram` buckets of 100                                               | D1     |
| `faucets` / `sinks` | coin ledger in range grouped by `COALESCE(NULLIF(reason_group,''), reason)` with the wave C sign convention (sink total = −Σ amount)                                                                                                          | D1     |

Builders verify the actual reason strings in `modules/economy/src` and `apps/game/src/server/**`
(seen: `market.fee`, `market.tax`, `trade.fee`, `trade.coin`, `shop.rent`, `shop.tax`, `plot.bid`,
`arena.reward`, `pass.reward`, `pass.premium`, `store.gems`, `store.refund`, `bank.deposit`).

### 2.5 Monetization (`GET /api/admin/monetization`, owner T-api-game)

| Field           | Definition                                                                                                                                                          | Source |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `revenueMinor`  | `purchase` rows `status = 'paid'`, `updated_at` in range: Σ `amount_minor` per currency per provider (sandbox/stub data included; provider `stub` shown separately) | D1     |
| `revenueSeries` | per bucket, one series per currency (minor units)                                                                                                                   | D1     |
| `purchases`     | counts in range: `paid`/`refunded` by `updated_at`, `pending`/`failed` by `created_at`                                                                              | D1     |
| `bySku`         | per (sku, currency): paid, refunded, revenue                                                                                                                        | D1     |
| `payers`        | distinct `account_id` with a paid purchase in range                                                                                                                 | D1     |
| `arpuMinor`     | revenue per currency ÷ distinct accounts in `account_activity` with `day` in range (0 when none)                                                                    | D1     |
| `arppuMinor`    | revenue per currency ÷ `payers` paying in that currency                                                                                                             | D1     |
| `pass`          | current season (`currentSeason(now).id`) in `pass_progress`: `players` rows, `premium` rows with `premium = 1`, `conversion = premium / players`                    | D1     |

### 2.6 Social (`GET /api/admin/social`, owner T-api-game)

| Field          | Definition                                                                                                                                                                    | Source |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `chat`         | `chat.message`: `messages` = outcome `ok`, `blocked` = other outcomes, `series` per bucket by outcome, `byChannel` by `channelKind` (`global`/`mode`/`guild`)                 | AE     |
| `moderation`   | `open` = unresolved `chat_report` rows (same rule as `admin/moderation.ts`), `reports` = rows with `at` in range, `actions` = `mod.action` by action, `series` per bucket     | D1+AE  |
| `guilds`       | `guild_index` `_deleted = 0`: `count`, `members` Σ member_count, `sizeHistogram` buckets `1`, `2-4`, `5-9`, `10-19`, `20+`                                                    | D1     |
| `leaderboards` | top 10: level (`classic_hero` by level, xp), rift (`leaderboard_rift` completed, by score), arena (current season `arena_rating` by rating); `value` = level / score / rating | D1     |

### 2.7 Tech health (`GET /api/admin/tech`, owner T-api-tech)

| Field                             | Definition                                                                                                                                         | Source |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `requests`                        | `http.request` count per bucket by `statusClass` (`2xx`, `3xx`, `4xx`, `5xx`, `101` for upgrades)                                                  | AE     |
| `errors`                          | `http.request` 5xx count per bucket by `route` (top 5)                                                                                             | AE     |
| `routes`                          | top 20 routes by count: requests, 5xx, 4xx, p50/p95 `ms`                                                                                           | AE     |
| `websockets`                      | `ws.open` count (`opens`), `byKind`, series per bucket by kind; `durationS` p50/p95 of `ws.close.durationS`                                        | AE     |
| `durableObjects`                  | `do.active` count by `class` (each point = one DO instance active in a 10-minute slot, so the value reads as "DO-slots")                           | AE     |
| `verification`                    | `segments` = `verify.segment` count, `resyncs` = `verify.resync` count, `byCode`, series per bucket by outcome                                     | AE     |
| `sync`                            | `sync.batch`: `batches` count, `records` Σ, `lagMs` and `applyMs` p50/p95, `dead` = outcome `dead`, `retries` = outcome `retry`, series by outcome | AE     |
| `d1`                              | `d1.query`: count, latency p50/p95, count by `label`                                                                                               | AE     |
| `client.fps`                      | `p50` = median over `client.perf` points of `fpsP50`, `p95` = median of `fpsP95` (the fps of the 95th-percentile frame time, i.e. the slow frames) | AE     |
| `client.frameMsP95`               | p50/p95 over points of `frameMsP95`                                                                                                                | AE     |
| `client.loadMs`                   | p50/p95 of `client.session.loadMs` (phase `start`)                                                                                                 | AE     |
| `client.errors`                   | top 20 `client.error` by (`build`, `kind`, `messageKey`)                                                                                           | AE     |
| `client.builds` / `contentHashes` | phase `start` count by `build` / `contentHash` (version adoption)                                                                                  | AE     |

**DLQ size.** Cloudflare exposes no queue depth to a Worker. The dashboard shows DLQ **inflow**: the
consumer records outcome `dead` for a message whose `attempts >= maxRetries` (10) when it fails, i.e.
the delivery that sends it to `gamez-sync-dlq`. Lag is `now − message.timestamp` (enqueue time).

### 2.8 Player lookup (owner T-api-players)

`GET /api/admin/players/search?q=&cursor=`: `q` empty = newest accounts; otherwise accounts whose
`account_id` starts with `q` or whose `display_name` contains `q` (case-insensitive), ordered by
`created_at DESC, account_id`, 25 per page, keyset cursor `"<created_at>:<account_id>"`.
`lastActiveDay` = `MAX(day)` from `account_activity` (day start ms, 0 when none).

`GET /api/admin/players/<accountId>` (404 when there is no `account_summary` row):

| Field          | Source                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`      | `account_summary` (+ `registered_at`)                                                                                                                      |
| `wallet`       | Live `ACCOUNT.getByName(id).wallet()` (only after the summary row exists, so lookup never creates a DO); fallback D1 `account_wallet`, `source` says which |
| `heroes`       | `classic_hero` rows of the account (`playHours = play_ticks / 20 / 3600`, classic runs at 20 Hz)                                                           |
| `ledger`       | last 50 `economy_ledger` rows of the account, newest first                                                                                                 |
| `purchases`    | last 50 `purchase` rows                                                                                                                                    |
| `reports`      | `chat_report` rows against the account: total, open                                                                                                        |
| `guild`        | Live `ACCOUNT.guild()`; null when none or unreachable                                                                                                      |
| `arena`        | current-season `arena_rating` row                                                                                                                          |
| `activeDays30` | `account_activity` rows with `day >= today − 29`                                                                                                           |
| `recent`       | AE `sim.tally` totals with `index = accountId` grouped by `metric`, plus `verify.resync` count as bucket `resync`                                          |

Support actions are the existing ones: mute (`POST /api/admin/mute` on a channel), hide (from the
moderation queue), flags. No new write endpoints for players.

---

## 3. Event schemas (Analytics Engine layout)

`apps/game/src/server/analytics/schema.ts` is the source of truth. `blob1` = metric name, then the
listed blobs in order (`blob2…`), the listed doubles (`double1…`), `index1` = sampling key.

| Metric           | Blobs                                                                                | Doubles                                     | index1     | Written by                                 |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- | ---------- | ------------------------------------------ |
| `http.request`   | route, method, statusClass, country                                                  | ms, status                                  | ""         | Worker fetch (`analytics/http.ts`)         |
| `ws.open`        | kind, mode                                                                           | —                                           | ""         | RelayDO, ChatChannelDO, InstanceDO (§11)   |
| `ws.close`       | kind, mode, code                                                                     | durationS                                   | ""         | same                                       |
| `do.active`      | class                                                                                | —                                           | DO name    | DOs (`analytics/do-active.ts`)             |
| `sync.batch`     | source (prefix before the first ":"), outcome                                        | records, lagMs, applyMs, attempts           | ""         | queue consumer                             |
| `d1.query`       | label, outcome                                                                       | ms, rows                                    | ""         | admin readers (`SourceLog.d1`), sync apply |
| `verify.segment` | mode, outcome                                                                        | ticks, costMs                               | accountId  | SimTally (§5)                              |
| `verify.resync`  | mode, code                                                                           | —                                           | accountId  | SimTally                                   |
| `sim.tally`      | mode, metric, k1, k2                                                                 | amount                                      | accountId  | SimTally                                   |
| `sim.offline`    | mode, levelBand                                                                      | ms, kills, xp, gold, items, levels          | accountId  | SimTally                                   |
| `chat.message`   | channelKind, outcome (`ok`, `filtered`, `muted`, `rate_limited`, `guard`)            | chars                                       | ""         | chat host                                  |
| `mod.action`     | action (`mute`, `hide`, `report`, `filter`, `guard`), by (`admin`, `auto`, `player`) | —                                           | ""         | chat host / moderation / admin forwards    |
| `client.session` | phase, platform, device, country, continent, build, contentHash, mode, lengthBand    | elapsedS, loadMs, visible                   | session id | `/api/telemetry`                           |
| `client.perf`    | mode, platform, device, build                                                        | fpsP50, fpsP95, frameMsP95, samples, heapMb | session id | `/api/telemetry`                           |
| `client.error`   | kind, build, messageKey, platform                                                    | —                                           | session id | `/api/telemetry`                           |

**Route keys** (`routeKey(pathname)` in `analytics/http.ts`): the path with id-like segments
replaced: `/api/admin/players/:id`, `/api/market/listings/:id`, `/api/pay/webhook/:provider`;
unknown `/api/*` paths become `/api/other` (bounded cardinality); `/ws`, `/ws/instance`,
`/ws/chat` stay. `statusClass` is `"2xx"`… or `"101"`.

**sim.tally metrics** (classic, `modules/classic/src/platform/analytics.ts`):

| metric            | k1                      | k2                                  | amount    | from event                                       |
| ----------------- | ----------------------- | ----------------------------------- | --------- | ------------------------------------------------ |
| `play.ms`         | control                 | levelBand                           | wall ms   | host (replay `costMs`)                           |
| `sim.ms`          | control                 | levelBand                           | sim ms    | host (ticks × 1000 / hz)                         |
| `kill`            | monster id              | monster rarity                      | 1         | `classic.death` with `isHero = false`            |
| `death`           | depth band at death     | killer monster id or `unknown`      | 1         | `classic.hero.died` (depth from world)           |
| `boss.spawned`    | monster id              | depth band                          | 1         | `classic.boss.spawned`                           |
| `boss.killed`     | monster id              | depth band                          | 1         | `classic.boss.killed`                            |
| `quest.accepted`  | quest id                | ""                                  | 1         | `classic.quest.accepted`                         |
| `quest.done`      | quest id                | ""                                  | 1         | `classic.quest.done`                             |
| `quest.completed` | quest id                | ""                                  | 1         | `classic.quest.completed`                        |
| `xp`              | levelBand               | reason                              | xp amount | `classic.xp`                                     |
| `gold`            | levelBand               | source (`loot`, `quest`, `vendor`…) | gold > 0  | `classic.gold` (quest rewards arrive as gold)    |
| `level`           | new level band          | class id                            | 1         | `classic.levelUp`                                |
| `verify.segments` | outcome (`ok` / code)   | ""                                  | 1         | host, per verified or failed segment             |
| `verify.resyncs`  | resync code             | ""                                  | 1         | host, per resync                                 |
| `drop`            | item rarity             | kind (`item`/`gold`/`potion`)       | 1         | `classic.loot.dropped`                           |
| `achievement`     | achievement id          | ""                                  | 1         | `classic.achievement.unlocked`                   |
| `cast`            | skill id                | ""                                  | 1         | `classic.cast`                                   |
| `talent`          | talent id               | ""                                  | 1         | `classic.talent.learned`                         |
| `rift`            | `completed` / `failed`  | rift level band                     | 1         | `classic.rift.completed` / `.failed`             |
| `gem`             | `socketed` / `combined` | ""                                  | 1         | `classic.gem.socketed` / `classic.gems.combined` |

T-sim-analytics reads `modules/classic/src/events.ts` for the exact payloads and may add rows here
(bounded keys only); any change to this table is reported to the integrator.

---

## 4. Storage and the analytics backends

### 4.1 Write path

`analyticsFor(env, waitUntil)` returns a writer for one invocation:

1. **AE**: when `env.ANALYTICS` is bound, `writeDataPoint({ blobs, doubles, indexes: [index] })`
   with the `toStoredPoint` layout. Never awaited, wrapped in try/catch.
2. **Local stub**: when `localSinkOn(env)` (MetricsDO bound, `ANALYTICS_LOCAL !== "0"`, and either
   `ANALYTICS_LOCAL === "1"`, or no AE SQL credentials in a dev build (`import.meta.env.DEV`, i.e.
   `vp dev`) or without an AE binding), the point is appended to a per-isolate buffer. A production
   build with the AE binding never writes the stub unless `ANALYTICS_LOCAL = "1"`. The buffer flushes
   to `METRICS.getByName("local").ingest(points)` via `waitUntil` when it holds
   `LOCAL_LIMITS.flushAt` (50) points, 100 ms after its first point, or on `flush()`. The Worker's
   fetch handler does not flush per request, so requests batch across the isolate. Above
   `LOCAL_LIMITS.perSecond` (200) points per second per isolate, points are sampled 1-in-N and the
   kept point's `sample` is N, so sums stay right.

AE limits honoured: ≤ 20 blobs, ≤ 20 doubles, 1 index ≤ 96 bytes (ids are cut), ≤ 16 KB of blobs
per point, ≤ 250 points per invocation (SimTally flushes at most 150; the HTTP wrapper writes 1).

### 4.2 Query path

`analyticsQueryFor(env)`:

- **AE SQL** (`analytics/ae-sql.ts`) when `ANALYTICS_ACCOUNT_ID` and `ANALYTICS_API_TOKEN` are set:
  `POST https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql` with the SQL as the
  body and `Authorization: Bearer <token>`. Queries are built only from the schema (column names
  from `blobColumn`/`doubleColumn`, never from input), values are single-quote escaped and limited
  to printable characters. Counts are `SUM(_sample_interval)`, sums `SUM(_sample_interval * doubleN)`,
  quantiles `quantileExactWeighted(q)(doubleN, _sample_interval)`, distinct `COUNT(DISTINCT index1)`,
  buckets `intDiv(toUInt32(timestamp), S) * S`. Unit-tested against recorded SQL strings and a fake
  fetch (there are no AE credentials in this environment: **unverified against the live API**).
- **Local** (`analytics/query-local.ts` → `MetricsDO`) otherwise when MetricsDO is bound and
  `ANALYTICS_LOCAL !== "0"`: the same query shapes, run as SQLite over the `metric_point` table
  (columns `t, b1..b10, d1..d10, idx, sample`), quantiles computed in JS over at most 50 000
  weighted values.
- `EMPTY_QUERY` otherwise (every AE source reports `ok: false, note: "no analytics backend"`).

### 4.3 MetricsDO "local"

SQLite table created in `blockConcurrencyWhile`. Indexes `(b1, t)`, `(idx, t)` and `(t)` (cheap
pruning by age and by row count). On ingest:
insert in one transaction, then prune rows older than 14 days and keep at most 200 000 rows (oldest
first). The row count is kept in a one-row `metric_meta` table, so pruning only does index lookups
on `t` and never a `COUNT(*)` scan per ingest. Used on dev hosts and as a production fallback only when `ANALYTICS_LOCAL = "1"` (a single
DO is not a production write path; the per-isolate buffer and sampler keep it survivable).

### 4.4 Local dev story

- `vp dev` has the AE binding (Miniflare accepts it; writes go nowhere) and no AE SQL credentials
  (undeclared secrets do not reach `env` locally, `docs/secrets.md`). It is a dev build
  (`import.meta.env.DEV`), so **the local sink is on by default** and the dashboard reads MetricsDO. Real dev traffic (requests, sockets, verified play,
  client telemetry) fills it.
- `POST /api/dev/admin/seed-metrics?days=7` (dev hosts + admin only) writes synthetic points for
  every metric in `schema.ts` across the last N days into the local stub (never into AE or D1), so
  every AE chart has shape for QA screenshots. Synthetic points carry `build = "seed"`.
- D1 sections fill from real dev play; `vp run migrate-local` applies `0010_admin.sql`. Missing
  tables answer empty data with `sources[].note = "table not migrated"`.
- Every section shows its sources as a footer chip ("D1", "local stub", "AE", "live"), so a reader
  never mistakes stub data for production.

---

## 5. Sim analytics (verified play only)

Kills, deaths, bosses, quests, drops, skills, playtime and gold/XP rates are computed **on the
server, from the replay of verified segments** — never from client claims:

1. `replaySegment(sim, seg, { …, onEvents })` (kernel, implemented) hands the observer the events
   of every step and successful dispatch. An observer that throws is ignored.
2. `SimTally.onEvents` buffers them. On success `commit(world, ticks, costMs)` folds the buffer via
   `ModeAnalytics.fold` and adds `play.ms` (= `costMs`, wall time) and `sim.ms` keyed by
   `ModeAnalytics.dims(world)`; it also counts `verify.segment` outcome `ok`. On failure `abort(code)`
   drops the buffer and counts `verify.segment` with the code.
3. Offline grants: `offline(world, elapsedMs, events)` → one `sim.offline` point (from
   `ModeAnalytics.offline`) and its events are **not** folded into `xp`/`gold`/`kill` (so per-hour
   rates measure online play only).
4. Counters are in memory per instance; `flush(analytics, accountId, now)` writes one `sim.tally`
   point per non-zero (metric, k1, k2), at most `TALLY_MAX_POINTS` (150; the rest folded into
   k1 = `"other"` per metric). Flush on compaction, on socket close and when `due(now)` (5 min or
   400 keys). A DO eviction loses at most 5 minutes of counters: acceptable for analytics, noted
   in the UI hint.
5. `ModeAnalytics` is pure, server-side, outside `contentHash`, and reads the world without
   changing it; determinism tests still cover the mode.

---

## 6. D1 additions (migration 0010, owner T-projections)

| Table / column                  | Writer                                                                                                                                                                                                                                                                                                                                                                                           | Projection                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `account_activity`              | `AccountDO.touchActivity(now)` (new RPC; `account/activity.ts`), at most once per UTC day per account: it stores the last day in DO SQLite and appends the outbox row only on a new day. Called from `checkSession` (registered accounts, inside AccountDO) and from `/api/telemetry` session `start`/`heartbeat` with a valid token (guests too; the route caches "touched today" per isolate). | `accountActivity` (`AccountActivityPayload`) |
| `pass_progress`                 | `account/pass.ts`: on every pass xp / tier / premium change, in the same transaction as the pass write                                                                                                                                                                                                                                                                                           | `passProgress` (`PassProgressPayload`)       |
| `account_summary.registered_at` | `account/profile.ts`: set when the account becomes registered (`addIdentity` on a guest, or `ensure` of a registered account); kept afterwards                                                                                                                                                                                                                                                   | `accountSummary` (payload `registeredAt`)    |

Volume: `account_activity` grows by DAU rows per day (10 k DAU → 3.65 M rows/year, ~200 MB): fine
for D1; a later retention job may roll it up. All writes go through the outbox and the
version-guarded apply; gameplay never reads these tables.

---

## 7. Admin API

### 7.1 Conventions

- Admin-only through `requireAdmin` (`ADMIN_ACCOUNT_IDS` ∪ dev admins on dev hosts). 401 without a
  token, 403 for players. `GET /api/admin/me` stays the dashboard's first call.
- Range: `from`, `to` (epoch ms or `YYYY-MM-DD`; `to` exclusive, a date means end of that day),
  `bucket` (`hour`/`day`, default by span). Clamped to 90 days and 400 buckets (`range.ts`).
- Every section response = `AdminSectionBase` (`at`, `range`, `sources`) + section fields. A failed
  source never fails the request: it yields empty data and `ok: false` in `sources`.
- Pagination: player search (25/page, keyset cursor). Tables in sections return top-N (≤ 50).

### 7.2 Caching

Per-isolate cache keyed by path + sorted query, 30 s (`cache.ts`); `fresh=1` bypasses and refills.
Response header `x-admin-cache: hit|miss`. Lookup and tunables are never cached. The AE SQL API is
rate-limited per account, so the cache and the dashboard's minimum auto-refresh (30 s) keep the
dashboard at most ~20 AE queries per section per 30 s per isolate.

### 7.3 Endpoints

| Method + path                                                                                                                 | Response              | Reader                          |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------- |
| `GET /api/admin/overview`                                                                                                     | `AdminOverview`       | `admin/metrics/overview.ts`     |
| `GET /api/admin/players`                                                                                                      | `AdminPlayers`        | `admin/metrics/players.ts`      |
| `GET /api/admin/gameplay?mode=classic`                                                                                        | `AdminGameplay`       | `admin/metrics/gameplay.ts`     |
| `GET /api/admin/economy/details`                                                                                              | `AdminEconomyDetails` | `admin/metrics/economy.ts`      |
| `GET /api/admin/monetization`                                                                                                 | `AdminMonetization`   | `admin/metrics/monetization.ts` |
| `GET /api/admin/social`                                                                                                       | `AdminSocial`         | `admin/metrics/social.ts`       |
| `GET /api/admin/tech`                                                                                                         | `AdminTech`           | `admin/metrics/tech.ts`         |
| `GET /api/admin/players/search?q=&cursor=`                                                                                    | `AdminPlayerSearch`   | `admin/metrics/lookup.ts`       |
| `GET /api/admin/players/<accountId>`                                                                                          | `AdminPlayerDetail`   | `admin/metrics/lookup.ts`       |
| `GET /api/admin/tunables`                                                                                                     | `TunablesResponse`    | `admin/metrics/tunables.ts`     |
| `POST /api/admin/tunables {values}`                                                                                           | `TunablesResponse`    | `admin/metrics/tunables.ts`     |
| `POST /api/telemetry`                                                                                                         | 204                   | `routes/telemetry.ts`           |
| `POST /api/dev/admin/seed-metrics?days=`                                                                                      | `{ ok, points }`      | `routes/dev-metrics.ts`         |
| existing: `GET /api/admin/economy?days=`, `GET /api/admin/moderation`, `POST /api/admin/{flags,mute,hide}`, `GET /api/config` | unchanged             | `routes/admin.ts`               |

Routes order (`routes/index.ts`): `telemetryRoutes`, `devMetricsRoutes`, `adminMetricsRoutes`
before `adminRoutes`; each answers only its own paths.

---

## 8. Tunables (ConfigDO "global", owner T-api-tech)

- `TUNABLES` (protocol `admin.ts`): `{ key, label, description, min, max, step, default, unit }`.
  First entry: `classic.offlineXpPct`, 0..100 %, step 1, default **20**.
- FlagsStore: table `config_tunable (key PRIMARY KEY, value REAL, by, at)` and
  `config_tunable_audit` (bounded like the flag audit). `config()` adds `tunables` (every spec key,
  stored value or default). `setTunables(patch, by)` ignores unknown keys and non-finite values,
  clamps to `[min, max]`, rounds to `step`, and audits each change.
- `POST /api/admin/tunables` validates strictly (unknown key, non-number, out of range → 400 with
  the key in the message) before calling ConfigDO; on success it resets the flags cache and the
  metrics cache. `GET /api/config` (public, 30 s) carries `tunables`.
- Server read path: `tunableValue(env, key)` in `config/flags.ts` (implemented): clamped value,
  spec default when ConfigDO is down (fail-open, like the flags).
- How the value reaches the classic offline grant is owned by the offline-idle workflow; see §11.

---

## 9. Client telemetry (owner T-telemetry)

Client (`apps/game/src/client/telemetry/`):

- `startTelemetry(opts)` once at boot; `setTelemetryContext({ token, mode, contentHash })` when the
  session or mode changes. `sid = crypto.randomUUID()` per page load; `build` from
  `import.meta.env.VITE_BUILD_ID` (fallback `"dev"`).
- `session.start` when the app is ready (`loadMs` = `performance.now()` at ready, navigation start
  based), `session.heartbeat` every 60 s (sent only while visible; carries `visible`),
  `session.end` on `pagehide` via `navigator.sendBeacon` (`elapsedS`).
- **perf** (25 % of sessions, decided once per sid): a requestAnimationFrame sampler that runs
  only while the page is visible and in a mode, writing frame deltas into a preallocated
  `Float32Array(600)` ring (no per-frame allocation); every 60 s it computes p50/p95 frame time and
  queues one `perf` event (`fpsP50 = 1000 / p50`, `fpsP95 = 1000 / p95`), `heapMb` from
  `performance.memory` when present.
- **errors**: `error` and `unhandledrejection` listeners (and an exported `reportRenderError` for
  error boundaries); the message is normalised (URLs → `<url>`, digit runs → `#`, hex ids → `<id>`,
  trimmed to 120 chars); at most 5 error events per minute per session; identical consecutive
  messages are counted once.
- Batching: events queue in memory and flush with the heartbeat (or at 20 events) via `fetch`
  (`keepalive: true`), `sendBeacon` on pagehide. Failures are dropped, never retried in a loop.

Server (`routes/telemetry.ts`):

- `POST` only; body ≤ 8 KB (413), JSON `TelemetryBatch` with `v: 1`, `sid` 8–64 chars of
  `[A-Za-z0-9-]`, ≤ 20 events (400 otherwise). Unknown event kinds are skipped, not fatal.
- Per-IP token bucket (burst 40, 120 / min) keyed by a hash of `cf-connecting-ip` in a bounded
  per-isolate map (≤ 10 000 keys); over the limit → 429. The IP itself is never stored.
- `country`/`continent` from `request.cf` (`"XX"` when missing). `platform`/`device` are validated
  enums. `lengthBand` computed server-side from `elapsedS` for `end`.
- A valid bearer token on `start`/`heartbeat` calls `ACCOUNT.touchActivity(now)` via `waitUntil`
  (at most once per account per isolate per hour). The account id is never written to an AE point
  here (index = sid).
- Answers 204 (also when sampled out or partly invalid).

Integration (§11): the shell calls `startTelemetry` in `main.ts`/`App.tsx`; the mode views report
`mode`/`contentHash` via `setTelemetryContext`.

---

## 10. UI

### 10.1 Shell (owner T-ui-shell)

```
┌───────────────┬──────────────────────────────────────────────────────────┐
│ gamez admin   │ Overview                   [24h|7d|30d|90d|custom] [Auto ▾] [↻] [◐] [Close] │
│               │ sources: D1 · local stub        updated 12:03:10 (cached)                     │
│ LIVE          ├──────────────────────────────────────────────────────────┤
│  Overview     │ [tile][tile][tile][tile][tile][tile]                      │
│ PLAYERS       │ ┌ DAU (line) ───────────────────────┐ ┌ Retention ─────┐ │
│  Players      │ │                                   │ │ cohort D1 D7 D30│ │
│  Lookup       │ └───────────────────────────────────┘ └────────────────┘ │
│  Social       │ ┌ Platforms (bars) ┐ ┌ Countries (bars) ┐                │
│ GAME          │ └──────────────────┘ └──────────────────┘                │
│  Gameplay     │  every chart: [Table] [CSV]                               │
│ BUSINESS      │                                                          │
│  Economy      │                                                          │
│  Monetization │                                                          │
│ OPS           │                                                          │
│  Tech health  │                                                          │
│  Flags&config │                                                          │
└───────────────┴──────────────────────────────────────────────────────────┘
```

- Below 900 px the sidebar becomes a top bar with a section `<select>` (44 px targets), the toolbar
  wraps, charts take the full width; nothing scrolls horizontally except tables inside
  `.adm-table-wrap`.
- **Range picker**: presets 24 h / 7 d / 30 d / 90 d, custom `<input type="date">` from/to, bucket
  auto/hour/day. **Auto-refresh**: off / 30 s / 60 s / 5 min, paused while the tab is hidden;
  manual refresh adds `fresh=1`. **Theme**: system / light / dark, sets `data-theme` on the `.adm`
  root (CSS accepts `.adm[data-theme]` in addition to `:root[data-theme]`). Section, range,
  refresh and theme are remembered in `localStorage` (try/catch).
- Deep links: `#admin/<section>[/<arg>]` (`fragments.ts` → `{ kind: "admin", section?, arg? }`,
  `AdminScreenProps.initialSection/initialArg`); `ctx.openPlayer(id)` switches to `lookup/<id>`.
- The "not an admin" flow (`NotAdmin`, dev self-grant) and Close stay as in wave C.
- Every section shows `SourcesNote` (failed sources) and the source chips.

### 10.2 Chart kit (owner T-ui-shell; props in `kit/types.ts`)

`StatTile`, `QuantilesTile`, `Panel`, `TimeSeriesChart` (line, bar, stacked; ≤ 8 series, the rest
folded into "other"; hover `<title>` per point; legend for 2+ series), `DistributionChart`
(horizontal bars with value labels, optional share %), `FunnelChart` (bars with step conversion
%), `DataTable` (sortable columns, "show all", CSV). Every chart has a "Table" disclosure and a CSV
button (`toCsv`, `Blob` + `URL.createObjectURL`, file `gamez-<csvName>-<from>-<to>.csv`). Pixel
units (no viewBox scaling), colours from `--adm-cat-1..8` and status tokens; status always with an
icon and text. Follow the `dataviz` skill (one axis, zero line, thin marks, no dual axes).

### 10.3 Sections (owners T-ui-sections-a / -b)

| Section        | Content                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview       | tiles: accounts (guest/registered), DAU/WAU/MAU, concurrent, revenue 24 h, error rate 1 h (status), sync lag p95 (status); DAU line                                                                                                                                                                                                                         |
| Players        | signups (bar, new vs registered), active (DAU/WAU/MAU lines), retention table (D1/D7/D30 as % cells with heat shading + text), sessions per bucket, length p50/p95 + histogram, platform/device/country/continent bars                                                                                                                                      |
| Lookup         | search box (debounced 300 ms), result table (paged), detail: account card, wallet (+source), heroes table, ledger table, purchases table, reports, guild, arena, activity, recent events; actions: mute in a channel (existing endpoint, confirm step)                                                                                                      |
| Social         | chat messages/blocked series, by channel, moderation tiles + actions + the wave C `ModerationPanel` (mute/hide), guild size histogram, three leaderboards                                                                                                                                                                                                   |
| Gameplay       | hero tiles; class / level / depth bars; playtime split (stacked bar Manual/Auto/Idle/Offline + series); kills by monster/rarity; deaths by depth/killer; boss table (kill rate); quest funnel + table; rift histogram; achievements, skills, talents; drop rarity + per 100 kills; offline grants tiles + series; XP/h by band; party "not in the game yet" |
| Economy        | wave C tiles + faucets/sinks + price index (existing components), gold/h by band, market tiles + series + category/rarity bars, trades, shops, gems, arena                                                                                                                                                                                                  |
| Monetization   | revenue by provider × currency table, revenue series, purchase status tiles, by SKU table, payers, ARPU/ARPPU per currency, pass conversion                                                                                                                                                                                                                 |
| Tech health    | requests stacked by status class, errors by route, routes table (p50/p95), sockets, DO activity, verification resyncs by code, sync lag/apply p50/p95 + dead/retries, D1 latency, client fps/frame/load quantiles, errors table, build and content hash adoption                                                                                            |
| Flags & config | the wave C `FlagsPanel` (unchanged behaviour) + tunables form (number input + range slider per spec, min/max/unit, Save with confirm, audit list)                                                                                                                                                                                                           |

---

## 11. Integration call sites (integrator only, after checking the file is not being edited)

Check `git diff --stat` and file mtimes first: these files belong to other active workflows.

1. `apps/game/src/server/do/instance.ts`: build an `Analytics` with
   `analyticsFor(env, (p) => ctx.waitUntil(p))` and pass it to the host deps; `markDoActive(...)` on
   fetch/webSocketMessage.
2. `apps/game/src/server/instance/verified-host.ts` (one `SimTally` per host):
   - field: `#tally = new SimTally(this.mode, this.#d.policy.analytics)`;
   - `replaySegment(sim, msg, { …, onEvents: this.#tally.onEvents })`;
   - after a successful `appendSegment`: `this.#tally.commit(sim.world, msg.toTick - msg.fromTick, out.costMs)`;
   - every failure branch before `#resync` for a replay failure: `this.#tally.abort(out.code)`;
   - in `#resync`: `this.#tally.resync(code)`;
   - after a granted offline dispatch: `this.#tally.offline(sim.world, elapsedMs, res.events)`;
   - in `#compact`, on socket close and when `this.#tally.due(now)`:
     `this.#tally.flush(this.#d.analytics, rec.accountId, now)`.
   - instance sockets: `ws.open`/`ws.close` with kind `"instance"` and the mode
     (`analytics/ws.ts` helpers).
3. `modules/classic/src/platform/policy.ts`: `analytics: classicAnalytics` (import from
   `./analytics.ts`).
4. Offline XP tunable: the offline-idle workflow owns how `classic.offlineXpPct` reaches the sim.
   Suggested shape: the host reads `await tunableValue(env, "classic.offlineXpPct")` and
   dispatches the offline action with `{ elapsedMs, xpPct }`; the classic offline action uses
   `xpPct` (clamped 0..100, default from `content/balance.ts`). If that workflow made it a balance
   constant only, the integrator wires the tunable so the admin control actually works, or marks
   the tunable read-only in the UI with a note — never a control that does nothing silently.
5. Client: `startTelemetry` in `apps/game/src/client/main.ts` (or `App.tsx` ready effect) and
   `setTelemetryContext` where the shell knows the session and the current mode/contentHash.
6. `vp run migrate-local` for `0010_admin.sql` (additive), then `POST /api/dev/admin/seed-metrics`
   on :5173 for QA.
7. Deploy notes (docs only, nothing deployed): add `ANALYTICS_ACCOUNT_ID` / `ANALYTICS_API_TOKEN`
   (Account Analytics: Read) to `docs/secrets.md`; set `VITE_BUILD_ID` in Workers Builds; the AE
   dataset is created on first write.

---

## 12. Privacy, sampling and limits

- **No PII in analytics.** No IPs, user agents, names, emails, chat text or URLs. Blobs are enums,
  registry ids, route keys and build ids. Account ids appear only as the AE `index1` of server
  sim/verify events (pseudonymous, needed for player lookup) — never in client telemetry.
- Client session ids are random per page load and never linked to accounts in AE.
- Error messages are scrubbed client-side and again server-side with the shared
  `scrubTelemetryMessage` (@gamez/protocol): URLs, e-mails, tokens/ids and digit runs are replaced
  and the text is cut to 120 characters. Build labels outside `TELEMETRY_BUILD_RE` become `other`.
- Geography is country/continent from Cloudflare only.
- Retention: AE keeps 3 months; the local stub 14 days; D1 activity rows follow the account
  (tombstoned with it).
- Sampling: perf 25 % of sessions (client); session and error events unsampled (error events
  capped at 5/min/session); the local stub samples above 200 points/s/isolate with weights; AE
  applies its own adaptive sampling, which every query weights by `_sample_interval`.
- Rate limits: telemetry 120 requests/min/IP (burst 40), 20 events and 8 KB per request; admin reads
  cached 30 s per isolate.

---

## 13. Test plan

| Layer           | Tests                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel          | `replay.test.ts`: `onEvents` receives step and dispatch events in order; a throwing observer does not fail the replay (**done**)                                                                                                                                                                                                                                                                                          |
| Analytics core  | `toStoredPoint` layout; writer → fake AE binding receives the layout; local buffer flush via `waitUntil` at 50 and on `flush()`; sampler weights; `localSinkOn` matrix; MetricsDO store on `FakeSqlStorage`: totals/series/quantiles/distinct with sample weights, pruning; AE SQL strings for each query shape (snapshot), escaping of hostile values, fake-fetch parsing; seed route 404 off dev hosts, 403 for players |
| Sim tally       | commit folds, abort drops, offline excluded from xp/gold/kill, `play.ms` uses costMs, flush cap 150 with "other", `due()`; classic `fold` on a real classic sim script (kill a monster, accept/complete a quest, die) produces the expected counters; `levelBand` edges; `dims` reads the control mode                                                                                                                    |
| Instrumentation | `routeKey` table (ids, unknown paths), status classes, request wrapper writes once and never changes the response; ws open/close helpers; sync consumer outcomes ok/retry/dead and lag from `message.timestamp`                                                                                                                                                                                                           |
| Projections     | `touchActivity` writes one outbox row per day (second call same day: none); `checkSession` touches; pass progress row on xp/premium change; `registered_at` on upgrade; projections map payload → columns; chaos test (shuffled, duplicated batches end in the latest state)                                                                                                                                              |
| Telemetry       | 405/400/413/429/204 paths, enum validation, lengthBand, token → `touchActivity` once per hour, index = sid (no account id in points); client sampler math (p50/p95 over a ring), normaliser, batching, sendBeacon on pagehide, perf sampling decision                                                                                                                                                                     |
| Admin readers   | each reader on `FakeD1` with the migrations applied + a fake `AnalyticsQuery`: exact numbers for a fixed fixture (DAU/WAU/MAU, retention with future days null, revenue per provider, ARPU/ARPPU, pass conversion, boss kill rate, xp/h by band, routes p95); missing tables → empty data + `sources[].ok = false`; `EMPTY_QUERY` → AE sources "no analytics backend"                                                     |
| Route           | `admin-metrics.ts`: 401/403/405, range parsing (`range.ts` edges: dates, clamps, bucket switch), cache hit/miss/fresh, players/<id> 400/404, tunables 400 on bad input, write resets caches                                                                                                                                                                                                                               |
| Tunables        | FlagsStore defaults, clamp, step, audit bound; `tunableValue` clamp + default on outage; `/api/config` carries tunables                                                                                                                                                                                                                                                                                                   |
| UI              | kit components render with `renderToStaticMarkup` (empty data, one series, many series folded, CSV escaping); sections render from fixtures without throwing at empty data; shell: section switching, range query string, refresh `fresh=1`, theme attribute, NotAdmin flow; fragments `#admin/lookup/<id>`                                                                                                               |
| E2E / QA        | `E2E_PORT=5790 node_modules/.bin/vp run e2e` stays green; QA (tools/qa) on :5173: dev self-admin → seed → every section at 375 px and 1280 px, light and dark, no console errors, CSV download, auto-refresh, lookup of the QA account                                                                                                                                                                                    |

Known flaky test (not this work): `tests/instance/verified-connection.test.ts` "keeps frame order
across async unpacking" failed once under full-suite load and passes alone.

---

## 14. As built (integration notes)

Everything above is implemented. These points differ from, or add to, the contract.

**Definitions decided while building**

- `xp` and `gold` skip reason `debug`. `quest.completed` adds no gold or xp of its own, because the
  rewards arrive as `classic.gold` and `classic.xp` with reason `quest`. `kill` includes summons
  (rarity `summon`). `sim.ms` uses 50 ms per tick (classic runs at 20 Hz).
- A death followed by a respawn in the same verified batch, with no earlier area change, is
  attributed to `town`.
- Rift `bestScore` is the maximum over completed runs in the range. `chat.byChannel` counts only
  accepted messages, so it sums to `messages`. Arena `matches` = ⌊Σ(wins+losses+draws) / 2⌋.
  ARPU and ARPPU are not rounded, and medians are the mean of the two middle values.
- ARPU's active accounts use the days ⌊from/day⌋ … ⌊(to−1)/day⌋. Economy gold/h and the arena
  ladder ignore `mode` (the endpoint takes none).
- `overview.concurrent` = max(distinct start sids, distinct heartbeat sids) in the 120 s window.
  This is a lower bound on the union, because the query API has no OR.
- The tunable audit records a row only when the effective value changes.

**Telemetry**

- `session.elapsedS` counts visible time only. `session.start` is sent at once on its own (one
  small request), so a tab killed before the first heartbeat still counts as a session.
- `perf` and `error` points carry platform `""`, because the wire perf event has no platform or
  device field. Splitting perf by device needs a protocol change.
- The per-IP bucket is burst 40, then 120/min (about one batch per player per minute, so a
  carrier NAT with ~100 players fits). Oversize bodies are refused with 413 before the bucket is
  charged. Refused batches show up as 429s on `/api/telemetry` in the Routes table. In dev,
  requests without `cf-connecting-ip` share one bucket.
- The shell calls `startTelemetry()` once the app is ready (`App.tsx`) and keeps the token and the
  running mode current with `setTelemetryContext`. `contentHash` is still `""` (see open items).
  `ModeHost` reports mode start failures with `reportRenderError`.

**API and UI**

- The admin leaderboard rows carry an optional `accountId` (protocol `AdminLeaderRow`), so the
  social section opens the player in lookup.
- `#admin/lookup/<id>` opens that account (the lookup section reads the deep-link argument).
- `AdminPlayerSearch` has no `sources`, so a failed search shows as an empty page.

**Open items** (call sites in files other workflows were editing during integration, §11)

1. `apps/game/src/server/do/instance.ts` and `instance/verified-host.ts`: build the `SimTally`,
   pass `onEvents` to `replaySegment`, and call `commit` / `abort` / `resync` / `offline` / `flush`.
   Also wire the instance socket `ws.open` / `ws.close` and `markDoActive`. Until then the AE
   gameplay charts (kills, play time, quests, drops, verification) show only seeded or earlier data
   on dev, and are empty in production.
2. `modules/classic/src/platform/policy.ts`: add `analytics: classicAnalytics` to
   `classicClientDriven`.
3. `contentHash` in client telemetry: the instance clients know `loaded.contentHash`. Call
   `setTelemetryContext({ …, contentHash })` from them (offline-idle owns
   `client/instance/verified.ts`), or expose the hash on `VerifiedConnection`.
4. Migration follow-up: add indexes `classic_hero(account_id)`,
   `arena_rating(account_id, season_id)` and `economy_ledger(account_id, at)` for the lookup detail
   on large tables.
5. AE SQL against the live API (ADR 0008 §2).

**Fixes after the QA round** (definitions that changed, with tests)

- ARPU's denominator is the accounts active in the range days UNION the accounts that paid in the
  range (a purchase is activity). Payers are then a subset of it, so ARPU ≤ ARPPU always holds.
- Battle pass premium = accounts with `pass_progress.premium = 1` UNION accounts with a paid (not
  refunded) purchase of the season's premium SKU; players = pass_progress rows UNION premium
  holders, so premium ≤ players. On dev, the 14 paid premium purchases predate migration 0010 (one
  per account, no double charge), so they had no pass_progress row.
- Active series (overview DAU, players DAU/WAU/MAU) start at the first day with an
  `account_activity` row (`activitySince`); earlier days are not shown as zeros. The tracking
  starts when migration 0010 is applied, so history before that has no data.
- Retention: an empty cohort (size 0) has `null` shares (a dash), not 0.
- Gold and XP per hour by level band leave out bands with no play time (no data) instead of 0.
- `/api/telemetry` scrubs error messages server-side with `scrubTelemetryMessage` and folds
  unknown build labels into `other`; oversize bodies answer 413 before the rate limit; the per-IP
  bucket is burst 40, 120/min.
- Tech: status series `101` is labelled "1xx (WebSocket upgrade)" and is left out of the overview
  error-rate denominator; the empty content hash is shown as "(none, outside a mode)"; the FPS tile
  reads "typical / slow frames" with its n.
- Economy: a "Coin reconciliation (all time)" panel shows wallets = faucets − sinks − custody
  (net ledger transfers: open market bids, escrow). On dev the 1,210 gap the QA found is exactly
  the open market bids (2,310 bid − 1,100 refunded); the difference tile reads 0.
- CSV exports money as plain major-unit numbers with a currency column (`DataColumn.raw`).
- A chart whose title repeats its panel heading hides the inner heading (PanelTitleContext).
- The QA `admin` scenario logs every `/api/` fetch: a range change must refetch the overview with
  200, and any 5xx or network error of the session fails the run with its URL.

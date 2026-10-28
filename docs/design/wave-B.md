# Wave B — platform: persistence, verification, auth, social (design)

Status: **built and integrated** (2026-10-28, on top of commit 3e42a69). "As built" notes are in
§13; decisions in [ADR 0005](../adr/0005-platform-wave-b.md).
Read first: `AGENTS.md` (rules, determinism §6, server recipes §11), the plan
`~/.claude/plans/we-are-trying-to-parallel-wombat.md` (§2 DO topology, §3 ping-free PvE, §4 sync,
§9 moderation), `docs/design/classic.md` (§12 client, §15.4 offline progress), `docs/design/wave-A.md`,
`tools/qa/README.md`.

Goal: classic stops being a browser-only game. The InstanceDO verifies and persists every hero,
players get real accounts, and the first social layer arrives: leaderboards, chat, guilds and
other players in the classic town. Ping must still never affect play: the browser keeps running
the sim locally and the server verifies behind it.

---

## 0. Scope

### 0.1 In scope

1. **Classic persistence + verification** (§2): `InstanceDO "classic:<accountId>"` hosts classic as
   a client-driven fixed-tick sim. The client streams input segments with its state hash; the DO
   replays them deterministically, compares hashes, persists (SQLite), resyncs on mismatch,
   enforces a wall-time ledger (anti speed-hack) and grants offline progress on rejoin from
   server-measured absence. The local save migrates to the server once.
2. **Real auth** (§3): email + password (PBKDF2-SHA256), Google and Discord OAuth (PKCE), Apple
   behind a stub, guest → account upgrade in place, revocable sessions; **AccountDO** for the
   shared economy (wallet ledger, universal stash, cosmetics, entitlements, all idempotent by
   txId) and **IdentityDO** for login uniqueness.
3. **Leaderboards** (§4): D1 projections fed by the InstanceDO outbox — hero level, deepest depth,
   rift score, all filterable per class — an `/api/leaderboards` read API and UI.
4. **Chat** (§5): `ChatChannelDO` (global, per mode, per guild), rate limits, a word filter, async
   Llama Guard moderation (Workers AI, with a local stub), block / mute / report, admin review.
5. **Guilds, basic** (§6): `GuildDO`, create / join / leave / kick, roster, guild chat, guild search
   via D1.
6. **Presence in the classic town** (§7): other players' heroes visible in the town through the
   existing RelayDO/ChunkDO layer, generalised to several worlds.
7. UI for all of it (§8), e2e (§10), QA (§11).

### 0.2 Out of scope (explicitly)

- Payments (Stripe, Asaas, Mercado Pago), the battle pass, store apps: phase 6. Only the
  entitlement hook `AccountDO.grantEntitlement(txId)` (idempotent) exists, plus a dev-only grant.
- Player shops, auction house, trade/escrow, professions (phase 3). No faucet into the account
  wallet in wave B (no sink needed yet).
- Parties, dungeons with several players, PvP / ArenaDO.
- Account-wide achievements (wave C); titles shown to others come only from cosmetics.
- Classic balance and content carry-overs from wave A (warrior pace, auto skill swap, rogue
  deaths, rift goal/guardian tuning, obelisk placement, `SkillProto.element` / `ItemView.gemTier`
  cleanups, gallery art overlap). They change content hashes and pinned numbers; they are
  wave C work. The one wave A carry-over in scope: the 1.19 MB main chunk (T-app-shell lazy-loads
  mode views) and RiftRecord submission (via reports, §4).
- Reward-rate ceilings per zone and full-replay spot checks (§2.8 lists them as future work).
- Guild invites, ranks beyond leader/officer/member, guild banks; chat DMs; voice.
- Quadtree chunk splitting, sharded relays (phase 4).

---

## 1. Ownership and parallel tasks

Contract files (architect; read-only for builders unless your row lists them — report contract bugs
instead of editing, or work around locally and say so):

```
packages/kernel/src/types.ts (ClientDrivenPolicy, InstanceReport), packages/kernel/src/api.ts
packages/protocol/src/{messages,platform,index}.ts
packages/ui-host/src/{platform,types,index}.ts
apps/game/src/server/{contracts,projections,http,index}.ts, apps/game/src/server/routes/{index,types}.ts
apps/game/src/server/do/account.ts, apps/game/cloudflare.config.ts, apps/game/migrations/0002-0005
apps/game/src/client/app/services.ts (T-app-shell may edit, keep the wave B wiring)
modules/classic/src/platform/policy.ts, modules/classic/src/index.ts
modules/classic/src/client/contract.ts (SyncView, panel ids, api.sync/platform/session)
tools/e2e/src/{features,e2e}.ts, tools/qa/src/waveB/index.ts, apps/game/tests/support/**
```

| Task               | Model | Owns (disjoint)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-verify           | Opus  | `packages/kernel/src/replay.ts`, `packages/kernel/tests/replay*.test.ts`, `packages/protocol/src/verified.ts`, `packages/protocol/tests/verified*.test.ts`, `apps/game/src/server/instance/**`, `apps/game/src/server/do/instance.ts`, `apps/game/src/client/instance/verified*.ts`, `apps/game/tests/instance/verified*.test.ts`, `tools/e2e/src/{classic-verify,classic-bot}.ts`, `tools/bench/src/verify.ts`, `tools/bench/package.json`, `docs/bench/*waveB*`       |
| T-classic-sync     | Opus  | `modules/classic/src/client/{index,game,persist,debug}.ts`, `modules/classic/src/client/sync/**`, `modules/classic/tests/client.{sync,persist,game}*.test.ts`, `tools/qa/src/waveB/classicServer.ts`                                                                                                                                                                                                                                                                    |
| T-auth             | Opus  | `apps/game/src/server/auth.ts`, `apps/game/src/server/auth/**`, `apps/game/src/server/account/profile.ts`, `apps/game/src/server/do/identity.ts`, `apps/game/src/server/routes/auth.ts`, `apps/game/tests/server/auth*.test.ts`, `apps/game/tests/auth/**`, `docs/secrets.md`, `apps/game/.dev.vars.example`, `tools/e2e/src/{auth,accounts}.ts`                                                                                                                        |
| T-economy          | Haiku | `apps/game/src/server/account/economy.ts`, `apps/game/src/server/routes/account.ts`, `apps/game/tests/account/**`                                                                                                                                                                                                                                                                                                                                                       |
| T-leaderboards     | Haiku | `modules/classic/src/platform/reports.ts`, `modules/classic/tests/platform.reports*.test.ts`, `apps/game/src/server/routes/leaderboards.ts`, `apps/game/src/server/leaderboards/**`, `apps/game/tests/leaderboards/**`, `tools/e2e/src/leaderboards.ts`                                                                                                                                                                                                                 |
| T-chat             | Haiku | `apps/game/src/server/chat/**`, `apps/game/src/server/do/chat.ts`, `apps/game/src/server/routes/chat.ts`, `apps/game/tests/chat/**`, `tools/e2e/src/chat*.ts`                                                                                                                                                                                                                                                                                                           |
| T-guilds           | Haiku | `apps/game/src/server/guild/**`, `apps/game/src/server/do/guild.ts`, `apps/game/src/server/account/social.ts`, `apps/game/src/server/routes/guilds.ts`, `apps/game/tests/guild/**`, `tools/e2e/src/guilds.ts`                                                                                                                                                                                                                                                           |
| T-presence         | Haiku | `apps/game/src/server/do/{relay,chunk}.ts`, `apps/game/src/server/routes/presence.ts`, `apps/game/src/server/presence/**`, `apps/game/src/server/rate-limit.ts`, `apps/game/src/shared/worlds.ts`, `packages/protocol/src/{binary-codec,json-codec}.ts`, `packages/protocol/tests/{binary-codec.test,fixtures}.ts`, `apps/game/src/client/presence/**`, `apps/game/tests/presence/**`, `apps/game/tests/server/rate-limit.test.ts`, `tools/e2e/src/classic-presence.ts` |
| T-classic-presence | Haiku | `modules/classic/src/client/presence/**`, `modules/classic/tests/client.presence*.test.ts`, `tools/qa/src/waveB/classicTown.ts`                                                                                                                                                                                                                                                                                                                                         |
| T-platform-client  | Haiku | `apps/game/src/client/platform/**`, `apps/game/src/client/session.ts`, `apps/game/tests/client/{platform,session}*.test.ts`                                                                                                                                                                                                                                                                                                                                             |
| T-social-ui        | Haiku | `packages/ui-host/src/social/**`, `packages/ui-host/tests/social*.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                             |
| T-app-shell        | Haiku | `apps/game/src/client/app/**`, `apps/game/src/client/modes/index.ts`, `apps/game/tests/client/app*.test.ts(x)`, `tools/qa/src/waveB/app.ts`                                                                                                                                                                                                                                                                                                                             |
| T-classic-hud      | Haiku | `modules/classic/src/client/hud/panels/{Chat,Guild,Leaderboard,Account}Panel.tsx`, `modules/classic/src/client/hud/widgets/{SyncBadge,MoreMenu,PanelButtons}.tsx`, `modules/classic/src/client/hud/index.tsx`, `modules/classic/tests/hud.social*.test.tsx`, `tools/qa/src/waveB/classicSocial.ts`                                                                                                                                                                      |

### 1.1 Rules for every builder

1. Only touch owned paths. Everyone works in the same tree at the same time; the live dev server on
   :5173 hot-reloads it, so **every saved file must compile**: write new code in new files first,
   wire it last. Never kill or restart anything on :5173. Use `node_modules/.bin/vp` (never the
   global `vp`).
2. Sim code stays deterministic (AGENTS.md §6). The server never mutates a sim except through
   `dispatch` / `step`.
3. Migrations 0002-0005 are already applied to the shared local D1: never edit them; a needed
   column is a new migration file (report it, the integrator adds it).
4. Pinned hashes you do not own (classic `tests/content.test.ts`, autoplay numbers): do not edit;
   report old/new values. Wave B should not change classic content at all.
5. External services with credentials: real implementation behind optional env (contracts.ts `Env`),
   a working local stub, secrets documented in `docs/secrets.md` (T-auth writes it; others send
   their rows to T-auth's section in their report — the integrator merges). Never invent keys.
6. E2E: `flock /tmp/gamez-e2e.lock env E2E_PORT=<your port> E2E_LOG=/tmp/gamez-e2e-<task>.log node_modules/.bin/vp run e2e`
   (ports: T-verify 5301, T-auth 5302, T-leaderboards 5303, T-chat 5304, T-guilds 5305,
   T-presence 5306; the lock serialises runs because all dev servers share the local state dir).
   Your feature's checks must pass; others' may still be stubs ("SKIP").
7. Gate: `node_modules/.bin/vp check` with 0 errors in your files, your tests pass, and for
   user-visible work a QA run with screenshots (`node tools/qa/src/run.ts …`, output under
   `/tmp/gamez-qa/waveB-<task>-…`). Report honestly: what works, what does not, numbers.
   Nobody commits; the final fixer does.

---

## 2. Classic persistence and verification (T-verify server, T-classic-sync client)

### 2.1 Model

```
browser: local Sim (authoritative-feeling, 20 Hz, x1..x8 in Full Idle)
   │  every successful dispatch: recorder.record(sim.tick, name, payload)
   │  after a step, every ~2 s wall or 400 ticks: recorder.cut(sim) -> segment {fromTick,toTick,inputs,hash}
   ▼  submit(segment) — never waits for the answer
InstanceDO "classic:<accountId>" (VerifiedHost)
   │  replaySegment(serverSim, segment, policy) (packages/kernel/src/replay.ts)
   │  ok + same hash  -> persist segment (SQLite) -> "verified" ack
   │  anything else   -> "resync" with the verified snapshot (new epoch)
   ▼  every ~30 s / 1200 ticks: compact (write base snapshot), reports() -> outbox -> D1
```

Replay semantics are fixed in `replay.ts` (both sides use the same code): inputs dispatch at their
tick in order; `step(k)` equals k × `step(1)`, so where the client splits its `step()` calls does
not matter. The actor is `VERIFIED_ACTOR` ("local", the sim never reads it).

### 2.2 Policy (kernel contract, `ModeSpec.instance.clientDriven`)

`ClientDrivenPolicy` (packages/kernel/src/types.ts): `maxTicksPerSegment` (400), `maxInputsPerSegment`
(256), `speedOf(world)` (classic: ControlState.speed in Full Idle, else 1), `maxSpeed` (8),
`serverOnlyActions` (`classic.offlineProgress`), `offline {action, minMs 60 s, capMs 7 d, eligible}`,
`reports(world, registry)`. Classic's lives in `modules/classic/src/platform/policy.ts`. The host is
generic: everything classic-specific comes from the policy.

### 2.3 Protocol (`packages/protocol/src/verified.ts`)

Same socket path as other instances (`/ws/instance?token&mode=classic`). The InstanceDO uses the
VerifiedHost when the mode has `clientDriven`. Messages: client `join {fresh?, resume?}`, `segment
{epoch, seq, fromTick, toTick, inputs, hash}`, `import {snapshot, savedAt}`, `ping`; server
`vstate`, `verified`, `resync`, `pong`, `error`. Snapshots travel as `PackedSnapshot` (JSON, or
gzip+base64 above 256 KB: the 1 MiB WebSocket message limit). `packSnapshot`/`unpackSnapshot` are
async (CompressionStream), so the VerifiedHost **serialises message handling with a promise
queue** (the DO does not block other events during non-storage awaits).

**Epochs.** Every `vstate`/`resync` starts a new epoch; segments carry theirs; the server drops
segments of older epochs silently (they were in flight). A segment of the current epoch is
accepted only if `fromTick === verifiedTick`; `toTick <= verifiedTick` is a duplicate (ignored,
re-acked); any other gap → `resync gap`.

### 2.4 VerifiedHost (server, T-verify)

`apps/game/src/server/instance/verified-host.ts` (pure, deps like `InstanceHost`: name, loaded,
policy, store, sockets, now, randomSeed, outbox sink, setAlarm) + `verified-store.ts` (SQLite) +
the InstanceDO choosing it. Rules:

- **Durable state** = a base snapshot at tick B + the verified segment log (B, verifiedTick]. The
  `verified` ack is sent only after the segment row committed. On wake the host restores the base
  and replays the stored segments (they verified before, so they must again; a failure is logged
  and the state falls back to the base). Compaction (write a new base, delete older segments)
  every 1200 ticks or 30 s, and when the last socket closes.
- **Speed ledger.** `credit = min(CREDIT_CAP_MS, credit + (now - creditAt))`; a segment costs
  `replay.costMs` (Σ msPerTick / speed). If `credit - cost < -TOLERANCE_MS` → `resync too_fast`
  (nothing consumed). Constants: `CREDIT_CAP_MS` 15 min, `TOLERANCE_MS` 2 s, `START_CREDIT_MS`
  3 s. A join that grants offline progress resets credit to START (no double dip).
  `maxPendingTicks` (sent in limits) = 12 000 ticks: the client never buffers more than the cap can
  verify.
- **Rate limits.** Per socket: segments burst 40 / 2 per s (a reconnect flush of 30 segments fits),
  imports 1 per minute, pings as today. Oversized frames (> `MAX_VERIFIED_CLIENT_FRAME`) → error.
- **Join.** `fresh` → new sim with a server seed (crypto random), segments wiped, epoch++.
  Otherwise load. If `resume` matches (tick and hash equal the verified ones) → `continued: true`
  unless an offline grant applies. **Offline grant**: `elapsed = now - lastActiveAt` (last verified
  segment, or socket close); when `!resume?.pending && elapsed >= offline.minMs &&
  offline.eligible(world)`, dispatch `offline.action {elapsedMs: min(elapsed, capMs)}` with actor
  "server", keep its events for `vstate.offline`, commit as a server-made segment-less change
  (write a new base right away), `continued: false`.
- **Import** (local save migration). Allowed while `importable` = no segment was ever verified
  and nothing imported. Validate: unpack, `modeId` + `contentHash` equal, `createSim(from)` works
  and a clone survives `step(20)`. Store as the new base (`imported = 1`), epoch++, answer vstate.
- **Content changes** (a deploy with new classic content). The stored base's contentHash differs:
  if the stored module id list equals the loaded one (or is a subset whose missing modules create
  state lazily — the wave A rule), carry over (relabel contentHash, a clone must survive
  `step(20)`), drop the segment log, `resync content_changed` on the next segment; else start
  fresh and tell the client (`error content_changed` then vstate).
- **Mismatch handling.** Every non-ok replay → rebuild the sim from durable state, epoch++,
  `resync <code>` with the verified snapshot. Count per code in the store (`mismatches`, `tooFast`);
  `flagged = 1` after 5 in an hour (logged; no automatic action in wave B).
- **Reports.** After each compaction: `policy.reports(world, registry)` → for every row whose
  `stableHash({data, displayName, imported})` changed since last time (`report_state` table) append
  an outbox record `table`, pk `${instanceName}/${key}`, payload `ReportEnvelope` in the same
  transaction; `outbox.scheduleFlush`; the DO alarm flushes (the verified host never uses the alarm
  for ticking). displayName = the joined socket's token name.
- **Bench** (`tools/bench/src/verify.ts`, results `docs/bench/2026-10-waveB-verify.md`): replay CPU
  ms per player-minute in Auto at x1 and x8 (classic, real content), snapshot JSON size and
  `hash()` cost at depth 1/5/10, segment frame sizes. Record it in the ADR.

### 2.5 Client (T-verify: platform connection; T-classic-sync: classic)

`VerifiedConnection` (`packages/ui-host/src/platform.ts`, implemented in
`apps/game/src/client/instance/verified.ts`): reconnect with backoff, asks `handlers.resume()`
before every join, unpacks snapshots, clock offset from pings, `submit` returns false when not
online. `services.connectVerified` is wired in services.ts (absent until implemented).

Classic client (`modules/classic/src/client/sync/**`, wired in `index.ts`/`game.ts`):

- **Server mode** when `services.connectVerified` exists and the run is not seeded (`?seed=`),
  not `cheats`, and not the gallery. Otherwise **local mode** = today's behaviour (local save,
  local offline progress). `api.sync` shows which.
- Start instantly from the local cache (`gamez.classic.server.v1.<accountId>`: last verified
  snapshot + pending segments, bounded) or, without one, wait for the first vstate (show
  "Connecting…"; after 8 s with no server fall back to local mode with a toast). Never block on
  the network after that: segments are fire-and-forget.
- Record with `SegmentRecorder` on every successful `act()` (the auto controller runs inside
  `step`, so it produces no inputs; only `dispatch`es are inputs). Cut right after a `step()`
  when ≥ `limits.segmentEveryMs` (2 s) passed or the open segment reached
  `limits.maxTicksPerSegment`. Keep each pending segment's end snapshot (or base + inputs) so an
  ack can advance the cached verified state.
- `verified` → drop acked pending, advance the verified base, update `api.sync`. `resync` →
  replace the sim with the snapshot (`createSim(loaded, {seed: 0, from})`), reset the recorder,
  drop pending, toast "Progress corrected by the server" (code in the log).
- Pending beyond `limits.maxPendingTicks` → stop recording (`overflow: true`); on the next join
  send `resume: null` and adopt the server state (plus its offline grant).
- Long hidden tab (≥ 60 s): on visible, reconnect with `resume {pending:false}` if nothing is
  pending, so the server can grant offline progress.
- New game → `connection.restart()`; never dispatch server-only actions in server mode.
- `vstate.offline.events` are fanned out like sim events (the existing offline summary toast).

### 2.6 Disconnected play

The client keeps playing and buffering while the socket is down (up to `maxPendingTicks`); on
reconnect it resumes and flushes in order; the ledger accrued the wall time, so honest offline play
verifies. Beyond the cap, local progress is replaced by the server state + offline grant (toast).

### 2.7 Local save migration

On the first `vstate` with `importable: true`, if a legacy local save exists (`SAVE_KEY`, current
content or carryable via `restoreCarried`), send `import` with it, then rename the key to
`${SAVE_KEY}.migrated` (kept as a backup) and toast "Your hero now lives on your account". When the
server already has progress, keep the server and leave the legacy save untouched.

### 2.8 Future work (not wave B)

Reward-rate ceilings per zone, random full-replay audits, server-chosen seeds per dungeon level
(today the world seed is server-chosen per hero), verification sampling to cut CPU.

---

## 3. Auth and accounts (T-auth, T-economy)

### 3.1 Sessions

Token = phase-0 HMAC format; payload gains `kind` ("guest" | "registered") and `sid`. Old guest
tokens stay valid. `authenticateToken/authenticateRequest` (`server/auth/session.ts`) are the only
entry points every route uses; for registered tokens they also call `AccountDO.checkSession(sid)`
(revocation on logout). Max age 30 days. The client keeps the token in localStorage (WebSocket URLs
need it) and sends `Authorization: Bearer` on HTTP.

### 3.2 IdentityDO and passwords

- One IdentityDO per login: `identityKey(provider, subject)` (`email:<normalised>`, `google:<sub>`,
  `discord:<id>`, `apple:<sub>`). Its single writer makes double claims impossible.
- Passwords: PBKDF2-SHA256 via WebCrypto, **100 000 iterations** (workerd's maximum), 16-byte salt,
  32-byte key, stored `pbkdf2-sha256$<iter>$<salt>$<hash>` (base64url), compared in constant time.
  Hashing runs in the IdentityDO (≈ tens of ms CPU; fine on the paid plan, documented in the ADR).
  `PASSWORD_MIN` 10, `PASSWORD_MAX` 128.
- Lockout: 5 failures → locked 1 min, doubling per further failure up to 1 h; success resets.
  Plus a per-isolate best-effort limiter per IP on /api/auth/*.

### 3.3 AccountDO (contract: `do/account.ts`, frozen) — profile/sessions part (T-auth)

`AccountProfileStore` (account/profile.ts): profile (kind, displayName, createdAt), identities,
sessions (`sid` random 128-bit, lastSeenAt), each profile change → `account_summary` outbox row.
`ensure()` lazily creates the profile for any account (old guests too). Display names: 3-20 chars
`[A-Za-z0-9 _-]`, trimmed, not starting with "Guest-" for registered accounts, not unique.

HTTP (`routes/auth.ts`; types in protocol/platform.ts):

| Endpoint                                               | Behaviour                                                                                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/guest`                                      | as today (+ `kind: "guest"`)                                                                                                                                                       |
| `GET /api/me`                                          | ensure + `AccountDO.view()`                                                                                                                                                        |
| `GET /api/auth/providers`                              | which providers work (and which are stubs)                                                                                                                                         |
| `POST /api/auth/register`                              | claim `email:` identity; with a guest bearer the **same accountId** becomes registered (all DOs keyed by accountId keep their data); without one a new account. → AuthResponse     |
| `POST /api/auth/login`                                 | IdentityDO.checkPassword → openSession → AuthResponse (the guest's progress stays with the guest)                                                                                  |
| `POST /api/auth/logout`                                | closeSession(sid); client then gets a fresh guest                                                                                                                                  |
| `POST /api/account/name`                               | setDisplayName → AuthResponse (new token with the new name)                                                                                                                        |
| `GET /api/auth/oauth/:provider/start?link=0\|1&token=` | PKCE S256 + signed state cookie (`gz_oauth`, HttpOnly, SameSite=Lax, 10 min) → 302 to the provider, or the stub page                                                               |
| `GET /api/auth/oauth/:provider/callback`               | verify state, exchange code, fetch profile, claim identity (link: for the token's account; `identity_taken` if owned by another), 302 to `/#auth=<token>` or `/#auth_error=<code>` |

Providers: Google (`openid email profile`, accounts.google.com / oauth2.googleapis.com /
openidconnect userinfo), Discord (`identify email`, discord.com/oauth2 + /api/users/@me), Apple
(**stub only** in wave B: real Sign in with Apple needs an ES256 client-secret JWT from
`APPLE_PRIVATE_KEY`; documented, `provider_disabled` without the stub). **Stub provider**: used
when a provider's client id is missing and `OAUTH_STUB !== "0"` and (`OAUTH_STUB === "1"` or the
host is `localhost`, `127.0.0.1` or `*.ts.net`). It serves a tiny HTML form (subject, email, name)
and a callback code `stub:<base64url json>`; production hosts never match.

### 3.4 Shared economy (T-economy, `account/economy.ts`)

Wallet ledger (currencies `coin`, `gem`), universal stash (items with `universal` origin), cosmetics
(owned = entitlements with `cosmetic.*` sku; equip per slot), entitlements — every mutation
idempotent by `txId` (a `tx` table stores the first result; replays return it with
`replayed: true`), balances never negative, integers only. HTTP: `GET /api/account/wallet|stash|
cosmetics`, `POST /api/account/cosmetics/equip {slot, id}`, `POST /api/dev/grant {sku}` (stub hosts
only, same host rule as the OAuth stub; QA/e2e use it to own a cosmetic). No gameplay faucet yet.

---

## 4. Leaderboards (T-leaderboards)

- **Producer**: `classicReports(world, registry)` (modules/classic/src/platform/reports.ts) returns
  `{table: "classic_hero", key: "hero", data: ClassicHeroReport}` once a hero exists, and one
  `{table: "leaderboard_rift", key: "run:<worldSeed>:<run>", data: ClassicRiftReport}` per
  RiftState.history record (completed or not; worldSeed keeps a new hero's runs from overwriting the
  old hero's). Pure, deterministic, never throws on old/partial worlds.
- **Pipeline**: VerifiedHost outbox → queue → `projections.ts` (`classicHero`, `leaderboardRift`,
  already written) → D1 tables from migration 0002.
- **Read API** `GET /api/leaderboards?board=level|depth|rift&mode=classic&classId=&limit=` →
  `LeaderboardResponse`. level: `ORDER BY level DESC, xp DESC`; depth: `deepest_depth DESC, level
  DESC`; rift: best completed run per account (`MAX(score)` grouped by account), `score DESC`.
  Always `_deleted = 0`. Missing tables → `available: false`, empty rows (never 500).
  `cache-control: public, max-age=15`. Limit clamp 1..100.
- **UI**: `LeaderboardView` (T-social-ui) in the picker (T-app-shell) and the classic HUD panel
  "leaderboard" (T-classic-hud). Imported rows show a marker.

---

## 5. Chat (T-chat)

- `ChatChannelDO` per channel: `global`, `mode:<modeId>` (catalog modes only), `guild:<guildId>`
  (members only: the route checks `AccountDO.guild()`). WebSocket `/ws/chat?token&channel` →
  Worker authenticates and forwards with `CHAT_HEADERS`. Hibernatable sockets, state in
  attachments (account, name, tag, blocks).
- Messages (`ChatClientMessage` / `ChatServerMessage`, protocol/platform.ts): `welcome` with the
  last `CHAT_HISTORY` (50) messages filtered by the viewer's blocks; `send` → `ack` + broadcast;
  errors `rate_limited`, `too_long` (> 280), `empty`, `duplicate` (same text within 30 s), `muted`,
  `filtered`.
- Rate limit per account per channel: registered burst 5 / 1 per 2 s; guests burst 3 / 1 per 5 s;
  guests may not post links.
- Word filter (`chat/filter.ts`, pure): normalise (case, leetspeak, repeated letters), mask listed
  words with `*`; a short original list in `chat/words.ts`; slurs block the message (`filtered`).
- Async moderation (`chat/moderation.ts`): `Moderator.classify(text)`; Llama Guard
  (`@cf/meta/llama-guard-3-8b` via `env.AI`, parse `safe` / `unsafe\nS<n>`) when `env.AI` is bound and
  `MODERATION` is not "stub"/"off"; otherwise the stub (flags texts containing `[unsafe-test]`, used
  by tests and e2e). Runs in `ctx.waitUntil` after the broadcast; unsafe → `hidden` broadcast +
  strike; 3 strikes in 24 h → mute 15 min (`muted` to the sender). The AI binding is **not** in
  cloudflare.config.ts (local dev would need a remote login); docs/secrets.md explains enabling it.
- Block: `block {accountId, blocked}` → `AccountDO.setBlocked` + attachment; blocked senders'
  messages are never delivered to the blocker. Report: stored once per (message, reporter) and
  appended to the outbox (`chat_report`, migration 0005) with the moderation verdict.
- Admin (`/api/admin/*`, `ADMIN_ACCOUNT_IDS`): `GET reports` (D1), `POST mute {channel, accountId,
  minutes}`, `POST hide {channel, ids}`.

## 6. Guilds (T-guilds)

- `GuildDO` named by `guildSlug(name)` (unique by construction). Info, roster (leader / officer /
  member), `GUILD_MAX_MEMBERS` 50, open or closed (closed = no joins in wave B). Each change →
  `guild_index` outbox row; disband (last member leaves) → delete (tombstone).
- One guild per account, held in `AccountDO` (account/social.ts). Saga, idempotent by opId:
  `reserveGuild(opId, guildId)` → `GuildDO.create/join` → `confirmGuild` or `releaseGuild`. Leave
  / kick: GuildDO first, then `releaseGuild` on the member's AccountDO.
- Guests may browse but not create or join (`guest_forbidden`): guilds need an account.
- HTTP `routes/guilds.ts`: `GET /api/guilds?q=` (D1 guild_index, name LIKE, member_count DESC,
  50), `GET /api/guilds/mine`, `GET /api/guilds/:id`, `POST /api/guilds` (create), `POST
  /api/guilds/:id/join`, `POST /api/guilds/leave`, `POST /api/guilds/kick {accountId}`.
- Guild chat = chat channel `guild:<id>` (T-chat checks membership via AccountDO.guild()).

## 7. Presence in the classic town (T-presence server/client, T-classic-presence classic)

- `apps/game/src/shared/worlds.ts`: `plaza` (phase-0 demo, server-path, legacy names) and
  `classic-town` (client-pose, 72×72, not persisted). `/ws?token&world=classic-town` → RelayDO
  `relayName(continent, world)` → ChunkDO `classic-town:0:0`.
- Pose worlds: `ClientMessage {t: "pose", ...PoseUpdate}` (rate 5/s burst 5; bounds-checked;
  path ≤ 8 tiles; speed clamped 1..12; appearance must match `/^unit\.hero(\.[a-z0-9_]+)*$/`, ≤ 64;
  tag ≤ 40 chars, control characters stripped). `moveTo` is rejected there, `pose` in plaza. Join
  in pose worlds needs no CharacterDO; leaving removes the avatar.
- `EntityState.tag` (optional) in both codecs (binary codec: new optional field and the pose tag).
- Client `PresenceConnection` (`apps/game/src/client/presence/**`, reusing net.ts / clock.ts /
  state.ts); `services.joinPresence` wired in services.ts.
- Classic `TownPresence` (`modules/classic/src/client/presence/**`): connect while the hero is in
  town, report poses ≤ 4/s on change, draw others with `renderer.upsertEntity` (`p:` ids,
  `walkAt` interpolation), remove on leave/area change. Tag "Lv N Class" (the guild tag comes in
  wave C). Houses jitter per world seed, so a remote hero may stand in a spot that is a house in
  your town: cosmetic, accepted.

## 8. Client UI

### 8.1 Platform SDK (T-platform-client)

`createPlatform(session)` (apps/game/src/client/platform/**) implements `PlatformServices`
(`AuthApi`, `LeaderboardApi`, `ChatApi` with one reconnecting socket per channel, `GuildApi`,
`AccountApi`) over fetch/WebSocket with injectable `fetch` / `WebSocket` for tests. Session store
(`session.ts`): `setSession`, `onSessionChange`, `consumeAuthFragment()` (reads `#auth=` /
`#auth_error=` after OAuth and clears it with `history.replaceState`).

### 8.2 App shell (T-app-shell)

Account chip in the picker header (guest: "Save your progress" → AccountPanel; registered:
display name → AccountPanel), Leaderboards and Guild screens reachable from the picker, a chat dock
(collapsed by default, global + guild tabs), OAuth return handling at boot (consumeAuthFragment →
setSession → toast), services re-created on session change (remount). Lazy-load mode views
(`modes/index.ts`: `lazyView(modeId, () => import(...))`) to split the 1.19 MB main chunk; measure
before/after with `vp -C apps/game build`. 375 px layouts, 44 px targets.

### 8.3 Shared social components (T-social-ui)

`packages/ui-host/src/social/**`: `ChatWindow`, `LeaderboardView`, `GuildView`, `AccountPanel`
(props in the stub files). Inline styles, dark theme matching the classic HUD palette, keyboard
accessible, no global CSS, work with fake `PlatformServices`.

### 8.4 Classic HUD (T-classic-hud)

Panels `chat`, `guild`, `leaderboard`, `account` wrap the shared components with `api.platform`
(offline note when null). `SyncBadge` widget (top-right, small): "Saved" (online, pending < 3 s of
play), "Saving…", "Offline — playing locally", "Local game" (local mode), tap → tooltip with
verified tick / pending ticks / last resync. Buttons in MoreMenu / PanelButtons. Keyboard shortcuts
stay as they are (index.ts is T-classic-sync's).

## 9. How Auto / Idle interact

Auto and Full Idle run inside `step()`, so they produce **no inputs**: a Full Idle hour is a stream
of input-less segments that verify cheaply in size (CPU is the replay cost, §2.4 bench). Speed
changes (`classic.setSpeed`, `classic.setControl`) are inputs; the server's ledger reads the speed
from the replayed state (`speedOf`), so x8 is legal only in Full Idle. Offline progress is the
server's: the client no longer dispatches `classic.offlineProgress` in server mode. The rift and
its records verify like everything else; `RiftRecord`s reach D1 only from verified state.

## 10. Test plan

| Layer            | Tests                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| kernel           | `replay.test.ts` (done): recorded segments replay to the same hash, speed accounting, bad shapes, server-only, rejected inputs                                                                                                                                                                                                                               |
| verified host    | with fakes: honest classic play (real modes, 3 classes, Auto, x8) verifies; tampered payload / hash / tick / server-only / too-fast / gap → resync and unchanged durable state; stale epoch dropped; duplicate re-acked; restart restores base+log; offline grant once, never with pending; import rules; content carry-over; reports emitted only on change |
| classic client   | recorder wiring (every act recorded once, cut after steps only), resync replaces the sim, overflow, cache round trip, local-mode fallback unchanged, import flow                                                                                                                                                                                             |
| auth             | PBKDF2 round trip + constant-time compare, lockout timing, token v1/v2, register-upgrades-guest keeps accountId, login, logout revokes, OAuth state/PKCE, stub provider host rule, link conflicts                                                                                                                                                            |
| economy          | idempotent tx replays, no negative balance, entitlement once, cosmetics equip owned only                                                                                                                                                                                                                                                                     |
| leaderboards     | reports determinism (pinned output for a fixed sim script), rift keys, SQL on a fake D1 (node:sqlite), per-class filter, missing tables                                                                                                                                                                                                                      |
| chat             | filter cases, rate limits (fake clock), duplicate, block filtering of history and live, moderation stub → hidden + strikes → mute, Llama Guard response parsing, report dedupe + outbox                                                                                                                                                                      |
| guilds           | slug rules, saga success / failure / retry idempotency, leader succession, disband tombstone, guest forbidden                                                                                                                                                                                                                                                |
| presence         | pose validation and sanitising, codec round trips incl. tag/pose, world routing, rate limit                                                                                                                                                                                                                                                                  |
| UI               | social components render with fakes (states: loading, empty, error, data), app shell session flows, classic panels/badge                                                                                                                                                                                                                                     |
| e2e (`features`) | auth, classic-verify (incl. restart persistence and a tampered segment), leaderboards (row in D1 + API), chat (2 bots, filter, block, report row), guilds (create/join/leave, D1 row, guild chat access), classic-presence (2 bots see poses)                                                                                                                |

## 11. QA focuses (tools/qa, wave B scenarios in `tools/qa/src/waveB/*`)

`account` + `social` (T-app-shell): picker account chip, register, sign out/in, leaderboards
screen, guild create/join, chat dock, desktop and phone. `classic-server` (T-classic-sync): an
unseeded classic run against the live server: badge reaches "Saved", reload restores the same hero
and tick, server restart is invisible. `classic-town` (T-classic-presence): two pages, both heroes
in town, each sees the other walking. `classic-social` (T-classic-hud): the four new panels and the
badge at 1366×768 and 390×844.

## 12. Decisions (to record in an ADR by the integrator)

1. Verification = full replay of every segment on the InstanceDO (no sampling) — simplest correct
   choice; the bench decides whether sampling is needed.
2. Ledger with a 15 min credit cap instead of per-segment wall-clock checks: tolerant of jitter and
   short disconnects, still bounds sim time by wall time.
3. Snapshots in WebSocket frames (gzip above 256 KB) rather than a separate HTTP endpoint.
4. PBKDF2 (100k, workerd max) over Argon2/scrypt (not in WebCrypto; WASM is heavier on CPU).
5. Stateless HMAC tokens + an AccountDO session check for registered accounts (revocable, one RPC
   per connect/API call).
6. Identity uniqueness via one IdentityDO per login (no D1 reads for auth).
7. One chat socket per channel; DO per channel; no fan-out tree yet (phase 4).
8. Guild names unique by DO name (slug); one guild per account in AccountDO; saga by opId.
9. Classic-town presence is client-reported (cosmetic) and unpersisted.

## 13. As built

Integrated 2026-10-28. Decisions and numbers: [ADR 0005](../adr/0005-platform-wave-b.md). Gates at
integration: `vp check` clean, `vp run -r test` green, `vp -C apps/game build` green, `vp run e2e`
green with every wave B feature running (no SKIP): auth, classic-verify, leaderboards, chat, guilds,
account (economy + guild chat access, added by the integrator) and classic-presence.

Deviations from §0-§12, as built:

- **§2.3 protocol** gained `ResyncCode "internal"` (segment write failed) and resume from an earlier
  verified state still in the segment log (`vstate.continued` with a tick ahead of the client's
  verified tick; the client re-stamps pending segments with the new epoch and resends, duplicates
  are re-acked).
- **§2.4 host extras**: a join rate limit (burst 5, 0.5/s); a failed replay costs ledger credit
  (`too_fast` does not); in-memory state is dropped after any internal error; one live socket per
  player (`CLOSE_REPLACED`). `VerifiedHostDeps.scheduleFlush()` replaces `setAlarm`. The verified
  DO's outbox source is `instance:<name>`.
- **§2.5 client**: `ServerSync` (modules/classic/src/client/sync) cuts after a step every
  `segmentEveryMs`, at `maxTicksPerSegment` or at half of `maxInputsPerSegment`; a new game plays
  on a placeholder sim until the fresh `vstate`, then rebases its inputs. `vstate` has no "fresh"
  marker (a reconnect racing a restart could rebase onto the old state; rare).
- **§3 auth**: guest tokens are refused once their account is registered (one `AccountDO.profile()`
  call per guest authentication). Rate-limited auth answers reuse the code `locked` with
  `error.retryAfterMs` and `Retry-After` (`AuthErrorCode` has no `rate_limited`). No sessions list
  / revoke-all RPC yet; guest tokens are not renewed (30 days).
- **§4 leaderboards**: `playTicks` uses `RunStats.ticksPlayed` (the world has no sim tick). Rift keys
  are `run:<worldSeed>:<run>` as in §4 (the contract comment's `run:<run>` was stale).
- **§5 chat**: blocks live in the channel DO's SQLite (`chat_block`), not in socket attachments
  (2 KB attachment cap), refreshed from `AccountDO` on join (merge, at most 2 s wait) and written
  back on change. Automatic moderation writes `chat_report` rows with reporter
  `system:moderation`. Rate-limit counters are in memory per channel DO (reset on hibernation).
- **§6 guilds**: route bodies are wrapped (`{guild}`, `{guilds}`); the client accepts bare and
  wrapped forms. `AccountSocial` gets the owner accountId from `do/account.ts`, so self-blocks are
  refused there as well as in chat. No officer promotion API yet.
- **§7 presence**: binary codec format v2 (entity flags byte, client tag 4 = pose); the wire still
  uses `jsonCodec`. Relays created before wave B have no stored world and default to `plaza`.
  `PresenceClient` stops on 4401; the shell re-creates services on session change.
- **§8.2 app shell**: the Town Plaza catalog entry moved to `client/modes/plaza-info.ts` so every
  mode view, the plaza included, is a lazy chunk.
- **e2e**: `tools/e2e/src/local-d1.ts` sends numeric SQL params as strings (the local explorer's
  `/raw` endpoint rejects non-string params with "Invalid input").
- **Secrets**: `docs/secrets.md` lists every wave B secret and variable. Optional keys are not
  declared in `cloudflare.config.ts` (a declared secret is required at deploy); whether undeclared
  `.dev.vars` keys reach `env` locally is unverified.

### 13.1 Fixes after the wave B QA pass

- **Town presence**: the ChunkDO no longer restarts a remote walk from the reported (floored) tile
  at every pose. `continueWalk` (`apps/game/src/server/presence/pose.ts`) continues the current
  walk's timeline into the reported route, reverses mid-segment when the walker turned back, and
  snaps only when the pose is more than 2 tiles from the drawn avatar. The wire contract is
  unchanged. `apps/game/tests/presence/continue-walk.test.ts` replays walks with floored poses
  every 250 ms and asserts that no drawn step exceeds speed × dt. Classic draws remote avatars at
  tile centres (t + 0.5), like the local hero.
- **Sync badge**: the "Saved" limit is `SAVED_PENDING_TICKS × speed`, about 3 s of wall time at
  any Idle speed, so x8 no longer reads "Saving…" while verification keeps up.
- **Account**: the forms use `noValidate`, so the app's own messages show. `AccountPanel.onChanged`
  says which change happened (`AccountChange`). The host shows "Signed out." and closes the
  sheet after a sign-out. The OAuth stub's `pattern` compiles with the `v` flag.
- **Social**: guest guild rows say "Sign in" and no longer shrink inside the scrolling list.
  The directory has a Refresh button. Guests are not told to "create the first one below". A
  chat report shows "Report sent. Thank you." outside the closed menu, and the composer says
  "Connecting to chat…" during the handshake. Toasts sit at the top, clear of the composers.
  On wide screens the open picker chat dock sits in the bottom-right corner, and the picker
  scrolls clear of it on narrow screens.
- **QA**: the new `classic-legacy` scenario covers the legacy-save import. `classic-town` judges
  movement only on the bot's avatar. The account flow checks the sign-out notice and that the
  sheet closed. `tools/qa/README.md` notes that SwiftShader stalls at x8 and that Chrome cannot
  emulate a dropped WebSocket.

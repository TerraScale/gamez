# ADR 0005: Wave B platform: verified classic, accounts and the first social layer

- Status: accepted (wave B)
- Date: 2026-10-28

Wave B makes Classic a server-backed game without giving up ping-free play, and adds the platform
around it: real accounts, a shared account economy, leaderboards, chat, guilds and other players in
the classic town. The design, ownership and wire contracts are in
[`docs/design/wave-B.md`](../design/wave-B.md); §13 there records how it was built. This ADR records
the decisions later waves build on, with the numbers behind them.

## 1. Classic is a client-driven, server-verified instance

The browser keeps running the classic sim at 20 Hz (x1..x8 in Full Idle) and never waits for the
network. It records every successful dispatch with `SegmentRecorder` and streams **input segments**
(`fromTick`, `toTick`, inputs, end hash) to `InstanceDO "classic:<accountId>"`. The DO's
`VerifiedHost` replays each segment with the same kernel code (`packages/kernel/src/replay.ts`) and
either acks it (`verified`, only after the segment row committed) or answers `resync` with the last
verified snapshot.

- The mode opts in through `ModeSpec.instance.clientDriven` (`ClientDrivenPolicy`). The host is
  generic; everything classic-specific (speed, server-only actions, offline eligibility, reports)
  is in `modules/classic/src/platform/policy.ts`. Event-ticked instance modes (steps, duel) keep
  the phase-1 `InstanceHost`.
- **Full replay of every segment, no sampling.** Bench
  ([`docs/bench/2026-10-waveB-verify.md`](../bench/2026-10-waveB-verify.md)): Auto x1 costs about
  1.2 s CPU per player-minute (~2 % of a core per player), flat across classes and depths 1-10;
  Full Idle x8 costs 5.0-6.3 s per player-minute (8-10.5 % of a core). x1 is clearly affordable.
  x8 is the dominant cost and the first place to optimise. `stableHash` is 37-44 % of x1 replay
  (15-18 ms per hash against ~3 ms per `snapshot()`), so a cheaper hash is the first lever, before
  sampling.
- **Epochs.** Every `vstate`/`resync` starts an epoch; in-flight segments of older epochs are
  dropped silently, so a resync never cascades.
- **Durable state = base snapshot + verified segment log.** Compaction (new base, reports diffed
  into the outbox in the same transaction) every 1200 ticks, 30 s, and on the last socket close.
  A DO wake restores the base and replays at most ~1600 ticks (well under a second; restore is
  ~3 ms).
- **Snapshots travel in WebSocket frames** (`PackedSnapshot`, gzip+base64 above 256 KB). Classic
  snapshots are 150-175 KB JSON up to depth 10, so they go as plain JSON today.
- A join may resume from an earlier state still in the log (acks lost with the old socket):
  `vstate.continued` with a tick ahead of the client's own verified tick, and re-sent duplicates
  are re-acked.

## 2. Speed hacks are bounded by a wall-time credit ledger

Instead of a per-segment wall-clock check, each instance has a credit:
`credit = min(15 min, credit + elapsed)`, and a segment costs `Σ 50 ms / speed` over its ticks,
with the speed read from the replayed state (`speedOf`; x8 is legal only in Full Idle). Below
`-2 s` the segment is refused (`resync too_fast`). Credit starts at 3 s and resets to 3 s after an
offline grant, so offline time is never paid twice. The client pauses itself against the credit
reported in acks. This tolerates jitter, tab throttling and short disconnects (buffered play
verifies on reconnect, up to `maxPendingTicks` = 12 000) while bounding sim time by wall time.
A cheap precheck at max speed runs before any replay; a failed replay still costs credit, so
replay spam is bounded too.

## 3. Offline progress is measured by the server

`classic.offlineProgress` is a server-only action: a client segment containing it is refused
(`server_only_action`). On join, if nothing is pending and the server-measured absence is at least
60 s (capped at 7 days) and the hero is eligible (in play, not Manual), the host dispatches it with
actor `server`, commits a new base and reports the events in `vstate.offline`.

## 4. Accounts: HMAC tokens, revocable sessions, one IdentityDO per login

- Tokens keep the phase-0 HMAC format with `kind` and `sid` added; max age 30 days. Registered
  tokens are checked against `AccountDO.checkSession(sid)` on every authentication (revocation on
  logout); guest tokens are refused once their account has been upgraded. One DO RPC per
  connect or API call is the price; it keeps auth free of D1.
- **Guest upgrade in place**: registering or linking OAuth with a guest bearer keeps the
  accountId, so every DO keyed by it (classic instance, account, character) keeps its data.
- **Login uniqueness by DO name**: one `IdentityDO` per `email:<normalised>`, `google:<sub>`,
  `discord:<id>`, `apple:<sub>`. The first claim wins. No automatic merge on matching emails
  (account takeover risk).
- **PBKDF2-SHA256, 100 000 iterations** (the workerd maximum; Argon2/scrypt are not in WebCrypto and
  WASM costs more CPU). About 95 ms per hash in workerd locally (login ~120 ms, register ~230 ms).
  Hashing runs in the IdentityDO, serialised per login, with a lockout of 5 failures → 1 min,
  doubling to 1 h. A per-isolate IP limiter on `/api/auth/*` is best effort only.
- Google and Discord use OAuth with PKCE S256 and a signed state cookie. Apple is stub-only (a
  real flow needs an ES256 client-secret JWT and a form_post callback; wave C). A **stub
  provider** answers on dev hosts only (`localhost`, `127.0.0.1`, `*.ts.net`, or `OAUTH_STUB=1`),
  so e2e and QA run the full OAuth round trip without credentials. Secrets: `docs/secrets.md`.
- Known trade-offs: login timing reveals whether an email exists (register already does via
  `email_taken`); link-mode OAuth carries the token in the start URL.

## 5. AccountDO holds the shared economy, idempotent by txId

Wallet ledger (`coin`, `gem`), universal stash, cosmetics and entitlements live in `AccountDO`.
Every mutation stores its first result under its `txId`; a replay returns that result with
`replayed: true`, so payment webhooks (phase 6) and sagas can retry freely. Balances never go
negative. There is no gameplay faucet yet, so no sink is needed; `/api/dev/grant` exists only on
stub hosts.

## 6. Leaderboards come only from verified state

`ClientDrivenPolicy.reports` (classic: `classicReports`) turns the verified world into rows
(`classic_hero`, `leaderboard_rift` keyed `run:<worldSeed>:<run>`). The host diffs them by stable
hash at compaction and appends changes to its outbox; the existing sync pipeline applies them to
D1. `GET /api/leaderboards` (level, depth, rift; per class) reads D1 with bound parameters, answers
`available: false` instead of 500 when a table is missing, and is cacheable for 15 s. Imported
(local-save) heroes are marked.

## 7. Chat: one DO per channel, async moderation

`ChatChannelDO` per channel (`global`, `mode:<id>`, `guild:<id>`) with hibernatable sockets, one
socket per channel per client, no fan-out tree yet (phase 4). Rate limits per account (registered
5 burst / 1 per 2 s; guests 3 / 1 per 5 s, no links), a 30 s duplicate rule, a pure word filter
(normalised leetspeak, masking; slurs block). Moderation runs after the broadcast
(`ctx.waitUntil`): Llama Guard via an optional Workers AI binding, or a stub that flags
`[unsafe-test]`; unsafe → hidden for everyone + a strike; 3 strikes in 24 h → 15 min mute. **The AI
binding is not in `cloudflare.config.ts`** (local dev would need a remote login); production
enables it per `docs/secrets.md`. Blocks are stored in the channel DO's SQLite (socket attachments
are capped at 2 KB) and mirrored to `AccountDO`.

## 8. Guilds: unique by DO name, saga with AccountDO

`GuildDO` is named by `guildSlug(name)`, so names are unique by construction. One guild per account,
held in `AccountDO`; create/join is a saga idempotent by opId (`reserveGuild` → `GuildDO` →
`confirmGuild`/`releaseGuild`). Guests can browse but not join. Search reads the `guild_index` D1
projection; disband writes a tombstone.

## 9. Classic-town presence is client-reported and cosmetic

`RelayDO`/`ChunkDO` now serve several worlds (`apps/game/src/shared/worlds.ts`): `plaza`
(server-computed paths, persisted via CharacterDO) and `classic-town` (72×72, client-reported poses
at most 4/s, validated and clamped, never persisted, no CharacterDO). A pose cannot affect gameplay,
so it needs no verification. `EntityState.tag` carries "Lv N Class".

## 10. Consequences and open items

- Verification CPU scales with sim speed. If x8 idling dominates the bill, first make `stableHash`
  cheaper, then consider sampling and reward-rate ceilings (wave-B.md §2.8).
- Guest tokens are not renewed and expire after 30 days; a guest who never registers loses access.
- Optional `.dev.vars` keys that are not declared in `cloudflare.config.ts` may not reach `env` in
  local dev (declaring them with `bindings.secret()` would make them required at deploy). Unverified.
- A `vstate` carries no "fresh" marker, so a reconnect racing a client-side new game could in rare
  cases rebase onto the old state.

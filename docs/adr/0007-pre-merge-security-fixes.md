# ADR 0007: Pre-merge security and correctness fixes (PRs #1-#3)

- Status: accepted (pre-merge of waves A-C)
- Date: 2026-10-28

A pre-merge review of waves A, B and C confirmed 19 findings. Two independent skeptics verified
each one. Several findings share a root cause, so this ADR records **13 root causes** (R1-R13).
Each section gives the problem, the decision and the consequences, and every fix ships with a
regression test that fails on 667cf80 and passes after the fix.

Shared contract changes (`apps/game/src/server/contracts.ts`, written before the fan-out):

- `WalletTxResult`, `VaultPutResult` and `VaultTakeResult` gain `{ ok: false, code: "conflict" }`
  (R2).
- `IdentityApi.checkPassword(password, client?)` takes the caller's network identity (R5).
- `ChatChannelApi.revoke(accountId, reason): Promise<number>` closes an account's sockets (R10).

No kernel or module code changes, so no sim behaviour changes: `contentHash`, module versions and
pinned hashes stay the same.

---

## R1. Forged legacy-save import reaches the shared economy, arena, season and leaderboards

Findings (4): _Forged local-save import feeds the shared economy through the bank_; _Import accepts a
client-fabricated hero, which can then bank gold into the shared account economy_; _A forged imported
save tops every leaderboard and can be banked into the shared economy_; _Legacy-save import accepts
any client-made snapshot, and the bank turns its gold and items into shared-economy coin and vault
items_.

**Problem.** `VerifiedHost.#import` installs a client-authored snapshot as the verified base after
shallow checks: it unpacks, `modeId` and `contentHash` match, and a clone survives `step(20)`. A
fresh account (any guest) can therefore import a hero with `Wallet.gold = 1e15` and invented items.
It can bank them into `AccountDO` at 10M coin per op (an unlimited faucet, multiplied across
throwaway accounts). The same forged hero feeds `exportBuild` (arena), `#reportSeason` (battle
pass) and the ranked leaderboards. Legacy saves come from wave A, when the game was single-player
and local-only. Their state was never verified, and no action log exists to re-simulate.

**Decision: quarantine, don't sanitise.** An imported hero keeps everything for **solo play**, so
an honest player's legacy save still imports. It is permanently cut off from everything shared
across players. The server cannot tell a real legacy save from a forged one, so any value derived
from it is untrusted, including gold and loot earned _after_ the import, because a forged level 999
hero farms "verified" loot unfairly fast. Clamping gold or items would still leave that path open,
and re-simulation is impossible without a log.

- `#bank`: when `rec.imported`, every bank op (deposits **and** withdrawals) fails
  `not_eligible` ("This hero was imported from a local save and can't use the bank. Start a new hero
  to trade."). Withdrawals are refused too, so account coin and items can't get trapped in a
  quarantined hero. The check runs before any account call and before the `bank_op` row is
  written.
- `exportBuild` returns `null` for an imported record, so the arena can't use the hero.
- `#reportSeason` never reports for an imported record.
- Ranked leaderboard queries (`leaderboards/query.ts`) exclude `imported = 1` rows. Report rows are
  still written, with `imported` set, for audit and admin.
- `#import` is also refused while any bank op on the instance is still pending
  (`pendingBankOps() > 0`), so a half-finished withdrawal can't land on the imported sim.
- The flag sticks. It survives content carry-over and restarts. Only a fresh game (`#newGame`, for
  example the Reset-progress button) clears it, and a fresh hero is fully eligible.
- The `imported` flag is logged with each refused bank op, so imports can be audited.

**Consequences.** An honest legacy player keeps their hero but must start a new hero to trade.
That is acceptable: legacy saves predate the economy, and the badge already tells the player the
hero was imported. Leaderboards no longer show imported heroes. No sim, `contentHash` or pinned
hash changes.

## R2. Bank opId reuse after the 7-day prune mints coin and duplicates items

Findings (2): _Reusing a bank opId after the 7-day prune mints coin_; _Pruned bank_op rows let a
client reuse an old opId; the AccountDO replays the old tx as ok, so coin and items are duplicated_.

**Problem.** `BankStore.prune` deletes `done` rows after `BANK_KEEP_MS` (7 days), but the
AccountDO `tx` rows for `bank:<instance>:<opId>:take` are kept forever. `applyWalletTx`,
`vaultTake` and `vaultPut` answer a known txId with `ok/replayed` **without comparing parameters**.
A client-chosen opId reused after the prune therefore replays a 1-coin debit as "ok" for 1e9 coin.
Then either the hero is credited, or `#refundOp` credits +1e9 under a fresh `:refund` txId.
`withdrawItem` gives a second copy of an item the same way.

**Decision: two independent layers.**

1. **Never forget an opId.** `BankStore.prune` keeps a permanent tombstone for every used opId
   (`op_id`, `account_id`, the op JSON and the final `result`) and drops only bulky data (`effect`).
   `get(opId)` still finds it, so the existing conflict check
   (`stableHash(prior.op) !== stableHash(msg.op)`) and the replay answer keep working forever. Rows
   are about 150 B, and ops are limited to 1/s per socket, so growth is negligible.
2. **Strict replays in AccountDO.** A replayed txId with different parameters returns
   `{ ok: false, code: "conflict" }` and changes nothing:
   - `applyWalletTx` compares the stored `currency` and `amount` (already in the `tx` table).
   - `vaultTake` compares the stored item's `uid` with the requested uid.
   - `vaultPut` compares a stable hash of the stored input (`itemId`, `origin`, `count`, `data`).
   - Rows written before this change without the needed fields count as a conflict unless they
     match exactly.

   `bank-saga.ts` maps `conflict` to a failed op (`conflict`), and a take that ended in conflict is
   **never refunded**. Shop, market and trade sagas already replay with identical parameters, so
   they are unaffected. Their tests must stay green.

**Consequences.** Bank `bank_op` storage grows by one small row per op, forever. Every AccountDO
txId is now bound to its parameters, which also hardens trade, market and shops.

## R3. OAuth link flow is open to login CSRF

Finding (1): _OAuth link flow is open to CSRF: /start takes the account to link from ?token= on a
cross-site GET_.

**Problem.** `GET /api/auth/oauth/:p/start?link=1&token=<attacker>` seals the attacker's account as
the link target into the victim's `gz_oauth` cookie. The victim's Google login is then claimed for
the attacker's account.

**Decision.**

- `/start` **never** reads a link target from the URL, and `?token=` is ignored there.
  `?link=1` only seals a link _intent_ (a boolean) into the state. It names no account.
- The callback of a link flow no longer claims the identity. It redirects to
  `/#oauth_link=<code>&n=<nonce>`. `code` is a sealed (AUTH_SECRET), 5-minute, single-purpose blob
  `{provider, subject, email, name, exp}` from the verified OAuth profile.
- The SPA redeems it with `POST /api/auth/oauth/link {code}` plus its **own bearer token**. The
  server claims the identity for the bearer's account. A forged link therefore links the victim's
  provider to the victim's own account, which is harmless.
- `authenticateRequest` accepts `?token=` only for WebSocket upgrade requests
  (`Upgrade: websocket`). Every other route needs `Authorization: Bearer`.

**Consequences.** Linking takes one more client round trip. The client builds the link URL without
a token. The e2e `oauthStub` helper drives the new redeem step.

## R4. Any `#auth=<token>` fragment silently replaces the stored session

Findings (2): _Any #auth=<token> fragment silently replaces the stored session (login CSRF; destroys
guest progress)_; _Client accepts any #auth=<token> fragment (login CSRF / session fixation),
silently replacing and losing the victim's guest account_.

**Decision.** The fragment is bound to a flow this browser started:

- Before navigating to `/start`, the client stores a random nonce in `sessionStorage`
  (`gamez.oauth.nonce`) and passes it as `?n=`.
- The server seals `n` into the `gz_oauth` state and echoes it in every fragment it produces
  (`#auth=..&n=..`, `#oauth_link=..&n=..`, `#auth_error=..&n=..`).
- `consumeAuthFragment` always strips the fragment, but accepts a token (or link code) only when
  `n` equals the stored nonce. It then removes the nonce.
- `n` must be 16 to 64 characters of `[A-Za-z0-9_-]`. A missing or unknown nonce means the fragment
  is dropped, with a neutral toast.
- Defence in depth: before `setSession` replaces a **guest** session with a different account, the
  old guest token is copied to `gamez.guest.prev.v1`, so it can be recovered.

**Consequences.** A sign-in started in another tab or browser fails safely ("sign-in expired, try
again").

## R5. Per-email lockout lets anyone lock any email account permanently

Finding (1): _Per-email lockout lets anyone permanently lock any email account, with no recovery
path_.

**Decision.** Lockout is per (login, client). `client` is the request's `cf-connecting-ip`, passed
by the Worker to `IdentityDO.checkPassword(password, client)` and stored only as a SHA-256 prefix.

- The identity's SQLite has an `attempt` table with columns `(client_hash PK, failures,
  locked_until, last_at)`. It is capped at 1000 rows: when it's full, the oldest `last_at` row is
  evicted.
- The existing `lockoutMs` schedule applies per client. A success clears only that client's row.
- The row-level `identity.failures` and `locked_until` columns are no longer read, so existing
  locks are released.
- A correct password from a client that hasn't failed always works.

**Consequences.** An attacker spread over many IPs gets 5 guesses per IP. PBKDF2 and the
per-isolate IP limiter mitigate that, and it's an accepted trade-off against a trivial permanent
DoS. A password reset is still future work.

## R6. Shop buy saga can be driven twice at once (double-booked earnings)

Finding (1): _Concurrent runs of the same shop buy saga add the sale price to the owner's earnings
twice_.

**Decision.**

- **Per-op serialisation.** `ShopBook` keeps an in-memory `Map<opKey, Promise>`. `#run(key)`
  returns the in-flight promise when one exists, and `buy()`, `drive()` and the other entry points
  go through it.
- **Compare-and-set booking.** The transaction that adds `gross` and `tax` first re-reads the op row
  and books only if it is still in step `debited` and the entry still exists. It moves the step
  forward in the same transaction. Otherwise it books nothing and returns the stored outcome.

## R7. Market sagas can be driven twice (alarm plus request) and a stale save revives a saga

Finding (1): _Market sagas can be driven twice at once (alarm plus request), and a stale #save brings
back a finished saga_.

**Decision.**

- **Per-listing serialisation.** `MarketBook` keeps an in-memory `Map<listingId, Promise>`. User
  paths and `tick()` await the existing drive.
- **Compare-and-set saves.** `#save` updates only when `busy_json` still equals the saga JSON the
  step started from (`UPDATE … WHERE id = ? AND busy_json = ?`). A step whose save changes no row
  stops, and leaves the listing to whoever owns it.

## R8. Gzip bomb in `unpackSnapshot`

Findings (2): _Import decompresses client gzip with no size limit (gzip bomb crashes the
InstanceDO)_; _unpackSnapshot inflates client-supplied gzip with no output limit (decompression bomb
in the InstanceDO)_.

**Problem (round 2).** A reader-side byte cap on `DecompressionStream` is not a memory bound in
workerd: its native inflater expands a whole input chunk before the reader can stop it (measured:
815 KB of base64 peaked at 688 MB RSS before "too large"). Even a correct 8 MiB cap allowed a ~12 KB
gzip of `[{},{},...]` (2.8M objects) that `JSON.parse`, `createSim`, `snapshot()` and the validation
clone amplify past 1 GB. A real classic save is about 3 KB, 500 JSON nodes, depth 7.

**Decision.**

- The server never inflates client data. `VerifiedHost.#import` refuses `enc: "gzip64"` with
  `import_rejected` "compressed saves are not accepted" and no longer calls `unpackSnapshot`. The
  client's `importSave` always sends `enc: "json"`, which the 900 KiB `MAX_VERIFIED_CLIENT_FRAME`
  cap and the frame-level `JSON.parse` already bound.
- Before any restore or clone, the host checks `jsonWithinLimits(snapshot)`
  (`@gamez/protocol`): at most `MAX_IMPORT_SNAPSHOT_NODES` (50,000, about 100x a real save) JSON
  nodes and `MAX_IMPORT_SNAPSHOT_DEPTH` (32) levels. The walk is iterative and stops at the first
  node over a limit. A save over either limit gets `import_rejected` "the save is too large". The
  client runs the same check (and the frame-size check) before sending.
- `unpackSnapshot` keeps its streamed 8 MiB cap, but is documented as for server-sent (trusted)
  snapshots only.

**Consequences.** A legacy save over 50,000 nodes or the 900 KiB frame cannot be imported; no real
save is near either. Old clients that gzip a save above 256 KB get `import_rejected`. Tests:
`verified-host.test.ts` ("refuses gzip-packed saves without inflating them", "refuses an under-cap
save whose structure would amplify in memory"), `packages/protocol/tests/verified.test.ts`
(`jsonWithinLimits`), `verified-connection.test.ts`, and the e2e `security` feature (both bombs).

## R9. Chat block messages: no rate limit and no cap

Finding (1): _Chat block messages have no rate limit and no cap, so the shared global ChatChannelDO
grows without bound_.

**Decision.**

- `#onBlock` gets its own token bucket per socket (`BLOCK_RATE`: 10 burst, 1 per 2 s).
- `ChatStore.setBlockRow` enforces `BLOCK_LIMIT` (200) per blocker in the channel's storage and
  answers `block_limit` without writing.
- Unblocking always works.

**Problem (round 2).** Both bounds are per socket and per blocker account, and guest accounts are
free. One client could loop "mint a guest, open `/ws/chat?channel=global`, block 10 made-up ids,
close", and `chat_block` rows were never pruned, so the shared global channel still grew linearly
with the number of guests (20,000 rows from 2,000 guests with no time passing).

**Decision (round 2).** The channel's `chat_block` table is a cache of the AccountDO block lists of
the accounts that have a socket open in the channel, never a store of every account that joined.

- `ChatChannelDO.webSocketClose` / `webSocketError` call `ChatHost.socketClosed`. When that was the
  account's last open socket here, its rows are dropped (`ChatStore.dropBlocks`). Sockets the host
  closes itself (guild revoke, membership sweep) do the same.
- `open()` restores the rows from AccountDO (`mergeBlocks`, capped at `BLOCK_LIMIT`). A socket that
  closed while AccountDO answered skips the merge, so the race leaves nothing behind.
- A host start (DO restart or hibernation wake) and, at most every `BLOCK_SWEEP_MS` (5 min), a join
  drop the rows of every blocker with no open socket (`dropBlocksExcept`). This catches a close the
  runtime never reported.
- Sockets carry an `acct:<accountId>` hibernation tag, so the per-account "last socket?" check is a
  `getWebSockets(tag)` lookup, not a scan of the whole channel.
- Blocks keep working the same way. Server-side filtering (`blockersOf`, history in the welcome) only
  ever needs the rows of connected blockers, and the client also filters by its own list.

**Consequences (round 2).**

- Storage is bounded by open sockets x `BLOCK_LIMIT`. An attacker has to keep the sockets open,
  and the rows go away when they close. Rotating guests leaves nothing behind
  (`tests/chat/block-cache.test.ts`).
- A block whose AccountDO write failed ("kept locally") now lasts only until the account's last
  socket in the channel closes. Before, it lasted forever in that one channel. The client still
  holds the block until it reloads.
- Per-IP limits on guest minting and chat connects would cap the open-socket bound as well. They are
  left as a follow-up.

## R9b. Chat reports, strikes, mutes and rate buckets grow without bound

Finding (re-verification of R9): _the same bug class as R9, through reports_. `#onReport` had no
rate limit, and every (message, reporter) pair wrote a `chat_seen_report` row plus an outbox append
(one D1 `chat_report` row). Nothing deleted them, and pruning a message left its report rows behind.
2,000 free guests reporting the 200 kept messages produced 400,000 rows (27 MB) and 400,000 outbox
appends, which survived socket close, restart and sweep. `chat_strike` and `chat_mute` rows were
never pruned either, `ChatHost.#buckets` (send rate per account) never evicted, and
`#sendToAccount` scanned every socket in the channel for each frame.

**Decision.**

- `#onReport` gets a per-socket token bucket (`REPORT_RATE`: 5 burst, 1 per 5 s).
- Only the first `REPORTERS_PER_MESSAGE` (5) reporters of a message are recorded (seen row and
  outbox append). Later reports are accepted silently and write nothing: the message is already in
  the moderation queue, and the admin views (`readModeration`, `/api/admin/chat/reports`) read the
  count as "at least 5". Automatic moderation reports are separate and unaffected.
- `ChatStore.prune` (called in the same transaction as every message insert) also deletes the
  report rows of pruned messages, strikes older than `STRIKE_WINDOW_MS` (they no longer count
  toward a mute) and mutes that have ended.
- An account's send bucket is dropped when its last socket closes, if it is full again (a full
  bucket is the same as a fresh one, so reconnecting never refills a draining bucket early). The
  `BLOCK_SWEEP_MS` join sweep drops the rest.
- `#sendToAccount`, `revoke` and the membership sweep use the `acct:<id>` tag lookup
  (`socketsOf`) instead of scanning the channel.

**Consequences.** `chat_seen_report` is bounded by `RETAIN_MESSAGES` x `REPORTERS_PER_MESSAGE`
(1,000 rows), and D1 `chat_report` grows only with messages sent (at most 5 rows each), not with
reporters. Strikes and mutes are bounded by the last 24 h of moderated sends and by active mutes.
Regression tests: `tests/chat/report-limit.test.ts` (40 guests x 200 messages: 8,000 rows and
8,000 appends before, 1,000 and 1,000 after).

**Follow-up.** Per-IP rate limits on guest minting and on chat connects. They would cap how many
sockets and accounts one client can hold, which bounds the remaining per-open-socket state (R9
block rows, R9b rate buckets) and the strike rows one client can cause.

## R10. Kicked or departed guild members keep using guild chat

Finding (1): _Kicked or departed guild members keep reading and writing guild chat_.

**Problem (round 2).** Revoke-on-kick alone left three gaps: an upgrade whose membership check ran
before the kick could be accepted after the revoke (which saw no socket); a lost revoke left a
silent reader connected forever (the re-check ran only on send); and a kick retried after a failed
`releaseGuild` answered `not_found` and skipped the revoke.

**Decision.**

- After `GuildDO.kick` (also when it answers `not_found`, the retry path) or `leave`,
  routes/guilds.ts calls `CHAT.getByName("guild:<id>").revoke(accountId, reason)`, which closes the
  account's sockets with 4403 and records the departure in the channel's membership cache. A failed
  revoke is logged and doesn't fail the kick.
- `ChatHost.open` in a guild channel runs a fresh `AccountDO.guild()` lookup after the socket is
  accepted and before the welcome (history). The kick releases the slot before it revokes, so
  either the lookup sees the release (close 4403) or the revoke sees the socket. Until the lookup
  confirms, the socket gets no broadcasts; a revoke during the lookup wins over its answer. A failed
  lookup closes with 1013 (retryable).
- A guild channel with open sockets keeps a DO alarm every `MEMBERSHIP_TTL_MS` (60 s):
  `sweepMembers` looks up every connected account and closes non-members with 4403. That covers a
  lost revoke and readers who never send. A lookup failure keeps the socket until its last confirmed
  answer is `MEMBERSHIP_STALE_MS` (180 s) old, then closes it with 1013 (the reconnect re-checks).
  The alarm is shared with the outbox: `#alarmAt` only moves it earlier, and a failed outbox flush
  reschedules itself instead of relying on runtime alarm retries.
- Sends in a guild channel still re-check membership (cached 60 s).

**Consequences.** A guild channel with sockets wakes once a minute (one AccountDO RPC per connected
account). A departed member reads at most until the next sweep (60 s) if every revoke path fails.
The guild tag shown on global and mode channels is fixed when the socket opens and stays stale until
the player reconnects (cosmetic; it grants no access).

## R11. Presence pose tag bypasses chat moderation

Finding (1): _Presence pose tag is free text shown to every player in town with no word filter_.

**Problem (round 2).** A Unicode-letter pattern plus the chat word filter still relayed fullwidth,
Cyrillic and math-letter look-alikes, links with unlisted TLDs, and any insult the short word list
does not know. Pose tags get no mutes or moderator, so filtering free text cannot be made safe.

**Decision.** A client-reported tag is not free text any more. `sanitisePoseTag` relays only:

- `Lv <1..9999> <word>`, plain ASCII, where `word` is exactly one of the world's `tagWords`. For
  "classic-town" those are `PRESENCE_TAG_WORDS` from `@gamez/mode-classic` (the class names plus
  the "Hero" fallback, game data), and the classic client builds its tag with the same
  `presenceTag(level, className)`.
- The load test's `lt-<digits>` latency tag.

Anything else is dropped (the avatar shows no tag). A world without `tagWords` relays no level tags.
Operator fixtures keep the lenient `sanitiseTag`.

**Consequences.** Chat mutes do not hide tags, and need not: a tag is a level number and a class
name from game data. A mode that wants other tags must add its words to its presence world.
Tests: `apps/game/tests/presence/pose.test.ts` ("game-data vocabulary only"), including the
reviewer's look-alike and link probes.

## R12. Outbox batches have no byte limit and can jam forever

Finding (1): _Outbox batches have no byte limit: 200 market_listing records go over the 128 KB queue
limit and jam the outbox for good_.

**Decision.**

- `Outbox.flush` builds each batch by **estimated serialised size** as well as count. A record's
  estimate is its JSON length, doubled if it holds any character above U+00FF (V8 two-byte
  strings), plus overhead. Batches are cut at `maxBytes` (default 96 KiB), with at least one record
  per batch.
- A single record whose estimate is above the hard limit (120 KiB) is removed from the head and
  reported through `onOversize` (default `console.error`), so it can never block the outbox.
- If `send` throws an error that looks like "too large", the batch is retried once with half the
  records.

## R13. Sync consumer retries instantly and nothing reads the DLQ

Finding (1): _The sync consumer retries immediately and sends to a DLQ nothing reads, so append-only
read-model rows are lost for good_.

**Decision.**

- **Retry delay.** The consumer retries with exponential backoff:
  `msg.retry({ delaySeconds: min(10 · 2^(attempts-1), 900) })`. That spreads 10 retries over about
  2 hours.
- **Statement budget.** The consumer stops applying once an invocation has used its budget (800
  statements) and retries the rest with a short delay. `maxBatchSize` drops to 4, so
  4 × 201 statements fit the 1000-query limit of the paid plan.
- **A DLQ consumer** for `gamez-sync-dlq`. It re-applies batches, which is idempotent and
  version-guarded, logs every failure at error level, and retries with a 15-minute delay.
- `docs/deploy.md` creates the DLQ queue.

**Consequences.** On the free plan (50 queries per invocation), D1 apply needs a smaller
`FLUSH_BATCH`. That's noted in `docs/deploy.md`.

---

## Integration notes (round 1)

- **Bank saga logging (R2).** `VerifiedHost` passes its own logger to `refundToAccount` and
  `creditAccount`, so a conflicting refund or credit is logged at error level through the DO's
  log pipeline instead of a bare `console.error`. A re-driven take (`taking` after a crash) whose
  txId already holds another change finishes with `conflict` instead of the generic
  "interrupted" failure, and is never refunded.
- **`block_limit` (R9)** is now a member of `ChatErrorCode` in `@gamez/protocol`. The host no
  longer casts it.
- **Pose tags (R11) vs. the load test.** `TAG_PATTERN` drops any tag with `:`. The swarm's
  latency tag was `lt:<ms>`, so every tag was dropped and the e2e loadtest measured 0 deliveries.
  The tag is now `lt-<ms>` (`tools/loadtest/src/tag.ts`), and a presence test pins that it passes
  `sanitisePoseTag` unchanged.
- **e2e (`tools/e2e/src/security.ts`).** Against the real dev server: a forged save (10M gold,
  level 60) imports for solo play but the bank refuses its deposits and withdrawals, the wallet
  does not move, its D1 row keeps `imported = 1` and the level board does not list it (R1). A
  used bank opId with another op is a `conflict`, and an identical resend replays the stored
  result without moving coin (R2). `/start` without a valid nonce fails and sets no state cookie
  (R4). A 64 MiB gzip bomb import is rejected as unreadable and the instance keeps answering
  (R8). The R3 link-CSRF checks live in `auth.ts` §7b. The leaderboards e2e ranks against
  non-imported rows only, like the board.
- `packages/sync` tests type `node:v8` through `tests/node-sqlite.d.ts` (no `@ts-expect-error`).

## Integration notes (round 2)

- **R8, R10 and R11 were reworked** (see their "Problem (round 2)" paragraphs). The round-1 e2e
  checks still hold. The gzip check now expects "compressed saves are not accepted", and an
  amplifying plain-JSON save (about 290k empty objects, under the frame cap) must be refused with
  "the save is too large" before any restore.
- **e2e (R10).** `security.ts` "guild kick closes chat": a registered member with an open
  `guild:<id>` chat socket is kicked through `POST /api/guilds/kick`. A line the leader posts right
  after the kick (and that is acked) must never reach the kicked socket, and the socket must close
  with 4403. In local dev, workerd delivers a close that a hibernatable DO socket sends from an RPC
  (the revoke) only about 10 s later (measured: 10.07 s, while frames sent just before it arrive at
  once). The revoke still takes effect immediately on the server: the host marks the socket closed,
  ignores its frames and leaves it out of broadcasts. So the e2e checks delivery right away and
  allows 25 s for the close code.
- **e2e (R11).** `classic-presence.ts`: a pose tagged `"Lv 3 visit evil.example"` reaches the other
  player without a tag, and `"Lv 3 Warrior"` still goes through.
- Both e2e additions were run against a dev server with each fix temporarily reverted (the kick's
  `revokeGuildChat` call, and `sanitisePoseTag` swapped for the old `sanitiseTag`). The three new
  checks failed (the tag was relayed, the kicked member received the line, and the socket stayed
  open), then passed with the fixes restored.
- **R4 in the browser.** The fragment's nonce check (`consumeAuthFragment`) runs only in the SPA,
  so it is covered by client unit tests (`tests/client/session.test.ts`,
  `tests/client/app.fragments.test.ts`). The e2e covers the server side: `/start` refuses a missing
  or malformed nonce and echoes a valid one in the fragment.
- `tools/loadtest/src/tag.ts` documents that its `lt-<digits>` tag must match
  `LATENCY_TAG_PATTERN`.

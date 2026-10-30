# ADR 0006: Wave C: player economy, async arena, payments, live ops and shipping

- Status: accepted (wave C)
- Date: 2026-10-28

Wave C adds a player-driven economy, async PvP and the pieces needed to ship. The economy is a
bank between the classic hero and the account, a vault, direct trade, an auction house and leased
player shops. The arena is an async ladder. Shipping means payments, a battle pass, live-ops flags
and telemetry, a PWA with native shells, and presence sharding. Design, ownership and contracts are
in [`docs/design/wave-C.md`](../design/wave-C.md). This ADR records the decisions later waves
build on, with the numbers behind them.

## 1. All value that crosses players lives in AccountDO

Coin and the **vault** live in the player's `AccountDO`. The vault is the wave B stash plus an item
payload, `tradable`/`universal` flags and a display summary. Trade, the market and shops only move
coin and vault items. Modes never transfer to each other directly: a classic hero reaches the vault
only through the **bank**.

- The vault table is now keyed by `uid`, which comes from a counter and is never reused. The wave B
  key `(item_id, origin)` could not hold two classic items with the same base. `AccountEconomy.init()`
  rebuilds a wave B table once and keeps every row. `vaultPut` never merges stacks. The vault holds
  at most 200 items.
- `walletTx` writes the ledger row and the `economy_ledger`/`account_wallet` outbox rows in one
  transaction. A replayed txId writes nothing. Every AccountDO write now schedules an outbox
  flush, including the wave B `applyWalletTx`/`stashAdd`/`grantEntitlement`.

## 2. The bank is a server-only action applied at a verified tick

The hero lives in a client-driven sim (ADR 0005 §1), so the server can change it only at a
verified tick, and the client must replay that change identically. A bank op is sent on the
verified socket, in order with segments. The client cuts a segment and **pauses** its sim. The
`InstanceDO` dispatches the server-only action `classic.bank` (actor `BANK_ACTOR`) on the verified
sim, then answers with `applied {tick, name, payload, hash}`. The client applies the same dispatch
outside its recorder and checks the hash. A mismatch, a late answer or an 8 s timeout triggers a
rejoin, and the rejoin resyncs. When the client's `at` is not the verified state, the server takes
the slow path: it applies the op, sends `resync {code:"bank"}`, then the answer. The client adopts
that resync quietly.

- **The saga is idempotent by opId** (`bank_op` table: `taking → applied → crediting → done`, or
  `refunding`).
  - Withdrawals take from the account first, then refund if the dispatch fails.
  - Deposits dispatch first, then commit the new base snapshot and the op row in one transaction,
    then credit.
  - The InstanceDO alarm re-drives every pending op.
  - A reused opId with a different op answers `conflict`.
- **Gold converts to coin at the bank with a 5 % fee (minimum 1).** It is the first gold sink
  outside the classic NPCs. Coin is the one currency of trade.
- **Season progress and arena builds come from verified state.** After each compaction the host
  reports `seasonTotal` (monotonic, so retries are safe). `exportBuild` maps the verified hero to
  an `ArenaBuild`.

## 3. Custody instead of holds

Escrow, the market, plots and shops each **debit into their own custody** with idempotent txIds
(`trade:<id>:…`, `mk:<id>:…`, `plot:<world>/<plot>:…`, `shop:<world>/<plot>:…`) and refund on
failure. AccountDO has no hold state. Every in-flight saga is persisted before each call and
re-driven from the DO alarm. An object in a saga carries a persisted lock: concurrent requests
answer `busy` (409) instead of interleaving across awaits.

- Trade tests inject a failure and a crash (before and after the call) at every custody and
  delivery step. In every case the total of coin, fees burnt and escrow, and the multiset of items,
  are conserved.
- Market buy txIds get a generation suffix after an aborted buy (`mk:<id>:buy.<gen>`), so a retry
  does not replay the refunded debit.
- Delivery and refund retries back off from 5 s up to 1 h. Value stays in custody meanwhile.

## 4. Who may trade, and the sinks

- **Trading needs a registered account.** This blocks multi-account farming. Guests can browse the
  market, shops and ladders, and can use the bank.
- **Sinks** (`@gamez/economy` `fees.ts`):
  - auction house: a 2 % listing fee and a 5 % sales tax;
  - player shops: a 3 % tax;
  - direct trade: a 2 % fee on coin sent;
  - plots: the winning bid is burnt (an outbid bid is refunded as a positive "sink" entry, so the
    net sink is exactly the winning bid), plus rent per period;
  - the bank's 5 % deposit fee;
  - premium pass bought with gems (the first gem sink).
- The arena's coin reward is the only new coin faucet besides the bank, and it is capped by
  `FIGHTS_PER_DAY`.

## 5. Market: sharded by scope and category, searched in D1

There is one `MarketDO "<scope>:<category>"` per shard. Listings are per item, with buyout and
bids. There is no commodity order book. A bid within 5 minutes of the end extends the auction by
5 minutes. Search and "mine" read the `market_listing` D1 projection and are display only: buying
and bidding always go to the shard DO. Without the table, search answers `available:false`
instead of 500.

## 6. Shops: auctioned leases, rent, ghost shopkeepers as presence fixtures

`PlotAuctionDO "classic-town"` auctions 8 plots on the town's east road (`shared/plots.ts`):

- The winner gets a lease and pays rent each period. A missed payment opens a grace period, and
  when grace runs out the plot is repossessed: stock goes back to the vault and earnings are paid
  out.
- One plot per account.

`ShopDO "<world>/<plot>"` holds the stock in custody and keeps selling while the owner is offline.
Leased plots appear in the town as **presence fixtures**: `ChunkDO.setFixtures("shops", …)`
persists them and sends them like avatars with kind `"shopkeeper"`. `join`, `pose` and `leave`
cannot touch a fixture. Tapping one opens the shop. A dev clock offset (`/api/dev/shops/advance`)
drives the lease lifecycle in e2e and QA.

## 7. Arena: async ghosts, one ladder DO per mode and season

`@gamez/mode-arena` is a deterministic 10 Hz one-dimensional lane auto-battle of two
`ArenaBuild`s:

- `fight(a, b, seed)` is pure. The pinned case (warrior vs rogue, seed 42) ends with the defender
  winning in 233 ticks, hash `41b3d3cf7704bf65`.
- Mirror fairness: warrior vs warrior over 200 seeds went attacker 86, defender 83, draws 31, a
  51.0 % attacker share.

`ArenaDO "<mode>:<seasonId>"` keeps a ghost pool, Elo ratings and queue tickets:

- Two waiting tickets within the rating band fight each other.
- A ticket older than 3 s fights a seeded ghost from a widening band.
- With an empty pool, the player fights an unrated "Sparring Shade" built at 90 % of their own
  stats.

Matches store the seed, both builds and the `contentHash`. The client re-runs `fight()` to replay a
match, and shows only the result when the hash differs. Reward and notice retries back off
exponentially (1 s doubling to 5 min, 30 attempts). **Real-time PvP (rollback) remains out of
scope**: the ladder DO is per ladder, not per match.

Known balance issue: a Cleave + Mend warrior beats a plain warrior 200-0. Skill power needs tuning
before the arena counts for anything.

## 8. Battle pass, store and payments

- **Season `2026-s1` "Season of Embers"** (`@gamez/economy` `season.ts`) has 30 tiers, a free track
  and a premium track. Every reward is a cosmetic entitlement `cosmetic.<CosmeticSlot>.<slug>`.
  XP comes from verified classic progress (`seasonProgress`, monotonic per source) and arena
  matches (`addSeasonXp`, idempotent per match).
- **One `PaymentProvider` interface** with Stripe, Asaas, Mercado Pago and a sandbox stub. The stub
  runs on dev hosts or with `PAYMENTS_STUB=1` and uses a local checkout page with a signed
  self-webhook. Routing goes by country. Webhooks are verified before anything in them is read.
  Fulfilment and refund are idempotent by orderId, so a replayed webhook does nothing.
- **A refund revokes, it does not delete.** It sets `entitlements.revoked_at`. Revoked grants stop
  counting as owned (cosmetics, the premium pass) but stay for audit. Gems are debited down to 0 at
  most.
- **Stripe refunds** do not carry the payment intent's metadata, so the order is looked up
  through the payment intent after the signature is verified.
- **Secrets stay undeclared** in `cloudflare.config.ts`, except `AUTH_SECRET`. A local probe
  confirmed that undeclared `.dev.vars` keys do not reach `env` in `vp dev`, which settles the
  ADR 0005 §10 question. `bindings.secret()` declares a _required_ secret, so declaring the
  optional provider keys would make every deploy need them. Dev hosts use the stubs instead, and
  [`docs/secrets.md`](../secrets.md) shows how to declare a key to test a real provider locally.
- Not built: App Store, Play and Steam billing (documented in [`docs/ship.md`](../ship.md)).

## 9. Live ops: fail-open feature flags, telemetry in D1

- **Feature flags** live in `ConfigDO "global"`, with an audit log. Routes read them through
  `config/flags.ts` with a 10 s isolate cache. **If ConfigDO fails, the defaults apply and every
  feature is on.** A flag is a kill switch, not a gate that a ConfigDO outage could close.
- **Telemetry convention.** `economy_ledger` stores signed wallet deltas tagged
  `faucet | sink | transfer`. The sink total is −Σ amount over `flow = sink`, so a refunded sink
  is a positive sink entry and nets out. The dashboard derives money supply, faucets vs sinks per
  day and reason group, and a daily median price index per category from D1. Pipelines to R2 is
  the scale path; it is not built.
- Admins are `ADMIN_ACCOUNT_IDS` plus admins granted on dev hosts (stored in ConfigDO).
  `GET /api/admin/me` lets the dashboard ask before any admin call.

## 10. Shipping: PWA in production builds only; native shells documented

The service worker (`public/sw.js`) uses a versioned cache:

- the shell is precached;
- `/assets` and `/art` are cache-first;
- `/api` and `/ws` are network-only;
- navigations go network-first, with the cached shell as the offline fallback.

The worker registers **only in production builds**, never on the Vite dev server, where it would
fight HMR. Capacitor and Electron shells under `apps/native` are not workspace packages; nothing in
them is installed or built in CI. See [`docs/ship.md`](../ship.md).

## 11. Presence at scale: sharded relays, no chunk grid yet

Bench: [`docs/bench/2026-10-waveC-presence.md`](../bench/2026-10-waveC-presence.md). It is local
workerd on one thread, so the numbers are a floor, not a production forecast.

- **Relays are sharded** per pose world (`relayShards`: 4 for `classic-town`, 1 for the plaza,
  which keeps its legacy name), by a stable FNV-1a hash of the account id.
- **Measured.** At 3 poses/s per bot, the production bundle delivered at p95 65 ms with 50 bots and
  189 ms with 100 bots, then saturated at 150 bots (1.07 s). The chunk still ingested 412-578 of
  450-600 poses per second there. The time goes to relay broadcast (N²) and client downlink
  (about 1 KB/s per moving player in JSON).
- **The swarm found and fixed three bottlenecks:**
  - a SQLite write per pose: pose worlds are now in memory and written at join only;
  - no backpressure: the chunk now keeps one delta in flight;
  - a storage read and a chunk call per relay message: now cached and sent in batches.
    At 50 bots on the dev server, p95 went from 1517 ms to 201 ms.
- **No chunk grid or area of interest yet.** Build a static 12-tile grid with 3×3 subscriptions
  when any of these hold: a production ChunkDO uses more than about 50 % CPU, more than about 150
  players move at once in one pose world, or client downlink in a town exceeds about 64 KB/s. The
  next cheap step is the binary codec, which is 2.24× smaller.

## 12. Test isolation

E2e servers persist into `/tmp/gamez-e2e-state-<port>`, a private DO/D1 and Vite dep-cache
directory, wiped at the start of each run. `apps/game/vite.config.ts` reads `GAMEZ_PERSIST_STATE`
and `GAMEZ_VITE_CACHE_DIR`. They no longer share SQLite files or the dep-optimizer cache with the
live dev server on :5173. Sharing caused `SQLITE_BUSY` during the swarm and 504 "outdated
optimize dep" answers in the client module-graph check.

## 13. Consequences and open items

- `vault-codec.ts` (sim code) imports the pure formatters `itemLines`/`STAT_TEXT` from
  `modules/classic/src/client/describe.ts`. Moving them, and `hud/format.ts`, into a non-client file
  would put them under the determinism lint. They only produce display text.
- ~~The arena pays rewards only to the attacker. A live defender spends a daily fight and earns
  nothing.~~ Resolved in arena.core 1.1.0: a live defender's daily fight is refunded (no new
  faucet). Arena balance and the remaining class gap: [docs/bench/2026-10-arena-balance.md](../bench/2026-10-arena-balance.md).
- `BankResult.balance` is 0 when the wallet cannot be read after a provisional deposit credit. The
  re-drive credits it later.
- A trade, market, shop or bank delivery blocked by a full vault retries indefinitely, at most
  hourly. Since the payments-verify change the caller passes `{ waiting: true }` to `vaultPut`;
  AccountDO lists the delivery in `vault_waiting` (shown as a banner in the vault view,
  `VaultResponse.waiting`) and sends one `vault.full` notice per full spell (toasts, opens the
  vault). A put that gives up at once (a market buy refunded, a shop purchase or unstock) is not
  listed.
- `VerifiedWebhook` carries `paid` (provider-reported currency and minor units). `fulfillOrder`
  grants only when it equals the order's price and the event comes from the order's provider;
  otherwise the order fails with an admin-visible `fail_reason` and grants nothing
  (`docs/secrets.md` "Paid amount check").
- `EscrowDO` calls `AccountDO.linkTrade` directly. That call is not part of the `AccountGateway`
  contract.
- The battle-pass and arena-build pins are sensitive to classic balance and RNG use. They must be
  re-pinned together with the classic content hash.

## 14. Final QA fixes

- **Presence join pose.** `PresenceClient.setPose` dropped poses until the welcome, so a hero
  that stood still after (re)joining town never sent a pose and stayed invisible (no tag) to
  others. The client now keeps the latest pose and sends it with every welcome. The town also
  re-reports an unchanged pose every 10 s (`POSE_KEEPALIVE_MS`), so a hero the server dropped
  (relay given up on, chunk restarted) gets "not-joined" and is rejoined. The chunk answers such
  keepalives without a delta (`sameStanding`), so they cost no fan-out.
- **Entry bundle.** The shell loads economy and play views from `@gamez/ui-host/economy` and
  `@gamez/ui-host/play`; the ui-host root re-exports their types only. The entry graph went from
  1,644,899 B to 1,321,208 B (wave B: 1,276,596 B). The remaining +3.5 % is accepted
  (`docs/ship.md` §1.9).
- **Gem flows.** The admin faucets/sinks chart reads coin rows only (gem purchases and the
  premium pass are gem flows), and the dashboard shows a per-source breakdown of the window.
- **Premium pass for gems.** Registered-only (guests 403 `guest_forbidden` before any charge),
  and reachable from the pass sheet ("Unlock for 500 gems", with the balance).

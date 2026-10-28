# Wave C — economy, arena, ship (design)

Status: **implemented and integrated** (2026-10-28, on top of commit b9d157a). Decisions are
recorded in [ADR 0006](../adr/0006-economy-arena-ship-wave-c.md); where the built code differs
from this text (stash rebuilt keyed by uid, market buy txId generations, shop payout txIds
`…:claim:<n>`/`…:tax:<n>`), the ADR and the code win.
Read first: `AGENTS.md` (rules, determinism §6, server recipes §11, economy rules), the plan
`~/.claude/plans/we-are-trying-to-parallel-wombat.md` (§2 DO topology, §5 economy, §10 payments,
§11 roadmap phases 3, 4 and 6), `docs/design/wave-B.md` (verified host, AccountDO, outbox, routes),
`docs/adr/0005-platform-wave-b.md`, `tools/qa/README.md`.

Goal: the game gets a **player-driven economy** (bank between hero and account, direct trade
through escrow, an auction house, leased player shops in the classic town), **async PvP** in an
instanced arena with a ladder, and it becomes **shippable**: PWA, native shells, payments behind
one provider interface, a battle pass, a live-ops dashboard with feature flags, and a presence
load test with relay sharding. Ping still never affects play: classic keeps simulating locally;
every economy action is an explicit, idempotent server operation.

---

## 0. Scope

### 0.1 In scope

1. **Bank** (§2): classic hero ⇄ account. Gold → coin (5 % fee, sink), coin → gold, hero items ⇄
   account vault, over the verified socket, applied by the InstanceDO at a verified tick.
2. **Vault, notices, direct trade** (§3): the AccountDO stash becomes the vault (item payload,
   tradable/universal flags, summary); an inbox of notices; EscrowDO two-party trade saga.
3. **Auction house** (§4): MarketDO per shard, listing fee + sales tax, buyout and bids,
   expiry, D1 search projection, price index.
4. **Shop plots and player shops** (§5): PlotAuctionDO per town (lease auctions, rent, grace,
   repossession), ShopDO per plot (custody stock, earnings while offline), ghost shopkeepers as
   presence fixtures in the classic town.
5. **Arena** (§6): `@gamez/mode-arena` deterministic auto-battle of two ArenaBuilds; ArenaDO
   ladder per mode and season (ghost pool, Elo, queue tickets, rewards); client replay.
6. **Battle pass** (§7): seasons in `@gamez/economy`, progress from verified play and arena,
   free + premium tracks, cosmetic rewards, premium via store or gems.
7. **Store and payments** (§8): one `PaymentProvider` (Stripe, Asaas, Mercado Pago, sandbox stub),
   verified webhooks, idempotent fulfilment in AccountDO.
8. **Live ops** (§9): ConfigDO feature flags, admin economy telemetry (money supply, faucets vs
   sinks, price index), moderation queue, admin dashboard.
9. **Ship** (§11): PWA (manifest, service worker, offline shell, installable), Capacitor and
   Electron shells under `apps/native` with build docs.
10. **Scale** (§12): bot-swarm presence load test, sharded relays, chunk fixtures, results in
    `docs/bench`, chunk splitting only if the numbers need it.
11. UI for all of it (§10), e2e (§13), QA (§14).

### 0.2 Out of scope (explicitly)

- Real-time PvP with rollback netcode (plan §3.8): wave C arena is async (ghosts). ArenaDO is
  named per ladder, not per match; a per-match live ArenaDO comes with real-time PvP.
- Party dungeons and lockstep (plan §3.7), professions/crafting markets, guild banks, mail.
- Commodity order books (the AH has per-item listings with buyout/bids only).
- Tradability rules by tier (plan §14): the `classicTradable()` hook returns true for every item.
- Moving universal items between _different_ modes (no second mode produces items yet); the rule
  is implemented (withdraw checks `universal || origin === mode`), the transfer fee is not.
- RevenueCat / App Store / Play Billing / Steam microtransactions: documented in `docs/ship.md`,
  not implemented. Sign in with Apple stays a stub (carry-over).
- Pipelines → R2 telemetry (D1 tables are used; noted as the scale path).
- Dynamic quadtree chunk splitting: only a static grid, and only if §12's bench requires it.
- Classic balance carry-overs from wave A (they change content hashes).

---

## 1. Ownership and parallel tasks

Contract files (architect; read-only for builders unless your row lists them — report contract
bugs instead of editing, or work around locally and say so):

```
packages/protocol/src/{economy,verified,messages,binary-codec,index}.ts  (codec: T-scale may edit)
packages/kernel/src/types.ts (PlatformHooks)
packages/ui-host/src/{platform,types,index}.ts, packages/ui-host/src/{economy,play}/index.ts (props)
modules/economy/src/{index,fees,market,lease}.ts (implemented), modules/arena/src/{index,mode}.ts
modules/classic/src/platform/{policy,bank}.ts (ids, data, event shape), modules/classic/src/{ids,actions,index}.ts
modules/classic/src/client/contract.ts (BankClient, BankView, PanelId "bank", openScreen)
apps/game/src/server/{contracts,projections,index}.ts, apps/game/src/server/routes/index.ts
apps/game/src/server/do/account.ts, apps/game/src/server/economy/{gateway,guards}.ts
apps/game/src/server/config/flags.ts, apps/game/src/server/payments/provider.ts
apps/game/cloudflare.config.ts, apps/game/migrations/0006-0009, apps/game/src/shared/plots.ts
apps/game/src/client/platform/{index,pending}.ts
tools/e2e/src/features.ts, tools/qa/src/waveC/index.ts, tools/qa/src/run.ts (wiring lines)
```

| Task         | Model | Owns (disjoint)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-bridge     | Opus  | `modules/classic/src/platform/{bank,vault-codec}.ts` (bodies only), `modules/classic/tests/platform.bank*.test.ts`, `apps/game/src/server/instance/**`, `apps/game/src/server/do/instance.ts`, `apps/game/src/client/instance/**`, `modules/classic/src/client/{index,game}.ts`, `modules/classic/src/client/sync/**`, `apps/game/tests/instance/bank*.test.ts`, `modules/classic/tests/client.bank*.test.ts`, `tools/e2e/src/waveC/bank.ts`                                    |
| T-escrow     | Opus  | `apps/game/src/server/account/{economy,vault,notices}.ts`, `apps/game/src/server/trade/**`, `apps/game/src/server/do/escrow.ts`, `apps/game/src/server/routes/{vault,trade}.ts`, `apps/game/tests/account/vault*.test.ts`, `apps/game/tests/account/notices*.test.ts`, `apps/game/tests/trade/**`, `apps/game/tests/support/fake-gateway.ts`, `tools/e2e/src/waveC/trade.ts`                                                                                                    |
| T-scale      | Opus  | `apps/game/src/server/do/{relay,chunk}.ts`, `apps/game/src/server/presence/**`, `apps/game/src/server/routes/presence.ts`, `apps/game/src/shared/worlds.ts`, `packages/protocol/src/{binary-codec,json-codec}.ts`, `packages/protocol/tests/**`, `apps/game/tests/presence/**`, `tools/loadtest/**`, `docs/bench/*waveC*`, `tools/e2e/src/waveC/loadtest.ts`                                                                                                                    |
| T-market     | Haiku | `apps/game/src/server/market/**`, `apps/game/src/server/do/market.ts`, `apps/game/src/server/routes/market.ts`, `apps/game/tests/market/**`, `tools/e2e/src/waveC/market.ts`                                                                                                                                                                                                                                                                                                    |
| T-shops      | Haiku | `apps/game/src/server/shops/**`, `apps/game/src/server/do/{plots,shop}.ts`, `apps/game/src/server/routes/shops.ts`, `apps/game/tests/shops/**`, `tools/e2e/src/waveC/shops.ts`                                                                                                                                                                                                                                                                                                  |
| T-arena-sim  | Haiku | `modules/arena/**` (except `src/index.ts` exports contract), `modules/classic/src/platform/build.ts`, `modules/classic/tests/platform.build*.test.ts`, `tools/qa/src/waveC/arena.ts`                                                                                                                                                                                                                                                                                            |
| T-arena      | Haiku | `apps/game/src/server/arena/**`, `apps/game/src/server/do/arena.ts`, `apps/game/src/server/routes/arena.ts`, `modules/economy/src/rating.ts`, `modules/economy/tests/rating*.test.ts`, `apps/game/src/client/platform/arena.ts`, `apps/game/tests/arena/**`, `tools/e2e/src/waveC/arena.ts`                                                                                                                                                                                     |
| T-pass       | Haiku | `modules/economy/src/season.ts`, `modules/economy/tests/season*.test.ts`, `modules/classic/src/platform/season.ts`, `modules/classic/tests/platform.season*.test.ts`, `apps/game/src/server/account/pass.ts`, `apps/game/src/server/routes/pass.ts`, `packages/ui-host/src/play/BattlePassView.tsx`, `packages/ui-host/tests/pass*.test.tsx`, `apps/game/src/client/platform/pass.ts`, `apps/game/tests/pass/**`, `tools/e2e/src/waveC/pass.ts`                                 |
| T-pay        | Haiku | `apps/game/src/server/payments/**` (except `provider.ts`), `apps/game/src/server/account/purchases.ts`, `apps/game/src/server/routes/store.ts`, `modules/economy/src/products.ts`, `modules/economy/tests/products*.test.ts`, `packages/ui-host/src/play/StoreView.tsx`, `packages/ui-host/tests/store*.test.tsx`, `apps/game/src/client/platform/store.ts`, `apps/game/tests/payments/**`, `docs/secrets.md`, `apps/game/.dev.vars.example`, `tools/e2e/src/waveC/payments.ts` |
| T-admin      | Haiku | `apps/game/src/server/admin/**`, `apps/game/src/server/do/config.ts`, `apps/game/src/server/routes/admin.ts`, `modules/economy/src/telemetry.ts`, `modules/economy/tests/telemetry*.test.ts`, `apps/game/src/client/admin/**`, `apps/game/src/client/platform/config.ts`, `apps/game/tests/admin/**`, `tools/e2e/src/waveC/admin.ts`, `tools/qa/src/waveC/admin.ts`                                                                                                             |
| T-econ-ui    | Haiku | `packages/ui-host/src/economy/**` (except `index.ts` props), `packages/ui-host/tests/economy*.test.tsx`, `apps/game/src/client/platform/{vault,trade,market,shops}.ts`, `apps/game/tests/client/platform.economy*.test.ts`                                                                                                                                                                                                                                                      |
| T-shell      | Haiku | `apps/game/src/client/app/**`, `apps/game/src/client/modes/index.ts`, `apps/game/tests/client/app*.test.ts(x)`, `tools/qa/src/waveC/shell.ts`                                                                                                                                                                                                                                                                                                                                   |
| T-classic-ui | Haiku | `modules/classic/src/client/hud/**`, `modules/classic/src/client/presence/**`, `modules/classic/src/client/input.ts`, `modules/classic/tests/hud.economy*.test.tsx`, `modules/classic/tests/client.presence*.test.ts`, `tools/qa/src/waveC/classic.ts`                                                                                                                                                                                                                          |
| T-ship       | Haiku | `apps/game/public/{manifest.webmanifest,sw.js,icons/**}`, `apps/game/index.html`, `apps/game/src/client/main.ts`, `apps/game/src/client/pwa/**`, `apps/game/tests/client/pwa*.test.ts`, `apps/native/**`, `tools/pwa/**`, `docs/ship.md`, `tools/qa/src/waveC/pwa.ts`                                                                                                                                                                                                           |

### 1.1 Rules for every builder

1. Only touch owned paths. Everyone works in the same tree at the same time and the user's live
   dev server on :5173 hot-reloads it: **every saved file must compile**. Write new code in new
   files, wire it last. Never kill or restart anything on :5173. Always use
   `/home/mariogk/Projects/gamez/node_modules/.bin/vp`.
2. Sim code stays deterministic (AGENTS.md §6): `modules/arena/src/**` (not `client/`), the
   classic platform files, `modules/economy/src/**` (no `Date`: callers pass `now`).
3. Migrations 0001-0009 exist; never edit them. A needed column = report it (the integrator adds
   0010+). Projections in `projections.ts` are fixed; report a needed change.
4. Classic content hash: `classic.platform` 1.0.0 is in the mode already (pins updated). Do not
   add registry data, setup or systems to it, and do not bump any classic module version.
5. Credentials: real implementation behind optional env (contracts.ts `Env`), a working local
   stub, secrets in `docs/secrets.md` (T-pay writes it; others report rows).
6. E2E: `flock /tmp/gamez-e2e.lock env E2E_PORT=<port> E2E_LOG=/tmp/gamez-e2e-<task>.log
   node_modules/.bin/vp run e2e`. Ports: T-bridge 5401, T-escrow 5402, T-scale 5403,
   T-market 5404, T-shops 5405, T-arena 5406, T-pass 5407, T-pay 5408, T-admin 5409. Your
   feature must pass; others may still print SKIP.
7. Gate: `node_modules/.bin/vp check` 0 errors in your files, your tests pass, user-visible work
   has a QA run with screenshots (`node tools/qa/src/run.ts <scenario>`, output under
   `/tmp/gamez-qa/waveC-<task>-…`). Report honestly with numbers. Nobody commits; the final
   fixer does `git add -A && git commit`.
8. Every wave C DO keeps its logic in a class taking `SqlStore`, `AccountGateway`, `Outbox` and a
   clock, tested with `FakeSqlStorage` (`apps/game/tests/support/fake-sql.ts`) and an in-memory
   gateway (`apps/game/tests/support/fake-gateway.ts`, written first by T-escrow; until it lands
   write a local fake in your test folder).

### 1.2 Route conventions (all wave C routes)

- `economyCaller(c, flag, { write })` (`economy/guards.ts`): flag check (503 `disabled`), auth
  (401), and for writes registered accounts only (403 `guest_forbidden`: trading needs an
  account — anti multi-account farming). Guests may browse market/shops/ladders and use the bank.
- Every mutating body has `opId` (`isOpId`), the idempotency root of every txId the DO derives.
- DO results are `EconResult<T>`; map failures with `statusOf(code)`; body `{error:{code,message}}`.
- Bodies via `readJson` (16 KB cap); integers via `isAmount`.

---

## 2. Bank: hero ⇄ account (T-bridge)

### 2.1 Why over the verified socket

The hero lives in a client-driven sim verified by `InstanceDO "classic:<accountId>"`. A server
change to it must happen at a verified tick and be replayed identically by the client, or the
next segment fails. The bank op therefore travels on the same socket as segments, in order, and
is applied as a **server-only action** (`classic.bank`) by the host, exactly like offline grants.

### 2.2 Protocol (`protocol/verified.ts`)

client `{t:"bank", opId, op: BankOp, at:{tick,hash}}` → server, after every earlier frame:

- fast path: `at` equals the verified tick/hash → dispatch `classic.bank` (actor `BANK_ACTOR`
  "server") on the verified sim, persist, answer `{t:"bank", opId, result, applied:{tick, name,
  payload, hash}}`; the client dispatches the same `(name, payload)` on its **paused** sim and
  checks `hash` (mismatch → rejoin, which resyncs).
- slow path: otherwise apply at the verified state, epoch++, send `resync {code:"bank"}` with the
  snapshot first, then `{t:"bank", …, applied:null}`.
- failures: `{t:"bank", opId, result:{ok:false, code, message}, applied:null}`; sim untouched.

`BankOp`: `depositGold {gold}`, `withdrawCoin {coin}`, `depositItem {ref}` (classic item uid in bag
or stash), `withdrawItem {uid}` (vault uid). `BankResult` carries coin/gold moved, the vault item
and the new coin balance.

### 2.3 Classic action `classic.bank` (`modules/classic/src/platform/bank.ts`)

Payload `{opId, op, item?}`; town only (depth 0), hero alive. depositGold: fee `bankFee(gold)`
(5 %, min 1), credit = gold − fee. withdrawCoin: gold += coin. depositItem: remove from bag/stash,
`itemToVault()`. withdrawItem: `vaultToItem(payload.item)` into the first free bag spot with a
fresh `GameState.nextUid`, `ERR.bagFull` otherwise. Emits one `ClassicBankEvent {type:
"classic.bank.effect", opId, credit, item, gold}`. Codec (`vault-codec.ts`): itemId = base (or
unique), origin "classic", universal false, tradable = `classicTradable()`, summary (name, rarity,
ilvl, category weapon/armor/jewelry/gem, slot, icon, ≤ 8 lines), data = JSON of the item without
uid/tab (≤ 4096 chars). `vaultToItem` validates every field strictly (known ids, integer ranges);
invalid → null → ActionError.

### 2.4 VerifiedHost bank saga (server)

Store table `bank_op(op_id PK, state, op, effect, result, at)`; states `taking` → `applied` →
`crediting` → `done` (or `refunding` → `done`). Rules:

1. Rate limit per socket (burst 5, 1/s); flag `bank` (`featureEnabled`); joined socket only.
2. Idempotent by opId: a done op answers its stored result (`applied: null`); a pending op continues.
3. **Withdrawals take first**: `walletTx(-coin, txId "bank:<instance>:<opId>:take", flow "sink",
   reason "bank.withdraw:classic")` or `vaultGet` (origin must be "classic" or universal, else
   `wrong_origin`) + `vaultTake(txId …:take)`; persist `applied` intent; dispatch; on dispatch
   failure refund (`…:refund`, `vaultPut`/credit) and answer the failure.
4. **Deposits dispatch first**: dispatch, then in ONE transaction write the new base snapshot and
   the op row `crediting` with the effect; then `walletTx(+credit, "…:credit", flow "faucet",
   reason "bank.deposit:classic")` or `vaultPut(…:credit)`; then `done`.
5. A pending op (crash, AccountDO error) is re-driven on the next wake/alarm (the InstanceDO
   alarm drives the outbox and pending bank ops); every account call is idempotent by txId.
6. The new base replaces the old one at the same tick (dispatch does not advance the tick in a
   fixed mode); the segment log restarts there; the next client segment starts at that tick.
7. `exportBuild(displayName)` (InstancePlatformApi): `policy.platform.build(world)` of the
   verified sim + accountId, displayName, sourceHash = `sim.hash()`.
8. Season progress: after each compaction, `policy.platform.seasonTotal(world)`; when it changed
   since the last successful report (kv), `AccountDO.seasonProgress(key, total)`
   (fire-and-forget, retried at the next compaction; monotonic so retries are safe).

### 2.5 Client (classic)

`BankClient` (`contract.ts`, built in `game.ts`/`sync/**`): `run(op)` → cut a segment, **pause**
stepping and dispatching, `connection.sendBank({opId, op, at})`, wait for `handlers.bank` (8 s
timeout → resume, `{ok:false, code:"unavailable"}`), apply `applied` outside the recorder (never
recorded as an input), resume. `view.blocked`: "local" | "offline" | "town" | "busy" | null.
`api.openScreen = services.openScreen`. Local mode: `bank` absent or blocked "local".

---

## 3. Vault, notices and direct trade (T-escrow)

### 3.1 Vault

The wave B `stash` table gains columns (guarded `ALTER TABLE ADD COLUMN`): `universal`,
`tradable`, `summary` (JSON), `data`. `VaultItem` = `UniversalItem` + those. Legacy rows read as
universal/tradable with a summary from itemId. `vaultPut(txId, item)` / `vaultTake(txId, uid)`
idempotent (economy.ts `tx` table, kinds `vault.put`/`vault.take`; a replay returns the same uid
/ item). Max `VAULT_MAX_ITEMS` (200) rows → `vault_full`. `walletTx(tx: WalletTxC)` = the wave B
ledger plus, in the same transaction for non-replayed txs, outbox rows `economy_ledger`
(pk `${accountId}/${txId}`, signed amount, flow, reasonGroup = `flowGroup(reason)`) and
`account_wallet` (pk accountId, both balances). Telemetry convention: **amounts are signed
wallet deltas; a refund of a sink is a positive amount with flow "sink"** (sink total =
−Σ amount where flow = sink). `applyWalletTx` (wave B callers) records flow "transfer", except
reason `dev*` → "faucet".

Dev-only `POST /api/dev/economy/grant {coin?, items?: VaultItemInput[]}` (isDevHost; registered
or guest) puts coin (faucet, reason "dev.grant") and test items into the caller's vault — e2e
and QA of trade/market/shops use it.

### 3.2 Notices

`notify(NoticeInput)` idempotent by id; newest `NOTICES_MAX` kept; `notices(sinceId)`
(newer than sinceId, oldest first) + unread; `markNoticesRead(upTo)`. `linkTrade/openTrades`
index the account's trades. HTTP: `GET /api/account/vault` → `VaultResponse`,
`GET /api/account/notices?since=` → `NoticesResponse`, `POST /api/account/notices/read {upTo}`.

### 3.3 Trade saga (EscrowDO "t<24 hex>")

HTTP `routes/trade.ts`: `POST /api/trade {opId, with}` (same opId → same trade: keep
`opId → tradeId` in the inviter's notices store or derive tradeId = "t" + first 24 hex of
SHA-256(`${accountId}:${opId}`)), `GET /api/trade` (openTrades → views), `GET /api/trade/:id`,
`POST /api/trade/:id/offer {coin, uids}`, `/accept {versions}`, `/cancel`. Only the two parties
may see or act. Both must be registered; no self-trade.

States `open → committing → done | failed`, `open → cancelled` (either side, or expiry after
`TRADE_TTL_MS`). Offers are snapshots (vaultGet, `tradable` required, ≤ `TRADE_MAX_ITEMS`);
any offer change bumps that side's version and clears both accepts. Accept names the pair
`[aVersion, bVersion]`; equal pairs from both → `committing`. Commit (persist each step before
the call, re-drive from the alarm after a crash):

1. custody from each side: coin `walletTx(-coin, "trade:<id>:<s>:coin", transfer)`, fee
   `walletTx(-tradeFee(coin), "trade:<id>:<s>:fee", sink, "trade.fee:<id>")`, items
   `vaultTake("trade:<id>:<s>:take:<uid>")`;
2. any failure → compensate every completed custody step (`…:refund…` credit, `…:return:<uid>`
   vaultPut to the owner) → `failed` with reason;
3. deliver: `walletTx(+coin, "trade:<id>:<s>:recv", transfer)` to the other side, `vaultPut`
   items (`…:give:<uid>`) to the other side → `done`; notices `trade.done`; `linkTrade(false)`.

Invariant (tested with injected failures at every step and replays): the multiset of items and
the coin sum (plus fees) are conserved; nothing duplicates or disappears.

---

## 4. Auction house (T-market)

- Shards: `MarketDO "<scope>:<category>"` (`marketShard()`): scope "universal" or the origin mode.
  Listing id `"<shard>/<seq>"`. Eligible: `marketEligible(summary)` (equipment ilvl ≥ 10, gems,
  materials, cosmetics). ≤ `MARKET_MAX_ACTIVE_PER_ACCOUNT` active per seller **per shard**.
- Route reads the vault item (`gateway.vaultGet`) to pick the shard and pre-check tradable /
  eligible; the DO re-checks after taking custody (wrong shard → return + refund).
- list: fee `listingFee()` debited (`mk:<id>:fee`, sink, "market.fee:<id>"), item taken
  (`mk:<id>:take`); fail → refund the fee; active until `endsAt` (12/24/48 h).
- bid: `amount ≥ minNextBid(topBid, startBid)`, not the seller; debit bidder (`mk:<id>:bid:<n>`,
  transfer); refund the previous top bidder (`mk:<id>:refund:<n-1>`), notice `market.outbid`;
  a bid within 5 min of the end extends it to now + 5 min; `amount ≥ buyout` = buy.
- buy (buyout): debit buyer (`mk:<id>:buy`), deliver item (`mk:<id>:deliver`), proceeds to the
  seller (`mk:<id>:proceeds`, +price, transfer) and tax (`mk:<id>:tax`, −salesTax, sink),
  refund a top bidder; notices `market.sold` / `market.won`; `economy_sale` row.
- expiry (alarm at the earliest `endsAt`): top bid → same as buy for the top bidder (already
  paid); none → return the item (`mk:<id>:return`), `market.expired`.
- cancel: seller, no bids → item returned, fee kept.
- **Worked example (buyout 1000):** at listing the seller pays the 2 % fee once: −20 coin,
  never refunded on a sale, expiry or cancel. At the sale the seller gets the price less the 5 %
  tax: +1000 then −50, net +950. Over the listing's life the seller nets 1000 − 50 − 20 = +930,
  but checks must look at the two moments separately (−20 at listing, +950 at sale); counting the
  fee again at the sale would be wrong.
- **Concurrency:** awaits on AccountDO calls let other requests interleave, so a listing in a
  saga is `busy` (persisted lock with the opId); concurrent ops get `busy` (409). Every saga is
  idempotent and re-driven by the alarm.
- Outbox: `market_listing` (full listing JSON) on every change; `economy_sale` on sales.
- Read API (D1): `GET /api/market/search` (status active, `ends_at > now`, filters on
  scope/category/rarity/level/name_lower LIKE, sort price/ending/newest, limit ≤ 50) →
  `MarketSearchResponse` (`available:false` when the table is missing); `GET /api/market/mine`.
  Writes: `POST /api/market/{list,bid,buy,cancel}`.

---

## 5. Shop plots and player shops (T-shops; fixtures T-scale; UI T-econ-ui/T-classic-ui)

### 5.1 Plots

`apps/game/src/shared/plots.ts`: 8 plots on the classic town's east road. PlotAuctionDO
"classic-town" owns, per plot: `auction` (startedAt, endsAt = +`PLOT_AUCTION_MS`, minBid
`PLOT_MIN_BID`, top bid in custody) → on end with a bid: lease to the winner (`PLOT_LEASE_MS`,
rent `plotRent(bid)` per `RENT_PERIOD_MS`, first period prepaid by the bid), `ShopDO.openLease`;
no bid → new auction. Bids: `plot:<world>/<plot>:bid:<n>` debit with flow **"sink"**
("plot.bid:<world>/<plot>"), outbid refunds `…:refund:<n-1>` credit with flow "sink" (a positive
sink amount), so the net sink is exactly the winning bid; notices `plot.outbid` / `plot.won`.
One plot per account.

### 5.2 Rent, grace, repossession

At `paidUntil` the DO debits rent (`plot:<world>/<plot>:rent:<period>`, sink, "shop.rent:…").
Insufficient → `grace` (`graceUntil = now + RENT_GRACE_MS`, notice `shop.rent_due`, retry every
`RENT_RETRY_MS`); paid → leased again; grace over → repossess: `ShopDO.closeLease("repossessed")`
returns every stocked item to the owner's vault (`shop:<world>/<plot>:return:<entryId>`) and
credits unclaimed earnings (`…:payout:<leaseId>`), notice `shop.repossessed`, new auction. Lease
end → the same with reason "ended" (`shop.lease_ended`). Alarm at the earliest due time.
`devAdvance(ms)` (dev hosts, `POST /api/dev/shops/advance {world, ms}`) adds a clock offset and
runs due work — e2e/QA use it; tests use a fake clock.

### 5.3 Shops

ShopDO "<world>/<plotId>": owner configures name (3-24 chars, word-filter-free plain text
`[A-Za-z0-9 '_-]`), appearance (`^unit\.hero(\.[a-z0-9_]+)*$`), open flag; stocks vault items
(tradable; `shop:<world>/<plot>:stock:<opId>` take) with a price (≤ `SHOP_MAX_STOCK` entries);
unstock returns them; buy: debit the buyer (`shop:<world>/<plot>:buy:<opId>`, −price,
transfer), deliver (`…:deliver:<opId>`), then `gross += price`, `tax += shopTax(price)` in the
shop. claim (and close): credit the owner `+gross` (`…:claim:<n>`, transfer) and debit `−tax`
(`…:tax:<n>`, sink, "shop.tax:<world>/<plot>"), net = gross − tax (the same "proceeds then tax"
pattern as the market). Shop views and the owner sheet show **net** earnings (gross − tax,
the amount a claim pays out; the API's `earnings` field is net). The
shop sells while the owner is offline. `economy_sale` row per sale (venue "shop"). Notice
`shop.sold` to the owner.

### 5.4 Ghost shopkeepers (fixtures)

PlotAuctionDO, after any lease/config change, sends
`ChunkFixtureApi.setFixtures("shops", fixtures)` to the world's chunk
(`presenceWorld(world).chunk`): one `EntityState` per leased plot with id
`shopFixtureId(plotId)` ("shops:p1"), kind `"shopkeeper"`, name = shop name, appearance = the
owner's chosen look, pos = plot tile, path [], speed 0, tag `"<owner> · Open|Closed"`. ChunkDO
(T-scale) persists fixtures, includes them in `subscribe()` state and broadcasts them as normal
upserts/removes. The classic client draws kind "shopkeeper" as a translucent ghost with a label;
tap → `openScreen({id:"shop", world, plotId})`. Outbox `shop_index` per plot change.

HTTP `routes/shops.ts`: `GET /api/shops?world=` → `PlotsResponse`, `POST /api/shops/plots/bid`,
`GET /api/shops/:world/:plotId`, `POST /api/shops/:world/:plotId/{configure,stock,unstock,buy,claim}`.

---

## 6. Arena (T-arena-sim: sim, build, replay UI; T-arena: server)

### 6.1 Sim (`@gamez/mode-arena`)

Fixed 10 Hz, 1-D lane (tenths of a tile, 0..200; attacker at 40, defender at 160). Each tick, in
alternating order (even ticks attacker first), a fighter that is out of range of its best ready
skill (or basic attack range 1 tile) walks toward the other (`moveSpeed` tiles/s); else uses the
first ready skill in priority order, else a basic attack when its timer allows
(`interval = round(100 / attackRate)` ticks). Damage = `rng.int(dmgMin, dmgMax) × power% `
(basic 100 %), crit `rng.chance(critPct/100)` × 1.5, then
`max(1, floor(raw × 100 / (100 + armor)) × (100 − resist) / 100)`, shields absorb first; heal %
of max hp; shield % of max hp (decays 5 %/s). All integers, `ctx.rng` only. End: a fighter at
0 hp loses; both in the same tick → draw; at `ARENA_MAX_TICKS` the higher remaining hp % wins,
equal → draw. `fight(a, b, seed, {frames})` dispatches an `arena.start` action with both builds
(clamped to the ArenaBuild ranges) and steps; pure; pinned hash test.

### 6.2 Builds

`classicArenaBuild(world, registry)` (classic/platform/build.ts): from the verified hero —
class, level, max hp, weapon damage, attack rate, armor, resist (average of resists), crit, move
speed, up to 4 bar skills mapped to arena kinds, appearance, gear score. Pure, null without a hero.

### 6.3 ArenaDO "<mode>:<seasonId>"

- Ghost pool: latest build per account (register on every queue).
- Queue: `POST /api/arena/queue {opId, mode?}` → route gets the build from
  `InstanceDO("classic:<accountId>").exportBuild(name)` (null → 409 `not_eligible` "Play classic
  first") → `ArenaDO.enqueue` → ticket. `GET /api/arena/queue/:ticket` polls; resolution on
  poll: two waiting tickets within the rating band → they fight (earlier = attacker; both tickets
  get the match); a ticket older than 3 s → fight a ghost picked from the pool within
  `MATCH_BAND`, widening by `MATCH_BAND_STEP` to `MATCH_BAND_MAX`, never self, seeded pick; empty
  pool → a "Sparring Shade" ghost derived from the player's build (90 % stats), unrated.
- Limits: `FIGHTS_PER_DAY` per account per UTC day.
- Result: `eloUpdate`; the ghost owner's rating moves too (notice `arena.defended`); rewards
  `arenaRewards(result)` → coin (`arena:<matchId>:coin`, faucet, "arena.reward:<matchId>") and
  season xp (`addSeasonXp("arena:<matchId>:xp")`) for the attacker; match stored (seed, builds,
  winner, ticks, contentHash); outbox `arena_rating` for both.
- `GET /api/arena/status`, `GET /api/arena/ladder` (D1 `arena_rating`), `GET /api/arena/match/:id`.
- Client replay: `ArenaReplay` re-runs `fight(builds, seed, {frames:true})`; when its
  `contentHash` differs from the match's, show the result only.

---

## 7. Battle pass (T-pass)

- Season `2026-s1` "Season of Embers" (`@gamez/economy` season.ts): 30 tiers, cumulative xp
  curve, free track (titles, chat colours, small coin), premium track (nameplates, titles,
  colours). Original names only; cosmetics are entitlements `cosmetic.<slot>.<name>`.
- Xp sources: classic `seasonTotal` deltas (`AccountApiC.seasonProgress`, from the verified host),
  arena (`addSeasonXp`). Idempotent and monotonic.
- Premium: owns `season.premiumSku` (store purchase, or `POST /api/pass/premium {opId}` paying
  `PASS_PREMIUM_GEMS` gems — the first gem sink).
- `GET /api/pass` → PassView, `POST /api/pass/claim {tier, track}`; dev `POST /api/dev/pass/xp {xp}`.
- Notice `pass.tier` when a tier is crossed.

---

## 8. Store and payments (T-pay)

- `PaymentProvider` (`payments/provider.ts`): `createCheckout`, `verifyWebhook`, `refund`.
  Implementations: Stripe (Checkout Session API, metadata accountId/orderId, webhook
  `checkout.session.completed` / `charge.refunded`), Asaas (payments API with
  `externalReference`, PIX/boleto/card, webhook `PAYMENT_RECEIVED|PAYMENT_CONFIRMED` /
  `PAYMENT_REFUNDED`), Mercado Pago (Checkout Pro preference with `external_reference`, webhook
  `payment` → GET payment), stub (dev hosts or `PAYMENTS_STUB=1`; local checkout page; signed
  self-webhook). Signature rules in the provider.ts header.
- Products (`@gamez/economy` products.ts): gem packs, premium pass, a cosmetic bundle; USD + BRL.
- Flow: `POST /api/store/checkout {opId, sku, provider, currency}` (registered only) →
  `createOrder` → `createCheckout` → `{orderId, url}`; webhook `POST /api/pay/webhook/:provider`
  → verify (401 when invalid) → `fulfillOrder` / `refundOrder` (idempotent by orderId; a
  replayed webhook is a no-op) → 200. Return to `/#store=paid&order=<id>` (or `cancel`).
- `GET /api/store?country=` (products, providers, suggestion), `GET /api/store/orders`.
- `docs/secrets.md`: every key, where to get it, sandbox notes.

---

## 9. Live ops (T-admin)

### 9.1 Telemetry (`GET /api/admin/economy?days=14`)

From D1: money supply = Σ `account_wallet`; faucets/sinks per day and `reason_group` from
`economy_ledger`; price index = daily median per category from `economy_sale`; market active /
sold 24 h / volume; shops by state (`shop_index`); purchases (`purchase`). `@gamez/economy`
telemetry.ts holds the pure math.

### 9.2 Flags (ConfigDO "global")

SQLite flags with an audit log (`by`, at); `GET /api/config` (public, `cache-control: max-age=30`);
`POST /api/admin/flags`. Routes read flags through `config/flags.ts` (10 s isolate cache; ConfigDO
failure = defaults on).

### 9.3 Admin access and dashboard

Admins = `ADMIN_ACCOUNT_IDS` ∪ dev-granted admins (`POST /api/dev/admin/self` on dev hosts only,
stored in ConfigDO) — this also settles the wave B carry-over that undeclared `.dev.vars` keys may
not reach `env` locally (verify and document which). Dashboard `apps/game/src/client/admin/**`
(`AdminScreen`, lazy route `#admin`): money supply, faucet vs sink chart, price index, market and
shop tiles, flags toggles, moderation queue (wave B `/api/admin/reports`, mute, hide) and
`GET /api/admin/moderation` (unresolved reports grouped by account). Charts follow the dataviz
skill conventions (inline SVG, no chart library needed).

---

## 10. Client UI

### 10.1 Platform SDK

`apps/game/src/client/platform/{vault,trade,market,shops}.ts` (T-econ-ui), `arena.ts`
(T-arena), `pass.ts` (T-pass), `store.ts` (T-pay), `config.ts` (T-admin): implement the ui-host
interfaces over `HttpClient`; generate `opId` with `newOpId()` when absent and reuse it for
retries of the same call.

### 10.2 Shared components (`packages/ui-host/src/economy`, T-econ-ui)

`VaultView`, `MarketView` (browse/search tabs, sell from vault with fee preview, bid/buy with tax
note, my listings/bids), `TradeWindow` (two columns, offer editor, versions-aware accept, status,
1 s poll), `PlotsView`, `ShopView` (owner: stock/unstock/configure/claim; visitor: buy),
`NoticesView`. Props are the contract (`economy/index.ts`). Dark classic palette, 375 px, 44 px.

### 10.3 Play components

`BattlePassView` (T-pass), `StoreView` (T-pay) in `packages/ui-host/src/play`; `ArenaScreen` and
`ArenaReplay` in `@gamez/mode-arena/client` (T-arena-sim).

### 10.4 Shell and classic HUD

- T-shell: `ClientServices.openScreen` → sheets over the running mode (lazy-loaded); picker bar
  with Market, Vault, Trade, Shops, Arena, Battle Pass, Store and a notices bell (poll 20 s;
  trade invites toast with "Open"); flags hide disabled features; `#store=paid|cancel` and
  `#admin` handling; keep the main chunk from growing (lazy sheets; measure the build).
- T-classic-ui: "bank" panel (gold deposit, item deposit from bag/stash, `VaultView` with the
  bank prop for withdrawals), opened from the stash chest and the More menu; buttons for Market,
  Trade, Arena, Pass, Store (`api.openScreen`); presence: shopkeeper ghosts, tap → shop; tap a
  remote hero → "Trade" → trade screen; hide a new remote avatar until its first pose
  (wave B carry-over).

---

## 11. Ship (T-ship)

- PWA: `public/manifest.webmanifest` (name, short_name, start_url "/", display standalone,
  theme/background colours, icons 192/512/maskable PNG generated by `tools/pwa/make-icons.ts`
  with node:zlib — original art), `public/sw.js` (versioned cache; precache shell; cache-first
  `/assets/*` and `/art/*`; network-only `/api/*` and `/ws*`; navigations network-first with the
  cached shell as offline fallback; old caches cleaned on activate), registration in
  `src/client/pwa/` only in production builds and never on the Vite dev server (HMR), an
  "Install" prompt hook (`beforeinstallprompt`) exposed for the shell, iOS meta tags.
- Native: `apps/native/capacitor` (config, package.json, README: add iOS/Android, sync the
  built client, live-reload against a dev URL, deep links for OAuth/payment returns, IAP note)
  and `apps/native/electron` (main/preload, loads the hosted URL, external links in the browser,
  optional steamworks.js init behind a flag, packaging with electron-builder, Steam depot notes).
  Neither is a pnpm workspace package; nothing is installed in CI. `docs/ship.md` explains all.

---

## 12. Scale (T-scale)

- Bot swarm `tools/loadtest` (Node, no deps beyond the workspace): N guests, `/ws?world=
  classic-town`, poses at 2-4/s on random walks, ramp 50 → 100 → 250 → 500 → 1000; measures join
  time, pose→delivery latency (server `pathStartedAt` vs receive time with ping clock offset)
  p50/p95/p99, frames and bytes per client per second, drops/errors, and server-side ChunkDO
  time per delta if logged. Results `docs/bench/2026-10-waveC-presence.md` (local workerd; note
  it is not production-representative).
- Relay sharding: `relayName(continent, world, shard)` with `shard = hash(accountId) %
  world.relayShards` (plaza keeps its legacy single name). The chunk already fans out once per
  relay.
- Chunk fixtures (§5.4) incl. both codecs (kind "shopkeeper" is already in the binary codec).
- Chunk grid/AOI only if the bench shows one chunk saturating below 500 bots: then a static grid
  for pose worlds with 3×3 subscriptions; otherwise document the measured headroom and defer.

---

## 13. How Auto / Idle interacts

Bank ops need the hero in town and pause the local sim for one round trip (≈ 100-300 ms); in
Auto/Full Idle the player walks or portals to town first (the panel says so). Auto and Idle never
dispatch `classic.bank` (server-only; a segment containing it is rejected). Season points come
from verified state only (Full Idle earns them, offline progress included, because the host
reports after compaction). Arena builds come from verified state; the arena fight itself is
fully automatic. Market, trade, shops, pass and store do not touch the sim at all.

---

## 14. Test plan

| Layer        | Tests                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| classic bank | action rules per op, determinism + pinned hash of a scripted bank sequence, codec round trip and strict rejection, server-only (segment with classic.bank → resync)                                         |
| bridge       | host: fast path, slow path (resync bank), idempotent retry, crash after sim commit re-drives credit, withdraw refund on bag full, wrong origin, rate limit; client: pause/apply/hash, timeout, not recorded |
| vault/trade  | vault put/take idempotency and limits, ledger rows; trade saga success, every injected failure point (custody/deliver/crash) conserves items and coin, version-aware accept, expiry, outsiders forbidden    |
| market       | fee/tax math, list/bid/outbid/buy/expire/cancel, busy lock under interleaving, saga re-drive, projections, search SQL on node:sqlite                                                                        |
| shops        | auction → lease → rent → grace → repossess (fake clock), stock/buy/claim, fixtures pushed, devAdvance                                                                                                       |
| arena        | sim determinism + pinned hash, end conditions, build clamping; classic build from fixtures; Elo; matchmaking band/self/limits; rewards idempotent                                                           |
| pass         | tier math, monotonic progress per key, claim rules, premium via entitlement / gems                                                                                                                          |
| payments     | each provider's signature verification (good, bad, stale), stub flow, fulfil once, replayed webhook, refund                                                                                                 |
| admin        | flags round trip and cache, telemetry SQL on node:sqlite, admin auth                                                                                                                                        |
| UI           | components with fakes (loading, empty, error, data), shell sheets and flag hiding, classic bank panel and fixture taps                                                                                      |
| e2e          | features `admin, bank, trade, market, shops, arena, payments, pass, loadtest` (tools/e2e/src/waveC/*)                                                                                                       |

## 15. QA focuses (tools/qa, `tools/qa/src/waveC/*`)

`economy-shell` (T-shell), `classic-bank` + `classic-market-street` + `classic-trade`
(T-classic-ui), `arena` (T-arena-sim), `admin` (T-admin), `pwa` (T-ship); each at 1366×768 and
390×844 where it has UI.

## 16. Decisions (to record in ADR 0006)

1. All value crossing players lives in AccountDO (coin + vault); modes reach it only through the
   bank, applied as a server-only action at a verified tick (no hero-to-hero transfers).
2. Custody instead of holds: escrow, market, plots and shops debit into their own custody with
   idempotent txIds and refund on failure; no hold state in AccountDO.
3. Trading needs a registered account; guests browse and bank.
4. One coin currency for every venue; gold ⇄ coin through the bank with a 5 % deposit fee.
5. Market shards by scope and category; search via D1 only (display), never for rules.
6. Async arena with ghosts; ladder DO per mode+season; client replays from seed + builds.
7. Payments: one interface, provider routing by country, fulfilment idempotent by orderId.
8. Feature flags as kill switches with a fail-open cache.
9. Telemetry in D1 for now (signed ledger deltas tagged by flow).
10. PWA service worker in production builds only.

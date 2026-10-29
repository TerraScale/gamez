# gamez

A web-first isometric 2.5D idle RPG on Cloudflare: Workers, SQLite Durable Objects, D1, Queues and Workers static assets. Everything gameplay-related is a module.

Phase 0 (the walking skeleton) is done: two browsers see each other tap-to-move on an isometric Kenney town, and character positions replicate CharacterDO → outbox → Queue → D1.

Phase 1 adds the kernel (staged data registries, a deterministic ECS, systems and actions with add/wrap/replace/disable overrides) and two test modes that run in a generic `InstanceDO`. See [ADR 0003](docs/adr/0003-kernel-and-modes.md).

Phase 2a adds **Classic**, an idle Diablo-like ARPG built entirely from kernel modules: a hero explores a procedural 16-level dungeon, fights, loots, levels and returns to town, and plays itself (Manual, Auto, Full Idle up to x8). See [`docs/design/classic.md`](docs/design/classic.md).

Wave A deepens Classic as a single-player game: talent trees and nine more skills, item sets, gems, sockets, durability and smith crafting, a gambler, stash tabs and a loot filter, bosses with telegraphed attacks and phases, the endless scored Rift after depth 16, 49 achievements, procedural WebAudio sound and music, graphics quality settings, onboarding tips and a DPS panel. Auto/Idle uses every new system. See [`docs/design/wave-A.md`](docs/design/wave-A.md) and [ADR 0004](docs/adr/0004-classic-wave-a.md).

Wave B makes Classic server-backed and adds the platform around it. The browser still runs the sim with no input lag, but it streams input segments to `InstanceDO "classic:<accountId>"`, which replays and verifies every segment, persists the hero, corrects tampering with a resync, bounds sim speed by wall time and grants offline progress itself. The wave also adds real accounts (email + password, Google and Discord OAuth with a local stub provider, guest upgrade in place, revocable sessions), a shared account economy (wallet, universal stash, cosmetics, entitlements, idempotent by txId), leaderboards fed from verified state into D1, chat channels with rate limits, a word filter and async moderation, guilds, and other players' heroes in the classic town. See [`docs/design/wave-B.md`](docs/design/wave-B.md), [ADR 0005](docs/adr/0005-platform-wave-b.md) and [`docs/secrets.md`](docs/secrets.md).

Wave C adds a player-driven economy and makes the game shippable. A **bank** moves gold (to coin, 5 % fee) and items between the classic hero and the account **vault**, applied by `InstanceDO` at a verified tick. Players trade directly through an **escrow** saga, list items on an **auction house** (per-shard `MarketDO`, D1 search, listing fee and sales tax), and lease **shop plots** in the classic town (lease auctions, rent, repossession, ghost shopkeepers in presence). **Arena** is async PvP: deterministic ghost fights (`@gamez/mode-arena`), an Elo ladder per mode and season, and a client replay. There is also a **battle pass**, a **store** (Stripe, Asaas, Mercado Pago and a sandbox stub behind one interface, with verified webhooks and idempotent fulfilment), **live ops** (feature flags, an economy telemetry and moderation dashboard at `#admin`), a **PWA** with Capacitor and Electron shells, and a presence **load test** that led to sharded relays. See [`docs/design/wave-C.md`](docs/design/wave-C.md), [ADR 0006](docs/adr/0006-economy-arena-ship-wave-c.md), [`docs/ship.md`](docs/ship.md) and [`docs/bench/2026-10-waveC-presence.md`](docs/bench/2026-10-waveC-presence.md).

The **party system** lets one player run up to four Classic heroes at once in the same sim: each has its own class, level, skills, talents, equipment, bag and belt, while gold, the stash, quests and waypoints are shared. Every hero plays on the party AI (formation, focus fire, protection, ally heals, revives, travel together), and the player takes control of any one of them with a portrait click, F1–F4 or Tab while the rest keep playing. Slots unlock at the depth 4/8/12 bosses or for gold, and monsters scale with party size. A party of one is bit-identical to the solo game, so old saves need no migration. See [`docs/design/party.md`](docs/design/party.md) and [ADR 0007](docs/adr/0007-classic-party.md).

## Layout

| Path                   | What                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/game`            | The one Worker: Pixi client (static assets), API routes (`src/server/routes`), the DOs (`RelayDO`, `ChunkDO`, `CharacterDO`, `InstanceDO`, `AccountDO`, `IdentityDO`, `ChatChannelDO`, `GuildDO`, and in wave C `EscrowDO`, `MarketDO`, `PlotAuctionDO`, `ShopDO`, `ArenaDO`, `ConfigDO`), sync queue consumer, admin dashboard, PWA. See [`apps/game/README.md`](apps/game/README.md). |
| `packages/protocol`    | Client ↔ relay wire messages, JSON and binary codecs                                                                                                                                                                                                                                                                                                                                    |
| `packages/sync`        | Sync engine v1: transactional outbox in DO SQLite, version-guarded `applyBatch` into D1                                                                                                                                                                                                                                                                                                 |
| `packages/world`       | Tile maps, isometric maths, A\* pathfinding                                                                                                                                                                                                                                                                                                                                             |
| `packages/assets`      | Asset manifest types, manifest merging, logical-id fallback                                                                                                                                                                                                                                                                                                                             |
| `packages/kernel`      | The kernel: module loader, staged registries, ECS world, sim, seeded RNG. See [`packages/kernel/README.md`](packages/kernel/README.md).                                                                                                                                                                                                                                                 |
| `packages/ui-host`     | Client contracts for mode UIs (`ClientModeView`, `ClientServices`, `InstanceConnection`), the world renderer interface and the UI slot registry                                                                                                                                                                                                                                         |
| `modules/steps`        | Test mode B, `@gamez/mode-steps`: a step-based roguelike (procedural floors, bump-to-attack, permadeath runs)                                                                                                                                                                                                                                                                           |
| `modules/duel`         | Test mode A, `@gamez/mode-duel`: turn-based creature battles (move menu, capture, team and box)                                                                                                                                                                                                                                                                                         |
| `modules/classic`      | `@gamez/mode-classic`: the Classic idle ARPG (sim modules under `src/`, client view, HUD and audio under `src/client/`)                                                                                                                                                                                                                                                                 |
| `modules/economy`      | `@gamez/economy`: pure economy rules (fees and taxes, market, plot leases, Elo rating, battle-pass seasons, store products, telemetry maths)                                                                                                                                                                                                                                            |
| `modules/arena`        | `@gamez/mode-arena`: the deterministic async arena fight (`fight()`), and `ArenaScreen` / `ArenaReplay` under `./client`                                                                                                                                                                                                                                                                |
| `modules/classic.town` | The phase-0 town map (used by Town Plaza)                                                                                                                                                                                                                                                                                                                                               |
| `modules/art.kenney`   | Kenney CC0 starter art pack and the script that builds its atlas                                                                                                                                                                                                                                                                                                                        |
| `tools/e2e`            | End-to-end check against a real local dev server                                                                                                                                                                                                                                                                                                                                        |
| `tools/qa`             | Browser QA harness (headless Chrome over CDP): scenarios, screenshots, perf probes. See [`tools/qa/README.md`](tools/qa/README.md).                                                                                                                                                                                                                                                     |
| `tools/loadtest`       | Presence bot swarm (`node tools/loadtest/src/swarm.ts`), with private server state; results in `docs/bench`                                                                                                                                                                                                                                                                             |
| `apps/native`          | Capacitor (iOS/Android) and Electron (desktop/Steam) shells; not workspace packages. See [`docs/ship.md`](docs/ship.md).                                                                                                                                                                                                                                                                |
| `tools/bench`          | Benchmark lab (ECS, kernel, sync); results in [`docs/bench`](docs/bench)                                                                                                                                                                                                                                                                                                                |
| `docs/adr`             | Architecture decisions; `docs/deploy.md` is the deploy runbook                                                                                                                                                                                                                                                                                                                          |

## Setup

Node 24+, and the Vite+ CLI (`vp`). Then:

```sh
vp install
cp apps/game/.dev.vars.example apps/game/.dev.vars   # AUTH_SECRET for local dev
```

Use the repo's own `vp` (`node_modules/.bin/vp`) if your global `vp` is not the official Vite+ CLI. A `vp` installed through mise's npm backend runs its own Vitest instead of the repo's, and every test suite then fails with `Cannot read properties of undefined (reading 'config')`. See ADR 0001.

## Develop

```sh
vp -C apps/game dev                      # client + Worker + DOs in workerd, http://localhost:5173
vp run migrate-local                     # once per fresh local state, while dev runs: D1 migrations into the local D1
```

Open http://localhost:5173 and pick a mode. For Town Plaza, use two browser windows (one private window, so they get different guest accounts) and tap tiles. Classic plays against your account's `InstanceDO` (the badge in the top right shows "Saved"); a seeded run (`?seed=`) or a cheat run plays locally in the browser. Add `?debug=1` for the `window.__gamez` QA hooks, `?debug=1&cheats=1` for the cheat module, `?fresh=1` to ignore the save and `?qa=gallery` for the art and effect gallery. Local state (D1, DO storage, queues) lives in `apps/game/.cloudflare/state/`; delete it to start fresh.

## Modes

| Mode      | Runs in                                 | What it is                                                                                                                                               |
| --------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classic` | the browser, verified by `InstanceDO`   | Idle Diablo-like ARPG on the kernel, fixed 20 Hz. Segments are replayed and persisted server-side; other heroes show in town (`/ws?world=classic-town`). |
| `plaza`   | `/ws` → RelayDO / ChunkDO / CharacterDO | Town Plaza: the phase-0 real-time town with presence and D1 replication.                                                                                 |
| `steps`   | `/ws/instance` → `InstanceDO`           | Step-based roguelike. Event-ticked: the world moves only when you act. Arrows/WASD, QEZC.                                                                |
| `duel`    | `/ws/instance` → `InstanceDO`           | Turn-based creature battles with original creatures. Menu-driven React screen.                                                                           |

Instanced modes are server-authoritative. The client predicts each action on a local copy of the same sim and reconciles with the server's `result` (ADR 0003 §3–4). The catalog both sides load is [`apps/game/src/shared/catalog.ts`](apps/game/src/shared/catalog.ts).

### Adding a module or a mode

1. Create a workspace package under `modules/` shaped like `modules/steps`. Its `package.json` exports `"."` (sim: `modules` and `mode`) and `"./client"` (the `ClientModeView`). Run `vp install` from the root.
2. Write modules with `defineModule` and a mode with `defineMode` (see [`packages/kernel/README.md`](packages/kernel/README.md)). Keep sim code in `src/` outside `src/client/`: the determinism lint (no `Date`, `Math.random`, timers…) covers it there. Use `ctx.rng` and `ctx.tick`.
3. Add tests: a scripted playthrough with a pinned `sim.hash()`, and a snapshot/resume test. They run in `vp run -r test`, and in CI.
4. Register it in the app:
   - add the package to `apps/game/package.json`;
   - spread its `modules` into `MODULE_CATALOG` and add its `mode` to `MODES` in `apps/game/src/shared/catalog.ts`;
   - add its client view to `CLIENT_MODE_VIEWS` in `apps/game/src/client/modes/index.ts`.

   The picker lists it, `/ws/instance?mode=<id>` routes to its InstanceDO, and the catalog test checks its `contentHash`.

5. To change another module's behaviour without forking it, write a module that patches prototypes in `dataUpdates`, or `wrap`/`replace`/`disable` systems and actions by id in `overrides`.

## Check and test

```sh
vp check                                 # format, lint, type check (vp check --fix to format)
vp run -r test                           # unit tests in every package
vp -C apps/game build                    # production build
vp -C packages/protocol run bench        # JSON vs binary codec benchmark
```

Browser QA against the running dev server: `node tools/qa/src/run.ts classic-idle warrior 2 8` (Idle x8 for 2 minutes), `classic-features <class>` (every wave A system through cheats), `party <class>` (recruit, control switch by portrait, F-keys and Tab, camera, outlines, party Idle), `gallery`, `panels`. See [`tools/qa/README.md`](tools/qa/README.md).

## End to end

```sh
vp run e2e                               # env: E2E_PORT (default 5299), E2E_LOG (default /tmp/gamez-e2e-dev.log)
```

It starts its own `vp dev` (so stop any dev server on that port first), applies the local D1 migrations, then:

1. logs in two guests and connects both to `/ws`; each gets a welcome and sees the other;
2. A walks twice; B must get a delta whose path ends at each target;
3. after each walk the local D1 `character_summary` row for A must reach the target, and `sync_cursor` must advance;
4. A and B leave. A then plays `steps` and `duel` over `/ws/instance`: a scripted action sequence where every result must match a local replay (same events, same snapshot hash), plus an invalid action, an unknown action and a replayed seq, all rejected with state unchanged;
5. the dev server restarts (every DO restarts). A reconnects and its welcome must put it on the last target. Each instance must resume from its persisted snapshot (same hash and `lastSeq`), and a `fresh` join must reset it.
6. it crawls the client module graph from the page's entry script (static, re-export and dynamic imports) and requires every module to answer 200, including the Classic view and its wave A modules. Classic runs in the browser, so a module that fails to transform would break it without any server error.

7. wave B features (`tools/e2e/src/features.ts`): auth (register in place, lockout, logout revocation, the OAuth stub round trip), classic-verify (honest play verifies, tampered hash / too fast / server-only action resync, resume after restart, fresh reset), leaderboards (a verified hero reaches D1 and the API), chat (delivery, filter, stub moderation, block, report row), guilds (create/join/leave, D1 index, guest rule), account (wallet, dev grant, cosmetics, guild chat access), classic-party (an imported save buys slots, recruits two heroes, switches control and plays verified party Idle; a tampered control input resyncs; one D1 leaderboard row per member; the party resumes after the restart) and classic-presence (two bots see each other's poses). Each may add checks after the restart.

8. wave C features (`tools/e2e/src/waveC/*`): admin (guard, flags, telemetry, a flag turning a feature off), bank (gold ⇄ coin, item round trip through the vault), trade (escrow saga, fee, guest refusal), market (list fee, D1 search, buyout and tax, outbid refund, cancel), shops (plot auction, stock, buy, 3 % tax, rent grace and repossession, shopkeeper fixture in presence), arena (shared live match, Elo, reward once, replay hash), payments (stub checkout, replayed webhook, bad signature, premium pass, cosmetic bundle), pass and loadtest (50 bots, p95 under 1 s, relay shards, fixtures). Each re-checks its state after the restart.

The e2e server persists into its own `/tmp/gamez-e2e-state-<port>` and never touches the live dev server's state.

It prints the timings (welcome latency, `moveTo` to delta, walk end to D1 row, instance join and action round trip) and exits non-zero on any failure. CI runs it too.

## Deploy

Workers Builds deploys `main` and creates previews for pull requests. See [`docs/deploy.md`](docs/deploy.md).

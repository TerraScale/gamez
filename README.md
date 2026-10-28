# gamez

A web-first isometric 2.5D idle RPG on Cloudflare: Workers, SQLite Durable Objects, D1, Queues and Workers static assets. Everything gameplay-related is a module.

Phase 0 (the walking skeleton) is done: two browsers see each other tap-to-move on an isometric Kenney town, and character positions replicate CharacterDO → outbox → Queue → D1.

Phase 1 adds the kernel (staged data registries, a deterministic ECS, systems and actions with add/wrap/replace/disable overrides) and two test modes that run in a generic `InstanceDO`. See [ADR 0003](docs/adr/0003-kernel-and-modes.md).

Phase 2a adds **Classic**, an idle Diablo-like ARPG built entirely from kernel modules: a hero explores a procedural 16-level dungeon, fights, loots, levels and returns to town, and plays itself (Manual, Auto, Full Idle up to x8). See [`docs/design/classic.md`](docs/design/classic.md).

Wave A deepens Classic as a single-player game: talent trees and nine more skills, item sets, gems, sockets, durability and smith crafting, a gambler, stash tabs and a loot filter, bosses with telegraphed attacks and phases, the endless scored Rift after depth 16, 49 achievements, procedural WebAudio sound and music, graphics quality settings, onboarding tips and a DPS panel. Auto/Idle uses every new system. Classic still runs its sim only in the browser; server persistence and verification come next. See [`docs/design/wave-A.md`](docs/design/wave-A.md) and [ADR 0004](docs/adr/0004-classic-wave-a.md).

## Layout

| Path                   | What                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/game`            | The one Worker: Pixi client (static assets), API, `RelayDO` / `ChunkDO` / `CharacterDO`, sync queue consumer. See [`apps/game/README.md`](apps/game/README.md). |
| `packages/protocol`    | Client ↔ relay wire messages, JSON and binary codecs                                                                                                            |
| `packages/sync`        | Sync engine v1: transactional outbox in DO SQLite, version-guarded `applyBatch` into D1                                                                         |
| `packages/world`       | Tile maps, isometric maths, A\* pathfinding                                                                                                                     |
| `packages/assets`      | Asset manifest types, manifest merging, logical-id fallback                                                                                                     |
| `packages/kernel`      | The kernel: module loader, staged registries, ECS world, sim, seeded RNG. See [`packages/kernel/README.md`](packages/kernel/README.md).                         |
| `packages/ui-host`     | Client contracts for mode UIs (`ClientModeView`, `ClientServices`, `InstanceConnection`), the world renderer interface and the UI slot registry                 |
| `modules/steps`        | Test mode B, `@gamez/mode-steps`: a step-based roguelike (procedural floors, bump-to-attack, permadeath runs)                                                   |
| `modules/duel`         | Test mode A, `@gamez/mode-duel`: turn-based creature battles (move menu, capture, team and box)                                                                 |
| `modules/classic`      | `@gamez/mode-classic`: the Classic idle ARPG (sim modules under `src/`, client view, HUD and audio under `src/client/`)                                         |
| `modules/classic.town` | The phase-0 town map (used by Town Plaza)                                                                                                                       |
| `modules/art.kenney`   | Kenney CC0 starter art pack and the script that builds its atlas                                                                                                |
| `tools/e2e`            | End-to-end check against a real local dev server                                                                                                                |
| `tools/qa`             | Browser QA harness (headless Chrome over CDP): scenarios, screenshots, perf probes. See [`tools/qa/README.md`](tools/qa/README.md).                             |
| `tools/bench`          | Benchmark lab (ECS, kernel, sync); results in [`docs/bench`](docs/bench)                                                                                        |
| `docs/adr`             | Architecture decisions; `docs/deploy.md` is the deploy runbook                                                                                                  |

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

Open http://localhost:5173 and pick a mode. For Town Plaza, use two browser windows (one private window, so they get different guest accounts) and tap tiles. Classic saves locally in the browser; add `?debug=1` for the `window.__gamez` QA hooks, `?debug=1&cheats=1` for the cheat module, `?fresh=1` to ignore the save and `?qa=gallery` for the art and effect gallery. Local state (D1, DO storage, queues) lives in `apps/game/.cloudflare/state/`; delete it to start fresh.

## Modes

| Mode      | Runs in                                 | What it is                                                                                |
| --------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `classic` | the browser (local sim, local save)     | Idle Diablo-like ARPG on the kernel, fixed 20 Hz. Server verification is the next wave.   |
| `plaza`   | `/ws` → RelayDO / ChunkDO / CharacterDO | Town Plaza: the phase-0 real-time town with presence and D1 replication.                  |
| `steps`   | `/ws/instance` → `InstanceDO`           | Step-based roguelike. Event-ticked: the world moves only when you act. Arrows/WASD, QEZC. |
| `duel`    | `/ws/instance` → `InstanceDO`           | Turn-based creature battles with original creatures. Menu-driven React screen.            |

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

Browser QA against the running dev server: `node tools/qa/src/run.ts classic-idle warrior 2 8` (Idle x8 for 2 minutes), `classic-features <class>` (every wave A system through cheats), `gallery`, `panels`. See [`tools/qa/README.md`](tools/qa/README.md).

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

It prints the timings (welcome latency, `moveTo` to delta, walk end to D1 row, instance join and action round trip) and exits non-zero on any failure. CI runs it too.

## Deploy

Workers Builds deploys `main` and creates previews for pull requests. See [`docs/deploy.md`](docs/deploy.md).

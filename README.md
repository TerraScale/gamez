# gamez

A web-first isometric 2.5D idle RPG on Cloudflare: Workers, SQLite Durable Objects, D1, Queues and Workers static assets. Everything gameplay-related is a module.

Phase 0 (the walking skeleton) is done: two browsers see each other tap-to-move on an isometric Kenney town, and character positions replicate CharacterDO → outbox → Queue → D1.

## Layout

| Path                   | What                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/game`            | The one Worker: Pixi client (static assets), API, `RelayDO` / `ChunkDO` / `CharacterDO`, sync queue consumer. See [`apps/game/README.md`](apps/game/README.md). |
| `packages/protocol`    | Client ↔ relay wire messages, JSON and binary codecs                                                                                                            |
| `packages/sync`        | Sync engine v1: transactional outbox in DO SQLite, version-guarded `applyBatch` into D1                                                                         |
| `packages/world`       | Tile maps, isometric maths, A\* pathfinding                                                                                                                     |
| `packages/assets`      | Asset manifest types, manifest merging, logical-id fallback                                                                                                     |
| `modules/classic.town` | The phase-0 town map                                                                                                                                            |
| `modules/art.kenney`   | Kenney CC0 starter art pack and the script that builds its atlas                                                                                                |
| `tools/e2e`            | End-to-end check against a real local dev server                                                                                                                |
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

Open http://localhost:5173 in two browser windows (one private window, so they get different guest accounts) and tap tiles. Local state (D1, DO storage, queues) lives in `apps/game/.cloudflare/state/`; delete it to start fresh.

## Check and test

```sh
vp check                                 # format, lint, type check (vp check --fix to format)
vp run -r test                           # unit tests in every package
vp -C apps/game build                    # production build
vp -C packages/protocol run bench        # JSON vs binary codec benchmark
```

## End to end

```sh
vp run e2e                               # env: E2E_PORT (default 5299), E2E_LOG (default /tmp/gamez-e2e-dev.log)
```

It starts its own `vp dev` (so stop any dev server on that port first), applies the local D1 migrations, then:

1. logs in two guests and connects both to `/ws`; each gets a welcome and sees the other;
2. A walks twice; B must get a delta whose path ends at each target;
3. after each walk the local D1 `character_summary` row for A must reach the target, and `sync_cursor` must advance;
4. A and B leave, the dev server restarts (every DO restarts), A reconnects and its welcome must put it on the last target.

It prints the timings (welcome latency, `moveTo` to delta, walk end to D1 row) and exits non-zero on any failure. CI runs it too.

## Deploy

Workers Builds deploys `main` and creates previews for pull requests. See [`docs/deploy.md`](docs/deploy.md).

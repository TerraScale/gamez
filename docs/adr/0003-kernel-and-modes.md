# ADR 0003: Kernel v1, instance protocol and the two test modes

- Status: accepted (phase 1)
- Date: 2026-10-27

Phase 1 builds the "everything is a module" kernel (plan §1) and two deliberately different test modes that run in a generic `InstanceDO`: **steps** (a step-based roguelike) and **duel** (turn-based creature battles). Classic stays on the phase-0 presence stack for now. This ADR records the decisions; [`packages/kernel/README.md`](../../packages/kernel/README.md) shows how to write a module and a mode.

## 1. Kernel: staged data, a deterministic ECS, overridable systems and actions

`@gamez/kernel` holds mechanics only. Every game rule lives in modules.

- **Modules** (`defineModule`) have a namespaced id (`steps.combat`), a version, `deps` / `optionalDeps`, three data stages (`data`, `dataUpdates`, `dataFinal`), `setup`, `systems`, `actions` and `overrides`.
- **Modes** (`defineMode`) select modules by glob (`"steps.*"`) and choose a tick policy: `{ kind: "event" }` (the world advances once per accepted action) or `{ kind: "fixed", hz }` (InstanceDO steps it on an alarm).
- **`loadMode(mode, catalog)`**:
  1. Resolves the globs and checks dependencies, naming both modules when one is missing and naming the cycle (`a -> b -> c -> a`).
  2. Orders modules topologically, breaking ties by id.
  3. Runs each data stage across all modules, then freezes and hashes the registry.
  4. Applies overrides in load order. `wrap` and `replace` act on a system or action by id; `disable` removes one. A later wrap is outermost, and wrapping a disabled target is a load error.
  5. Orders systems by stage, then `order`, then module load index, then id.

  The result, `LoadedMode`, is immutable and carries `contentHash = stableHash([mode id, module ids+versions, registry hash])`.

- **The ECS `World`**:
  - Entity ids are monotonic, starting at 1.
  - Components and resources are plain JSON, deep-cloned on write and on snapshot.
  - Queries are sorted.
  - `snapshot()` and `restoreWorld()` round-trip exactly.
- **`Sim`**:
  - `dispatch(name, payload, actor)` is atomic: it saves world, RNG and tick, runs `parse` and `apply`, and in event modes then runs every system once. Any throw restores everything and returns `ok: false` with the `ActionError` code (or `internal`, or `unknown_action`).
  - `step(n)` is for fixed modes.
  - `hash()` is `stableHash(snapshot())`.
  - Modes do not special-case the kernel. steps replaces the tick policy and generates floors procedurally. duel replaces combat and HUD with a menu-driven React screen.

### Why the kernel's own World, not an ECS library

The bench ([`docs/bench/2026-10-phase1.md`](../bench/2026-10-phase1.md) §1) measured bitecs, miniplex and koota against the kernel `World` on the same 3-component workload. The libraries are 10–20x faster on a 50k query+update pass: about 40M entities/s for bitecs, 34M/s for miniplex and 2.1M/s for the kernel. None of them gives JSON snapshots, sorted deterministic iteration or exact restore, which instances, prediction and verification all need. The kernel keeps its own `World` behind the `World` interface in `types.ts`, so a library-backed implementation can replace it once classic's real-time sim needs the throughput.

### Known cost: rollback snapshots per dispatch

Bench §2: `dispatch()` snapshots the whole world to be able to roll back, so throughput falls from about 465k/s with 1 entity to about 830/s with 1001 entities. That is fine for steps and duel, whose worlds are tens of entities. It must change (undo log or copy-on-write of touched components) before classic's real-time sim moves onto the kernel. That change will get its own ADR.

## 2. Determinism rules and the lint guard

Sim code is everything the kernel runs: `data*`, `setup`, systems, actions and overrides. It must give the same result on every JS engine:

- randomness only from `ctx.rng`, which is sfc32 seeded through splitmix32 with a 12-output warm-up. The first outputs for seed 42 are pinned in the kernel tests;
- time only from `ctx.tick` / `ctx.timeMs`; no timers, no I/O;
- state only in components and resources, as plain JSON. Fields set to `undefined` are dropped, as JSON does, and `stableHash` rejects anything else (functions, `NaN`, `Map`, class instances, cycles);
- no `dispatch()` or `step()` from inside sim code (re-entry throws).

The root `vite.config.ts` enforces this in `vp check` with an oxlint override on `packages/kernel/src/**` and `modules/*/src/**`, excluding `modules/*/src/client/**` and `*.tsx`. The override forbids:

- `Date`, `performance` and `crypto`;
- `setTimeout`, `setInterval`, `setImmediate`, `requestAnimationFrame` and `queueMicrotask`;
- `Math.random`;
- the `globalThis.` forms of `Date`, `performance` and the timers.

Phase 1 checked this with probe files in both `modules/steps/src` and `modules/duel/src`: every rule fired there, and none fired in the client folders. A mode package therefore keeps its sim code out of `src/client/`, and its UI code in it.

Tests back the lint rule:

- the kernel's determinism suite;
- each mode's scripted playthrough with a pinned hash (steps: seed 1, tick 25; duel: seed 7, plus an event digest);
- snapshot and resume tests;
- `apps/game/tests/shared/catalog.test.ts`, which checks that every catalog mode loads with the same `contentHash` twice and in any catalog order, and that the modes' hashes differ.

The mode tests run in `vp run -r test`, which CI runs. Phase 1 checked that a one-line kernel change (one more RNG warm-up round) fails both modes' pinned tests. The two test modes are the module-system regression suite (plan §1).

## 3. Instance protocol (`/ws/instance`)

- **Route.** `GET /ws/instance?token=…&mode=…` returns 426 without an upgrade and 404 for a mode that is not in `MODES`. A bad or expired guest token is closed with 4401. Otherwise the Worker forwards the upgrade to `InstanceDO` `"<mode>:<accountId>"`, placed with the same `locationHint` as the relay, and sets the identity headers itself.
- **Messages.** They are JSON, defined in `packages/protocol/src/instance.ts`. Client frames are validated in full and capped at 16 KB.
  - Client: `join {token, mode, fresh?}`, `action {seq, name, payload}`, `ping`.
  - Server: `state {instanceId, mode, contentHash, lastSeq, snapshot}`, `result {seq, ok, error?, events, snapshot}`, `pong`, `error`.
- **Server authority, full snapshots.** Each accepted action is dispatched with the account id as actor. The snapshot and the player's `lastSeq` are written to DO SQLite in one transaction, and the reply carries the full snapshot. Phase-1 snapshots are a few KB; deltas come when a mode needs them.
- **Rejections leave state unchanged.** These always get a `result` with `ok: false` and the current snapshot:
  - kernel rejections (`ActionError` codes, `unknown_action`);
  - `stale_seq` (seq ≤ lastSeq);
  - `rate_limited` (burst 10, 10/s per socket);
  - `not_joined`.
- **Lifecycle.**
  - `join` restores the stored snapshot, or creates a sim from a crypto-random seed.
  - `fresh: true` discards the instance (new run, new battle); `lastSeq` carries on.
  - A stored snapshot whose `contentHash` no longer matches is dropped with `error content_changed`, and a fresh instance starts.
  - A newer socket for the same player closes the older one with 4409.
- **Fixed-tick modes.** An alarm runs ticks while a player is joined. It catches up at most 1 s, broadcasts at most every 100 ms and persists at most every second. No phase-1 mode uses this yet. The `state` message carries no events, so a real-time mode will need a protocol extension.
- **Shared catalog.** `apps/game/src/shared/catalog.ts` lists every mode package's `modules` in `MODULE_CATALOG` and each `mode` in `MODES`. The Worker, the browser and `tools/e2e` import the same file, so their `contentHash` agree by construction. A client whose hash differs from the server's shows `client_outdated`.

## 4. Prediction and reconciliation

The client's `InstanceClient` (`apps/game/src/client/instance/`) implements `InstanceConnection` from `@gamez/ui-host`:

- **Prediction.** `act()` gives the action the next seq, sends it, and predicts it right away on a local sim (same kernel, same modules). The view is always "last authoritative snapshot + pending actions replayed".
- **Reconciliation.** On every `result` the server wins. The authoritative snapshot is replaced and the remaining pending actions are replayed on top. A predicted-vs-server hash mismatch is logged with `console.debug`; with deterministic sims it should not happen.
- **Reconnect.** After a reconnect the `state.lastSeq` resolves actions the server already applied, and the rest are re-sent with the same seq.
- **Restart.** `restart()` drops pending actions and sends `join` with `fresh: true`.
- **Connection housekeeping.** It reconnects with the phase-0 backoff and pings every 5 s for `pingMs`. On 4401 it re-logs in. On 4409 it stops reconnecting and shows `replaced`.

Mode UIs read `InstanceView` through `subscribe` / `useSyncExternalStore` (plan §8). steps draws its floor with the shared Pixi `WorldRenderer` under a React HUD. duel is a React screen with inline SVG art.

## 5. Verified end to end

`vp run e2e` keeps the phase-0 presence checks and adds both modes over `/ws/instance` against a real `vp dev`:

1. Join a new instance, checking `contentHash`, `lastSeq` 0 and tick 0.
2. Play a scripted sequence: 24 steps actions (walk to the stairs, bump-attack, descend) and 16 duel actions (moves, forced switches, the next battle). The e2e replays every action on a local sim restored from the server's snapshot and requires the same ok/code, the same events and the same snapshot hash.
3. Send an invalid action, an unknown action and a replayed seq in the middle of the run. Each must be rejected, with state unchanged.
4. Restart the dev server. A plain join must return the persisted snapshot (same hash, same `lastSeq`) and accept the next seq.
5. A `fresh` join must reset to tick 0, accept the next seq, and stay reset on reconnect.

First green run, local workerd: `connect -> state` took 48–106 ms, and `action -> result` averaged 13–20 ms.

## Consequences and follow-ups

- Kernel packages must stay type-strippable (ADR 0002 §4). `ActionError` in `types.ts` was changed from a parameter property to a plain field for this, with the same type and behaviour.
- The rollback-snapshot cost (§1) blocks classic's real-time sim on the kernel until it is replaced.
- The art pack has no monster or stairs sprites yet. steps falls back to the renderer's primitive circle for monsters and to the `missing` sprite for stairs.
- The DO storage microbench is still blocked under Vitest 5 (bench §4). Wire-format and fan-out benchmarks for instances come with the next phases.

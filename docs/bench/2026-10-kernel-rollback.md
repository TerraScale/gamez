# Kernel rollback: undo log instead of snapshots (2026-10-27)

Follow-up to [`2026-10-phase1.md`](2026-10-phase1.md) §2. `Sim.dispatch()` and `Sim.step()` used to deep-snapshot the whole world before every call so a throw could roll back. They now open a world transaction, and the world keeps an undo log of what the call touches. Same machine as phase 1 (Node v24.22.1, Xeon E5-2660 v4, shared). **Relative numbers only.**

## What changed

- `packages/kernel/src/world.ts`: each stored component or resource value lives in a small `Slot`. Between `begin()` and `commit()`/`rollback()` (internal to `WorldImpl`, not part of the `World` contract), the world logs what each change overwrites:
  - membership entries (table, key, previous slot or absent) for `add`, `remove`, `destroy`, `setResource` and `deleteResource`;
  - value entries, once per slot per transaction: the old value by reference when it is replaced, or a deep copy taken before a live value is handed out by `get()`/`read()`/`getResource()` or patched by `update()`;
  - entities created are the ids from the saved `nextEntity` up; destroyed older ids are listed.

  `rollback()` restores slot values and replays membership entries in reverse. `commit()` drops the log. Both cost what the call touched, not the world size.

- `packages/kernel/src/sim.ts`: `dispatch()` and `step()` call `begin()`, then `commit()` or `rollback()`, and save and restore RNG state and tick as before. The re-entry guard, event semantics, `snapshot()`, `hash()` and restore are unchanged.
- `packages/kernel/src/hash.ts`: `cloneJson()` validates and clones in one fast pass with no path bookkeeping. Only when that pass finds a problem does it re-walk the value to throw the same error as before, with its exact path. Callers pass the path as a function, so it is only built on error. `copyStored()` is the journal copy: no validation, key order kept.
- Validation stays on everywhere. It is about 2% of a classic-like tick (`fastClone` in the profile). A dev-only flag would also let a client and a server disagree on whether an action throws, which breaks determinism.

Steps' and duel's pinned hashes did not change.

## Commands

```sh
node_modules/.bin/vp run --no-cache --filter @gamez/bench bench:kernel
# BENCH_RESULTS=<name> writes tools/bench/results/<name>.json instead of kernel.json
```

The "before" run used the same `src/kernel.ts` against the previous kernel and is kept in `tools/bench/results/kernel-snapshot-rollback.json`. The "after" run is in `results/kernel.json`. Both were run on the same day; the phase-1 run of the unchanged rows was faster (465k vs 322k dispatches/s with 1 entity), which shows how noisy this host is.

New rows in `src/kernel.ts`:

- a rejected dispatch, which mutates and then throws `ActionError`, so the rollback path runs;
- `step(1)` at 1000 entities, which is what a 20 Hz instance calls;
- a **classic-like** fixed mode shaped like `modules/classic`: about 300 monsters with position, velocity, HP and AI state, projectiles spawned and destroyed every tick, loot drops with a TTL, a hit bus resource and a 512-word exploration bitset. Its "systems only" row runs the same systems on a bare world with a fake context, with no sim and no rollback. The bench checks that the bare run and the sim reach the same state.

## Results

### Dispatch (event mode)

| Case                                           |  Before |   After |         Speed-up |
| ---------------------------------------------- | ------: | ------: | ---------------: |
| world of 1 entity, dispatches/s                | 322,335 | 837,566 |             2.6x |
| world of 1001 entities, dispatches/s           |     783 | 868,326 | **about 1,100x** |
| 1001 entities, rejected dispatch, dispatches/s |     368 |  80,736 |             220x |

Dispatch cost no longer depends on world size. A rejected dispatch costs about 12 µs, and most of that is building the `ActionError` (stack capture), not the rollback.

### step() (fixed mode)

| Case                                   | Before ms/tick | After ms/tick | Speed-up |
| -------------------------------------- | -------------: | ------------: | -------: |
| 1000 movers, `step(100)` (per tick)    |          0.200 |         0.182 |     1.1x |
| 1000 movers, `step(1)`                 |          2.365 |         0.488 |     4.8x |
| classic-like, systems only (floor)     |          0.262 |         0.286 |        — |
| classic-like, `sim.step(1)`            |      **2.134** |     **0.531** |     4.0x |
| classic-like, kernel overhead per tick |          1.872 |         0.245 |     7.6x |

The classic-like `step(1)` is now about 0.5 ms for about 470 to 500 entities, roughly 1% of a 50 ms tick. Before, rollback was 88% of the tick. It is now about 46%: the floor run and the sim run each have their own share of host noise, so the split is approximate.

### Where the remaining overhead goes

The kernel overhead per tick is now one deep copy per mutable value that the tick hands out. That is about 1,400 values per tick in the classic-like workload, at roughly 150 ns each across many object shapes. Experiments on the classic-like workload with `step(1)`:

| Variant (unsafe, measurement only) | ms/tick |
| ---------------------------------- | ------: |
| as shipped                         |    0.57 |
| no copy on `get()`, log kept       |    0.37 |
| no copy and no log                 |    0.29 |

`step(20)` costs about 0.30 ms per tick, because each value is copied once per call rather than once per tick. The copy cannot be skipped without knowing whether the caller mutates the value, and that would need an API change (for example a read-only `peek()`). The bench systems do almost no work per entity. Real classic systems (pathing, line of sight, AI scoring) do more per value they touch, so the journal's share of a real tick will be smaller.

### Raw World costs (outside any transaction, 50k entities, 3 components)

Measured with a one-off script that imports the previous kernel and the new one into the same process:

| Case                                 |     Before |      After |
| ------------------------------------ | ---------: | ---------: |
| create (`create` + 3x `add`), ms     |    209–240 |  about 150 |
| `read` + mutate pass, ms             | about 16.5 | about 16.5 |
| `update()` pass, ms                  |      54–62 |      31–40 |
| `snapshot()`, ms                     |    173–217 |   about 95 |
| `restoreWorld()`, ms                 |    212–227 |    151–182 |
| heap per entity, bytes (own process) |        304 |        448 |

The validation fast path makes `add`, `update`, `snapshot` and restore faster. The cost is memory: each stored value now has a `Slot` holder, about 48 bytes per component instance. For classic's few hundred entities that is tens of KB.

## Semantic edge cases

- **Rollback restores exactly.** It brings back values, key order (copies keep insertion order), entity membership and `nextEntity`. The randomized test in `packages/kernel/tests/rollback.test.ts` checks the snapshot JSON text after random operations.
- **Object identity after rollback.** A value touched by a failed call is replaced by its pre-call copy, so references taken during that call are detached and mutating them later has no effect. Untouched values keep their identity. The old snapshot rollback replaced every value.
- **Mutate only values you got in the same `dispatch()`/`step()`.** A live value cached across calls (for example in a module-level variable) and mutated later without a fresh `get()` is not journaled, so it is not rolled back. The old full snapshot would have caught it. That code already broke the rule that state lives in the world.
- **Do not alias live values into each other in place** (`a.items = world.read(b, Inv).items`). `add`, `update` and `setResource` clone, so aliasing can only come from in-place assignment. A mutation through one alias is journaled only under the key it was read from. Restoring from a snapshot does not keep the aliasing either.
- Empty component tables created by a rolled-back call stay in memory as empty maps. `snapshot()` and `query()` cannot see them.

## Caveats

- Shared 46-thread Xeon running Node, not workerd. Rows with only 3 iterations (the old 1001-entity dispatch rows) are rough.
- The bench's `classicEntities` and its final sanity hash depend on how many iterations ran, so they differ between runs.

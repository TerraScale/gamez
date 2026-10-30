# Sim hot path: the classic melee tick (2026-10-30)

Follow-up to [`2026-10-party.md`](2026-10-party.md) and party.md §12. With every module, the
classic sim cost about 2.3–2.6 ms per tick in the 300-monster melee on the dev box, above the
2 ms budget. This round cut the tick by about a quarter without changing behaviour. Decisions
are in [ADR 0013](../adr/0013-sim-hot-path.md).

## Method

- **Bench:** `tools/bench/src/melee.ts`, the real classic mode with every module and no bench
  overrides. A solo hero and a party of four are put on Full Idle in their first dungeon level
  and topped up to 300 awake monsters (life raised so none die; heroes healed outside the timed
  step). Each case is snapshotted once; each measured repeat restores the snapshot, runs 200
  untimed ticks and then times 600 `sim.step(1)` calls. Three measured repeats per run.
- **A/B:** `tools/bench/melee-ab.sh <base> <rounds>` runs the bench on the base commit
  (`34dff81`, the bench alone on the old code) and on the branch, alternating which goes first,
  on one host in one job (`ts-heavy-any`). Load hits both sides alike.
- **Behaviour check:** every repeat ends on a sim hash, and the base and new hashes must match:
  solo `bc942a510289cfd7`, 4 heroes `a5c69f668edabaea`, identical on every run and commit. The
  steps, duel and classic pinned-hash tests stayed green too; no module version changed.

```sh
node --experimental-transform-types tools/bench/src/melee.ts      # one host, 3 repeats
ts-heavy-any tools/bench/melee-ab.sh 34dff81 4 --repo gamez --branch <branch>
```

## Results

Per row: the median of the three measured repeats of one run (ms per tick), and the median
best 25-tick window. Four rounds per host.

### beta (Ryzen 5 PRO 6650H, 12 threads, load average 1.7–1.8)

| Round | Base solo | New solo | Base 4 heroes | New 4 heroes | Base best (4) | New best (4) |
| ----: | --------: | -------: | ------------: | -----------: | ------------: | -----------: |
|     1 |     0.752 |    0.565 |         0.849 |        0.624 |         0.717 |        0.538 |
|     2 |     0.717 |    0.582 |         0.832 |        0.632 |         0.697 |        0.556 |
|     3 |     0.755 |    0.554 |         0.837 |        0.628 |         0.717 |        0.526 |
|     4 |     0.764 |    0.570 |         0.813 |        0.631 |         0.710 |        0.535 |

Solo 0.754 → 0.568 ms (−25 %), 4 heroes 0.835 → 0.630 ms (−25 %), best windows −25 %. The
three repeats inside each run agree within about 5 %.

### mariogk-dev (Xeon E5-2660 v4, 46 threads, the budget's reference box, load average 41–58)

The box was busy with other workflows for the whole run, so absolute numbers are 1.5–2× the
idle ones and noisy; the interleaved comparison still holds.

| Round | Base solo | New solo | Base 4 heroes | New 4 heroes | Base best (4) | New best (4) |
| ----: | --------: | -------: | ------------: | -----------: | ------------: | -----------: |
|     1 |     2.592 |    1.828 |         3.377 |        1.991 |         2.191 |        1.666 |
|     2 |     4.811 |    2.856 |         4.048 |        3.212 |         2.770 |        1.939 |
|     3 |     4.061 |    3.013 |         3.833 |        3.013 |         3.090 |        2.419 |
|     4 |     3.292 |    2.870 |         3.954 |        3.157 |         3.039 |        2.315 |

Medians: solo 3.68 → 2.86 ms (−22 %), 4 heroes 3.89 → 3.09 ms (−21 %), best windows 2.90 →
2.13 ms (−27 %).

**Budget.** The last idle-box reading of the old code was 2.3 ms best window and 2.6 ms mean
(4 heroes, load average 5, 2026-10-party.md). A 21–27 % cut puts that at about 1.7–1.8 ms best
and 1.9–2.05 ms mean: the 2 ms budget is met for the best window and at the edge for the mean.
It could not be confirmed on an idle dev box today (the box never dropped below load 40). The
perf tests (`party.auto.perf`, `party.perf`, `monsters.perf`) pass when run alone on beta
(3 of 3; party/solo best-window ratio 1.22–1.25).

## What the profile showed, and what changed

CPU profiles (`node --cpu-prof`, 4 heroes, 4000 ticks) and per-system wrap timers pointed at
these, in order of effect:

1. **Dictionary-mode objects.** The kernel clones stored values key by key, and V8 turns such
   an object into a slow dictionary past 16 properties. CombatStats (27 fields, on every unit),
   AutoState (20) and big registry prototypes were dictionaries: every read a hash lookup, a
   rollback copy 7–12 µs instead of about 1 µs. Big clones are now rebuilt with a spread copy.
2. **Spatial grid rebuild.** It truncated 1024 cell arrays every tick (`length = 0` is a slow
   runtime call) and allocated one position object per unit: about 0.4 ms in isolation on the
   loaded box. Cells now reuse arrays with an `Int32Array` of counts.
3. **Rollback copies.** About 260 deep copies per tick, mostly projectiles (55 per tick,
   damage and hit list included), positions and movers, plus a dozen resources read only for a
   depth or a hero id. Read-only sites now `peek()`/`peekResource()`; projectiles and movement
   write back changed fields, which the undo log keeps as field entries instead of deep copies;
   exploration takes its bitsets live only when a tile is revealed.
4. **Kernel lookups and clones.** Component tables by a hidden handle index (array load instead
   of a string-keyed `Map`), insertion-sorted keys in clones, no closure per `add`/`update`.
5. **Classic hot spots.** `lineOfSight` (hundreds of segments per tick from the leader's foe
   scan), `mapFor` (a string key per call), big query results sorted natively, the stats system
   writing Life, Mana and HeroStats every tick.

Copies left per tick (µs at load about 30): the aggro memory 28 (about 80 integer keys in a
sparse object), AutoState 14, casting 12, HeroStats 9. The remaining time is spread over the
monster AI, the auto brains, movement and the grid; no single item is above 5 % of the tick.

## Next candidates

- The aggro memory: a dense layout (sorted `[entity, tick]` pairs) would make its copy cheap,
  but it changes the state and the hashes (needs a version bump).
- `Map<Entity, Slot>` lookups are now the largest kernel cost (about 13 000 per tick). A
  faster store must keep `query()`'s cheap ascending iteration and bounded memory (ADR 0013 §4).
- The leader's twelve-tile foe scan tests line of sight to about 150 monsters per think.

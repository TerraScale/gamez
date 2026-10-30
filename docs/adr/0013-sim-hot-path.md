# ADR 0012: Sim hot path (field undo entries, peekResource, fast-property clones)

- Status: accepted (branch `sim-perf`)
- Date: 2026-10-30

The classic sim with every module cost about 2.3–2.6 ms per tick in the 300-monster melee
(party.md §12, ADR 0010 §7), above the 2 ms budget. This ADR records what was changed to cut
it without changing behaviour, and the rules later work should follow. The measurements are in
[`docs/bench/2026-10-sim-perf.md`](../bench/2026-10-sim-perf.md).

Every change keeps the state and its hashes identical: the melee bench prints its end hash for
a solo hero and a party of four (unchanged on every commit), and the steps, duel and classic
pinned-hash tests stayed green. No module version was bumped.

## 1. Undo log: field entries for `update()`

`update()` of a value not yet logged in the transaction used to deep-copy the whole value. Now,
when every patched key already exists and none is deleted, the world saves only the old values
of those keys, by reference (`update()` replaces them with clones and never mutates them). Key
order cannot change, so restoring those fields is exact.

- If the same value is later handed out live (`get`/`read`) or replaced (`add`) in the
  transaction, the field entry is promoted to a whole-value entry: a copy of the value with the
  saved fields put back.
- Patches that add or delete a key still log the whole value (they change key order).
- The randomized rollback test now mixes field entries, promotions and key-adding patches.

Rule for hot systems: to change a few fields of a big value, `peek()` it, work on a shallow copy
and `update()` the fields that changed (projectiles, movement). Do not mutate a nested value of
the copy: replace it (`path.slice()` instead of `path.splice()`).

## 2. `World.peekResource(key)`

`getResource()` hands out the live value and copies the whole resource on its first read in a
transaction. `peekResource()` returns the same value without the copy, like `peek()` for
components. Never mutate what it returns. It is a deliberate addition to the `World` contract;
`WorldImpl` is its only implementation.

Classic's read-only helpers use it: `heroOf`, `currentDepth`, `getAreaMap`, `configOf`, and the
pure party helpers (`partyMembers`, `partySize`, `isPartyHero`). `partyStateOf()` and the
`need()` accessors stay live because callers mutate what they return.

## 3. Stored objects keep fast properties

The kernel clones every stored value key by key (sorted keys). V8 turns an object built with
computed-key stores into a slow dictionary once it has more than 16 properties. CombatStats (27
fields, on every unit), AutoState (20) and the bigger registry prototypes were all
dictionaries: each property read was a hash lookup, and a rollback copy of one took 7–12 µs
instead of about 1 µs. Clones with more than 16 keys are now rebuilt once with a spread copy,
which keeps the same keys, order and values with fast properties.

- Rejected: `Object.fromEntries()` (fast properties, but several µs per object on the dev box)
  and a per-shape template cache (a key-signature string per clone, and more state).
- Rollback copies stay a for-in copy: they are dropped at commit, and copying a fast source is
  the cheapest option measured.

## 4. Smaller kernel changes

- `defineComponent()` gives each handle a hidden index shared by every handle of the same name;
  worlds cache tables by it, so `get/peek/has/update/query` use an array load instead of a
  string-keyed `Map` lookup. Hand-built `{ name }` handles still work through the `Map`.
- Object keys are sorted with an insertion sort for lists up to 32 keys (three to five times
  faster than `Array.prototype.sort` there, same UTF-16 order, checked by a randomized test).
- `add()`/`update()` no longer allocate an error-path closure per call.

Considered and rejected: replacing the per-component `Map<Entity, Slot>` with paged arrays or an
open-addressing table. The lookup would be 5–10 ns faster, but paged arrays grow with the
highest entity id (projectiles create ids forever), and a hash table loses the insertion order
that lets `query()` skip its sort.

## 5. Classic changes

- Spatial grid: per-cell id/x/y arrays with an `Int32Array` of counts, so the per-tick rebuild
  is one `fill(0)` instead of truncating 1024 arrays (a slow runtime call each), and queries read
  positions from the cell. Results over 32 ids are sorted in a `Float64Array`.
- `get()`/`read()` that only read became `peek()` across monsters, combat, the auto brains,
  talents and regen. The stats system writes Life, Mana and HeroStats only when they change
  (the merge check compared nested key order against the unsorted patch, so HeroStats was
  rewritten every tick).
- Projectiles and movement write back changed fields (section 1).
- Exploration checks read-only whether the light radius reveals a new tile before taking the
  whole ExploreState live.
- `mapFor()` returns the last map directly when registry, seed and depth match;
  `lineOfSight()` inlines the tile test and skips samples on a tile already found walkable.
- The monster AI indexes the aggro memory with the entity number instead of `String(e)`.

## 6. Result and budget

See the bench doc for the tables. Summary, 300 awake monsters, every module, median of three
measured repeats per round, interleaved with the old code on the same host:

| Host                                      | Case                  | Before ms/tick | After ms/tick | Change |
| ----------------------------------------- | --------------------- | -------------: | ------------: | -----: |
| beta (Ryzen 5 PRO 6650H, load 1.8)        | solo, mean            |          0.754 |         0.568 |  −25 % |
| beta (Ryzen 5 PRO 6650H, load 1.8)        | 4 heroes, mean        |          0.835 |         0.630 |  −25 % |
| mariogk-dev (Xeon E5-2660 v4, load 41–58) | solo, mean            |           3.68 |          2.86 |  −22 % |
| mariogk-dev (Xeon E5-2660 v4, load 41–58) | 4 heroes, mean        |           3.89 |          3.09 |  −21 % |
| mariogk-dev (Xeon E5-2660 v4, load 41–58) | 4 heroes, best window |           2.90 |          2.13 |  −27 % |

Budget: on an idle dev box the old code measured 2.3 ms best window and 2.6 ms mean (4 heroes,
load 5). The measured cut puts that at about 1.7–1.8 ms best and 1.9–2.05 ms mean, so the 2 ms
budget is met for the best window and at the edge for the mean. It could not be confirmed on an
idle dev box (it stayed above load 40 all day); re-measure with `tools/bench/melee-ab.sh` when
it is quiet. The relative party target of party.md §12 holds (party/solo best-window ratio
1.22–1.25 in `party.auto.perf` on beta).

The remaining cost is spread over the monster AI, the auto brains, movement and the spatial
grid. The largest single rollback copy left is the aggro memory (about 80 integer keys in a
sparse object, one copy per tick); changing its layout would change the state and the hashes.

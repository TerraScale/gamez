# Wave C: presence at scale (2026-10-28)

How many players one pose world (`classic-town`) carries, measured with a bot swarm against a
private local server (docs/design/wave-C.md §12). The numbers drove three fixes, relay sharding,
and the decision to **defer the chunk grid / area of interest**.

**Caveat first: local workerd is not production.** Locally one workerd thread runs the Worker,
all four relays and the chunk. In production each Durable Object is its own isolate, on its own
thread and usually its own machine. The local knee is therefore the knee of _the whole presence
system on one 2 GHz core_. It is a floor for production, not a forecast. The host is the shared
46-vCPU Xeon E5-2660 v4 VM used by the other October benches. Other agents were running builds
and tests at the same time (load average 4–75 during the runs; the JSON records it per step).
Read the numbers as relative.

## Method

```sh
node_modules/.bin/vp -C apps/game build          # for --mode preview
node tools/loadtest/src/swarm.ts --serve 5413 --mode preview \
  --ramp 50,100,150,200,250,500,1000 --duration 10 --warmup 3 --workers 4
node tools/loadtest/src/chunk-cost.ts --relays 4 --hz 3   # chunk CPU model, no runtime
```

The swarm (`tools/loadtest`, Node only, no dependencies) works like this:

- **Server.** It starts its own `vp dev` or `vp preview` on the given port and refuses :5173. It
  uses a **private state dir** (`tools/loadtest/vite.isolated.config.mjs`,
  `/tmp/gamez-loadtest-state/<port>`). Every other dev server (the user's :5173 and every e2e
  server) persists into `apps/game/.cloudflare/state`. The first swarm run used the shared
  files: both workerd processes hit `SQLITE_BUSY` on the same ChunkDO file. It also turns off the
  local explorer's per-invocation tracing (`X_LOCAL_OBSERVABILITY=false`), which production does
  not do per RPC. With tracing on, workerd RSS grew to 4.4 GB at 250 bots. `--observability`
  keeps it on.
- **Bots.** Each bot does `POST /api/guest`, then `/ws?token&world=classic-town`, then a random
  walk over the 72×72 town at 4 tiles/s. It sends a pose (tile plus up to 8 tiles ahead) at
  `--pose-hz` (3/s; the server limit is 5/s and the classic client sends at most 4/s, only on
  change). Bots run in 4 worker threads; generator event-loop use stayed at 0.23 or below, so the
  generator never limited a run.
- **Latency.**
  - _End to end_ (the headline): each pose carries its send time in the cosmetic tag. A bot
    receiving another bot's upsert records receive minus send time. All bots share the host
    clock, so no clock sync is needed. This is pose → delivery as other players see it.
  - _Server stamp_ (column "srv p95"): receive time, moved to server time with the lowest-RTT
    ping offset, minus the upsert's `pathStartedAt`. `continueWalk` back-dates `pathStartedAt`
    while an avatar is mid-step, so this is an upper bound of chunk → client latency, given for
    comparison.
- **Delivery.** _Delivery_ = upserts received ÷ (poses sent × (bots − 1)). Below 100 % means
  poses of the same player coalesced into one upsert (latest wins), which is what an overloaded
  pipeline should do.
- **Join time.** Join time runs from guest login to the welcome.
- **Server counters.** Chunk counters (poses, flushes, upserts per flush, relays) come from the
  dev-only `GET /api/dev/presence/stats`. workerd CPU and RSS come from `/proc`.
- **Saturation.** A step counts as saturated on any of: e2e p95 > 300 ms, any error, any close,
  any failed join, or delivery < 95 %.

Results: `tools/loadtest/results/2026-10-28-waveC-*.json`.

## Results

### Production bundle (`vp preview`), 4 relay shards, 3 poses/s per bot

| Bots | Join p50 / p95 ms | e2e p50 / p95 / p99 ms | srv p95 ms | Frames /bot/s | KB /bot/s | Upserts /bot/s | Delivery | Chunk ingest (poses/s) | Flushes/s | workerd CPU | RSS MB | Errors / closes |
| ---: | ----------------: | ---------------------: | ---------: | ------------: | --------: | -------------: | -------: | ---------------------: | --------: | ----------: | -----: | --------------- |
|   50 |        725 / 1040 |       **39 / 65 / 79** |        380 |          19.5 |      52.4 |          146.5 |   99.8 % |              150 / 150 |      19.3 |        40 % |    237 | 0 / 0           |
|  100 |        765 / 1023 |    **108 / 189 / 216** |        403 |          14.6 |      99.7 |          288.4 |   98.7 % |              298 / 300 |      14.5 |        90 % |    309 | 0 / 0           |
|  150 |       1311 / 2190 |      723 / 1071 / 1187 |        701 |           2.7 |     115.5 |          341.7 |   79.5 % |              412 / 450 |       2.5 |        97 % |    353 | 0 / 0           |
|  200 |       3505 / 3541 |     1115 / 1498 / 1609 |        869 |           1.7 |      96.9 |          287.6 |   50.2 % |              578 / 600 |       1.5 |        98 % |    408 | 0 / 0           |
|  250 |       5111 / 5857 |     2995 / 4295 / 4562 |       2230 |           0.9 |      43.8 |          131.4 |   15.9 % |              617 / 750 |       0.5 |        77 % |    450 | 409 rl / 0      |
|  500 |     14425 / 24518 |     6351 / 9017 / 9556 |       4440 |           0.6 |      24.4 |           73.3 |    4.9 % |                      – |         – |        98 % |    678 | 2308 rl / 0     |
| 1000 |     49863 / 78321 |  17730 / 23358 / 23812 |      11433 |           0.4 |      13.7 |           41.4 |    2.1 % |                      – |         – |        97 % |    784 | 2528 rl / 0     |

Notes on the table:

- **Ingest column.** It reads "chunk ingest / poses sent per second". At 500 bots and above the
  stats request itself timed out on the saturated thread.
- **The 1000 step.** Only 668 of 1000 bots joined: 332 joins hit the swarm's 30 s join timeout.
  No socket ever closed.
- **"rl" errors.** These are `rate_limited` notices. They are a _symptom_, not a cause: an
  overloaded relay handles each socket's queued messages in a burst, so the token bucket sees
  several poses at the same `Date.now()`.

A first preview run, with the host load average at 4–9, gave 50 bots p95 61 ms, 100 bots
p95 99 ms, and 250 saturated (`…preview-run1.json`). A 40 s steady window at 100 bots gave
p50 / p95 / p99 65 / 162 / 222 ms over 1.19 M deliveries (`…preview-100-steady.json`).

### Dev server (`vp dev`), same code

| Bots | e2e p50 / p95 / p99 ms | KB /bot/s | Delivery | workerd CPU | Status    |
| ---: | ---------------------: | --------: | -------: | ----------: | --------- |
|   50 |         47 / 129 / 300 |      50.7 |   95.9 % |        53 % | ok        |
|  100 |        106 / 186 / 228 |     103.7 |  100.0 % |        91 % | ok        |
|  250 |     2973 / 3416 / 3550 |      75.0 |   29.4 % |        99 % | saturated |

The dev server runs the Worker through Vite's module runner (a `Proxy` around every DO, about
22–28 % of samples) and costs about 1.5× the CPU of the production bundle at the same load.

### What the swarm found and fixed (dev server, tracing on, 3 poses/s)

| Change                                                                                             | 50 bots e2e p95 | 100 bots                                                      |
| -------------------------------------------------------------------------------------------------- | --------------: | ------------------------------------------------------------- |
| Baseline (wave B code)                                                                             |         1517 ms | not run (50 already at 64 % delivery and 2 frames/s)          |
| Chunk: poses kept in memory in pose worlds; persisted seq becomes a ceiling, not a write per delta |          723 ms | **collapse**: 0.7 frames/s, 6.6 % delivery, RSS 929 MB+       |
| Relay: world and chunk stub cached; poses batched; chunk: one delta in flight                      |      **201 ms** | 830 ms p95, **98 % delivery**: degrades instead of collapsing |

1. **One SQLite write per pose.** `INSERT OR REPLACE` per pose (3–4 per player per second) held
   every outgoing delivery behind its storage commit (output gate). At 50 bots the chunk took
   145 poses/s but flushed only 1.8 times a second. Pose-world presence is ephemeral, so an
   avatar row is now written at join only. A restarted chunk shows the avatar at its join tile
   until its next pose. The delta seq is persisted as a ceiling raised 10 000 at a time instead
   of on every flush. After a restart the chunk resumes past every seq it delivered, so relays
   see a gap and resync, as before.
2. **No backpressure.** The flush timer fired every 50 ms whatever the deliveries were doing.
   Under load, concurrent deliveries piled up (RSS climbed, frames dropped to 0.2/s). Now one
   delta is in flight at a time and changes meanwhile coalesce into the next one: bigger, fewer
   frames under load, and delivery stays near 100 % until the core saturates.
3. **Relay hot path.** The CPU profile (CDP `Profiler` on the workerd inspector) showed:
   - a KV read on every message (`get world`, 6 %);
   - a new chunk stub per call;
   - one chunk RPC per pose (11 %).

   The relay now caches the world and the stub. It sends poses as a batch RPC
   (`ChunkDO.poses`), one batch in flight: a quiet relay forwards each pose at once, and a busy
   one coalesces to the latest pose per player.

## Where the time goes (production bundle, 100 bots, 300 poses/s, 15 s CPU profile)

| Owner                            | Share of samples | Top items                                                                 |
| -------------------------------- | ---------------: | ------------------------------------------------------------------------- |
| Relays (4 shards)                |       **42.8 %** | `#broadcast` 21.3 %, `#forwardPoses` (batch RPC) 11.8 %, `#sockets` 3.5 % |
| Chunk                            |        **9.5 %** | flush/deliver closure 2.6 %, `#pose` 2.4 %, `sanitisePose` 0.6 %          |
| Native (unattributed), GC, other |           28.0 % | RPC serialisation, WebSocket writes                                       |
| Idle                             |           19.6 % |                                                                           |

The relays' fan-out (`#broadcast`: one encode per delta, one `send` per socket) is the cost that
grows with N². The chunk's work is linear in poses.

## Does one ChunkDO saturate below 500 bots?

Not by the measured evidence. That rules out the grid under the design's rule (§12).

- **Swarm.** The whole local system saturates at 100–150 bots. In those steps the chunk kept
  ingesting almost every pose: 412 of 450 per second at 150 bots, 578 of 600 at 200. Deliveries
  slowed to 2.5 and then 1.5 flushes a second. The bottleneck is fan-out on the shared thread,
  not the chunk.
- **Profile, upper bound.** Give the chunk its proportional share of the unattributed native/GC
  time. It then uses about 14.6 % of a core at 300 poses/s, which is ≤ 0.49 ms per pose
  including both RPC directions. One core would carry about 2000 poses/s on this 2 GHz host:
  ~680 bots at 3 poses/s, ~500 at 4 poses/s. Cost per pose falls as batches grow, so this
  overstates heavy load.
- **Model, lower bound.** `tools/loadtest/src/chunk-cost.ts` measures the chunk's JS work plus
  one structured clone per relay per delta, without the runtime. That is 75–89 µs per pose with
  4 relays, a ceiling of about 3000–4400 bots at 3–4 poses/s.

| `chunk-cost.ts`, 4 relays | 100 bots |  250 |  500 | 1000 |
| ------------------------- | -------: | ---: | ---: | ---: |
| µs per pose, 3/s          |     88.9 | 83.5 | 75.0 | 78.8 |
| % of a core, 3/s          |      2.7 |  6.3 | 11.2 | 23.6 |
| % of a core, 4/s          |      2.9 |  8.1 | 15.0 | 31.7 |

Real players pose only while moving (the classic client sends at most 4/s, on change), and an
idle game's town is mostly standing heroes. The 3/s continuous swarm is a worst case.

**The first limit is bandwidth, not the chunk.** Each client receives every other player's
poses: about 1 KB/s per moving player with JSON (52 KB/s at 50 bots, 100 KB/s at 100). The
binary codec is 2.24× smaller on the same deltas (145 vs 325 bytes per entity with a 6-tile path
and a tag, `node` measurement, 16–64 upserts per delta). Relay CPU is spread over
`relayShards`.

## Decision and recommendation

**Keep one ChunkDO per pose world, sharded relays (`classic-town`: 4), no grid for now.**

1. Ship relay sharding (done: `relayShards` in `shared/worlds.ts`, `relayShard()` is a stable
   FNV-1a of the account id, so all of one account's sockets meet on one relay; the plaza keeps
   its legacy single relay). Raise `relayShards` when a relay's CPU or its broadcast time grows.
2. Switch the wire codec to `binaryCodec` (`apps/game/src/shared/codec.ts`, one line; both
   codecs already round-trip every message including `shopkeeper`). That cuts client downlink and
   relay bytes by about 2.2×. It is a separate change because it touches the client and its owner.
3. Re-measure on a deployed preview with `--url` once the game runs on Cloudflare. The swarm
   needs no changes for that, apart from `/api/dev/presence/stats`, which exists on dev hosts
   only.

**ADR-ready paragraph (chunk grid / AOI, deferred).** Pose worlds keep one ChunkDO per world:
measured locally, its ingest kept pace with 600 poses/s on a thread shared with four relays and
the Worker. Its cost is linear in poses: ≤ 0.5 ms per pose upper bound, ~80 µs in a runtime-free
model, so a single chunk carries ~500–4000 moving players depending on the true RPC overhead.
The growth term is fan-out (N² bytes): relay broadcast CPU and client downlink, about 1 KB/s per
moving player in JSON. Sharded relays and the binary codec address it first. A static grid for
pose worlds becomes worth its complexity when any of these hold:

- (a) a production ChunkDO exceeds ~50 % CPU time per wall second;
- (b) a pose world regularly holds more than ~150 concurrently moving players;
- (c) client downlink in a town exceeds ~64 KB/s.

The grid itself would be:

- cells of 12 tiles (a 6×6 grid on the 72-tile town);
- relays subscribe to the 3×3 cells around each of their players and hand off when a player
  crosses a cell edge;
- fixtures stay on the world's primary chunk (`presenceWorld(world).chunk`), which every relay
  keeps subscribed.

Cells as large as 24 tiles would make a 3×3 neighbourhood cover the whole town and save nothing.

## World fixtures (ghost shopkeepers)

Not a throughput item, but delivered with this bench. `ChunkDO.setFixtures(group, fixtures)`:

- **Validation** (`presence/fixtures.ts`):
  - group `^[a-z][a-z0-9_-]{0,31}$`;
  - ids `<group>:…`, unique;
  - kind `shopkeeper`;
  - tile inside the world;
  - at most 64 per group;
  - name, tag and appearance sanitised like poses;
  - fixtures are normalised to standing still.
- **Storage.** Each group is replaced atomically in the chunk's SQLite (`fixtures` table).
- **Delivery.** Fixtures are part of `subscribe()` state and every welcome. Changes go out as
  ordinary upserts and removes, and unchanged fixtures are not re-sent.
- **Isolation.** Fixtures never time out. `join`, `pose`, `moveTo` and `leave` never touch them,
  and an id held by a live avatar is refused.
- **Dev hook** (dev hosts only): `POST /api/dev/presence/fixtures {world, group, fixtures}`. The
  e2e feature `loadtest` checks the whole path, including survival across a dev-server restart.

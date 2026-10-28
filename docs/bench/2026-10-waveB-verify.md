# Wave B: classic replay verification cost (2026-10-28)

What full replay of every classic segment costs the InstanceDO (`VerifiedHost`,
docs/design/wave-B.md §2.4, decision 1 in §12). Same machine as the other October benches
(Node v24.22.1, Xeon E5-2660 v4, shared and noisy). **Read the numbers as relative, and as an
upper bound for workerd**: V8 is the same, but the host is slower than Cloudflare's.

## Command

```sh
node_modules/.bin/vp run --filter @gamez/bench bench:verify
# writes tools/bench/results/verify.json and prints the tables below
```

`tools/bench/src/verify.ts`:

- **Replay rate.** For each class, a fresh hero on the real content (`classic.modules`) plays on
  the "client" side with a `SegmentRecorder`: Auto at x1 cut every 40 ticks (one segment per 2 s,
  `limits.segmentEveryMs`), and Full Idle at x8 cut every 320 ticks (2 s at x8). The timed part is
  the server side: `replaySegment()` with `expectHash` on a sim restored from the start snapshot,
  exactly what `VerifiedHost` does per segment (limits, server-only set, `speedOf`, final
  `hash()`). Best of two runs. A player-minute is 1200 ticks at x1 and 9600 ticks at x8.
- **Depth profile.** A warrior with a QA grant (level 40, eight rare items; the `classic.debug`
  module is loaded, so this content hash is not the real one, but the per-tick work is) in Full
  Idle until depth 1, 5 and 10. At each: snapshot JSON and gzip size, `snapshot()`, `hash()` and
  restore (`createSim(from)`, i.e. DO wake / resync) medians, and one x1 player-minute replayed.
- **Frames.** JSON size of `segment` messages.

## Results

### Replay CPU per player-minute (real content)

| Case                  | Ticks | Segments | Replay ms | CPU ms / player-minute | Share of one core | `hash()` share |
| --------------------- | ----: | -------: | --------: | ---------------------: | ----------------: | -------------: |
| warrior Auto x1       |  2400 |       60 |     2,390 |              **1,195** |             2.0 % |         37.1 % |
| warrior Full Idle x8  |  9600 |       30 |     6,310 |              **6,310** |            10.5 % |          9.1 % |
| rogue Auto x1         |  2400 |       60 |     2,361 |              **1,180** |             2.0 % |         40.4 % |
| rogue Full Idle x8    |  9600 |       30 |     5,664 |              **5,664** |             9.4 % |          7.1 % |
| sorcerer Auto x1      |  2400 |       60 |     2,334 |              **1,167** |             1.9 % |         44.0 % |
| sorcerer Full Idle x8 |  9600 |       30 |     5,030 |              **5,030** |             8.4 % |         10.9 % |

### Depth profile (warrior, QA grant: level 40, Full Idle)

| Depth |  Tick | Snapshot JSON |    gzip | `snapshot()` ms | `hash()` ms | restore ms | CPU ms / x1 player-minute |
| ----: | ----: | ------------: | ------: | --------------: | ----------: | ---------: | ------------------------: |
|     1 |   250 |        149 KB | 12.6 KB |            2.58 |       15.25 |       2.76 |                     1,063 |
|     5 | 13750 |        169 KB | 14.3 KB |            2.89 |       17.83 |       2.97 |                     1,258 |
|    10 | 30500 |        173 KB | 15.4 KB |            2.93 |       17.93 |       3.15 |                     1,191 |

### Segment frames

| Case                                              | JSON bytes |
| ------------------------------------------------- | ---------: |
| Auto x1, 40 ticks, no inputs                      |         99 |
| Full Idle x8, 320 ticks, no inputs                |        101 |
| Manual, 40 ticks, 40 inputs (worst-case clicking) |      2,268 |

## Reading

- **x1 play costs about 1.2 s of CPU per player-minute** (about 2 % of a core per connected
  player), flat across classes and depths 1 to 10. About 40 % of it is the one `hash()` per
  segment: `stableHash` of a ~150 KB snapshot takes 15-18 ms, five to six times what `snapshot()`
  itself takes. The sim ticks themselves are ~0.5 ms each.
- **Full Idle at x8 costs 5-6.3 s of CPU per player-minute** (8-10 % of a core per player): the
  server replays eight sim seconds per wall second. This is the dominant cost of verification.
  An hour of x8 idling is about six CPU-minutes of DO time.
- **Snapshots stay small**: 150-175 KB of JSON up to depth 10, so `vstate` and `resync` travel as
  plain JSON (`PACK_GZIP_ABOVE` is 256 KB) and gzip would cut them to ~15 KB. Restoring a
  snapshot takes ~3 ms; a DO waking with a full segment log (`COMPACT_TICKS` = 1200 ticks)
  replays at most ~1200 + 400 ticks, well under a second.
- **Segment frames are tiny** (~100 bytes for Auto/Idle; a few KB for frantic manual play), far
  under the 1 MiB WebSocket limit and `MAX_VERIFIED_CLIENT_FRAME`.

## Implications (for the wave B ADR)

1. Full replay of every segment is **affordable at x1** and keeps the design simple; keep it as
   the wave B default (decision 1).
2. **x8 Full Idle is where CPU goes.** Options, cheapest first, none needed for wave B:
   - make `stableHash` cheaper (it is ~5× the cost of `snapshot()`; hashing the JSON string with
     a fast non-cryptographic hash, or hashing only dirty tables, would cut ~40 % at x1);
   - longer segments at x8 do not help (hash share is already ~9 %);
   - verification sampling (replay a random subset of segments in full, trust the rest within
     reward-rate ceilings; wave-B.md §2.8 future work);
   - server-side Full Idle: since Full Idle has no inputs, the server could run it lazily on
     rejoin like offline progress instead of replaying it live.
3. Snapshot size is not a concern up to depth 10; no need for incremental snapshots yet.

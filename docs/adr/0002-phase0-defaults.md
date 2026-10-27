# ADR 0002: Phase-0 defaults (to be revisited by benchmark)

- Status: accepted for phase 0; each item names what would change it
- Date: 2026-10-27

The plan's rule is "start with a sensible default, benchmark alongside, swap if something wins". These are the defaults the walking skeleton ships with.

## 1. Wire format: JSON, binary codec ready

`apps/game/src/shared/codec.ts` exports one `codec` constant used by the client, the RelayDO and `tools/e2e`; it is `jsonCodec`. `binaryCodec` (`packages/protocol/src/binary-codec.ts`: 1-byte tags, uvarints, uint16 tiles, float64 times, strict framing) is implemented, tested for exact round trips, and is a one-line switch.

Measured on this machine (Node 24.22, `vp -C packages/protocol test bench --run --reporter=verbose`), encode + decode per message:

| Message                      | JSON             | Binary                  |
| ---------------------------- | ---------------- | ----------------------- |
| welcome, 200 entities: size  | 42,685 B         | 13,008 B (3.3x smaller) |
| welcome, 200 entities: ops/s | ~1,140–1,150     | ~990–1,015              |
| small delta: ops/s           | ~161,000–169,000 | ~77,000–80,000          |

Binary wins on bytes, JSON wins on CPU (V8's native JSON beats a per-field writer). Phase 0 traffic is tiny, so JSON stays for readability. **Revisit** in the phase-1 wire-format benchmark, which should measure in workerd and on a low-end phone, include MessagePack/FlatBuffers/protobuf-es, and try the obvious binary speedups (`TextEncoder.encodeInto` into a pre-sized buffer, no per-entity closures). The binary decoder rejects trailing bytes, so protocol evolution needs a version byte or new tags, not appended fields.

## 2. DO fan-out: RPC `deliver()` once per relay

ChunkDO coalesces upserts/removes for 50 ms and calls `RelayDO.deliver(chunkId, seq, upserts, removes)` over DO RPC, once per subscribed relay (`Promise.allSettled`, one cached stub per relay so deliveries stay ordered). The relay encodes once and broadcasts to its sockets. **Revisit** with the DO fan-out benchmark (RPC vs DO-to-DO WebSocket vs direct broadcast; msgs/s per DO, p95) before the phase-4 load test.

Phase-0 e2e numbers (local workerd, one relay, two bots): `moveTo` to the delta arriving at the other client 26–50 ms, including the 50 ms coalescing window when it applies.

## 3. One chunk: `classic:0:0`

The whole 48x48 town is one ChunkDO named `classic:0:0` (`PHASE0_CHUNK`); relays are `relay:<continent>:0`. Quadtree splitting and handoff between chunks come with the phase-4 scale work. Chunk names already follow `<mode>:<cx>:<cy>`.

## 4. Internal packages export TypeScript source, not tsdown builds

`@gamez/*` packages point `exports` at `./src/index.ts`. Vite, Vitest, the Worker bundle and plain Node (type stripping) all consume it directly, so there is no build step, no stale `dist/`, and no declaration files to keep in sync. Cost: packages must stay strippable (no enums, no parameter properties) and are not publishable as-is. **Revisit** when a package needs to ship outside the monorepo or build times grow; then add tsdown per package.

## 5. No worktree isolation for this run

The plan called for one git worktree per parallel agent. This run had all agents edit one working tree with disjoint path ownership instead, because the repo had no commits to branch from yet and the integrator owned the merge. It worked here (no overlapping edits), but it relies on discipline: one agent's broken file fails everyone's `vp check`, and shared files (`pnpm-lock.yaml`, `pnpm-workspace.yaml`) need a single owner. **Revisit**: use worktrees from phase 1 on, now that the repo can have a base commit.

## 6. Replication timing defaults

The CharacterDO outbox alarm fires 2 s after the first unflushed write (`scheduleFlush` default) and the queue consumer batches up to 100 messages or 1 s. Measured end of walk to row visible in local D1: about 1.1–1.2 s when the walk ends just before an already-armed alarm, about 3.0 s in steady state (2 s alarm + 1 s queue timeout). The plan target is "within a few seconds"; tune both knobs with the queues benchmark.

/**
 * CPU cost model of one ChunkDO in a pose world, without the Workers runtime
 * (docs/bench/2026-10-waveC-presence.md, "Does one chunk saturate?"). Local
 * workerd runs the Worker, every relay and the chunk on one thread, so the
 * swarm cannot show a chunk's own ceiling; this measures the chunk's work per
 * pose in plain V8:
 *
 * - ingest: the relay's batch arrives (structured clone of the batch), and each
 *   pose is checked (sanitisePose) and continued (continueWalk);
 * - flush: every FLUSH_MS the queued upserts are delivered to each relay
 *   (one structured clone of the delta per relay, as RPC serialisation does).
 *
 *   node tools/loadtest/src/chunk-cost.ts [--relays 4] [--hz 3]
 */
import { parseArgs } from "node:util";
import type { EntityState, PoseUpdate } from "@gamez/protocol";
import { continueWalk, sanitisePose } from "../../../apps/game/src/server/presence/pose.ts";

const FLUSH_MS = 50;
const BOUNDS = { width: 72, height: 72 };

function pose(i: number, t: number): PoseUpdate {
  const x = 4 + ((i * 7 + t) % 60);
  const y = 4 + ((i * 13 + t) % 60);
  return {
    pos: { x, y },
    path: Array.from({ length: 6 }, (_, k) => ({ x: Math.min(71, x + k + 1), y })),
    speed: 4,
    appearance: "unit.hero.warrior",
    tag: `lt:${1793200000000 + t}`,
  };
}

/** CPU ms per pose (ingest + its share of the flush) for `bots` posing at `hz`, over `seconds` of simulated time. */
export function chunkCostPerPose(bots: number, hz: number, relays: number, seconds = 5): number {
  const avatars = new Map<string, EntityState>();
  for (let i = 0; i < bots; i++) {
    avatars.set(`bot-${i}:classic-town`, {
      id: `bot-${i}:classic-town`,
      kind: "player",
      name: `Guest-${i}`,
      appearance: "unit.hero",
      pos: { x: 10, y: 10 },
      path: [],
      pathStartedAt: 0,
      speed: 4,
    });
  }
  const posesPerFlush = Math.max(1, Math.round((bots * hz * FLUSH_MS) / 1000));
  const flushes = Math.round((seconds * 1000) / FLUSH_MS);
  const ids = [...avatars.keys()];
  let cursor = 0;
  let poses = 0;
  const started = process.cpuUsage();
  for (let f = 0; f < flushes; f++) {
    const now = 1793200000000 + f * FLUSH_MS;
    // A batch from each relay (structured clone = RPC argument serialisation).
    const batch = Array.from({ length: posesPerFlush }, () => {
      const id = ids[cursor++ % ids.length]!;
      return { id, pose: pose(cursor, f) };
    });
    const arrived = structuredClone(batch);
    const upserts = new Set<string>();
    for (const { id, pose: raw } of arrived) {
      const check = sanitisePose(raw, BOUNDS);
      if (!check.ok) continue;
      const old = avatars.get(id)!;
      const state: EntityState = { ...old, ...continueWalk(old, check.pose, now) };
      state.appearance = check.pose.appearance;
      if (check.pose.tag !== undefined) state.tag = check.pose.tag;
      avatars.set(id, state);
      upserts.add(id);
      poses++;
    }
    const delta = [...upserts].map((id) => avatars.get(id)!);
    for (let r = 0; r < relays; r++) structuredClone({ seq: f, upserts: delta, removes: [] });
  }
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000 / poses;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      relays: { type: "string", default: "4" },
      hz: { type: "string", default: "3" },
    },
  });
  const relays = Number(values.relays);
  const hz = Number(values.hz);
  chunkCostPerPose(200, hz, relays, 2); // warm up the JIT
  console.log(
    `chunk CPU per pose (${relays} relays, ${hz} poses/s per bot, ${FLUSH_MS} ms flushes):`,
  );
  for (const bots of [100, 250, 500, 1000]) {
    const ms = chunkCostPerPose(bots, hz, relays);
    const core = (ms * bots * hz) / 1000;
    console.log(
      `  ${String(bots).padStart(4)} bots: ${(ms * 1000).toFixed(1)} µs/pose -> ${(core * 100).toFixed(1)} % of a core; saturates near ${Math.round(1000 / (ms * hz))} bots`,
    );
  }
}

if (process.argv[1]?.endsWith("chunk-cost.ts")) main();

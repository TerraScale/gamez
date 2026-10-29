/**
 * Party Idle soak (T-auto, docs/design/party.md §6.7): four heroes (warrior,
 * rogue, sorcerer, warrior) recruited through the real classic.party actions
 * play Full Idle for 40 000 ticks (33 sim minutes) on the real content with
 * every classic module. Asserts that the party never splits or deadlocks:
 *
 * - no exception;
 * - the deepest depth grows and kills keep coming (no stall);
 * - every follower is within PartyProto.leashTeleport of the acting leader
 *   on at least 99 % of the sampled ticks;
 * - outside town and fights (follower or leader in plan "fight"), no
 *   follower is farther than 6 tiles for more than 300 consecutive ticks.
 *
 * Logs one PARTYIDLE stats line (docs/bench/2026-10-party.md).
 */
import type { Entity, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { AutoState, Dead, Level, Pos } from "../src/components.ts";
import { actingLeaderOf, partyMembers } from "../src/party/shared.ts";
import { currentDepth, dungeonOf, RES, type RunStats } from "../src/resources.ts";
import { DEFAULT_PARTY_PROTO } from "../src/rules.ts";
import { recruitParty } from "./support/party.ts";

const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer", "classic.warrior"];
const TICKS = 40_000;
const SAMPLE = 10;

function gap(sim: Sim, a: Entity, b: Entity): number {
  const pa = sim.world.read(a, Pos);
  const pb = sim.world.read(b, Pos);
  return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
}

describe("party Idle soak (4 heroes)", () => {
  it("40 000 ticks: no split, no deadlock, depth and kills progress", () => {
    const sim = recruitParty(2026, CLASSES);
    const members = partyMembers(sim.world);
    expect(members).toHaveLength(4);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    const near = 6 * 256;
    const sampled = new Map<Entity, number>(members.map((e) => [e, 0]));
    const within = new Map<Entity, number>(members.map((e) => [e, 0]));
    const farRun = new Map<Entity, number>(members.map((e) => [e, 0]));
    let worstFar = 0;
    let killsAt10k = 0;
    let townTicks = 0;
    let downedTicks = 0;
    for (let t = 0; t < TICKS; t++) {
      sim.step(1);
      const leader = actingLeaderOf(sim.world);
      const depth = currentDepth(sim.world);
      if (depth === 0) townTicks++;
      if (members.some((e) => sim.world.has(e, Dead))) downedTicks++;
      if (t === 10_000) killsAt10k = sim.world.getResource<RunStats>(RES.stats)!.kills;
      const leaderFight = sim.world.get(leader, AutoState)?.plan === "fight";
      for (const e of members) {
        if (e === leader || sim.world.has(e, Dead) || sim.world.has(leader, Dead)) {
          farRun.set(e, 0);
          continue;
        }
        const d = gap(sim, e, leader);
        const fight = leaderFight || sim.world.get(e, AutoState)?.plan === "fight";
        if (depth > 0 && !fight && d > near) {
          const run = farRun.get(e)! + 1;
          farRun.set(e, run);
          worstFar = Math.max(worstFar, run);
        } else farRun.set(e, 0);
        if (t % SAMPLE === 0) {
          sampled.set(e, sampled.get(e)! + 1);
          if (d <= DEFAULT_PARTY_PROTO.leashTeleport) within.set(e, within.get(e)! + 1);
        }
      }
    }
    const stats = sim.world.getResource<RunStats>(RES.stats)!;
    const deepest = dungeonOf(sim.world).deepest;
    const levels = members.map((e) => sim.world.read(e, Level).level);
    // Per member: share of its samples as a standing follower within leashTeleport.
    const leashPct = members
      .filter((e) => sampled.get(e)! > 0)
      .map((e) => Math.floor((within.get(e)! * 1000) / sampled.get(e)!) / 10);
    console.log(
      `PARTYIDLE ticks=${TICKS} deepest=${deepest} kills=${stats.kills} deaths=${stats.deaths}` +
        ` levels=${levels.join("/")} leashPct=${leashPct.join("/")} worstFarRun=${worstFar}` +
        ` townTicks=${townTicks} downedTicks=${downedTicks}`,
    );
    expect(deepest, "deepest depth grows").toBeGreaterThanOrEqual(3);
    expect(stats.kills, "kills progress after 10k ticks").toBeGreaterThan(killsAt10k + 50);
    for (const p of leashPct) expect(p, "within leashTeleport").toBeGreaterThanOrEqual(99);
    expect(worstFar, "far from the leader outside fights").toBeLessThanOrEqual(300);
  }, 900_000);
});

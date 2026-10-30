/**
 * Party wipe respawn soak (gameplay polish, item d). A long soak flagged
 * "wipe respawn: not all in town". The respawn itself moves every member
 * (execRespawn -> one transition -> placeParty), so the only way to end a
 * respawn with a member outside town was a member that was never in the
 * party's area: the QA party grant (classic.debug, `free`) placed recruits in
 * the TOWN even when the party was in the dungeon, a split that survived until
 * the next transition. Recruits now join in the party's current area.
 *
 * The soak plays Full Idle with four heroes and wipes the party on purpose at
 * many kinds of moment (in the dungeon, in town, on the tick a level change is
 * queued, one member at a time), plus a party granted in the dungeon. After
 * every wipe it waits for the respawn and asserts: town, every member alive,
 * every member tagged with the town, on a walkable town tile. On every tick,
 * every member is tagged with the current area (no split).
 */
import { createSim, loadMode, type Entity, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { busOf } from "../src/bus.ts";
import { AreaTag, Dead, Life, Pos } from "../src/components.ts";
import { DEBUG_GRANT } from "../src/debug/index.ts";
import { debugModules, mode, modules } from "../src/index.ts";
import { partyMembers, partyWiped } from "../src/party/shared.ts";
import { currentDepth } from "../src/resources.ts";
import { getMap, walkableAt } from "../src/world/maps.ts";
import { recruitParty } from "./support/party.ts";

const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer", "classic.warrior"];
/** Respawn delay (60) + the auto retry cadence, with a wide margin. */
const RESPAWN_BUDGET = 1200;

function down(sim: Sim, e: Entity): void {
  if (sim.world.has(e, Dead)) return;
  sim.world.update(e, Life, { hp: 0 });
  sim.world.add(e, Dead, { at: sim.tick, killer: 0 });
}

function where(sim: Sim, members: readonly Entity[]): string {
  return members
    .map((e) => {
      const p = sim.world.get(e, Pos);
      const d = sim.world.get(e, AreaTag)?.depth ?? -1;
      return `${e}:d${d}@${p ? p.x >> 8 : -1},${p ? p.y >> 8 : -1}${sim.world.has(e, Dead) ? "D" : ""}`;
    })
    .join(" ");
}

/** Every member tagged with the current area. */
function expectTogether(sim: Sim, members: readonly Entity[], label: string): void {
  const depth = currentDepth(sim.world);
  const off = members.filter((e) => sim.world.get(e, AreaTag)?.depth !== depth);
  expect(off, `${label} t=${sim.tick} area=${depth} ${where(sim, members)}`).toEqual([]);
}

/** Steps until the wipe is respawned; asserts everyone is alive in town on a walkable tile. */
function expectRespawnInTown(sim: Sim, members: readonly Entity[], label: string): void {
  const start = sim.tick;
  while (sim.tick - start < RESPAWN_BUDGET) {
    sim.step(1);
    expectTogether(sim, members, label);
    if (currentDepth(sim.world) === 0 && members.every((e) => !sim.world.has(e, Dead))) break;
  }
  const msg = `${label}: wipe at ${start}, t=${sim.tick} ${where(sim, members)}`;
  expect(currentDepth(sim.world), msg).toBe(0);
  const town = getMap(sim.world, sim.loaded.registry, 0);
  for (const e of members) {
    expect(sim.world.has(e, Dead), msg).toBe(false);
    expect(sim.world.read(e, AreaTag).depth, msg).toBe(0);
    const p = sim.world.read(e, Pos);
    expect(walkableAt(town, p.x >> 8, p.y >> 8), msg).toBe(true);
  }
}

type Moment = "dungeon" | "town" | "transition" | "staggered";

interface WipeRun {
  wipes: Record<Moment, number>;
  natural: number;
}

/** Full Idle for `ticks`, wiping the party at each kind of moment in turn. */
function soak(seed: number, ticks: number): WipeRun {
  const sim = recruitParty(seed, CLASSES);
  const members = partyMembers(sim.world);
  expect(members).toHaveLength(4);
  expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
  const run: WipeRun = { wipes: { dungeon: 0, town: 0, transition: 0, staggered: 0 }, natural: 0 };
  const order: Moment[] = ["transition", "dungeon", "staggered", "town"];
  let next = 0;
  let quietUntil = 600;
  while (sim.tick < ticks) {
    sim.step(1);
    expectTogether(sim, members, `seed ${seed}`);
    if (partyWiped(sim.world)) {
      run.natural++;
      expectRespawnInTown(sim, members, `seed ${seed} natural`);
      quietUntil = sim.tick + 600;
      continue;
    }
    if (sim.tick < quietUntil) continue;
    const moment = order[next % order.length]!;
    const depth = currentDepth(sim.world);
    const pending = busOf(sim.world).transitions.length > 0;
    const hit =
      (moment === "transition" && pending) ||
      (moment === "dungeon" && depth >= 1 && !pending) ||
      (moment === "staggered" && depth >= 1) ||
      (moment === "town" && depth === 0 && sim.tick > 1200);
    if (!hit) {
      // A transition moment may never come in a while; fall through to the next kind.
      if (sim.tick - quietUntil > 6000) next++;
      continue;
    }
    if (moment === "staggered") {
      // One member at a time, the controlled hero last, a few ticks apart.
      for (const e of [...members].reverse()) {
        down(sim, e);
        sim.step(3);
        expectTogether(sim, members, `seed ${seed} staggered`);
      }
      // A member may have been revived by an ally in between: finish the wipe.
      for (const e of members) down(sim, e);
    } else {
      for (const e of members) down(sim, e);
    }
    run.wipes[moment]++;
    next++;
    expectRespawnInTown(sim, members, `seed ${seed} ${moment}`);
    quietUntil = sim.tick + 600;
  }
  return run;
}

describe("party wipe respawn soak (Full Idle, four heroes)", () => {
  for (const seed of [5, 2026, 77]) {
    it(`seed ${seed}: every wipe respawns the whole party in town`, () => {
      const run = soak(seed, 30_000);
      const forced = Object.values(run.wipes).reduce((a, b) => a + b, 0);
      console.log(
        `PARTYWIPE seed=${seed} forced=${JSON.stringify(run.wipes)} natural=${run.natural}`,
      );
      expect(forced).toBeGreaterThanOrEqual(8);
      expect(run.wipes.dungeon).toBeGreaterThan(0);
      expect(run.wipes.town).toBeGreaterThan(0);
      expect(run.wipes.staggered).toBeGreaterThan(0);
    }, 900_000);
  }
});

describe("a QA party granted in the dungeon", () => {
  const LOADED = loadMode({ ...mode }, [...modules, ...debugModules]);

  it("joins the party's area, and a wipe respawns all four in town", () => {
    const sim = createSim(LOADED, { seed: 41 });
    expect(
      sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Tester" }, null).ok,
    ).toBe(true);
    sim.step(2);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    for (let i = 0; i < 8000 && currentDepth(sim.world) === 0; i++) sim.step(1);
    expect(currentDepth(sim.world)).toBeGreaterThan(0);
    sim.step(40);
    const r = sim.dispatch(
      DEBUG_GRANT,
      { party: ["classic.rogue", "classic.sorcerer", "classic.warrior"] },
      null,
    );
    expect(r.ok, r.error?.message).toBe(true);
    const members = partyMembers(sim.world);
    expect(members).toHaveLength(4);
    expectTogether(sim, members, "after the grant");
    for (let i = 0; i < 400; i++) {
      sim.step(1);
      expectTogether(sim, members, "after the grant");
    }
    for (const e of members) down(sim, e);
    expectRespawnInTown(sim, members, "granted in the dungeon");
  }, 300_000);
});

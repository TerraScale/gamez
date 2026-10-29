/**
 * Auto repair trips end to end on the real content (integration QA finding:
 * no Idle or quests QA run ever produced classic.repaired, because natural
 * wear (1 durability per 8 kills) never gets low enough in a short run).
 *
 * A fresh Idle hero walks into the dungeon and plays past the voluntary trip
 * cooldown (TRIP_COOLDOWN_TICKS after the last town visit, which also holds
 * repair trips: real wear needs hundreds of kills, so gear never breaks that
 * soon after a visit that could afford the smith), the QA cheat
 * `wearGear: 0` breaks its gear through the real wear path, and Idle must then go to town
 * for the repair (plan toTown, note "repair"), pay the smith
 * (classic.repaired), restore every worn item's durability and head back down.
 * Also the parseGrant rules for the `wearGear` field.
 */
import { createSim, loadMode, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { AutoState, Equipment } from "../src/components.ts";
import { DEBUG_GRANT, parseGrant } from "../src/debug/index.ts";
import { debugModules, mode, modules } from "../src/index.ts";
import { currentDepth, heroOf } from "../src/resources.ts";
import { EQUIP_SLOTS } from "../src/types.ts";

const LOADED = loadMode({ ...mode }, [...modules, ...debugModules]);

/** Ticks Idle gets to be in the dungeon past the trip cooldown, from a fresh hero. */
const DESCEND_TICKS = 8_000;
/** Ticks Idle gets, after the gear breaks, to go to town and repair. */
const REPAIR_TICKS = 6_000;

interface Durability {
  slot: string;
  cur: number;
  max: number;
}

function gear(sim: Sim): Durability[] {
  const eq = sim.world.read(heroOf(sim.world), Equipment);
  const out: Durability[] = [];
  for (const slot of EQUIP_SLOTS) {
    const d = eq[slot]?.dur;
    if (d && d.max > 0) out.push({ slot, cur: d.cur, max: d.max });
  }
  return out;
}

interface RepairRun {
  sim: Sim;
  /** Events from the wearGear grant on (grant + every later step). */
  events: GameEvent[];
  broken: Durability[];
  repairedAt: number;
  backDownAt: number;
}

function repairRun(seed: number, classId: string): RepairRun {
  const sim = createSim(LOADED, { seed });
  expect(sim.dispatch(ACTION.newHero, { classId, name: "Mender" }, null).ok).toBe(true);
  expect(sim.dispatch(ACTION.setControl, { mode: "idle" }, null).ok).toBe(true);
  // Gold for the smith: a fresh hero's purse goes to potions first.
  expect(sim.dispatch(DEBUG_GRANT, { gold: 5_000 }, null).ok).toBe(true);
  const hero = heroOf(sim.world);
  const ready = (): boolean =>
    currentDepth(sim.world) >= 1 && sim.tick > sim.world.read(hero, AutoState).tripAt;
  for (let i = 0; i < DESCEND_TICKS && !ready(); i++) sim.step(1);
  expect(ready(), "in the dungeon, past the trip cooldown").toBe(true);

  const wear = sim.dispatch(DEBUG_GRANT, { wearGear: 0 }, null);
  expect(wear.ok, wear.error?.message).toBe(true);
  const events: GameEvent[] = [...wear.events];
  const broken = gear(sim);
  let repairedAt = -1;
  let backDownAt = -1;
  for (let i = 0; i < REPAIR_TICKS && backDownAt < 0; i++) {
    const evs = sim.step(1);
    events.push(...evs);
    if (repairedAt < 0 && evs.some((e) => e.type === "classic.repaired")) repairedAt = sim.tick;
    if (repairedAt >= 0 && currentDepth(sim.world) >= 1) backDownAt = sim.tick;
  }
  return { sim, events, broken, repairedAt, backDownAt };
}

describe("Idle repair trip (real content, wearGear cheat)", () => {
  for (const classId of ["classic.warrior", "classic.rogue", "classic.sorcerer"]) {
    it(`${classId}: broken gear sends Idle to the smith and back down`, () => {
      const run = repairRun(4242, classId);
      // The cheat breaks every wearable item through the real wear path.
      expect(run.broken.length).toBeGreaterThan(0);
      expect(run.broken.every((d) => d.cur === 0)).toBe(true);
      expect(run.events.some((e) => e.type === "classic.item.broken")).toBe(true);

      // Idle plans a town trip for the repair.
      expect(run.events).toContainEqual(
        expect.objectContaining({ type: "classic.auto.plan", plan: "toTown", note: "repair" }),
      );
      // The smith repairs and is paid.
      const repaired = run.events.find((e) => e.type === "classic.repaired") as
        | (GameEvent & { uids: number[]; cost: number })
        | undefined;
      expect(repaired, "classic.repaired").toBeDefined();
      expect(repaired!.cost).toBeGreaterThan(0);
      expect(repaired!.uids.length).toBeGreaterThan(0);
      expect(run.repairedAt).toBeGreaterThan(0);

      // Every item that broke is whole again (the hero may have worn it a little since).
      const now = gear(run.sim);
      for (const b of run.broken) {
        const d = now.find((g) => g.slot === b.slot);
        expect(d, `${b.slot} still equipped`).toBeDefined();
        expect(d!.cur, `${b.slot} durability`).toBeGreaterThanOrEqual(d!.max - 2);
      }
      // ...and Idle goes back to the dungeon.
      expect(run.backDownAt, "back in the dungeon").toBeGreaterThan(run.repairedAt);
    }, 120_000);
  }

  it("is deterministic: same seed, same hash", () => {
    const a = repairRun(77, "classic.warrior");
    const b = repairRun(77, "classic.warrior");
    expect(a.sim.tick).toBe(b.sim.tick);
    expect(a.sim.hash()).toBe(b.sim.hash());
  }, 120_000);
});

describe("debug grant: wearGear", () => {
  it("accepts 0..99 and rejects anything else", () => {
    expect(parseGrant({ wearGear: 0 })).toEqual({ wearGear: 0 });
    expect(parseGrant({ wearGear: 99 })).toEqual({ wearGear: 99 });
    for (const bad of [-1, 100, 1.5, "0", null]) {
      expect(() => parseGrant({ wearGear: bad })).toThrow(/wearGear/);
    }
  });

  it("only lowers durability, and refuses when nothing can wear", () => {
    const sim = createSim(LOADED, { seed: 5 });
    expect(
      sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Mender" }, null).ok,
    ).toBe(true);
    sim.step(1);
    expect(sim.dispatch(DEBUG_GRANT, { wearGear: 50 }, null).ok).toBe(true);
    const half = gear(sim);
    expect(half.length).toBeGreaterThan(0);
    for (const d of half) expect(d.cur).toBe(Math.floor((d.max * 50) / 100));
    // A higher percent never repairs: nothing to lower, refused, world unchanged.
    const before = sim.hash();
    const r = sim.dispatch(DEBUG_GRANT, { wearGear: 80 }, null);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_target");
    expect(sim.hash()).toBe(before);
    expect(gear(sim)).toEqual(half);
  });
});

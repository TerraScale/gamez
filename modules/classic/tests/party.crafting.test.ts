/**
 * classic.crafting with a party (docs/design/party.md §7.4; T-progress):
 * smith ops act on the commanded member's bag and equipment, need THAT
 * member next to the smith, and are paid from the purse.
 */
import type { Entity, GameEvent, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf, pushCommand, type DeathRecord } from "../src/bus.ts";
import { AreaTag, Body, Equipment, Npc, Pos, Wallet } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { nextUid } from "../src/resources.ts";
import { itemValue, maxDurabilityOf, repairCost } from "../src/rules.ts";
import {
  ECONOMY_ID,
  KIND,
  type EconomyProto,
  type EquipSlot,
  type ItemBaseProto,
  type ItemInstance,
} from "../src/types.ts";
import { spawnTestParty, testSim, useOpenMap } from "./support/harness.ts";

const MODULES = ["classic.core", "classic.items", "classic.crafting", "classic.party"];
const SMITH = "classic.npc.brannoc";

function partySim(): { sim: Sim; heroes: Entity[] } {
  const sim = testSim(MODULES, { seed: 2, content: "real" });
  useOpenMap(sim, 0);
  const heroes = spawnTestParty(
    sim.world,
    [0, 1].map((i) => ({
      classId: "classic.warrior",
      x: i === 0 ? 4 : 20,
      y: 5,
      skills: [],
      bar: [null, null, null, null, null, null],
      gold: i === 0 ? 2000 : 0,
    })),
  );
  return { sim, heroes };
}

function worn(sim: Sim, baseId: string, cur: number): ItemInstance {
  const b = sim.loaded.registry.require<ItemBaseProto>(KIND.itemBase, baseId);
  return {
    uid: nextUid(sim.world),
    base: baseId,
    rarity: "normal",
    ilvl: 1,
    name: b.name,
    mods: [],
    affixes: [],
    value: itemValue(b, "normal", 1),
    dur: { cur, max: maxDurabilityOf(b) },
  };
}

function equip(sim: Sim, hero: Entity, slot: EquipSlot, item: ItemInstance): void {
  sim.world.update(hero, Equipment, { [slot]: item });
}

function spawnSmith(sim: Sim, x: number, y: number): Entity {
  const e = sim.world.create();
  sim.world.add(e, Npc, { proto: SMITH });
  sim.world.add(e, Pos, { x: tileCenter(x), y: tileCenter(y) });
  sim.world.add(e, AreaTag, { depth: 0 });
  sim.world.add(e, Body, { radius: 80, solid: true });
  return e;
}

function eventsOf<T = Record<string, unknown>>(events: GameEvent[], type: string): T[] {
  return events.filter((e) => e.type === type) as unknown as T[];
}

describe("party crafting", () => {
  it("a follower's repair command repairs the follower's gear and charges the purse", () => {
    const { sim, heroes } = partySim();
    const [a, f] = heroes as [Entity, Entity];
    const smith = spawnSmith(sim, 21, 5); // next to the follower, far from the founder
    const fVest = worn(sim, "classic.item.padded_vest", 3);
    const aVest = worn(sim, "classic.item.padded_vest", 2);
    equip(sim, f, "armor", fVest);
    equip(sim, a, "armor", aVest);
    const econ = sim.loaded.registry.require<EconomyProto>(KIND.economy, ECONOMY_ID);
    const cost = repairCost(econ, fVest);
    expect(cost).toBeGreaterThan(0);

    pushCommand(sim.world, { op: "repair", npc: smith, uid: 0, hero: f });
    const events = sim.step(1);
    expect(sim.world.read(f, Equipment).armor?.dur).toEqual({
      cur: fVest.dur!.max,
      max: fVest.dur!.max,
    });
    expect(sim.world.read(a, Equipment).armor?.dur).toEqual(aVest.dur);
    expect(sim.world.read(a, Wallet).gold).toBe(2000 - cost);
    expect(sim.world.has(f, Wallet)).toBe(false);
    expect(eventsOf(events, "classic.repaired")).toEqual([
      { type: "classic.repaired", uids: [fVest.uid], cost, hero: f },
    ]);

    // The founder is out of reach of that smith: its own repair fails, nothing is paid.
    pushCommand(sim.world, { op: "repair", npc: smith, uid: 0 });
    const far = sim.step(1);
    expect(
      eventsOf<{ op: string; code: string }>(far, "classic.command.failed").map((e) => [
        e.op,
        e.code,
      ]),
    ).toEqual([["repair", "too_far"]]);
    expect(sim.world.read(a, Wallet).gold).toBe(2000 - cost);
  });

  it("a follower cannot spend more than the purse holds", () => {
    const { sim, heroes } = partySim();
    const [a, f] = heroes as [Entity, Entity];
    sim.world.update(a, Wallet, { gold: 0 });
    const smith = spawnSmith(sim, 21, 5);
    equip(sim, f, "armor", worn(sim, "classic.item.padded_vest", 1));
    const before = JSON.stringify(sim.world.read(f, Equipment));
    pushCommand(sim.world, { op: "repair", npc: smith, uid: 0, hero: f });
    const events = sim.step(1);
    expect(
      eventsOf<{ code: string; hero?: Entity }>(events, "classic.command.failed").map((e) => [
        e.code,
        e.hero,
      ]),
    ).toEqual([["no_gold", f]]);
    expect(JSON.stringify(sim.world.read(f, Equipment))).toBe(before);
  });

  it("kill wear goes to the hero credited with the kill; death wear to the dying member", () => {
    const { sim, heroes } = partySim();
    const [a, f] = heroes as [Entity, Entity];
    useOpenMap(sim, 1);
    const econ = sim.loaded.registry.require<EconomyProto>(KIND.economy, ECONOMY_ID);
    const maceA = worn(sim, "classic.item.mace", 40);
    const maceF = worn(sim, "classic.item.mace", 40);
    const max = maceF.dur!.max;
    maceA.dur = { cur: max, max };
    maceF.dur = { cur: max, max };
    equip(sim, a, "weapon", maceA);
    equip(sim, f, "weapon", maceF);
    const death = (over: Partial<DeathRecord>): DeathRecord => ({
      entity: 0,
      killer: f,
      creditTeam: "hero",
      team: "monster",
      isHero: false,
      x: 0,
      y: 0,
      depth: 1,
      monster: "classic.monster.zombie",
      rarity: "normal",
      level: 1,
      xp: 0,
      pack: 0,
      ...over,
    });
    for (let i = 0; i < econ.repair.everyKills; i++) busOf(sim.world).deaths.push(death({}));
    sim.step(1);
    expect(sim.world.read(f, Equipment).weapon?.dur?.cur).toBe(max - 1);
    expect(sim.world.read(a, Equipment).weapon?.dur?.cur).toBe(max);

    busOf(sim.world).deaths.push(
      death({ entity: a, killer: 0, isHero: true, creditTeam: "monster", rarity: "hero" }),
    );
    sim.step(1);
    const loss = Math.max(1, Math.floor((max * econ.repair.deathLossPct) / 100));
    expect(sim.world.read(a, Equipment).weapon?.dur?.cur).toBe(max - loss);
    expect(sim.world.read(f, Equipment).weapon?.dur?.cur).toBe(max - 1);
  });
});

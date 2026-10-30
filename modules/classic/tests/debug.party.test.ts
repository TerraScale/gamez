/**
 * The QA cheat's party grant (classic.debug, `party: string[]`): one grant builds
 * a party of four (free, anywhere), unlocks the slots they need, and names each
 * recruit "<Class> <n>". Also the parseGrant rules for the field.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { AreaTag, Hero, Wallet } from "../src/components.ts";
import { DEBUG_GRANT, parseGrant } from "../src/debug/index.ts";
import { mode, modules, debugModules } from "../src/index.ts";
import { partyMembers, partyGold } from "../src/party/shared.ts";
import { heroOf, partyStateOf, RES, type AreaState } from "../src/resources.ts";

const LOADED = loadMode({ ...mode }, [...modules, ...debugModules]);

function hero(seed: number): Sim {
  const sim = createSim(LOADED, { seed });
  expect(
    sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Tester" }, null).ok,
  ).toBe(true);
  sim.step(1);
  return sim;
}

describe("debug grant: party", () => {
  it("builds a party of four in one grant, free of charge", () => {
    const sim = hero(31);
    const gold = partyGold(sim.world);
    const r = sim.dispatch(
      DEBUG_GRANT,
      { party: ["classic.warrior", "classic.rogue", "classic.sorcerer"] },
      null,
    );
    expect(r.ok, r.error?.message).toBe(true);
    sim.step(1);

    const w = sim.world;
    const members = partyMembers(w);
    expect(members).toHaveLength(4);
    expect(members[0]).toBe(heroOf(w));
    const names = members.map((e) => w.read(e, Hero).name);
    expect(names).toEqual(["Tester", "Warrior 1", "Rogue 2", "Sorcerer 3"]);
    expect(w.read(members[2]!, Hero).classId).toBe("classic.rogue");
    expect(partyStateOf(w)?.slotsBought).toBe(3);
    expect(partyGold(w)).toBe(gold);
    expect(w.has(members[1]!, Wallet)).toBe(false);
  });

  it("works outside the town and for a single class", () => {
    const sim = hero(32);
    const area = sim.world.getResource<AreaState>(RES.area)!;
    sim.world.setResource(RES.area, { ...area, depth: 1 });
    const r = sim.dispatch(DEBUG_GRANT, { party: ["classic.rogue"] }, null);
    expect(r.ok, r.error?.message).toBe(true);
    expect(partyMembers(sim.world)).toHaveLength(2);
    expect(partyStateOf(sim.world)?.slotsBought).toBe(1);
    // The recruit joins the party's current area, never the town while the party is away.
    expect(sim.world.read(partyMembers(sim.world)[1]!, AreaTag).depth).toBe(1);
  });

  it("refuses to exceed four members with party_full and changes nothing", () => {
    const sim = hero(33);
    expect(
      sim.dispatch(
        DEBUG_GRANT,
        { party: ["classic.warrior", "classic.rogue", "classic.sorcerer"] },
        null,
      ).ok,
    ).toBe(true);
    sim.step(1);
    const before = sim.hash();
    const r = sim.dispatch(DEBUG_GRANT, { party: ["classic.rogue"] }, null);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("party_full");
    expect(sim.hash()).toBe(before);
  });

  it("rejects an unknown class id with unknown_id", () => {
    const sim = hero(34);
    const before = sim.hash();
    const r = sim.dispatch(DEBUG_GRANT, { party: ["classic.nope"] }, null);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("unknown_id");
    expect(sim.hash()).toBe(before);
  });
});

describe("parseGrant party field", () => {
  it("accepts 1..3 class ids", () => {
    expect(parseGrant({ party: ["classic.rogue"] }).party).toEqual(["classic.rogue"]);
    expect(
      parseGrant({ party: ["classic.warrior", "classic.rogue", "classic.sorcerer"] }).party,
    ).toHaveLength(3);
  });

  it("rejects empty lists, more than three, non-arrays and bad ids", () => {
    expect(() => parseGrant({ party: [] })).toThrow();
    expect(() =>
      parseGrant({ party: ["classic.a", "classic.b", "classic.c", "classic.d"] }),
    ).toThrow();
    expect(() => parseGrant({ party: "classic.rogue" })).toThrow();
    expect(() => parseGrant({ party: ["rogue"] })).toThrow();
    expect(() => parseGrant({ party: [3] })).toThrow();
  });
});

/**
 * classic.party module (docs/design/party.md §2, §9): a solo game is unchanged
 * until the first party action (no RES.party, the same hash as a sim without
 * the module, across 200 steps); recruiting builds the members, founder and
 * PartyMember records as designed; the same script gives the same hash, pinned.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { Hero, PartyMember, Wallet } from "../src/components.ts";
import { DEBUG_GRANT } from "../src/debug/index.ts";
import { mode, modules, debugModules } from "../src/index.ts";
import { partyMembers, purseOf, founderOf } from "../src/party/shared.ts";
import { heroOf, partyStateOf, RES, runStatsOf } from "../src/resources.ts";
import { PARTY_ID, KIND, type PartyProto } from "../src/types.ts";
import { classicParty } from "../src/party/index.ts";

const FULL = loadMode({ ...mode }, [...modules, ...debugModules]);

function newHero(sim: Sim): void {
  const r = sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Tester" }, null);
  expect(r.ok, r.error?.message).toBe(true);
}

/** Two heroes: the founder (warrior) and Rita (rogue), built with the real actions. */
function partyScript(sim: Sim): void {
  newHero(sim);
  sim.step(20);
  expect(sim.dispatch(DEBUG_GRANT, { bossesKilled: [4], gold: 2000 }, null).ok).toBe(true);
  sim.step(1);
  expect(
    sim.dispatch(ACTION.partyRecruit, { classId: "classic.rogue", name: "Rita" }, null).ok,
  ).toBe(true);
  sim.step(40);
  const rita = partyMembers(sim.world)[1]!;
  expect(sim.dispatch(ACTION.partyControl, { hero: rita }, null).ok).toBe(true);
  sim.step(60);
  expect(sim.dispatch(ACTION.partyRename, { hero: rita, name: "Ritty" }, null).ok).toBe(true);
  sim.step(100);
}

/** The world part of a sim snapshot, serialised (what the game state is). */
function stableWorld(sim: Sim): string {
  return JSON.stringify(sim.snapshot().world);
}

describe("solo games are unchanged by the party module", () => {
  it("never creates RES.party and matches a sim without the module, across 200 steps", () => {
    const withParty = createSim(loadMode({ ...mode }, modules), { seed: 5 });
    const withoutParty = createSim(
      loadMode(
        { ...mode },
        modules.filter((m) => m.id !== "classic.party"),
      ),
      { seed: 5 },
    );
    for (const sim of [withParty, withoutParty]) {
      newHero(sim);
    }
    // The snapshot carries contentHash, which differs by design; the world must not.
    for (let i = 0; i < 4; i++) {
      withParty.step(50);
      withoutParty.step(50);
      expect(partyStateOf(withParty.world)).toBeNull();
      expect(stableWorld(withParty)).toBe(stableWorld(withoutParty));
    }
    expect(withParty.tick).toBe(200);
  });

  it("the party resource is absent until the first party action", () => {
    const sim = createSim(FULL, { seed: 9 });
    newHero(sim);
    sim.step(100);
    expect(sim.world.getResource(RES.party)).toBeUndefined();
    expect(partyMembers(sim.world)).toEqual([heroOf(sim.world)]);
    expect(founderOf(sim.world)).toBe(heroOf(sim.world));
    expect(sim.world.has(heroOf(sim.world), Wallet)).toBe(true);
    expect(purseOf(sim.world)).toBe(heroOf(sim.world));
  });
});

describe("after the first party action", () => {
  it("builds the founder, the members and the purse as designed", () => {
    const sim = createSim(FULL, { seed: 13 });
    newHero(sim);
    sim.step(20);
    const founder = heroOf(sim.world);
    expect(sim.dispatch(DEBUG_GRANT, { bossesKilled: [4], gold: 2000 }, null).ok).toBe(true);
    sim.step(1);
    expect(
      sim.dispatch(ACTION.partyRecruit, { classId: "classic.rogue", name: "Rita" }, null).ok,
    ).toBe(true);
    const party = partyStateOf(sim.world);
    expect(party).not.toBeNull();
    expect(party!.founder).toBe(founder);
    expect(party!.members).toEqual([founder, partyMembers(sim.world)[1]]);
    expect(party!.slotsBought).toBe(0);
    expect(party!.nextUid).toBe(2);
    expect(party!.config.formation).toBe("wedge");

    // The founder keeps the solo record: uid 0 and its RunStats counters.
    const stats = runStatsOf(sim.world);
    expect(sim.world.read(founder, PartyMember)).toMatchObject({
      uid: 0,
      kills: stats.kills,
      deaths: stats.deaths,
    });
    expect(purseOf(sim.world)).toBe(founder);

    const rita = party!.members[1]!;
    expect(sim.world.read(rita, Hero).name).toBe("Rita");
    expect(sim.world.read(rita, PartyMember).uid).toBe(1);
    expect(sim.world.has(rita, Wallet)).toBe(false);
  });

  it("the same script gives the same hash, pinned", () => {
    const a = createSim(FULL, { seed: 2026 });
    const b = createSim(FULL, { seed: 2026 });
    partyScript(a);
    partyScript(b);
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).toBe(PINNED_HASH);
  });

  it("the classic.party module is wired with its content and no hidden state", () => {
    expect(classicParty.id).toBe("classic.party");
    expect(classicParty.deps).toEqual(["classic.core"]);
    const loaded = FULL.registry.get(KIND.party, PARTY_ID) as PartyProto | undefined;
    expect(loaded?.maxMembers).toBe(4);
  });
});

/** Pinned hash of partyScript (seed 2026). Re-pin when classic.party changes on purpose. */
const PINNED_HASH = "d60d304c24d194bb";

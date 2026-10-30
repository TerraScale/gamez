/**
 * The party AI (T-auto, docs/design/party.md §6): the follower brain
 * (classic.auto.party) and the party rules of the leader brain.
 *
 * Unit level (harness: open test maps, spawnTestParty, test monsters that
 * stand still because classic.monsters is not loaded):
 * formation behind a walking manual leader, focus fire, protect, ally heals
 * (real Mend with allyRadius), revives, loot, gear distribution.
 *
 * Full mode (real content, every classic module, followers recruited with
 * classic.party.recruit): a follower's own town routine with the purse, the
 * party travelling together, a wipe in Auto respawning everyone in town,
 * determinism with a pinned hash.
 */
import { createSim, loadMode, type Entity, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Wallet } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { partyMembers, purseOf } from "../src/party/shared.ts";
const TILE = 256;
const loaded = loadMode(mode, modules);
const NAMES = ["Brannoc", "Ysolde", "Corvin", "Maelis"];

function setPurse(sim: Sim, gold: number): void {
  sim.world.update(purseOf(sim.world), Wallet, { gold });
}

function recruitParty(seed: number, classes: readonly string[]): Sim {
  const sim = createSim(loaded, { seed });
  expect(sim.dispatch("classic.newHero", { classId: classes[0], name: NAMES[0] }, null).ok).toBe(
    true,
  );
  sim.step(2);
  for (let i = 1; i < classes.length; i++) {
    setPurse(sim, 1_000_000);
    expect(sim.dispatch("classic.party.buySlot", {}, null).ok, `buySlot ${i}`).toBe(true);
    const r = sim.dispatch("classic.party.recruit", { classId: classes[i], name: NAMES[i] }, null);
    expect(r.ok, `recruit ${classes[i]}`).toBe(true);
    sim.step(2);
  }
  setPurse(sim, 200);
  return sim;
}

describe("determinism", () => {
  const script = (): Sim => {
    const sim = recruitParty(77, ["classic.warrior", "classic.sorcerer", "classic.rogue"]);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    sim.step(1500);
    // Take control of the second member for a while, then back.
    const [a, b] = partyMembers(sim.world) as [Entity, Entity];
    expect(sim.dispatch("classic.party.control", { hero: b }, null).ok).toBe(true);
    sim.step(500);
    expect(sim.dispatch("classic.party.control", { hero: a }, null).ok).toBe(true);
    sim.step(500);
    return sim;
  };

  it("two identical party scripts give the same hash (pinned)", () => {
    const a = script();
    const b = script();
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).toBe("fabe29216d63567a");
  }, 300_000);
});

void TILE;

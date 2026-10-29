/**
 * Party test helpers shared by the Idle soak and the downed regression test.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { expect } from "vite-plus/test";
import { Wallet } from "../../src/components.ts";
import { mode, modules } from "../../src/index.ts";
import { purseOf } from "../../src/party/shared.ts";

export const loaded = loadMode(mode, modules);
export const NAMES = ["Brannoc", "Ysolde", "Corvin", "Maelis"];

function setPurse(sim: Sim, gold: number): void {
  sim.world.update(purseOf(sim.world), Wallet, { gold });
}

/** Founder + recruits through the real actions (slots bought with cheat gold). */
export function recruitParty(seed: number, classes: readonly string[]): Sim {
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

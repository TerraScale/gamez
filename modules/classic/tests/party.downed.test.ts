/**
 * Downed members are never left down for long (docs/design/party.md §6.1,
 * QA finding "downed member stays down 800+ ticks while the leader fights"):
 * the leader's 400-tick revive give-up also applies in the middle of a
 * fight (think.ts reviveRetreat), so with a town portal scroll the party
 * leaves for town, which revives every downed member.
 *
 * Seed 77, rogue, warrior, sorcerer and rogue on Full Idle: the run that had two members down for
 * 882 and 837 ticks while the leader fought. Every downed episode outside a
 * rift (town portals do not work there) must now end within
 * REVIVE_GIVEUP_TICKS plus the portal and arrival slack.
 */
import type { Entity } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Dead } from "../src/components.ts";
import { REVIVE_GIVEUP_TICKS } from "../src/auto/lead.ts";
import { partyMembers } from "../src/party/shared.ts";
import { currentDepth } from "../src/resources.ts";
import { isRiftDepth } from "../src/rules.ts";
import { recruitParty } from "./support/party.ts";

const CLASSES = ["classic.rogue", "classic.warrior", "classic.sorcerer", "classic.rogue"];
const TICKS = 13_000;
/** Give-up plus the town portal travel retry and the arrival in town. */
const MAX_DOWN_TICKS = REVIVE_GIVEUP_TICKS + 50;

describe("party downed members (seed 77)", () => {
  it("no downed episode outside a rift lasts past the revive give-up, even mid-fight", () => {
    const sim = recruitParty(77, CLASSES);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    const members = partyMembers(sim.world);
    const since = new Map<Entity, number>();
    const rift = new Set<Entity>();
    let worst = 0;
    let episodes = 0;
    for (let t = 0; t < TICKS; t++) {
      sim.step(1);
      const depth = currentDepth(sim.world);
      for (const e of members) {
        const down = sim.world.has(e, Dead);
        if (down && !since.has(e)) {
          since.set(e, t);
          episodes++;
        }
        if (down && isRiftDepth(depth)) rift.add(e);
        if (!down && since.has(e)) {
          if (!rift.has(e)) worst = Math.max(worst, t - since.get(e)!);
          since.delete(e);
          rift.delete(e);
        }
      }
    }
    for (const [e, t0] of since) if (!rift.has(e)) worst = Math.max(worst, TICKS - t0);
    console.log(`PARTYDOWNED seed=77 ticks=${TICKS} episodes=${episodes} worst=${worst}`);
    expect(episodes, "the scenario still downs members").toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(MAX_DOWN_TICKS);
  }, 600_000);
});

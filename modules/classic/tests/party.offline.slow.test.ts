/**
 * Party offline XP against the party's recent online Idle rate
 * (docs/design/offline-idle.md §4.3, docs/design/party.md §6.8): a party of
 * three idles at x1 until its controlled hero is L12, then every member's
 * offline share for 10 minutes, 1 hour and 8 hours is 20 % (15-27 %) of that
 * member's own kill XP per minute over the last 10 minutes online. The admin
 * factor scales it (50 % = 2.5x the 20 % share, 0 % = none).
 */
import { createSim, type SimSnapshot } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { partyOfflineGrant } from "../src/auto/offline.ts";
import { Level } from "../src/components.ts";
import type { ClassicEvent } from "../src/events.ts";
import { CLASSIC_HZ } from "../src/index.ts";
import { partyMembers } from "../src/party/shared.ts";
import { heroOf } from "../src/resources.ts";
import { loaded, recruitParty } from "./support/party.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SEED = 7;
const CLASSES = ["classic.rogue", "classic.sorcerer", "classic.warrior"];

describe("party offline XP follows the party's recent online Idle rate", () => {
  it("a party of three at L12: every member's share is 15-27 % of its last 10 minutes online", () => {
    const sim = recruitParty(SEED, CLASSES);
    expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
    const members = partyMembers(sim.world);
    const perMin: number[][] = members.map(() => []);
    let snap: SimSnapshot | null = null;
    for (let minute = 1; minute <= 70 && snap === null; minute++) {
      const acc = members.map(() => 0);
      for (const e of sim.step(60 * CLASSIC_HZ) as ClassicEvent[]) {
        if (e.type !== "classic.xp" || e.reason !== "kill") continue;
        const i = members.indexOf((e as { hero?: number }).hero ?? -1);
        if (i >= 0) acc[i]! += e.amount;
      }
      acc.forEach((xp, i) => perMin[i]!.push(xp));
      if (sim.world.read(heroOf(sim.world), Level).level >= 12 && minute >= 20)
        snap = sim.snapshot();
    }
    expect(snap, "the party reached L12 within 70 minutes").not.toBeNull();
    const last10 = perMin.map((p) => p.slice(-10).reduce((a, b) => a + b, 0) / 10);
    for (const ms of [10 * MINUTE, HOUR, 8 * HOUR]) {
      const s = createSim(loaded, { seed: SEED, from: snap! });
      const plan = partyOfflineGrant(s.world, s.loaded.registry, ms);
      expect(plan.grant.source).toBe("rate");
      plan.shares.forEach((sh, i) => {
        const ratio = sh.xp / (ms / MINUTE) / last10[i]!;
        const at = `member ${i}, ${ms / MINUTE} min away`;
        expect(ratio, at).toBeGreaterThanOrEqual(0.15);
        expect(ratio, at).toBeLessThanOrEqual(0.27);
      });
    }
    const s = createSim(loaded, { seed: SEED, from: snap! });
    const d20 = partyOfflineGrant(s.world, s.loaded.registry, HOUR).shares;
    const d50 = partyOfflineGrant(s.world, s.loaded.registry, HOUR, 50).shares;
    const d0 = partyOfflineGrant(s.world, s.loaded.registry, HOUR, 0).shares;
    d20.forEach((sh, i) => {
      expect(Math.abs(d50[i]!.xp * 2 - sh.xp * 5)).toBeLessThanOrEqual(5);
      expect(d0[i]!.xp).toBe(0);
    });
  }, 300_000);
});

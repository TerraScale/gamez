/**
 * End-to-end check of the pieces the verified host wires together
 * (docs/design/admin-dashboard.md §5, §11.2): real classic play, folded by
 * classicAnalytics inside a SimTally, flushes "sim.tally" kill/xp points with
 * the account id as the index. The host call sites (onEvents, commit, flush)
 * are the only missing part; this proves the data they produce is right.
 */
import { createSim, loadMode, type GameEvent } from "@gamez/kernel";
import { mode, modules } from "@gamez/mode-classic";
import { describe, expect, it } from "vite-plus/test";
import { classicAnalytics } from "../../../../modules/classic/src/platform/analytics.ts";
import { SimTally } from "../../src/server/analytics/sim-tally.ts";
import { RecordingAnalytics } from "./fake.ts";

describe("SimTally + classicAnalytics on real classic play", () => {
  it("turns verified auto play into sim.tally kill and xp points for the account", () => {
    const sim = createSim(loadMode(mode, modules), { seed: 2026 });
    expect(
      sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Tally" }, null).ok,
    ).toBe(true);
    expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);

    const tally = new SimTally("classic", classicAnalytics);
    const out = new RecordingAnalytics();
    // Segments of 100 ticks, as the client sends them; each one verifies "ok".
    let kills = 0;
    for (let seg = 0; seg < 40 && kills === 0; seg++) {
      const events: GameEvent[] = [];
      for (let i = 0; i < 100; i++) events.push(...sim.step(1));
      tally.onEvents(events);
      tally.commit(sim.world, 100, 1);
      kills += events.filter((e) => e.type === "classic.death" && e.isHero !== true).length;
    }
    expect(kills).toBeGreaterThan(0);

    const written = tally.flush(out, "acc-1", 0);
    expect(written).toBeGreaterThan(0);
    const points = out.of("sim.tally");
    expect(points.every((p) => p.index === "acc-1" && p.blobs.mode === "classic")).toBe(true);
    const metrics = new Set(points.map((p) => p.blobs.metric));
    expect(metrics.has("kill")).toBe(true);
    expect(metrics.has("xp")).toBe(true);
    expect(metrics.has("play.ms")).toBe(true);
    // One "ok" verify.segment point carries the summed ticks.
    const seg = out.of("verify.segment");
    expect(seg).toHaveLength(1);
    expect(seg[0]?.blobs.outcome).toBe("ok");
  }, 60_000);
});

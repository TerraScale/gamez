/**
 * Party autoplay acceptance (docs/design/party.md §13): a party of four mixed
 * classes (warrior, rogue, sorcerer, rogue), recruited through the real
 * classic.party actions, plays Full Idle for 20 sim minutes (24 000 ticks at
 * 20 Hz) headless on the real content with every classic module. It must show
 * the whole party loop:
 *
 * - kills, and XP and levels for EVERY hero (no member left behind);
 * - descents (the deepest depth grows) and town trips the party makes
 *   together (every member arrives in town in the same tick, invariant I2);
 * - no split: every member is always in the party's area, and every standing
 *   follower is within PartyProto.leashTeleport of the acting leader on at
 *   least 99 % of the sampled ticks;
 * - no deadlock: kills keep coming in every quarter of the run;
 * - determinism: a second sim with the same seed and script reaches the
 *   same hash at tick 3000, pinned.
 *
 * The mean and worst tick times are logged (PARTYAUTOPLAY line).
 */
import { createSim, loadMode, type Entity, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { AreaTag, Dead, Level, Pos, Wallet } from "../src/components.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { actingLeaderOf, partyMembers, purseOf } from "../src/party/shared.ts";
import { currentDepth, dungeonOf, RES, type RunStats } from "../src/resources.ts";
import { DEFAULT_PARTY_PROTO } from "../src/rules.ts";

const loaded = loadMode(mode, modules);
const SEED = 2027;
const TICKS = 24_000;
const QUARTER = TICKS / 4;
const SAMPLE = 10;
const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer", "classic.rogue"];
const NAMES = ["Brannoc", "Ysolde", "Corvin", "Tamsin"];
/** sim.hash() after the setup script plus 3000 Idle ticks (re-pin on any behaviour change). */
const PINNED_3000 = "088140d31b86f3bd";

/** Founder + three recruits through the real actions (slots bought with test gold). */
function startParty(seed: number): Sim {
  const sim = createSim(loaded, { seed });
  const r = sim.dispatch("classic.newHero", { classId: CLASSES[0], name: NAMES[0] }, null);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  sim.step(2);
  for (let i = 1; i < CLASSES.length; i++) {
    sim.world.update(purseOf(sim.world), Wallet, { gold: 1_000_000 });
    expect(sim.dispatch("classic.party.buySlot", {}, null).ok, `buySlot ${i}`).toBe(true);
    const rec = sim.dispatch(
      "classic.party.recruit",
      { classId: CLASSES[i], name: NAMES[i] },
      null,
    );
    expect(rec.ok, `recruit ${CLASSES[i]}: ${JSON.stringify(rec.error)}`).toBe(true);
    sim.step(2);
  }
  sim.world.update(purseOf(sim.world), Wallet, { gold: 200 });
  expect(sim.dispatch("classic.setControl", { mode: "idle" }, null).ok).toBe(true);
  return sim;
}

function gap(sim: Sim, a: Entity, b: Entity): number {
  const pa = sim.world.read(a, Pos);
  const pb = sim.world.read(b, Pos);
  return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
}

describe("party autoplay (4 heroes, Full Idle, 20 sim minutes)", () => {
  it("kills, XP and levels for every hero, descents, town trips together, no split", () => {
    const sim = startParty(SEED);
    const members = partyMembers(sim.world);
    expect(members).toHaveLength(4);
    const xp0 = members.map((e) => sim.world.read(e, Level).xp);
    const xpEvents = new Map<Entity, number>(members.map((e) => [e, 0]));
    let townTrips = 0;
    let descents = 0;
    let splitTicks = 0;
    let hash3000 = "";
    const killsAt: number[] = [];
    const sampled = new Map<Entity, number>(members.map((e) => [e, 0]));
    const within = new Map<Entity, number>(members.map((e) => [e, 0]));
    let ms = 0;
    let worst = 0;
    let prevDepth = currentDepth(sim.world);
    for (let t = 1; t <= TICKS; t++) {
      const t0 = performance.now();
      const events = sim.step(1);
      const dt = performance.now() - t0;
      ms += dt;
      if (dt > worst) worst = dt;
      for (const ev of events) {
        const e = ev as ClassicEvent;
        if (e.type === "classic.xp") {
          const who = e.hero ?? members[0]!;
          xpEvents.set(who, (xpEvents.get(who) ?? 0) + 1);
        }
      }
      const depth = currentDepth(sim.world);
      if (depth !== prevDepth) {
        if (depth === 0) townTrips++;
        else if (depth > prevDepth) descents++;
        prevDepth = depth;
      }
      // I2: every member is in the party's area on every tick.
      if (members.some((e) => sim.world.read(e, AreaTag).depth !== depth)) splitTicks++;
      if (t === 3000) hash3000 = sim.hash();
      if (t % QUARTER === 0) killsAt.push(sim.world.getResource<RunStats>(RES.stats)!.kills);
      if (t % SAMPLE === 0) {
        const leader = actingLeaderOf(sim.world);
        if (sim.world.has(leader, Dead)) continue;
        for (const e of members) {
          if (e === leader || sim.world.has(e, Dead)) continue;
          sampled.set(e, sampled.get(e)! + 1);
          if (gap(sim, e, leader) <= DEFAULT_PARTY_PROTO.leashTeleport) {
            within.set(e, within.get(e)! + 1);
          }
        }
      }
    }
    const stats = sim.world.getResource<RunStats>(RES.stats)!;
    const levels = members.map((e) => sim.world.read(e, Level).level);
    const gained = members.map((e, i) => sim.world.read(e, Level).xp - xp0[i]!);
    const leashPct = members
      .filter((e) => sampled.get(e)! > 0)
      .map((e) => Math.floor((within.get(e)! * 1000) / sampled.get(e)!) / 10);
    const deepest = dungeonOf(sim.world).deepest;
    const perQuarter = killsAt.map((k, i) => k - (i === 0 ? 0 : killsAt[i - 1]!));
    // Logged on purpose: the acceptance numbers of the party loop.
    console.log(
      `PARTYAUTOPLAY ticks=${TICKS} mean=${(ms / TICKS).toFixed(3)}ms worst=${worst.toFixed(1)}ms` +
        ` kills=${stats.kills} perQuarter=${perQuarter.join("/")} deaths=${stats.deaths}` +
        ` levels=${levels.join("/")} xp=${gained.join("/")} deepest=${deepest}` +
        ` descents=${descents} townTrips=${townTrips} leashPct=${leashPct.join("/")}` +
        ` splitTicks=${splitTicks} hash3000=${hash3000}`,
    );
    expect(stats.kills, "kills").toBeGreaterThan(300);
    for (let i = 0; i < members.length; i++) {
      expect(gained[i], `XP for ${NAMES[i]}`).toBeGreaterThan(0);
      expect(xpEvents.get(members[i]!), `XP events for ${NAMES[i]}`).toBeGreaterThan(0);
      expect(levels[i], `level of ${NAMES[i]}`).toBeGreaterThanOrEqual(5);
    }
    expect(deepest, "descents").toBeGreaterThanOrEqual(3);
    expect(descents, "descents").toBeGreaterThanOrEqual(3);
    expect(townTrips, "town trips (the party travels together)").toBeGreaterThanOrEqual(1);
    expect(splitTicks, "every member always in the party's area").toBe(0);
    for (const p of leashPct)
      expect(p, "followers within leashTeleport").toBeGreaterThanOrEqual(99);
    for (const k of perQuarter)
      expect(k, "kills in every quarter (no deadlock)").toBeGreaterThan(20);
    expect(hash3000).toBe(PINNED_3000);
  }, 900_000);

  it("is deterministic: the same seed and script give the same hash at tick 3000", () => {
    const a = startParty(SEED);
    a.step(3000);
    const b = startParty(SEED);
    b.step(3000);
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).toBe(PINNED_3000);
  }, 300_000);
});

/**
 * Party balance (T-auto, docs/design/party.md §8), real content with every
 * classic module, Auto, depths 1-4 (AutoConfig.maxDepth 4), same ticks:
 *
 *   party: warrior founder + rogue, sorcerer, warrior recruits (all level 1,
 *          level-matched: recruits start at highest - 3 = 1)
 *   solo:  one hero of each class in the party, weighted like the party
 *          (the baseline a party member is compared with)
 *
 * Prints one `BALROW {...}` line per run and asserts the §8 band:
 *
 *   - party kills/min      1.2 .. 2.5 x solo
 *   - deaths/hour per hero <= solo + DEATH_SLACK
 *   - XP per hero per min  0.8 .. 1.8 x solo
 *
 * Multi-seed table (one-off): BAL_SEEDS=2026,7,4242 BAL_MIN=30 node_modules/.bin/vp test run
 * modules/classic/tests/party.balance.test.ts  (numbers: docs/bench/2026-10-party.md).
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type GameEvent,
  type LoadedMode,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Level, Wallet } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { partyMembers, purseOf } from "../src/party/shared.ts";
import { RES, type DungeonState, type RunStats } from "../src/resources.ts";
import { KIND, PARTY_ID, type PartyProto } from "../src/types.ts";

/** Node's process.env (no node types in this package). */
declare const process: { env: Record<string, string | undefined> };

/**
 * BAL_PARTY='{"xpSharePct":[100,65,50,42]}' overrides PartyProto fields
 * (dataFinal patch module) to measure a proposal without touching the
 * architect's defaults (rules.ts DEFAULT_PARTY_PROTO).
 */
function loadedWith(patch: Partial<PartyProto> | null): LoadedMode {
  if (!patch) return loadMode(mode, modules);
  const override = defineModule({
    id: "balance.party",
    version: "0.0.0",
    deps: ["classic.party"],
    dataFinal(reg) {
      reg.patch<PartyProto>(KIND.party, PARTY_ID, (p) => {
        Object.assign(p, patch);
      });
    },
  });
  const m = defineMode({ ...mode, modules: [...mode.modules, "balance.party"] });
  return loadMode(m, [...modules, override]);
}
const PATCH = process.env.BAL_PARTY
  ? (JSON.parse(process.env.BAL_PARTY) as Partial<PartyProto>)
  : null;
const loaded = loadedWith(PATCH);
const TICKS_PER_MIN = 20 * 60;
const PARTY = ["classic.warrior", "classic.rogue", "classic.sorcerer", "classic.warrior"];
const NAMES = ["Brannoc", "Ysolde", "Corvin", "Maelis"];
/** Deaths per hour per hero a party member may exceed the solo rate by. */
const DEATH_SLACK = 2;

interface Row {
  run: string;
  seed: number;
  minutes: number;
  heroes: number;
  levels: number[];
  kills: number;
  killsPerMin: number;
  deaths: number;
  /** Per hero. */
  deathsPerHour: number;
  /** Per hero: all XP, kill XP only, quest XP only. */
  xpPerMin: number;
  killXpPerMin: number;
  questXpPerMin: number;
  deepest: number;
}

function setPurse(sim: Sim, gold: number): void {
  sim.world.update(purseOf(sim.world), Wallet, { gold });
}

function start(seed: number, classes: readonly string[]): Sim {
  const sim = createSim(loaded, { seed });
  const made = sim.dispatch("classic.newHero", { classId: classes[0], name: NAMES[0] }, null);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  sim.step(2);
  const startGold = sim.world.read(purseOf(sim.world), Wallet).gold;
  for (let i = 1; i < classes.length; i++) {
    setPurse(sim, 1_000_000);
    expect(sim.dispatch("classic.party.buySlot", {}, null).ok).toBe(true);
    const r = sim.dispatch("classic.party.recruit", { classId: classes[i], name: NAMES[i] }, null);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    sim.step(2);
  }
  // Same starting purse as a fresh solo hero (its starter gold).
  if (classes.length > 1) setPurse(sim, startGold);
  expect(sim.dispatch("classic.setAutoConfig", { config: { maxDepth: 4 } }, null).ok).toBe(true);
  expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
  return sim;
}

function runAuto(run: string, seed: number, minutes: number, classes: readonly string[]): Row {
  const sim = start(seed, classes);
  const members = partyMembers(sim.world);
  const xp0 = members.map((e) => sim.world.read(e, Level).xp);
  const kills0 = sim.world.getResource<RunStats>(RES.stats)!.kills;
  const byReason: Record<string, number> = {};
  const total = Math.round(minutes * TICKS_PER_MIN);
  for (let done = 0; done < total; done += 200) {
    for (const ev of sim.step(Math.min(200, total - done)) as GameEvent[]) {
      if (ev.type !== "classic.xp") continue;
      const x = ev as unknown as { amount: number; reason: string };
      byReason[x.reason] = (byReason[x.reason] ?? 0) + x.amount;
    }
  }
  const stats = sim.world.getResource<RunStats>(RES.stats)!;
  const dungeon = sim.world.getResource<DungeonState>(RES.dungeon)!;
  let xp = 0;
  members.forEach((e, i) => (xp += sim.world.read(e, Level).xp - xp0[i]!));
  const n = members.length;
  const kills = stats.kills - kills0;
  return {
    run,
    seed,
    minutes,
    heroes: n,
    levels: members.map((e) => sim.world.read(e, Level).level),
    kills,
    killsPerMin: Math.round((kills / minutes) * 10) / 10,
    deaths: stats.deaths,
    deathsPerHour: Math.round(((stats.deaths / n) * 600) / minutes) / 10,
    xpPerMin: Math.round(xp / n / minutes),
    killXpPerMin: Math.round((byReason.kill ?? 0) / n / minutes),
    questXpPerMin: Math.round((byReason.quest ?? 0) / n / minutes),
    deepest: dungeon.deepest,
  };
}

/** The solo baseline: one run per party class, weighted like the party (runs cached per class). */
function soloBaseline(seed: number, minutes: number): Row {
  const runs = new Map<string, Row>();
  const rows = PARTY.map((c) => {
    const hit = runs.get(c) ?? runAuto(`solo ${c}`, seed, minutes, [c]);
    runs.set(c, hit);
    return hit;
  });
  const avg = (f: (r: Row) => number): number =>
    Math.round((rows.reduce((a, r) => a + f(r), 0) / rows.length) * 10) / 10;
  for (const r of runs.values()) console.log(`BALROW ${JSON.stringify(r)}`);
  return {
    run: "solo (party-weighted mean)",
    seed,
    minutes,
    heroes: 1,
    levels: rows.map((r) => r.levels[0]!),
    kills: Math.round(avg((r) => r.kills)),
    killsPerMin: avg((r) => r.killsPerMin),
    deaths: Math.round(avg((r) => r.deaths)),
    deathsPerHour: avg((r) => r.deathsPerHour),
    xpPerMin: Math.round(avg((r) => r.xpPerMin)),
    killXpPerMin: Math.round(avg((r) => r.killXpPerMin)),
    questXpPerMin: Math.round(avg((r) => r.questXpPerMin)),
    deepest: Math.max(...rows.map((r) => r.deepest)),
  };
}

interface Ratios {
  kills: number;
  xp: number;
  killXp: number;
}

function compare(seed: number, minutes: number): { party: Row; solo: Row; ratio: Ratios } {
  const solo = soloBaseline(seed, minutes);
  const party = runAuto("party of 4", seed, minutes, PARTY);
  const ratio = {
    kills: Math.round((party.killsPerMin / Math.max(0.1, solo.killsPerMin)) * 100) / 100,
    xp: Math.round((party.xpPerMin / Math.max(1, solo.xpPerMin)) * 100) / 100,
    killXp: Math.round((party.killXpPerMin / Math.max(1, solo.killXpPerMin)) * 100) / 100,
  };
  console.log(`BALROW ${JSON.stringify(solo)}`);
  console.log(`BALROW ${JSON.stringify(party)}`);
  const tag = PATCH ? JSON.stringify(PATCH) : "default";
  console.log(
    `BALROW ${JSON.stringify({ run: "ratio party/solo", seed, minutes, proto: tag, ...ratio })}`,
  );
  return { party, solo, ratio };
}

const seeds = process.env.BAL_SEEDS;
if (seeds) {
  const minutes = Number(process.env.BAL_MIN ?? 30);
  for (const s of seeds.split(",").map(Number))
    it(`party balance table seed ${s} (${minutes} min)`, () => void compare(s, minutes), 3_600_000);
} else {
  describe("party balance (Auto, depths 1-4, real content)", () => {
    it("four heroes vs the solo baseline, 15 minutes, mean of two seeds, are in the §8 band", () => {
      // One seed is too noisy for a band (measured: XP ratio 1.95 on 2026, 1.47 on 7).
      const runs = [compare(2026, 15), compare(7, 15)];
      const mean = (f: (r: (typeof runs)[number]) => number): number =>
        runs.reduce((a, r) => a + f(r), 0) / runs.length;
      const kills = mean((r) => r.ratio.kills);
      const xp = mean((r) => r.ratio.xp);
      const partyDeaths = mean((r) => r.party.deathsPerHour);
      const soloDeaths = mean((r) => r.solo.deathsPerHour);
      console.log(
        `BALROW ${JSON.stringify({ run: "mean ratio party/solo", seeds: [2026, 7], kills, xp, partyDeaths, soloDeaths })}`,
      );
      expect(kills, "party kills/min vs solo").toBeGreaterThanOrEqual(1.2);
      expect(kills).toBeLessThanOrEqual(2.5);
      expect(partyDeaths, "deaths/hour per hero").toBeLessThanOrEqual(soloDeaths + DEATH_SLACK);
      expect(xp, "XP per hero per minute vs solo").toBeGreaterThanOrEqual(0.8);
      expect(xp).toBeLessThanOrEqual(1.8);
    }, 1_800_000);
  });
}

/**
 * Hero skill balance (wave A, T-skills). Light check on every run: over 20
 * sim minutes in Auto (seed 2026, real content) the Rogue kills at least half
 * as fast as the Sorcerer. The full measurement table is a one-off run:
 *
 *   BAL_CLASS=classic.rogue BAL_SEED=7 BAL_MIN=60 node_modules/.bin/vp test run \
 *     modules/classic/tests/skills.balance.test.ts
 *
 * which prints one `BALROW {...}` line (level, kills/min, deaths/h, deepest).
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type LoadedMode,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Level } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { heroOf, RES, type DungeonState, type RunStats } from "../src/resources.ts";
import { KIND, type AttrBlock, type ClassProto, type SkillProto } from "../src/types.ts";

/** Node's process.env (no node types in this package). */
declare const process: { env: Record<string, string | undefined> };

const TICKS_PER_MIN = 20 * 60;

/** Pre-wave-A class lists (git HEAD) and the nine new skills, for the same-tree A/B (BAL_REVERT=1). */
const PRE_WAVE: Record<
  string,
  { skills: string[]; autoSkillOrder: string[]; autoAlloc: AttrBlock }
> = {
  "classic.warrior": {
    skills: ["attack", "mend", "cleave", "whirl", "rally", "charge"],
    autoSkillOrder: ["cleave", "rally", "whirl", "charge", "mend"],
    autoAlloc: { str: 2, dex: 1, mag: 0, vit: 2 },
  },
  "classic.rogue": {
    skills: ["attack", "mend", "multishot", "venom_shot", "spark_sentry", "tumble"],
    autoSkillOrder: ["multishot", "venom_shot", "spark_sentry", "tumble", "mend"],
    autoAlloc: { str: 1, dex: 3, mag: 0, vit: 1 },
  },
  "classic.sorcerer": {
    skills: ["attack", "mend", "ember_bolt", "frost_ring", "arc_chain", "cinder_orb", "phase_step"],
    autoSkillOrder: ["ember_bolt", "frost_ring", "arc_chain", "cinder_orb", "phase_step", "mend"],
    autoAlloc: { str: 0, dex: 1, mag: 3, vit: 1 },
  },
};
const WAVE_A_NEW = [
  "quake_stomp",
  "iron_skin",
  "sky_leap",
  "piercing_shot",
  "caltrops",
  "night_volley",
  "glacial_spike",
  "storm_call",
  "falling_star",
].map((k) => `classic.skill.${k}`);

/**
 * The real mode, optionally changed for measurement only (never shipped):
 * BAL_ORDER="id,id,..." replaces the class's autoSkillOrder; BAL_REVERT=1
 * restores the pre-wave-A class lists and removes the new skills and status
 * (same tree, so the A/B isolates this wave's content). Cached per key.
 */
const loadedCache = new Map<string, LoadedMode>();
/**
 * BAL_PATCH='{"skills":{"<id>":{...}},"classes":{"<id>":{...}}}' shallow-merges
 * fields into skill / class prototypes (measurement only).
 */
interface BalPatch {
  skills?: Record<string, Partial<SkillProto>>;
  classes?: Record<string, Partial<ClassProto>>;
}
function loadedFor(
  classId: string,
  order: string[] | null,
  revert: boolean,
  patch: BalPatch | null = null,
): LoadedMode {
  const key = `${classId}|${order?.join(",") ?? ""}|${revert}|${JSON.stringify(patch)}`;
  const hit = loadedCache.get(key);
  if (hit) return hit;
  if (!order && !revert && !patch) {
    const plain = loadMode(mode, modules);
    loadedCache.set(key, plain);
    return plain;
  }
  const override = defineModule({
    id: "balance.override",
    version: "1.0.0",
    deps: ["classic.content"],
    dataUpdates(reg) {
      if (revert) {
        for (const id of WAVE_A_NEW) reg.remove(KIND.skill, id);
        reg.remove(KIND.status, "classic.status.iron_skin");
        // Wave A rogue numbers back to HEAD.
        reg.patch<SkillProto>(KIND.skill, "classic.skill.venom_shot", (sk) => {
          sk.weaponPct = 110;
        });
        for (const [cls, pre] of Object.entries(PRE_WAVE)) {
          reg.patch<ClassProto>(KIND.class, cls, (c) => {
            c.skills = pre.skills.map((k) => `classic.skill.${k}`);
            c.autoSkillOrder = [...pre.autoSkillOrder].map((k) => `classic.skill.${k}`);
            c.autoAlloc = { ...pre.autoAlloc };
          });
        }
      }
      if (order) {
        reg.patch<ClassProto>(KIND.class, classId, (c) => {
          c.autoSkillOrder = [...order];
        });
      }
      for (const [id, fields] of Object.entries(patch?.skills ?? {}))
        reg.patch<SkillProto>(KIND.skill, id, (sk) => {
          Object.assign(sk, fields);
        });
      for (const [id, fields] of Object.entries(patch?.classes ?? {}))
        reg.patch<ClassProto>(KIND.class, id, (c) => {
          Object.assign(c, fields);
        });
    },
  });
  const m = defineMode({ ...mode, modules: [...mode.modules, "balance.override"] });
  const loaded = loadMode(m, [...modules, override]);
  loadedCache.set(key, loaded);
  return loaded;
}

interface Row {
  classId: string;
  seed: number;
  minutes: number;
  level: number;
  kills: number;
  killsPerMin: number;
  deaths: number;
  deathsPerHour: number;
  deepest: number;
}

function runAuto(
  classId: string,
  seed: number,
  minutes: number,
  order: string[] | null = null,
  revert = false,
  patch: BalPatch | null = null,
): Row {
  const sim: Sim = createSim(loadedFor(classId, order, revert, patch), { seed });
  const created = sim.dispatch("classic.newHero", { classId, name: "Tester" }, null);
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const control = sim.dispatch("classic.setControl", { mode: "auto" }, null);
  if (!control.ok) throw new Error(JSON.stringify(control.error));
  const total = Math.round(minutes * TICKS_PER_MIN);
  for (let done = 0; done < total; done += 20) {
    sim.step(Math.min(20, total - done));
    if (heroOf(sim.world) === 0) break;
  }
  const hero = heroOf(sim.world);
  const stats = sim.world.getResource<RunStats>(RES.stats)!;
  const dungeon = sim.world.getResource<DungeonState>(RES.dungeon)!;
  const level = hero === 0 ? 0 : sim.world.read(hero, Level).level;
  const hours = minutes / 60;
  return {
    classId,
    seed,
    minutes,
    level,
    kills: stats.kills,
    killsPerMin: Math.round((stats.kills / minutes) * 10) / 10,
    deaths: stats.deaths,
    deathsPerHour: Math.round((stats.deaths / hours) * 10) / 10,
    deepest: dungeon.deepest,
  };
}

const tableClass = process.env.BAL_CLASS;
if (tableClass) {
  const seed = Number(process.env.BAL_SEED ?? 2026);
  const minutes = Number(process.env.BAL_MIN ?? 60);
  const order = process.env.BAL_ORDER ? process.env.BAL_ORDER.split(",") : null;
  const revert = process.env.BAL_REVERT === "1";
  const patch = process.env.BAL_PATCH ? (JSON.parse(process.env.BAL_PATCH) as BalPatch) : null;
  it(
    `table row ${tableClass} seed ${seed} (${minutes} min)`,
    () => {
      const row = {
        ...runAuto(tableClass, seed, minutes, order, revert, patch),
        order: order?.join(",") ?? "current",
        revert,
        patch: patch ? "yes" : "no",
      };
      console.log(`BALROW ${JSON.stringify(row)}`);
    },
    60 * 60 * 1000,
  );
} else {
  describe("skill balance (Auto, real content)", () => {
    it("the rogue kills at least half as fast as the sorcerer over 20 minutes", () => {
      const rogue = runAuto("classic.rogue", 2026, 20);
      const sorc = runAuto("classic.sorcerer", 2026, 20);
      console.log(`BALROW ${JSON.stringify(rogue)}`);
      console.log(`BALROW ${JSON.stringify(sorc)}`);
      expect(rogue.level).toBeGreaterThan(1);
      expect(rogue.killsPerMin).toBeGreaterThanOrEqual(sorc.killsPerMin * 0.5);
    }, 900_000);
  });
}

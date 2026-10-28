/**
 * classicArenaBuild (wave-C.md §6.2): the arena build of a verified classic
 * hero. Runs real classic sims: a new hero of each class, and a warrior after
 * an Auto run. Pure, deterministic, every number inside its ArenaBuild range.
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import type { ArenaBuild, ArenaSkill } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { mode, modules } from "../src/index.ts";
import { arenaKindOf, classicArenaBuild, type ClassicArenaBuild } from "../src/platform/build.ts";
import type { SkillProto } from "../src/types.ts";

const loaded = loadMode(mode, modules);
const SEED = 2026;

function newHero(classId: string, seed = SEED): Sim {
  const sim = createSim(loaded, { seed });
  expect(sim.dispatch("classic.newHero", { classId, name: "Tester" }, null).ok).toBe(true);
  sim.step(1);
  return sim;
}

function autoHero(classId: string, ticks: number, seed = SEED): Sim {
  const sim = newHero(classId, seed);
  expect(sim.dispatch("classic.setControl", { mode: "auto" }, null).ok).toBe(true);
  sim.step(ticks);
  return sim;
}

function build(sim: Sim): ClassicArenaBuild | null {
  return classicArenaBuild(sim.world, loaded.registry);
}

/** Every number of a build inside the ArenaBuild ranges (protocol economy.ts + arena clamps). */
function expectInRanges(b: ClassicArenaBuild): void {
  const ints = [
    b.level,
    b.maxHp,
    b.dmgMin,
    b.dmgMax,
    b.attackRate,
    b.armor,
    b.resist,
    b.critPct,
    b.moveSpeed,
    b.power,
  ];
  for (const n of ints) expect(Number.isSafeInteger(n)).toBe(true);
  expect(b.maxHp).toBeGreaterThanOrEqual(1);
  expect(b.dmgMin).toBeGreaterThanOrEqual(1);
  expect(b.dmgMax).toBeGreaterThanOrEqual(b.dmgMin);
  expect(b.attackRate).toBeGreaterThanOrEqual(1);
  expect(b.attackRate).toBeLessThanOrEqual(100);
  expect(b.resist).toBeGreaterThanOrEqual(0);
  expect(b.resist).toBeLessThanOrEqual(75);
  expect(b.critPct).toBeGreaterThanOrEqual(0);
  expect(b.critPct).toBeLessThanOrEqual(75);
  expect(b.moveSpeed).toBeGreaterThanOrEqual(1);
  expect(b.moveSpeed).toBeLessThanOrEqual(8);
  expect(b.skills.length).toBeLessThanOrEqual(4);
  for (const s of b.skills) expectSkillInRange(s);
}

function expectSkillInRange(s: ArenaSkill): void {
  expect(["strike", "projectile", "nova", "heal", "shield"]).toContain(s.kind);
  expect(s.power).toBeGreaterThanOrEqual(1);
  expect(s.power).toBeLessThanOrEqual(1000);
  expect(s.cooldown).toBeGreaterThanOrEqual(1);
  expect(s.cooldown).toBeLessThanOrEqual(400);
  const [lo, hi] =
    s.kind === "strike" ? [1, 2] : s.kind === "projectile" || s.kind === "nova" ? [2, 8] : [0, 0];
  expect(s.range).toBeGreaterThanOrEqual(lo);
  expect(s.range).toBeLessThanOrEqual(hi);
}

describe("classicArenaBuild", () => {
  it("returns null before a hero exists, and does not touch the world", () => {
    const sim = createSim(loaded, { seed: SEED });
    const before = sim.hash();
    expect(build(sim)).toBeNull();
    expect(sim.hash()).toBe(before);
  });

  it("maps a new warrior to the pinned build", () => {
    expect(build(newHero("classic.warrior"))).toEqual({
      mode: "classic",
      classId: "classic.warrior",
      level: 1,
      name: "Tester",
      appearance: "unit.hero.warrior",
      maxHp: 125,
      dmgMin: 5,
      dmgMax: 13,
      attackRate: 15,
      armor: 8,
      resist: 0,
      critPct: 7,
      moveSpeed: 4,
      skills: [
        {
          id: "classic.skill.cleave",
          name: "Cleave",
          kind: "strike",
          power: 130,
          cooldown: 10,
          range: 2,
        },
      ],
      power: 33,
    });
  });

  it("maps a new rogue to the pinned build (ranged skill)", () => {
    expect(build(newHero("classic.rogue"))).toEqual({
      mode: "classic",
      classId: "classic.rogue",
      level: 1,
      name: "Tester",
      appearance: "unit.hero.rogue",
      maxHp: 88,
      dmgMin: 5,
      dmgMax: 10,
      attackRate: 18,
      armor: 13,
      resist: 0,
      critPct: 8,
      moveSpeed: 4,
      skills: [
        {
          id: "classic.skill.multishot",
          name: "Fan of Arrows",
          kind: "projectile",
          power: 85,
          cooldown: 10,
          range: 8,
        },
      ],
      power: 34,
    });
  });

  it("maps a new sorcerer to the pinned build", () => {
    expect(build(newHero("classic.sorcerer"))).toEqual({
      mode: "classic",
      classId: "classic.sorcerer",
      level: 1,
      name: "Tester",
      appearance: "unit.hero.sorcerer",
      maxHp: 60,
      dmgMin: 2,
      dmgMax: 10,
      attackRate: 14,
      armor: 5,
      resist: 0,
      critPct: 7,
      moveSpeed: 4,
      skills: [
        {
          id: "classic.skill.ember_bolt",
          name: "Ember Bolt",
          kind: "projectile",
          power: 100,
          cooldown: 10,
          range: 8,
        },
      ],
      power: 19,
    });
  });

  it("pins the warrior after a fixed Auto run (3000 ticks, seed 2026)", () => {
    const sim = autoHero("classic.warrior", 3000);
    expect(build(sim)).toEqual({
      mode: "classic",
      classId: "classic.warrior",
      level: 3,
      name: "Tester",
      appearance: "unit.hero.warrior",
      maxHp: 192,
      dmgMin: 5,
      dmgMax: 13,
      attackRate: 15,
      armor: 16,
      resist: 0,
      critPct: 7,
      moveSpeed: 4,
      skills: [
        {
          id: "classic.skill.cleave",
          name: "Cleave",
          kind: "strike",
          power: 138,
          cooldown: 10,
          range: 2,
        },
        {
          id: "classic.skill.rally",
          name: "Rallying Cry",
          kind: "shield",
          power: 20,
          cooldown: 150,
          range: 0,
        },
      ],
      power: 48,
    });
  }, 60_000);

  it("keeps every number inside the arena ranges for each class and after Auto", () => {
    for (const c of ["classic.warrior", "classic.rogue", "classic.sorcerer"]) {
      const fresh = build(newHero(c));
      expect(fresh).not.toBeNull();
      expectInRanges(fresh!);
      const auto = build(autoHero(c, 1500));
      expect(auto).not.toBeNull();
      expectInRanges(auto!);
    }
  }, 60_000);

  it("is deterministic: the same script gives the same build and does not change the sim", () => {
    const a = autoHero("classic.rogue", 1500);
    const b = autoHero("classic.rogue", 1500);
    expect(a.hash()).toBe(b.hash());
    expect(build(a)).toEqual(build(b));
    const before = a.hash();
    build(a);
    build(a);
    expect(a.hash()).toBe(before);
  }, 60_000);

  it("is a full ArenaBuild once the host adds accountId, displayName and sourceHash", () => {
    const b: ArenaBuild = {
      ...build(newHero("classic.warrior"))!,
      accountId: "acc",
      displayName: "Acc",
      sourceHash: "0000",
    };
    expect(Object.keys(b).sort()).toEqual(
      [
        "accountId",
        "appearance",
        "armor",
        "attackRate",
        "classId",
        "critPct",
        "dmgMax",
        "dmgMin",
        "displayName",
        "level",
        "maxHp",
        "mode",
        "moveSpeed",
        "name",
        "power",
        "resist",
        "skills",
        "sourceHash",
      ].sort(),
    );
  });
});

describe("arenaKindOf", () => {
  const proto = (over: Partial<SkillProto>): SkillProto =>
    ({ shape: "melee", ...over }) as SkillProto;
  it("maps shapes and self effects to arena kinds", () => {
    expect(arenaKindOf(proto({ shape: "melee" }))).toBe("strike");
    expect(arenaKindOf(proto({ shape: "arc" }))).toBe("strike");
    expect(arenaKindOf(proto({ shape: "dash" }))).toBe("strike");
    expect(arenaKindOf(proto({ shape: "projectile" }))).toBe("projectile");
    expect(arenaKindOf(proto({ shape: "chain" }))).toBe("projectile");
    expect(arenaKindOf(proto({ shape: "nova" }))).toBe("nova");
    expect(arenaKindOf(proto({ shape: "aoeTarget" }))).toBe("nova");
    expect(arenaKindOf(proto({ shape: "pulse" }))).toBe("nova");
    expect(arenaKindOf(proto({ shape: "self", heal: { pct: 20, pctPerRank: 2, flat: 10 } }))).toBe(
      "heal",
    );
    expect(
      arenaKindOf(
        proto({ shape: "self", buff: { status: "s", duration: 1, power: 20, powerPerRank: 3 } }),
      ),
    ).toBe("shield");
    expect(arenaKindOf(proto({ shape: "blink" }))).toBeNull();
    expect(arenaKindOf(proto({ shape: "summon" }))).toBeNull();
  });
});

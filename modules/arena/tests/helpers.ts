/** Shared builders for the arena tests (plain ArenaBuild values). */
import type { ArenaBuild, ArenaSkill } from "@gamez/protocol";

export function build(over: Partial<ArenaBuild> = {}): ArenaBuild {
  return {
    mode: "classic",
    accountId: "acc-a",
    name: "Tester",
    displayName: "Tester",
    classId: "classic.warrior",
    level: 10,
    appearance: "unit.hero.warrior",
    maxHp: 200,
    dmgMin: 5,
    dmgMax: 9,
    attackRate: 12,
    armor: 10,
    resist: 10,
    critPct: 5,
    moveSpeed: 4,
    skills: [],
    power: 100,
    sourceHash: "0000",
    ...over,
  };
}

export function skill(over: Partial<ArenaSkill> = {}): ArenaSkill {
  return {
    id: "classic.skill.cleave",
    name: "Cleave",
    kind: "strike",
    power: 130,
    cooldown: 30,
    range: 2,
    ...over,
  };
}

/** Deterministic pseudo-random integers for property tests (not sim code). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

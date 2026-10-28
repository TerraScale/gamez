/**
 * Boss and rift guardian skills and statuses (wave A, docs/design/wave-A.md
 * §6). OWNER: T-bosses. Skill ids "classic.mskill.<name>" (users "monster"),
 * status ids "classic.status.<name>".
 *
 * Every skill here is telegraphed (SkillProto.telegraph): classic.combat
 * places the danger zone when the cast fires and hits whoever is still in it
 * `ticks` later. Damage is weapon % of the boss (scaled with its level).
 * Skills whose `damage` block is all zeros convert their whole packet to that
 * element (classic.combat convertsElement: boss_meteor is always fire,
 * boss_frost_nova always cold, boss_pyre_ring always fire).
 */
import { tiles } from "../fixed.ts";
import type { Element, SkillProto, StatusProto } from "../types.ts";

/** Id of the boss enrage status (buff; power = MonsterProto.phases[].enragePct). */
export const ENRAGE_STATUS = "classic.status.enrage";

const BASE: SkillProto = {
  name: "",
  description: "",
  icon: "",
  users: "monster",
  reqLevel: 1,
  maxRank: 20,
  shape: "nova",
  target: "self",
  range: 0,
  manaCost: 0,
  manaPerRank: 0,
  cooldown: 0,
  castTicks: 14,
  hitTick: 7,
  speedStat: "attack",
  weaponPct: 100,
  weaponPctPerRank: 0,
  damage: null,
  scaling: null,
  canMiss: false,
  effect: "",
  ai: { tags: ["aoe"], priority: 5 },
};

type Overrides = Partial<SkillProto> & Pick<SkillProto, "name" | "description">;

function boss(key: string, p: Overrides): SkillProto {
  return { ...BASE, icon: `icon.skill.${key}`, effect: `fx.${key}`, ...p };
}

/** A zero `damage` block: classic.combat deals the weapon packet as `element`. */
function as(element: Element): SkillProto["damage"] {
  return { element, min: 0, max: 0, minPerRank: 0, maxPerRank: 0 };
}

export const BOSS_SKILLS: Record<string, SkillProto> = {
  "classic.mskill.boss_quake": boss("boss_quake", {
    name: "Groundbreaker",
    description: "Marks the ground under its foe, then splits it open and stuns.",
    shape: "aoeTarget",
    target: "enemy",
    range: tiles(8),
    radius: tiles(2.5),
    weaponPct: 170,
    cooldown: 150,
    castTicks: 14,
    hitTick: 8,
    speedStat: "attack",
    status: { id: "classic.status.stun", chancePct: 100, duration: 12, power: 0, powerPerRank: 0 },
    telegraph: { ticks: 30, shape: "circle" },
    ai: { tags: ["aoe", "control", "ranged"], priority: 7 },
  }),
  "classic.mskill.boss_cleave": boss("boss_cleave", {
    name: "Reaping Sweep",
    description: "Winds up a wide sweep in front of itself.",
    shape: "arc",
    target: "enemy",
    range: tiles(3.5),
    arc: 12,
    weaponPct: 180,
    cooldown: 100,
    castTicks: 12,
    hitTick: 6,
    speedStat: "attack",
    telegraph: { ticks: 24, shape: "cone" },
    ai: { tags: ["aoe", "melee"], priority: 6 },
  }),
  "classic.mskill.boss_rush": boss("boss_rush", {
    name: "Trampling Rush",
    description: "Lines up on its foe and tramples everything in the lane.",
    shape: "dash",
    target: "enemy",
    range: tiles(8),
    dash: { speed: 140, maxRange: tiles(8) },
    weaponPct: 160,
    cooldown: 180,
    castTicks: 10,
    hitTick: 6,
    speedStat: "attack",
    telegraph: { ticks: 20, shape: "line", width: tiles(1.2) },
    ai: { tags: ["mobility", "melee"], priority: 5 },
  }),
  "classic.mskill.boss_meteor": boss("boss_meteor", {
    name: "Starfall",
    description: "Calls three burning stones down around its foe.",
    shape: "aoeTarget",
    target: "enemy",
    range: tiles(10),
    radius: tiles(2),
    weaponPct: 150,
    damage: as("fire"),
    cooldown: 200,
    castTicks: 16,
    hitTick: 8,
    speedStat: "cast",
    telegraph: { ticks: 36, shape: "circle", count: 3 },
    ai: { tags: ["aoe", "ranged"], priority: 7 },
  }),
  "classic.mskill.boss_frost_nova": boss("boss_frost_nova", {
    name: "Rime Bloom",
    description: "Frost gathers around it, then bursts outward and chills.",
    shape: "nova",
    target: "self",
    radius: tiles(4),
    weaponPct: 120,
    damage: as("cold"),
    cooldown: 160,
    castTicks: 14,
    hitTick: 7,
    speedStat: "cast",
    status: {
      id: "classic.status.chill",
      chancePct: 100,
      duration: 40,
      power: 30,
      powerPerRank: 0,
    },
    telegraph: { ticks: 30, shape: "circle" },
    ai: { tags: ["aoe", "control"], priority: 6 },
  }),
  // Extra (not in the binding list): Vessa's fire ring; reuses the boss_nova art.
  "classic.mskill.boss_pyre_ring": boss("boss_pyre_ring", {
    name: "Pyre Ring",
    description: "Flames rise in a ring around it, then roar up all at once.",
    shape: "nova",
    target: "self",
    radius: tiles(3.5),
    weaponPct: 140,
    damage: as("fire"),
    cooldown: 140,
    castTicks: 14,
    hitTick: 7,
    speedStat: "cast",
    telegraph: { ticks: 28, shape: "circle" },
    effect: "fx.boss_nova",
    ai: { tags: ["aoe"], priority: 6 },
  }),
};

export const BOSS_STATUSES: Record<string, StatusProto> = {
  [ENRAGE_STATUS]: {
    name: "Enraged",
    kind: "buff",
    mods: [
      { stat: "dmgPct", perPower: 1 },
      { stat: "attackSpeed", perPower: 1 },
      { stat: "castSpeed", perPower: 1 },
    ],
    stacks: false,
    icon: "icon.status.enrage",
    tint: 0xff3b3b,
  },
};

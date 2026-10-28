/**
 * Talent trees (wave A, docs/design/wave-A.md §3). OWNER: T-talents.
 *
 * One TalentTreeProto per class ("classic.talents.<class>") with three branches
 * (columns) and five tiers (rows, 0..4): 15 nodes per class, one capstone per
 * branch (tier 4, rank 1). Node ids are "classic.talent.<class>.<key>".
 * Effects are per rank: rank r gives r x perRank. Descriptions use "{v}" for
 * the total of the first effect (stats first, then skills), at the current
 * rank (at least one rank).
 *
 * Every class has at least 7 nodes that modify its own skills (SkillModifier
 * selectors: exact skill ids, "tag:<tag>" or "*"); the rest are stat passives.
 * autoOrder lists the nodes in the order Auto/Idle spends points on them (each
 * key repeated once per rank); the sum of maxRank is 54 per tree.
 */
import type { SkillModifier, StatMod, TalentNodeProto, TalentTreeProto } from "../types.ts";

interface NodeSpec {
  name: string;
  description: string;
  /** Row 0..4. */
  tier: number;
  /** Branch index 0..2. */
  col: number;
  maxRank: number;
  /** Key (within the same tree) of the node that needs one rank first. */
  requires?: string;
  stats?: StatMod[];
  skills?: SkillModifier[];
}

interface TreeSpec {
  /** Class key: "warrior", "rogue", "sorcerer". */
  cls: string;
  /** ClassProto id. */
  classId: string;
  name: string;
  branches: [string, string, string];
  nodes: Record<string, NodeSpec>;
  /** Node keys in Auto/Idle priority order (a key repeats once per rank). */
  autoOrder: string[];
}

function stat(stat: StatMod["stat"], value: number): StatMod {
  return { stat, value };
}

function skill(skill: string, field: SkillModifier["field"], value: number): SkillModifier {
  return { skill, field, value };
}

/** Builds one class tree: its TalentTreeProto and TalentNodeProto entries. */
function buildTree(spec: TreeSpec): {
  tree: [string, TalentTreeProto];
  nodes: [string, TalentNodeProto][];
} {
  const treeId = `classic.talents.${spec.cls}`;
  const prefix = `classic.talent.${spec.cls}.`;
  const keys = Object.keys(spec.nodes).sort((a, b) => {
    const x = spec.nodes[a]!;
    const y = spec.nodes[b]!;
    return x.col - y.col || x.tier - y.tier || (a < b ? -1 : a > b ? 1 : 0);
  });
  const nodes: [string, TalentNodeProto][] = keys.map((key) => {
    const s = spec.nodes[key]!;
    return [
      prefix + key,
      {
        name: s.name,
        description: s.description,
        icon: `icon.talent.${key}`,
        tree: treeId,
        tier: s.tier,
        col: s.col,
        maxRank: s.maxRank,
        requires: s.requires === undefined ? null : prefix + s.requires,
        perRank: { stats: s.stats ?? [], skills: s.skills ?? [] },
      },
    ];
  });
  const tree: TalentTreeProto = {
    name: spec.name,
    classId: spec.classId,
    tierPoints: 3,
    branches: [...spec.branches],
    nodes: keys.map((key) => prefix + key),
    autoOrder: spec.autoOrder.map((key) => prefix + key),
  };
  return { tree: [treeId, tree], nodes };
}

const WARRIOR: TreeSpec = {
  cls: "warrior",
  classId: "classic.warrior",
  name: "Warrior",
  branches: ["Bulwark", "Warcry", "Fury"],
  nodes: {
    // Bulwark
    hardened: {
      name: "Hardened",
      description: "Adds {v} maximum life.",
      tier: 0,
      col: 0,
      maxRank: 5,
      stats: [stat("life", 6)],
    },
    iron_stance: {
      name: "Iron Stance",
      description: "Raises armor by {v}%.",
      tier: 1,
      col: 0,
      maxRank: 4,
      stats: [stat("armorPct", 5)],
    },
    iron_skin_mastery: {
      name: "Iron Skin Mastery",
      description: "Iron Skin lasts {v}% longer.",
      tier: 2,
      col: 0,
      maxRank: 3,
      requires: "iron_stance",
      skills: [skill("classic.skill.iron_skin", "durationPct", 20)],
    },
    stone_skin: {
      name: "Stone Skin",
      description: "Adds {v}% to every resistance.",
      tier: 3,
      col: 0,
      maxRank: 4,
      requires: "iron_skin_mastery",
      stats: [stat("resAll", 4)],
    },
    unbreakable: {
      name: "Unbreakable",
      description: "Raises armor by {v}% and adds block chance.",
      tier: 4,
      col: 0,
      maxRank: 1,
      requires: "stone_skin",
      stats: [stat("armorPct", 25), stat("blockPct", 10)],
    },
    // Warcry
    war_bellow: {
      name: "War Bellow",
      description: "Rally reaches {v}% further.",
      tier: 0,
      col: 1,
      maxRank: 3,
      skills: [skill("classic.skill.rally", "radiusPct", 15)],
    },
    cleaving_arc: {
      name: "Cleaving Arc",
      description: "Cleave deals {v}% more damage.",
      tier: 1,
      col: 1,
      maxRank: 5,
      skills: [skill("classic.skill.cleave", "damagePct", 8)],
    },
    restorative_hands: {
      name: "Restorative Hands",
      description: "Mend costs {v}% less mana.",
      tier: 2,
      col: 1,
      maxRank: 4,
      requires: "cleaving_arc",
      skills: [skill("classic.skill.mend", "manaCostPct", -8)],
    },
    sweeping_blows: {
      name: "Sweeping Blows",
      description: "Area skills reach {v}% wider.",
      tier: 3,
      col: 1,
      maxRank: 4,
      requires: "restorative_hands",
      skills: [skill("tag:aoe", "radiusPct", 8)],
    },
    warlord: {
      name: "Warlord",
      description: "Area skills deal {v}% more damage.",
      tier: 4,
      col: 1,
      maxRank: 1,
      requires: "sweeping_blows",
      skills: [skill("tag:aoe", "damagePct", 20)],
    },
    // Fury
    sharpened_edge: {
      name: "Sharpened Edge",
      description: "Raises weapon damage by {v}%.",
      tier: 0,
      col: 2,
      maxRank: 5,
      stats: [stat("dmgPct", 4)],
    },
    keen_eye: {
      name: "Keen Eye",
      description: "Raises critical hit chance by {v}%.",
      tier: 1,
      col: 2,
      maxRank: 5,
      stats: [stat("critPct", 2)],
    },
    blood_frenzy: {
      name: "Blood Frenzy",
      description: "Raises attack speed by {v}%.",
      tier: 2,
      col: 2,
      maxRank: 4,
      requires: "keen_eye",
      stats: [stat("attackSpeed", 4)],
    },
    momentum: {
      name: "Momentum",
      description: "Charge deals {v}% more damage.",
      tier: 3,
      col: 2,
      maxRank: 5,
      requires: "blood_frenzy",
      skills: [skill("classic.skill.charge", "damagePct", 8)],
    },
    bloodlust: {
      name: "Bloodlust",
      description: "Heal {v}% of the damage you deal.",
      tier: 4,
      col: 2,
      maxRank: 1,
      requires: "momentum",
      stats: [stat("lifeSteal", 6), stat("critDmgPct", 20)],
    },
  },
  autoOrder: [
    "hardened",
    "hardened",
    "hardened",
    "hardened",
    "hardened",
    "sharpened_edge",
    "sharpened_edge",
    "sharpened_edge",
    "sharpened_edge",
    "sharpened_edge",
    "cleaving_arc",
    "cleaving_arc",
    "cleaving_arc",
    "cleaving_arc",
    "cleaving_arc",
    "iron_stance",
    "iron_stance",
    "iron_stance",
    "iron_stance",
    "keen_eye",
    "keen_eye",
    "keen_eye",
    "keen_eye",
    "keen_eye",
    "war_bellow",
    "war_bellow",
    "war_bellow",
    "restorative_hands",
    "restorative_hands",
    "restorative_hands",
    "restorative_hands",
    "iron_skin_mastery",
    "iron_skin_mastery",
    "iron_skin_mastery",
    "blood_frenzy",
    "blood_frenzy",
    "blood_frenzy",
    "blood_frenzy",
    "stone_skin",
    "stone_skin",
    "stone_skin",
    "stone_skin",
    "sweeping_blows",
    "sweeping_blows",
    "sweeping_blows",
    "sweeping_blows",
    "momentum",
    "momentum",
    "momentum",
    "momentum",
    "momentum",
    "unbreakable",
    "warlord",
    "bloodlust",
  ],
};

const ROGUE: TreeSpec = {
  cls: "rogue",
  classId: "classic.rogue",
  name: "Rogue",
  branches: ["Shadow", "Toxin", "Deadeye"],
  nodes: {
    // Shadow
    light_feet: {
      name: "Light Feet",
      description: "Raises movement speed by {v}%.",
      tier: 0,
      col: 0,
      maxRank: 5,
      stats: [stat("moveSpeed", 3)],
    },
    nimble_hands: {
      name: "Nimble Hands",
      description: "Raises attack speed by {v}%.",
      tier: 1,
      col: 0,
      maxRank: 5,
      stats: [stat("attackSpeed", 3)],
    },
    tumbling_grace: {
      name: "Tumbling Grace",
      description: "Tumble recovers {v}% faster.",
      tier: 2,
      col: 0,
      maxRank: 4,
      requires: "nimble_hands",
      skills: [skill("classic.skill.tumble", "cooldownPct", -8)],
    },
    cutthroat: {
      name: "Cutthroat",
      description: "Raises critical hit chance by {v}%.",
      tier: 3,
      col: 0,
      maxRank: 5,
      requires: "tumbling_grace",
      stats: [stat("critPct", 2)],
    },
    shadow_step: {
      name: "Shadow Step",
      description: "Raises critical damage by {v}%.",
      tier: 4,
      col: 0,
      maxRank: 1,
      requires: "cutthroat",
      stats: [stat("critDmgPct", 30)],
    },
    // Toxin
    venom_coating: {
      name: "Venom Coating",
      description: "Adds {v} poison damage to your attacks.",
      tier: 0,
      col: 1,
      maxRank: 5,
      stats: [stat("poisonDmg", 2)],
    },
    toxic_arrows: {
      name: "Toxic Arrows",
      description: "Venom Shot deals {v}% more damage.",
      tier: 1,
      col: 1,
      maxRank: 4,
      skills: [skill("classic.skill.venom_shot", "damagePct", 12)],
    },
    pestilence: {
      name: "Pestilence",
      description: "Damage over time lasts {v}% longer.",
      tier: 2,
      col: 1,
      maxRank: 4,
      requires: "toxic_arrows",
      skills: [skill("tag:dot", "durationPct", 15)],
    },
    caustic_cloud: {
      name: "Caustic Cloud",
      description: "Caltrops deal {v}% more damage.",
      tier: 3,
      col: 1,
      maxRank: 4,
      requires: "pestilence",
      skills: [skill("classic.skill.caltrops", "damagePct", 15)],
    },
    plague_master: {
      name: "Plague Master",
      description: "Damage over time deals {v}% more damage.",
      tier: 4,
      col: 1,
      maxRank: 1,
      requires: "caustic_cloud",
      skills: [skill("tag:dot", "damagePct", 30)],
    },
    // Deadeye
    steady_aim: {
      name: "Steady Aim",
      description: "Raises accuracy by {v}%.",
      tier: 0,
      col: 2,
      maxRank: 5,
      stats: [stat("toHitPct", 6)],
    },
    long_draw: {
      name: "Long Draw",
      description: "Raises weapon damage by {v}%.",
      tier: 1,
      col: 2,
      maxRank: 5,
      stats: [stat("dmgPct", 4)],
    },
    split_shot: {
      name: "Split Shot",
      description: "Multishot fires {v} more arrows.",
      tier: 2,
      col: 2,
      maxRank: 2,
      requires: "long_draw",
      skills: [skill("classic.skill.multishot", "extraProjectiles", 1)],
    },
    piercing_eye: {
      name: "Piercing Eye",
      description: "Piercing Shot pierces {v} more targets.",
      tier: 3,
      col: 2,
      maxRank: 3,
      requires: "split_shot",
      skills: [skill("classic.skill.piercing_shot", "extraPierce", 1)],
    },
    night_hunter: {
      name: "Night Hunter",
      description: "Night Volley fires {v} more arrows.",
      tier: 4,
      col: 2,
      maxRank: 1,
      requires: "piercing_eye",
      skills: [skill("classic.skill.night_volley", "extraProjectiles", 2)],
    },
  },
  autoOrder: [
    "light_feet",
    "light_feet",
    "light_feet",
    "light_feet",
    "light_feet",
    "steady_aim",
    "steady_aim",
    "steady_aim",
    "steady_aim",
    "steady_aim",
    "venom_coating",
    "venom_coating",
    "venom_coating",
    "venom_coating",
    "venom_coating",
    "long_draw",
    "long_draw",
    "long_draw",
    "long_draw",
    "long_draw",
    "nimble_hands",
    "nimble_hands",
    "nimble_hands",
    "nimble_hands",
    "nimble_hands",
    "toxic_arrows",
    "toxic_arrows",
    "toxic_arrows",
    "toxic_arrows",
    "split_shot",
    "split_shot",
    "tumbling_grace",
    "tumbling_grace",
    "tumbling_grace",
    "tumbling_grace",
    "pestilence",
    "pestilence",
    "pestilence",
    "pestilence",
    "piercing_eye",
    "piercing_eye",
    "piercing_eye",
    "cutthroat",
    "cutthroat",
    "cutthroat",
    "cutthroat",
    "cutthroat",
    "caustic_cloud",
    "caustic_cloud",
    "caustic_cloud",
    "caustic_cloud",
    "shadow_step",
    "night_hunter",
    "plague_master",
  ],
};

const SORCERER: TreeSpec = {
  cls: "sorcerer",
  classId: "classic.sorcerer",
  name: "Sorcerer",
  branches: ["Ember", "Glacier", "Tempest"],
  nodes: {
    // Ember
    kindled_mind: {
      name: "Kindled Mind",
      description: "Raises spell damage by {v}%.",
      tier: 0,
      col: 0,
      maxRank: 5,
      stats: [stat("spellPct", 4)],
    },
    ember_focus: {
      name: "Ember Focus",
      description: "Ember Bolt deals {v}% more damage.",
      tier: 1,
      col: 0,
      maxRank: 4,
      skills: [skill("classic.skill.ember_bolt", "damagePct", 12)],
    },
    fire_mastery: {
      name: "Fire Mastery",
      description: "Adds {v} fire damage to your attacks.",
      tier: 2,
      col: 0,
      maxRank: 5,
      requires: "ember_focus",
      stats: [stat("fireDmg", 2)],
    },
    cinder_strike: {
      name: "Cinder Strike",
      description: "Cinder Orb deals {v}% more damage.",
      tier: 3,
      col: 0,
      maxRank: 4,
      requires: "fire_mastery",
      skills: [skill("classic.skill.cinder_orb", "damagePct", 15)],
    },
    inferno: {
      name: "Inferno",
      description: "Falling Star deals {v}% more damage.",
      tier: 4,
      col: 0,
      maxRank: 1,
      requires: "cinder_strike",
      skills: [skill("classic.skill.falling_star", "damagePct", 25)],
    },
    // Glacier
    biting_cold: {
      name: "Biting Cold",
      description: "Adds {v} cold damage to your attacks.",
      tier: 0,
      col: 1,
      maxRank: 5,
      stats: [stat("coldDmg", 2)],
    },
    frost_lattice: {
      name: "Frost Lattice",
      description: "Frost Ring is {v}% wider.",
      tier: 1,
      col: 1,
      maxRank: 4,
      skills: [skill("classic.skill.frost_ring", "radiusPct", 10)],
    },
    deep_freeze: {
      name: "Deep Freeze",
      description: "Control effects last {v}% longer.",
      tier: 2,
      col: 1,
      maxRank: 3,
      requires: "frost_lattice",
      skills: [skill("tag:control", "durationPct", 20)],
    },
    glacial_lance: {
      name: "Glacial Lance",
      description: "Glacial Spike deals {v}% more damage.",
      tier: 3,
      col: 1,
      maxRank: 4,
      requires: "deep_freeze",
      skills: [skill("classic.skill.glacial_spike", "damagePct", 15)],
    },
    absolute_zero: {
      name: "Absolute Zero",
      description: "Casting is {v}% faster.",
      tier: 4,
      col: 1,
      maxRank: 1,
      requires: "glacial_lance",
      stats: [stat("castSpeed", 12)],
    },
    // Tempest
    static_charge: {
      name: "Static Charge",
      description: "Adds {v} lightning damage to your attacks.",
      tier: 0,
      col: 2,
      maxRank: 5,
      stats: [stat("lightningDmg", 2)],
    },
    quick_casting: {
      name: "Quick Casting",
      description: "Raises cast speed by {v}%.",
      tier: 1,
      col: 2,
      maxRank: 5,
      stats: [stat("castSpeed", 4)],
    },
    chain_reaction: {
      name: "Chain Reaction",
      description: "Arc Chain bounces {v} more times.",
      tier: 2,
      col: 2,
      maxRank: 3,
      requires: "quick_casting",
      skills: [skill("classic.skill.arc_chain", "extraBounces", 1)],
    },
    storm_caller: {
      name: "Storm Caller",
      description: "Storm Call deals {v}% more damage.",
      tier: 3,
      col: 2,
      maxRank: 4,
      requires: "chain_reaction",
      skills: [skill("classic.skill.storm_call", "damagePct", 15)],
    },
    tempest_lord: {
      name: "Tempest Lord",
      description: "All skills cost {v}% less mana.",
      tier: 4,
      col: 2,
      maxRank: 1,
      requires: "storm_caller",
      skills: [skill("*", "manaCostPct", -12)],
    },
  },
  autoOrder: [
    "kindled_mind",
    "kindled_mind",
    "kindled_mind",
    "kindled_mind",
    "kindled_mind",
    "static_charge",
    "static_charge",
    "static_charge",
    "static_charge",
    "static_charge",
    "biting_cold",
    "biting_cold",
    "biting_cold",
    "biting_cold",
    "biting_cold",
    "ember_focus",
    "ember_focus",
    "ember_focus",
    "ember_focus",
    "quick_casting",
    "quick_casting",
    "quick_casting",
    "quick_casting",
    "quick_casting",
    "frost_lattice",
    "frost_lattice",
    "frost_lattice",
    "frost_lattice",
    "fire_mastery",
    "fire_mastery",
    "fire_mastery",
    "fire_mastery",
    "fire_mastery",
    "chain_reaction",
    "chain_reaction",
    "chain_reaction",
    "deep_freeze",
    "deep_freeze",
    "deep_freeze",
    "cinder_strike",
    "cinder_strike",
    "cinder_strike",
    "cinder_strike",
    "glacial_lance",
    "glacial_lance",
    "glacial_lance",
    "glacial_lance",
    "storm_caller",
    "storm_caller",
    "storm_caller",
    "storm_caller",
    "inferno",
    "absolute_zero",
    "tempest_lord",
  ],
};

const SPECS: TreeSpec[] = [WARRIOR, ROGUE, SORCERER];

/** One TalentTreeProto per class (id "classic.talents.<class>"). */
export const TALENT_TREES: Record<string, TalentTreeProto> = {};

/** Every TalentNodeProto (id "classic.talent.<class>.<key>"). */
export const TALENT_NODES: Record<string, TalentNodeProto> = {};

for (const spec of SPECS) {
  const built = buildTree(spec);
  TALENT_TREES[built.tree[0]] = built.tree[1];
  for (const [id, node] of built.nodes) TALENT_NODES[id] = node;
}

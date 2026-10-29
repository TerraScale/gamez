/**
 * classic.talents behaviour (wave A §3, T-talents): points per level (lazy
 * component), learn rules and every rejection, BonusStats sums and their
 * effect on the hero stats and skill modifiers, Auto/Idle allocation order,
 * the reset (town, gold, refund, goldSpent), the command path, determinism
 * with a pinned hash. A small test tree is registered on top of testContent.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type GameEvent,
  type ModuleSpec,
  type Registry,
  type Sim,
  type World,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { bonusMods, skillModsOf } from "../src/bonus.ts";
import { pushCommand } from "../src/bus.ts";
import {
  BonusStats,
  CombatStats,
  Dead,
  Hero,
  Level,
  Life,
  Talents,
  Wallet,
} from "../src/components.ts";
import { modules as classicModules } from "../src/index.ts";
import { ECONOMY } from "../src/content/economy.ts";
import { buildTalentsView } from "../src/client/model/talents.ts";
import type { ModelContext } from "../src/client/model/context.ts";
import { RES, runStatsOf, type ControlState } from "../src/resources.ts";
import { ECONOMY_ID, KIND, type TalentNodeProto, type TalentTreeProto } from "../src/types.ts";
import { testContent } from "./support/content.ts";
import { ensureResources, spawnTestHero, useOpenMap } from "./support/harness.ts";

const CLASS = "test.class.fighter";
const OTHER = "test.class.mage";
const F = (k: string) => `test.talent.fighter.${k}`;

const FIGHTER_NODES: Record<string, TalentNodeProto> = {
  [F("vigor")]: {
    name: "Vigor",
    description: "Adds {v} maximum life.",
    icon: "icon.talent.vigor",
    tree: "test.talents.fighter",
    tier: 0,
    col: 0,
    maxRank: 3,
    requires: null,
    perRank: { stats: [{ stat: "life", value: 5 }], skills: [] },
  },
  [F("edge")]: {
    name: "Edge",
    description: "Raises maximum life by {v}%.",
    icon: "icon.talent.edge",
    tree: "test.talents.fighter",
    tier: 0,
    col: 1,
    maxRank: 2,
    requires: null,
    perRank: { stats: [{ stat: "lifePct", value: 10 }], skills: [] },
  },
  [F("focus")]: {
    name: "Focus",
    description: "Raises critical hit chance by {v}%.",
    icon: "icon.talent.focus",
    tree: "test.talents.fighter",
    tier: 0,
    col: 2,
    maxRank: 2,
    requires: null,
    perRank: { stats: [{ stat: "critPct", value: 3 }], skills: [] },
  },
  [F("bash")]: {
    name: "Bash",
    description: "Strike deals {v}% more damage.",
    icon: "icon.talent.bash",
    tree: "test.talents.fighter",
    tier: 1,
    col: 0,
    maxRank: 2,
    requires: F("vigor"),
    perRank: {
      stats: [],
      skills: [{ skill: "test.skill.strike", field: "damagePct", value: 20 }],
    },
  },
  [F("deep")]: {
    name: "Deep",
    description: "Raises critical hit chance by {v}%.",
    icon: "icon.talent.deep",
    tree: "test.talents.fighter",
    tier: 2,
    col: 1,
    maxRank: 1,
    requires: null,
    perRank: { stats: [{ stat: "critPct", value: 5 }], skills: [] },
  },
  [F("capstone")]: {
    name: "Capstone",
    description: "Raises maximum life by {v}%.",
    icon: "icon.talent.capstone",
    tree: "test.talents.fighter",
    tier: 4,
    col: 2,
    maxRank: 1,
    requires: F("edge"),
    perRank: { stats: [{ stat: "lifePct", value: 20 }], skills: [] },
  },
};

const FIGHTER_TREE: TalentTreeProto = {
  name: "Fighter",
  classId: CLASS,
  tierPoints: 3,
  branches: ["Guard", "Fury", "Focus"],
  nodes: Object.keys(FIGHTER_NODES).sort(),
  autoOrder: [
    F("vigor"),
    F("vigor"),
    F("vigor"),
    F("edge"),
    F("edge"),
    F("focus"),
    F("focus"),
    F("bash"),
    F("bash"),
    F("deep"),
    F("capstone"),
  ],
};

const MAGE_TREE: TalentTreeProto = {
  name: "Mage",
  classId: OTHER,
  tierPoints: 3,
  branches: ["Spark", "Ward", "Storm"],
  nodes: ["test.talent.mage.spark"],
  autoOrder: ["test.talent.mage.spark"],
};

const MAGE_NODE: TalentNodeProto = {
  name: "Spark",
  description: "Adds {v}% spell damage.",
  icon: "icon.talent.spark",
  tree: "test.talents.mage",
  tier: 0,
  col: 0,
  maxRank: 1,
  requires: null,
  perRank: { stats: [{ stat: "spellPct", value: 5 }], skills: [] },
};

/** Two trees (fighter, mage) and the economy used by the reset tests. */
export const testTalents = defineModule({
  id: "test.talents",
  version: "0.0.1",
  data(reg: Registry) {
    reg.define(KIND.talentTree, "test.talents.fighter", FIGHTER_TREE);
    reg.define(KIND.talentTree, "test.talents.mage", MAGE_TREE);
    for (const id of Object.keys(FIGHTER_NODES).sort()) {
      reg.define(KIND.talent, id, FIGHTER_NODES[id]!);
    }
    reg.define(KIND.talent, "test.talent.mage.spark", MAGE_NODE);
    reg.define(KIND.economy, ECONOMY_ID, ECONOMY);
  },
});

const MODULES = [
  "classic.core",
  "classic.talents",
  "classic.progression",
  "test.content",
  "test.talents",
];

/** A play sim on an open town map with a hero (no Talents component unless `talents` is given). */
function talentSim(
  opts: {
    seed?: number;
    level?: number;
    gold?: number;
    depth?: number;
    talents?: { points: number; spent?: number; ranks?: { node: string; rank: number }[] };
  } = {},
): { sim: Sim; hero: number } {
  const mode = defineMode({
    id: "classic",
    name: "Classic (talents test)",
    description: "test",
    world: null,
    modules: MODULES,
    tick: { kind: "fixed", hz: 20 },
  });
  const catalog: ModuleSpec[] = [...classicModules, testContent, testTalents];
  const sim = createSim(loadMode(mode, catalog), { seed: opts.seed ?? 1 });
  ensureResources(sim.world);
  if (opts.depth && opts.depth > 0) useOpenMap(sim, opts.depth);
  else useOpenMap(sim, 0);
  const hero = spawnTestHero(sim.world, {
    classId: CLASS,
    level: opts.level ?? 1,
    gold: opts.gold ?? 0,
    depth: opts.depth ?? 0,
  });
  if (opts.talents) {
    const ranks = opts.talents.ranks ?? [];
    sim.world.add(hero, Talents, {
      points: opts.talents.points,
      spent: opts.talents.spent ?? ranks.reduce((s, r) => s + r.rank, 0),
      ranks,
      levelSeen: opts.level ?? 1,
    });
  }
  return { sim, hero };
}

function setLevel(world: World, hero: number, level: number): void {
  world.update(hero, Level, { level });
}

function talentsOf(world: World, hero: number) {
  return world.get(hero, Talents);
}

function rankOf(world: World, hero: number, node: string): number {
  return talentsOf(world, hero)?.ranks.find((r) => r.node === node)?.rank ?? 0;
}

function expectRejected(sim: Sim, name: string, payload: unknown, code: string): void {
  const before = sim.hash();
  const res = sim.dispatch(name, payload, null);
  expect(res.ok).toBe(false);
  expect(res.error?.code).toBe(code);
  expect(sim.hash()).toBe(before);
}

describe("talent points per level", () => {
  it("grants one point per level from level 2 and records levelSeen", () => {
    const { sim, hero } = talentSim();
    sim.step(1);
    expect(talentsOf(sim.world, hero)).toBeUndefined();
    setLevel(sim.world, hero, 2);
    const events = sim.step(1);
    expect(talentsOf(sim.world, hero)).toMatchObject({ points: 1, spent: 0, levelSeen: 2 });
    expect(events).toContainEqual({ type: "classic.talent.points", points: 1, gained: 1 });
  });

  it("grants every level gained at once and does not grant twice", () => {
    const { sim, hero } = talentSim();
    setLevel(sim.world, hero, 6);
    const first = sim.step(1);
    expect(talentsOf(sim.world, hero)).toMatchObject({ points: 5, levelSeen: 6 });
    expect(first.filter((e) => e.type === "classic.talent.points")).toEqual([
      { type: "classic.talent.points", points: 5, gained: 5 },
    ]);
    const second = sim.step(5);
    expect(talentsOf(sim.world, hero)?.points).toBe(5);
    expect(second.filter((e) => e.type === "classic.talent.points")).toEqual([]);
  });

  it("gives a fresh level-1 hero no component and no points", () => {
    const { sim, hero } = talentSim({ level: 1 });
    sim.step(10);
    expect(sim.world.has(hero, Talents)).toBe(false);
  });

  it("creates the component lazily on an old hero at a high level (levelSeen 1)", () => {
    const { sim, hero } = talentSim({ level: 9 });
    sim.step(1);
    expect(talentsOf(sim.world, hero)).toMatchObject({
      points: 8,
      spent: 0,
      ranks: [],
      levelSeen: 9,
    });
  });
});

describe("learning talents", () => {
  it("spends a point on a learnable node and refreshes the stats at once", () => {
    const { sim, hero } = talentSim({ talents: { points: 2 } });
    sim.step(1);
    const before = sim.world.read(hero, Life).max;
    const res = sim.dispatch("classic.learnTalent", { node: F("vigor") }, null);
    expect(res.ok).toBe(true);
    expect(res.events).toContainEqual({
      type: "classic.talent.learned",
      node: F("vigor"),
      rank: 1,
    });
    expect(talentsOf(sim.world, hero)).toMatchObject({ points: 1, spent: 1 });
    expect(rankOf(sim.world, hero, F("vigor"))).toBe(1);
    expect(sim.world.read(hero, Life).max).toBe(before + 5);
  });

  it("rejects an unknown node, a node of another class and learning without points", () => {
    const { sim } = talentSim({ talents: { points: 0 } });
    expectRejected(sim, "classic.learnTalent", { node: "test.talent.fighter.nope" }, "unknown_id");
    expectRejected(sim, "classic.learnTalent", { node: F("vigor") }, "no_points");
    expectRejected(sim, "classic.learnTalent", { node: "test.talent.mage.spark" }, "wrong_class");
  });

  it("rejects a node at max rank", () => {
    const { sim, hero } = talentSim({
      talents: { points: 1, spent: 3, ranks: [{ node: F("vigor"), rank: 3 }] },
    });
    expect(talentsOf(sim.world, hero)?.points).toBe(1);
    expectRejected(sim, "classic.learnTalent", { node: F("vigor") }, "max_rank");
  });

  it("gates tiers: tier t needs t x tierPoints points spent in the tree", () => {
    // Bash is tier 1 (needs 3 spent) and requires Vigor.
    const { sim } = talentSim({
      talents: {
        points: 3,
        spent: 2,
        ranks: [
          { node: F("vigor"), rank: 1 },
          { node: F("edge"), rank: 1 },
        ],
      },
    });
    expectRejected(sim, "classic.learnTalent", { node: F("bash") }, "talent_locked");
    // Capstone is tier 4 (needs 12 spent).
    expectRejected(sim, "classic.learnTalent", { node: F("capstone") }, "talent_locked");
  });

  it("gates requirements: a node needs its required talent learned", () => {
    // Three points spent without Vigor: the tier is open, the requirement is not.
    const { sim, hero } = talentSim({
      talents: {
        points: 1,
        spent: 3,
        ranks: [
          { node: F("edge"), rank: 2 },
          { node: F("focus"), rank: 1 },
        ],
      },
    });
    expectRejected(sim, "classic.learnTalent", { node: F("bash") }, "talent_locked");
    // Once Vigor has a rank, Bash opens.
    sim.world.update(hero, Talents, {
      ranks: [
        { node: F("edge"), rank: 2 },
        { node: F("focus"), rank: 1 },
        { node: F("vigor"), rank: 1 },
      ],
      spent: 4,
    });
    const res = sim.dispatch("classic.learnTalent", { node: F("bash") }, null);
    expect(res.ok).toBe(true);
    expect(rankOf(sim.world, hero, F("bash"))).toBe(1);
  });

  it("rejects malformed payloads and leaves the hash unchanged", () => {
    const { sim } = talentSim({ talents: { points: 1 } });
    expectRejected(sim, "classic.learnTalent", {}, "bad_payload");
    expectRejected(sim, "classic.learnTalent", { node: 3 }, "bad_payload");
    expectRejected(sim, "classic.learnTalent", { node: F("vigor"), extra: 1 }, "bad_payload");
  });

  it("rejects learning while dead", () => {
    const { sim, hero } = talentSim({ talents: { points: 1 } });
    sim.world.add(hero, Dead, { at: 0, killer: 0 });
    expectRejected(sim, "classic.learnTalent", { node: F("vigor") }, "dead");
  });
});

describe("BonusStats sums", () => {
  it("writes the summed rank x perRank of every node into the classic.talents entry", () => {
    const { sim, hero } = talentSim({ talents: { points: 9 } });
    sim.dispatch("classic.learnTalent", { node: F("vigor") }, null);
    sim.dispatch("classic.learnTalent", { node: F("vigor") }, null);
    sim.dispatch("classic.learnTalent", { node: F("focus") }, null);
    sim.dispatch("classic.learnTalent", { node: F("bash") }, null);
    const b = sim.world.get(hero, BonusStats);
    expect(b?.sources).toEqual([
      {
        source: "classic.talents",
        mods: [
          { stat: "critPct", value: 3 },
          { stat: "life", value: 10 },
        ],
        skills: [{ skill: "test.skill.strike", field: "damagePct", value: 20 }],
      },
    ]);
  });

  it("feeds CombatStats and Life after classic.progression.stats (crit, life %)", () => {
    const { sim, hero } = talentSim({ talents: { points: 9 } });
    sim.step(1);
    const crit = sim.world.read(hero, CombatStats).critPct;
    const life = sim.world.read(hero, Life).max;
    sim.dispatch("classic.learnTalent", { node: F("edge") }, null);
    sim.dispatch("classic.learnTalent", { node: F("edge") }, null);
    sim.dispatch("classic.learnTalent", { node: F("focus") }, null);
    sim.dispatch("classic.learnTalent", { node: F("focus") }, null);
    sim.step(1);
    expect(sim.world.read(hero, CombatStats).critPct).toBe(crit + 6);
    // Edge: +10% life per rank, two ranks = +20% of the class life (base x 1.2).
    expect(sim.world.read(hero, Life).max).toBe(Math.floor((life * 120) / 100));
    expect(bonusMods(sim.world, hero)).toEqual([
      { stat: "critPct", value: 6 },
      { stat: "lifePct", value: 20 },
    ]);
  });

  it("exposes skill modifiers to skillModsOf (damagePct on the matching skill only)", () => {
    const { sim, hero } = talentSim({ talents: { points: 9 } });
    sim.dispatch("classic.learnTalent", { node: F("vigor") }, null);
    sim.dispatch("classic.learnTalent", { node: F("edge") }, null);
    sim.dispatch("classic.learnTalent", { node: F("focus") }, null);
    sim.dispatch("classic.learnTalent", { node: F("bash") }, null);
    sim.dispatch("classic.learnTalent", { node: F("bash") }, null);
    const reg = sim.loaded.registry;
    expect(skillModsOf(sim.world, reg, hero, "test.skill.strike").damagePct).toBe(40);
    expect(skillModsOf(sim.world, reg, hero, "test.skill.bolt").damagePct).toBe(0);
  });
});

describe("Auto/Idle allocation", () => {
  it("spends granted points in autoOrder (first learnable entry each time)", () => {
    const { sim, hero } = talentSim();
    (sim.world.getResource<ControlState>(RES.control) as ControlState).mode = "idle";
    setLevel(sim.world, hero, 10);
    const events = sim.step(1);
    const t = talentsOf(sim.world, hero);
    expect(t?.points).toBe(0);
    expect(t?.spent).toBe(9);
    expect(t?.ranks).toEqual([
      { node: F("bash"), rank: 2 },
      { node: F("edge"), rank: 2 },
      { node: F("focus"), rank: 2 },
      { node: F("vigor"), rank: 3 },
    ]);
    expect(events.filter((e) => e.type === "classic.talent.learned")).toHaveLength(9);
  });

  it("keeps points in manual mode and when config.autoAllocate is off", () => {
    const { sim, hero } = talentSim();
    setLevel(sim.world, hero, 4);
    sim.step(5);
    expect(talentsOf(sim.world, hero)?.points).toBe(3);
    const control = sim.world.getResource<ControlState>(RES.control) as ControlState;
    control.mode = "auto";
    control.config.autoAllocate = false;
    sim.step(5);
    expect(talentsOf(sim.world, hero)?.points).toBe(3);
  });

  it("does not spend while dead", () => {
    const { sim, hero } = talentSim();
    (sim.world.getResource<ControlState>(RES.control) as ControlState).mode = "idle";
    setLevel(sim.world, hero, 4);
    sim.world.add(hero, Dead, { at: 0, killer: 0 });
    sim.step(2);
    expect(talentsOf(sim.world, hero)?.points).toBe(3);
  });
});

describe("reset", () => {
  it("refunds every point for the EconomyProto price, town only", () => {
    const cost = ECONOMY.talentResetPerLevel * 3;
    const { sim, hero } = talentSim({
      level: 3,
      gold: 1000,
      talents: {
        points: 1,
        ranks: [
          { node: F("vigor"), rank: 2 },
          { node: F("edge"), rank: 1 },
        ],
      },
    });
    const res = sim.dispatch("classic.resetTalents", {}, null);
    expect(res.ok).toBe(true);
    expect(res.events).toContainEqual({ type: "classic.talents.reset", refunded: 3, cost });
    expect(talentsOf(sim.world, hero)).toMatchObject({ points: 4, spent: 0, ranks: [] });
    expect(sim.world.read(hero, Wallet).gold).toBe(1000 - cost);
    expect(runStatsOf(sim.world).goldSpent).toBe(cost);
    expect(bonusMods(sim.world, hero)).toEqual([]);
  });

  it("is rejected outside town, with nothing spent, or without gold", () => {
    const { sim: outside } = talentSim({
      depth: 1,
      gold: 1000,
      talents: { points: 0, ranks: [{ node: F("vigor"), rank: 1 }] },
    });
    expectRejected(outside, "classic.resetTalents", {}, "not_in_town");

    const { sim: empty } = talentSim({ gold: 1000, talents: { points: 3 } });
    expectRejected(empty, "classic.resetTalents", {}, "empty");

    const { sim: broke } = talentSim({
      level: 3,
      gold: 0,
      talents: { points: 1, ranks: [{ node: F("vigor"), rank: 1 }] },
    });
    expectRejected(broke, "classic.resetTalents", {}, "no_gold");
  });
});

describe("command path", () => {
  it("runs queued learnTalent / resetTalents ops and reports failures", () => {
    const { sim, hero } = talentSim({ talents: { points: 1 } });
    pushCommand(sim.world, { op: "learnTalent", node: F("vigor") });
    pushCommand(sim.world, { op: "learnTalent", node: F("deep") });
    const events: GameEvent[] = sim.step(1);
    expect(rankOf(sim.world, hero, F("vigor"))).toBe(1);
    expect(events).toContainEqual({ type: "classic.talent.learned", node: F("vigor"), rank: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "classic.command.failed",
        op: "learnTalent",
        code: "no_points",
      }),
    );
  });
});

describe("validation of the module contract", () => {
  it("creates the BonusStats component only when a talent is learned", () => {
    const { sim, hero } = talentSim({ talents: { points: 1 } });
    sim.step(1);
    expect(sim.world.has(hero, BonusStats)).toBe(false);
    sim.dispatch("classic.learnTalent", { node: F("vigor") }, null);
    expect(sim.world.has(hero, BonusStats)).toBe(true);
    expect(sim.world.has(hero, Hero)).toBe(true);
  });
});

describe("determinism and pinned hash", () => {
  function script(seed: number): Sim {
    const { sim } = talentSim({ seed });
    const hero = sim.world.query(Hero)[0]!;
    sim.world.update(hero, Level, { level: 6 });
    sim.step(5);
    sim.dispatch("classic.learnTalent", { node: F("vigor") }, null);
    sim.dispatch("classic.learnTalent", { node: F("vigor") }, null);
    sim.dispatch("classic.learnTalent", { node: F("focus") }, null);
    sim.dispatch("classic.learnTalent", { node: F("edge") }, null);
    sim.dispatch("classic.learnTalent", { node: F("bash") }, null);
    sim.step(20);
    return sim;
  }

  it("the same seed and actions give the same hash", () => {
    expect(script(7).hash()).toBe(script(7).hash());
  });

  it("the hash after a fixed script is pinned", () => {
    expect(script(7).hash()).toBe("da34d3d5709901bf");
  });
});

describe("HUD view (client/model/talents.ts)", () => {
  function ctxOf(sim: Sim, hero: number): ModelContext {
    return {
      world: sim.world,
      registry: sim.loaded.registry,
      hero,
      heroView: null,
      tick: 0,
      vendor: 0,
      itemView: () => {
        throw new Error("not used by talents");
      },
    };
  }

  it("returns null without a hero or a class tree", () => {
    const { sim } = talentSim({ talents: { points: 1 } });
    expect(buildTalentsView(ctxOf(sim, 0))).toBeNull();
  });

  it("lists the tree with ranks, learnable and locked flags, lines and the reset price", () => {
    const { sim, hero } = talentSim({
      gold: 1000,
      level: 2,
      talents: { points: 1, spent: 2, ranks: [{ node: F("vigor"), rank: 2 }] },
    });
    const view = buildTalentsView(ctxOf(sim, hero));
    expect(view).not.toBeNull();
    expect(view).toMatchObject({
      tree: "test.talents.fighter",
      name: "Fighter",
      branches: ["Guard", "Fury", "Focus"],
      tierPoints: 3,
      points: 1,
      spent: 2,
      resetCost: ECONOMY.talentResetPerLevel * 2,
      canReset: true,
    });
    const byId = new Map(view!.nodes.map((n) => [n.id, n]));
    const vigor = byId.get(F("vigor"))!;
    expect(vigor).toMatchObject({ rank: 2, learnable: true, locked: false });
    expect(vigor.description).toBe("Adds 10 maximum life.");
    expect(vigor.lines).toEqual(["Current: +10 maximum life", "Next: +15 maximum life"]);
    // Bash is tier 1 (needs 3 spent): locked, and not learnable.
    expect(byId.get(F("bash"))).toMatchObject({ learnable: false, locked: true });
    // Capstone is tier 4 (needs 12 spent): locked.
    expect(byId.get(F("capstone"))).toMatchObject({ learnable: false, locked: true, rank: 0 });
    expect(
      view!.nodes.every(
        (n) => n.learnable === (n.id === F("vigor") || n.id === F("edge") || n.id === F("focus")),
      ),
    ).toBe(true);
  });

  it("flags tier and requirement locks even with no points to spend", () => {
    const { sim, hero } = talentSim({
      talents: { points: 0, spent: 1, ranks: [{ node: F("vigor"), rank: 1 }] },
    });
    const byId = new Map(buildTalentsView(ctxOf(sim, hero))!.nodes.map((n) => [n.id, n]));
    // No points: nothing is learnable, but only the tier/requires rules mark a node locked.
    expect([...byId.values()].some((n) => n.learnable)).toBe(false);
    expect(byId.get(F("vigor"))).toMatchObject({ locked: false, learnable: false });
    expect(byId.get(F("edge"))).toMatchObject({ locked: false, learnable: false });
    expect(byId.get(F("bash"))).toMatchObject({ locked: true });
    expect(byId.get(F("capstone"))).toMatchObject({ locked: true });
  });

  it("agrees with the learn action: learnable nodes are accepted, locked ones rejected", () => {
    const { sim, hero } = talentSim({ talents: { points: 2 } });
    const view = buildTalentsView(ctxOf(sim, hero))!;
    expect(view.nodes.find((n) => n.id === F("vigor"))!.learnable).toBe(true);
    expect(sim.dispatch("classic.learnTalent", { node: F("vigor") }, null).ok).toBe(true);
    const bash = buildTalentsView(ctxOf(sim, hero))!.nodes.find((n) => n.id === F("bash"))!;
    expect(bash.learnable).toBe(false);
    expect(sim.dispatch("classic.learnTalent", { node: F("bash") }, null).error?.code).toBe(
      "talent_locked",
    );
  });

  it("cannot reset outside town, with nothing spent or without gold", () => {
    const { sim: outside, hero: h1 } = talentSim({
      depth: 1,
      gold: 1000,
      talents: { points: 0, ranks: [{ node: F("vigor"), rank: 1 }] },
    });
    expect(buildTalentsView(ctxOf(outside, h1))!.canReset).toBe(false);
    const { sim: empty, hero: h2 } = talentSim({ gold: 1000, talents: { points: 3 } });
    expect(buildTalentsView(ctxOf(empty, h2))!.canReset).toBe(false);
    const { sim: broke, hero: h3 } = talentSim({
      gold: 0,
      talents: { points: 0, ranks: [{ node: F("vigor"), rank: 1 }] },
    });
    expect(buildTalentsView(ctxOf(broke, h3))!.canReset).toBe(false);
  });
});

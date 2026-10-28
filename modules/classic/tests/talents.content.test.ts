/**
 * Real talent content validation (wave A §3, T-talents): every tree node
 * exists and points back to its tree, requirements are in the same tree one
 * tier lower, tiers and branches are in range, one capstone per branch, every
 * class has 13-16 nodes and at least 6 skill modifiers on its own skills,
 * autoOrder covers >= 50 points with tree nodes, and the descriptions carry
 * the "{v}" total.
 */
import { describe, expect, it } from "vite-plus/test";
import { CLASSES } from "../src/content/classes.ts";
import { SKILLS } from "../src/content/skills.ts";
import { TALENT_NODES, TALENT_TREES } from "../src/content/talents.ts";
import type { SkillModifier, SkillTag, TalentNodeProto, SkillProto } from "../src/types.ts";

const FIELDS = new Set([
  "damagePct",
  "manaCostPct",
  "cooldownPct",
  "speedPct",
  "radiusPct",
  "extraProjectiles",
  "extraPierce",
  "extraBounces",
  "durationPct",
  "extraSummons",
]);
const TAGS = new Set<SkillTag>([
  "single",
  "aoe",
  "melee",
  "ranged",
  "mobility",
  "heal",
  "buff",
  "summon",
  "dot",
  "control",
  "basic",
]);

function classKeyOf(classId: string): string {
  return classId.replace("classic.", "");
}

function nodesOf(treeId: string): [string, TalentNodeProto][] {
  return Object.entries(TALENT_NODES).filter(([, n]) => n.tree === treeId);
}

/** The class skills of a tree's class, as SkillProto (missing ids are reported by the tests). */
function skillsOfClass(classId: string): SkillProto[] {
  const cls = CLASSES[classId];
  return (cls?.skills ?? [])
    .map((id) => SKILLS[id])
    .filter((s): s is SkillProto => s !== undefined);
}

/** True when a SkillModifier selector picks at least one hero skill of the class. */
function selectsClassSkill(mod: SkillModifier, classId: string): boolean {
  const own = CLASSES[classId]?.skills ?? [];
  if (mod.skill === "*") return own.length > 0;
  if (mod.skill.startsWith("tag:")) {
    const tag = mod.skill.slice(4) as SkillTag;
    return skillsOfClass(classId).some((s) => s.ai.tags.includes(tag));
  }
  return own.includes(mod.skill);
}

describe("talent trees: structure", () => {
  it("has one tree per class, keyed classic.talents.<class>", () => {
    const keys = Object.keys(CLASSES).map(classKeyOf).sort();
    const trees = Object.keys(TALENT_TREES)
      .map((id) => id.replace("classic.talents.", ""))
      .sort();
    expect(trees).toEqual(keys);
    for (const [id, tree] of Object.entries(TALENT_TREES)) {
      expect(CLASSES[tree.classId], `${id} classId`).toBeDefined();
      expect(id).toBe(`classic.talents.${classKeyOf(tree.classId)}`);
    }
  });

  for (const treeId of Object.keys(TALENT_TREES)) {
    describe(treeId, () => {
      const tree = TALENT_TREES[treeId]!;
      const nodes = nodesOf(treeId);
      const byId = new Map(nodes);

      it("has 13 to 16 nodes, three branches and tierPoints 3", () => {
        expect(nodes.length).toBeGreaterThanOrEqual(13);
        expect(nodes.length).toBeLessThanOrEqual(16);
        expect(tree.branches).toHaveLength(3);
        expect(tree.tierPoints).toBe(3);
      });

      it("lists exactly its nodes, in panel order (col, tier)", () => {
        expect([...tree.nodes].sort()).toEqual(nodes.map(([id]) => id).sort());
        const ordered = tree.nodes.map((id) => byId.get(id)!);
        for (let i = 1; i < ordered.length; i++) {
          const a = ordered[i - 1]!;
          const b = ordered[i]!;
          expect(a.col * 10 + a.tier).toBeLessThanOrEqual(b.col * 10 + b.tier);
        }
      });

      it("has tiers 0..4, columns inside the branches, maxRank 1..5 and the node id prefix", () => {
        const cls = classKeyOf(tree.classId);
        for (const [id, n] of nodes) {
          expect(id.startsWith(`classic.talent.${cls}.`), id).toBe(true);
          expect(n.tier, id).toBeGreaterThanOrEqual(0);
          expect(n.tier, id).toBeLessThanOrEqual(4);
          expect(n.col, id).toBeGreaterThanOrEqual(0);
          expect(n.col, id).toBeLessThan(tree.branches.length);
          expect(Number.isInteger(n.maxRank), id).toBe(true);
          expect(n.maxRank, id).toBeGreaterThanOrEqual(1);
          expect(n.maxRank, id).toBeLessThanOrEqual(5);
          expect(n.icon, id).toMatch(/^icon\.talent\./);
          expect(n.name.length, id).toBeGreaterThan(0);
        }
      });

      it("requires a node of the same tree at a lower tier", () => {
        for (const [id, n] of nodes) {
          if (n.requires === null) continue;
          const req = byId.get(n.requires);
          expect(req, `${id} requires ${n.requires}`).toBeDefined();
          expect(req!.tier, id).toBeLessThan(n.tier);
        }
      });

      it("has one capstone per branch (tier 4, maxRank 1)", () => {
        for (let col = 0; col < tree.branches.length; col++) {
          const caps = nodes.filter(([, n]) => n.col === col && n.tier === 4);
          expect(caps, `branch ${col}`).toHaveLength(1);
          expect(caps[0]![1].maxRank).toBe(1);
        }
      });

      it("gives every node effects, with the {v} total in the description", () => {
        for (const [id, n] of nodes) {
          const effects = n.perRank.stats.length + n.perRank.skills.length;
          expect(effects, id).toBeGreaterThan(0);
          expect(n.description, id).toContain("{v}");
          for (const m of n.perRank.stats) expect(Number.isInteger(m.value), id).toBe(true);
        }
      });

      it("has skill modifiers whose selectors and fields are valid for the class", () => {
        for (const [id, n] of nodes) {
          for (const m of n.perRank.skills) {
            expect(FIELDS.has(m.field), `${id} field ${m.field}`).toBe(true);
            expect(Number.isInteger(m.value), id).toBe(true);
            if (m.skill === "*") continue;
            if (m.skill.startsWith("tag:")) {
              expect(TAGS.has(m.skill.slice(4) as SkillTag), `${id} ${m.skill}`).toBe(true);
            }
            expect(selectsClassSkill(m, tree.classId), `${id} selects ${m.skill}`).toBe(true);
          }
        }
      });

      it("has at least 6 nodes that modify the class skills", () => {
        const modding = nodes.filter(([, n]) => n.perRank.skills.length > 0);
        expect(modding.length).toBeGreaterThanOrEqual(6);
      });

      it("autoOrder covers at least 50 points, lists tree nodes and never exceeds maxRank", () => {
        const total = tree.autoOrder.length;
        expect(total).toBeGreaterThanOrEqual(50);
        const counts = new Map<string, number>();
        for (const id of tree.autoOrder) {
          expect(byId.has(id), `autoOrder ${id}`).toBe(true);
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        for (const [id, c] of counts) expect(c, id).toBeLessThanOrEqual(byId.get(id)!.maxRank);
        const maxTotal = nodes.reduce((s, [, n]) => s + n.maxRank, 0);
        expect(maxTotal).toBeGreaterThanOrEqual(50);
      });
    });
  }
});

describe("talent trees: every class skill id resolves", () => {
  it("every SkillModifier skill of a class tree is a real skill (exact ids)", () => {
    for (const [id, n] of Object.entries(TALENT_NODES)) {
      for (const m of n.perRank.skills) {
        if (m.skill === "*" || m.skill.startsWith("tag:")) continue;
        expect(SKILLS[m.skill], `${id} -> ${m.skill}`).toBeDefined();
      }
    }
  });
});

/**
 * Achievement content validation (wave A, OWNER: T-achievements): at least 30
 * achievements, every AchievementMetric used, positive integer targets, unique
 * names and orders, logical icon ids, small gold rewards, hidden ones and
 * titles present, and the real content registry holds the same table.
 */
import { createSim, defineMode, loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { modules as classicModules } from "../src/index.ts";
import { ACHIEVEMENTS } from "../src/content/achievements.ts";
import { BALANCE } from "../src/content/balance.ts";
import { MONSTERS } from "../src/content/monsters.ts";
import { scaleMonster, xpToNext } from "../src/rules.ts";
import {
  KIND,
  type AchievementMetric,
  type AchievementProto,
  type QuestProto,
} from "../src/types.ts";

/**
 * Analytic gold a hero earns from normal kills alone on the way to level 60
 * (regular monsters' average xp, monster level = hero level, balance.ts gold
 * piles); item sales, champions and bosses only add to it.
 */
function killGoldToLevel60(): number {
  const regular = Object.values(MONSTERS).filter((m) => m.xp > 0 && m.xp < 100);
  const avgXp = regular.reduce((s, m) => s + m.xp, 0) / regular.length;
  let gold = 0;
  for (let level = 1; level < 60; level++) {
    const xpPerKill = scaleMonster({ ...regular[0]!, xp: avgXp }, level, "normal", []).xp;
    const kills = xpToNext(BALANCE, level) / xpPerKill;
    const pile = ((BALANCE.goldPerLevel[0] + BALANCE.goldPerLevel[1]) * level) / 2;
    gold += (kills * BALANCE.drops.normal.gold * pile) / 100;
  }
  return gold;
}

const ALL_METRICS: AchievementMetric[] = [
  "kills",
  "championKills",
  "uniqueKills",
  "bossKills",
  "level",
  "deepest",
  "goldEarned",
  "goldSpent",
  "itemsFound",
  "uniquesFound",
  "setItemsFound",
  "setComplete",
  "questsCompleted",
  "potionsUsed",
  "itemsCrafted",
  "gemsSocketed",
  "gambles",
  "talentPoints",
  "riftLevel",
  "riftsCompleted",
  "playMinutes",
];

const ENTRIES = Object.entries(ACHIEVEMENTS);
const PROTOS: AchievementProto[] = ENTRIES.map(([, p]) => p);

describe("classic achievement content", () => {
  it("has at least 30 achievements", () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(30);
  });

  it("uses every AchievementMetric, in more than one tier where tiers make sense", () => {
    const used = new Set(PROTOS.map((p) => p.metric));
    for (const m of ALL_METRICS) expect(used.has(m), `metric ${m}`).toBe(true);
    const kills = PROTOS.filter((p) => p.metric === "kills");
    expect(kills.length).toBeGreaterThanOrEqual(3);
  });

  it("has positive integer targets and small non-negative integer gold", () => {
    let total = 0;
    for (const [id, p] of ENTRIES) {
      expect(id.startsWith("classic.achievement.")).toBe(true);
      expect(Number.isInteger(p.target) && p.target > 0, id).toBe(true);
      expect(Number.isInteger(p.reward.gold) && p.reward.gold >= 0, id).toBe(true);
      expect(p.reward.gold, id).toBeLessThanOrEqual(5000);
      total += p.reward.gold;
    }
    expect(total).toBeGreaterThan(0);
  });

  it("keeps the gold rewards within ~2 % of what a level-60 hero earns", () => {
    const total = PROTOS.reduce((s, p) => s + p.reward.gold, 0);
    const earned = killGoldToLevel60();
    expect(earned).toBeGreaterThan(500_000);
    expect(total).toBeLessThanOrEqual(Math.ceil(earned * 0.021));
  });

  it("names, ids, orders and icons are unique and well formed", () => {
    const names = new Set(PROTOS.map((p) => p.name));
    expect(names.size).toBe(PROTOS.length);
    const orders = PROTOS.map((p) => p.order).sort((a, b) => a - b);
    expect(orders).toEqual(orders.map((_, i) => i + 1));
    for (const [id, p] of ENTRIES) {
      expect(p.icon).toBe(`icon.achievement.${id.split(".").pop()}`);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it("has hidden achievements and several titles", () => {
    expect(PROTOS.filter((p) => p.hidden).length).toBeGreaterThanOrEqual(3);
    const titles = new Set(PROTOS.map((p) => p.reward.title).filter((t): t is string => !!t));
    expect(titles.size).toBeGreaterThanOrEqual(5);
  });

  it("every questsCompleted target can be reached with the quests in the registry", () => {
    const mode = defineMode({
      id: "classic",
      name: "Classic (content)",
      description: "test",
      world: null,
      modules: ["classic.content"],
      tick: { kind: "fixed", hz: 20 },
    });
    const sim = createSim(loadMode(mode, classicModules), { seed: 1 });
    const questCount = sim.loaded.registry.all<QuestProto>(KIND.quest).length;
    expect(questCount).toBeGreaterThan(0);
    const quest = PROTOS.filter((p) => p.metric === "questsCompleted");
    expect(quest.length).toBeGreaterThan(0);
    for (const p of quest) expect(p.target, p.name).toBeLessThanOrEqual(questCount);
  });

  it("the real classic.content registry holds the same achievements", () => {
    const mode = defineMode({
      id: "classic",
      name: "Classic (content)",
      description: "test",
      world: null,
      modules: ["classic.content"],
      tick: { kind: "fixed", hz: 20 },
    });
    const sim = createSim(loadMode(mode, classicModules), { seed: 1 });
    const reg = sim.loaded.registry.all<AchievementProto>(KIND.achievement);
    expect(reg.map(([id]) => id)).toEqual(ENTRIES.map(([id]) => id).sort());
    for (const [id, p] of reg) expect(p).toEqual(ACHIEVEMENTS[id]);
  });
});

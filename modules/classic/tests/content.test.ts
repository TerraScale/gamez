/**
 * Integrity tests of module "classic.content" (data only). Loads only this
 * module (no systems) and checks that every reference resolves, that the
 * roster covers the design (classes, skills, monsters, bosses, items,
 * affixes, uniques, quests, themes), and that every number is an integer.
 */
import { defineMode, loadMode, type FrozenRegistry } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { classicContent } from "../src/content/index.ts";
import {
  BALANCE_ID,
  KIND,
  NAMES_RARE_ITEM,
  NAMES_UNIQUE_MONSTER,
  type AffixProto,
  type BalanceProto,
  type ClassProto,
  type ItemBaseProto,
  type ItemCategory,
  type MonsterModProto,
  type MonsterProto,
  type NameTableProto,
  type NpcProto,
  type QuestProto,
  type SkillProto,
  type SkillShape,
  type StatusProto,
  type ThemeProto,
  type UniqueProto,
} from "../src/types.ts";

const mode = defineMode({
  id: "classic",
  name: "Classic (content only)",
  description: "classic.content alone",
  world: null,
  modules: ["classic.content"],
  tick: { kind: "fixed", hz: 20 },
});

const loaded = loadMode(mode, [classicContent]);
const reg: FrozenRegistry = loaded.registry;

function table<T extends object>(kind: string): Record<string, Readonly<T>> {
  return Object.fromEntries(reg.all<T>(kind)) as Record<string, Readonly<T>>;
}

const classes = table<ClassProto>(KIND.class);
const skills = table<SkillProto>(KIND.skill);
const statuses = table<StatusProto>(KIND.status);
const monsters = table<MonsterProto>(KIND.monster);
const mods = table<MonsterModProto>(KIND.monsterMod);
const items = table<ItemBaseProto>(KIND.itemBase);
const affixes = table<AffixProto>(KIND.affix);
const uniques = table<UniqueProto>(KIND.unique);
const npcs = table<NpcProto>(KIND.npc);
const quests = table<QuestProto>(KIND.quest);
const themes = table<ThemeProto>(KIND.theme);
const names = table<NameTableProto>(KIND.names);
const balances = table<BalanceProto>(KIND.balance);

/** Every id a reference points at, as a list of human-readable problems. */
function missing(refs: [label: string, kind: object, id: string][]): string[] {
  return refs.filter(([, kind, id]) => !(id in kind)).map(([label, , id]) => `${label} -> ${id}`);
}

/** Recursively collects non-integer numbers (path + value). */
function badNumbers(value: unknown, path: string, out: string[]): string[] {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) out.push(`${path} = ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => badNumbers(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) badNumbers(v, `${path}.${k}`, out);
  }
  return out;
}

describe("classic.content loading", () => {
  it("loads as its own module with a stable content hash", () => {
    expect(loaded.modules.map((m) => m.id)).toEqual(["classic.content"]);
    const again = loadMode(mode, [classicContent]);
    expect(again.contentHash).toBe(loaded.contentHash);
    expect(again.registry.hash).toBe(reg.hash);
  });

  it("defines the balance prototype under BALANCE_ID", () => {
    expect(Object.keys(balances)).toEqual([BALANCE_ID]);
    const b = balances[BALANCE_ID]!;
    expect(b.levelWidth).toBe(128);
    expect(b.levelHeight).toBe(128);
    expect(b.rooms).toEqual([18, 26]);
    expect(b.roomSize).toEqual([6, 16]);
    expect(b.packs).toEqual([28, 40]);
    expect(b.maxMonstersPerLevel).toBe(300);
    expect(b.uniquePacksPerLevel).toEqual([1, 2]);
  });
});

describe("classes", () => {
  it("has the three classes", () => {
    expect(Object.keys(classes).sort()).toEqual([
      "classic.rogue",
      "classic.sorcerer",
      "classic.warrior",
    ]);
  });

  it("allocates exactly statPointsPerLevel on auto", () => {
    const perLevel = balances[BALANCE_ID]!.statPointsPerLevel;
    for (const [id, c] of Object.entries(classes)) {
      const sum = c.autoAlloc.str + c.autoAlloc.dex + c.autoAlloc.mag + c.autoAlloc.vit;
      expect(sum, id).toBe(perLevel);
    }
  });

  it("has a six-slot default bar and valid starting skills", () => {
    for (const [id, c] of Object.entries(classes)) {
      expect(c.defaultBar.length, id).toBe(6);
      expect(c.startingSkills.length, id).toBeGreaterThan(0);
      for (const s of c.startingSkills) expect(c.skills, id).toContain(s);
      expect(c.defaultBar, id).toContain("classic.skill.attack");
    }
  });

  it("references only existing ids", () => {
    const problems: string[] = [];
    for (const [id, c] of Object.entries(classes)) {
      problems.push(
        ...missing(c.skills.map((s): [string, object, string] => [`${id}.skills`, skills, s])),
        ...missing(
          c.startingSkills.map((s): [string, object, string] => [
            `${id}.startingSkills`,
            skills,
            s,
          ]),
        ),
        ...missing(
          c.defaultBar
            .filter((s): s is string => s !== null)
            .map((s): [string, object, string] => [`${id}.defaultBar`, skills, s]),
        ),
        ...missing(
          c.autoSkillOrder.map((s): [string, object, string] => [
            `${id}.autoSkillOrder`,
            skills,
            s,
          ]),
        ),
        ...missing(
          c.starterItems.map((s): [string, object, string] => [`${id}.starterItems`, items, s]),
        ),
        ...missing(
          c.starterPotions.map((p): [string, object, string] => [
            `${id}.starterPotions`,
            items,
            p.base,
          ]),
        ),
      );
      expect(c.starterPotions.every((p) => p.count > 0)).toBe(true);
      expect(c.moveSpeed).toBe(51);
    }
    expect(problems).toEqual([]);
  });
});

describe("skills", () => {
  const hero = Object.entries(skills).filter(([, s]) => s.users === "hero");

  it("has at least 15 hero skills, all classic.skill.*", () => {
    expect(hero.length).toBeGreaterThanOrEqual(15);
    for (const [id] of hero) expect(id.startsWith("classic.skill.")).toBe(true);
    for (const [id, s] of Object.entries(skills)) {
      if (s.users === "monster") expect(id.startsWith("classic.mskill.")).toBe(true);
    }
  });

  it("covers the shapes used by the hero roster", () => {
    const used = new Set<SkillShape>(hero.map(([, s]) => s.shape));
    const wanted: SkillShape[] = [
      "melee",
      "arc",
      "projectile",
      "nova",
      "chain",
      "dash",
      "blink",
      "summon",
      "self",
      "pulse",
    ];
    for (const shape of wanted) expect(used.has(shape), shape).toBe(true);
  });

  it("keeps hitTick within castTicks and valid speed stats", () => {
    for (const [id, s] of Object.entries(skills)) {
      expect(s.hitTick, id).toBeLessThanOrEqual(s.castTicks);
      expect(["attack", "cast"]).toContain(s.speedStat);
    }
  });

  it("has the basic attack as the first melee skill of each class", () => {
    const attack = skills["classic.skill.attack"]!;
    expect(attack.shape).toBe("melee");
    expect(attack.range).toBe(0);
    expect(attack.ai.tags).toEqual(["basic", "single"]);
    expect(attack.weaponPct).toBe(100);
  });

  it("references only existing statuses, monsters and monster skills", () => {
    const problems: string[] = [];
    for (const [id, s] of Object.entries(skills)) {
      if (s.status) problems.push(...missing([[`${id}.status`, statuses, s.status.id]]));
      if (s.buff) problems.push(...missing([[`${id}.buff`, statuses, s.buff.status]]));
      if (s.summon) problems.push(...missing([[`${id}.summon`, monsters, s.summon.monster]]));
    }
    for (const [id, m] of Object.entries(monsters)) {
      problems.push(
        ...missing(m.skills.map((s): [string, object, string] => [`${id}.skills`, skills, s])),
      );
      if (m.onDeathSkill) {
        problems.push(...missing([[`${id}.onDeathSkill`, skills, m.onDeathSkill]]));
      }
    }
    expect(problems).toEqual([]);
  });

  it("gives every hero skill a non-empty name and icon", () => {
    for (const [id, s] of hero) {
      expect(s.name.length, id).toBeGreaterThan(0);
      expect(s.icon, id).toMatch(/^icon\.skill\./);
    }
  });
});

describe("statuses", () => {
  it("covers slow, stun, dot and buff kinds", () => {
    const kinds = new Set(Object.values(statuses).map((s) => s.kind));
    expect(kinds).toEqual(new Set(["slow", "stun", "dot", "buff"]));
    expect(Object.keys(statuses).sort()).toEqual([
      "classic.status.burn",
      "classic.status.chill",
      "classic.status.poison",
      "classic.status.rally",
      "classic.status.stun",
    ]);
  });
});

describe("monsters", () => {
  const regular = Object.entries(monsters).filter(([, m]) => m.boss === undefined);
  const bosses = Object.entries(monsters).filter(([, m]) => m.boss !== undefined);

  it("has at least 10 non-boss monsters covering the behaviours", () => {
    const population = regular.filter(([, m]) => m.themes.length > 0);
    expect(population.length).toBeGreaterThanOrEqual(10);
    const behaviours = new Set(regular.map(([, m]) => m.behaviour));
    for (const b of [
      "rusher",
      "swarm",
      "archer",
      "caster",
      "tank",
      "charger",
      "summoner",
      "exploder",
      "totem",
    ] as const) {
      expect(behaviours.has(b), b).toBe(true);
    }
  });

  it("has four bosses at depths 4, 8, 12 and 16 with no themes", () => {
    expect(bosses.map(([, m]) => m.boss!.depth).sort((a, b) => a - b)).toEqual([4, 8, 12, 16]);
    for (const [id, m] of bosses) {
      expect(m.behaviour, id).toBe("boss");
      expect(m.themes, id).toEqual([]);
      expect(m.minDepth, id).toBe(m.boss!.depth);
      expect(id.startsWith("classic.monster.boss_"), id).toBe(true);
    }
  });

  it("references existing themes, skills and boss minions", () => {
    const problems: string[] = [];
    for (const [id, m] of Object.entries(monsters)) {
      problems.push(
        ...missing(m.themes.map((t): [string, object, string] => [`${id}.themes`, themes, t])),
      );
      if (m.boss) problems.push(...missing([[`${id}.boss.minions`, monsters, m.boss.minions]]));
    }
    for (const [id, t] of Object.entries(themes)) {
      problems.push(
        ...missing(
          t.monsters.map((m): [string, object, string] => [`${id}.monsters`, monsters, m]),
        ),
      );
    }
    expect(problems).toEqual([]);
  });

  it("has a distinct tint per monster and valid pack sizes", () => {
    const tints = Object.values(monsters).map((m) => m.tint);
    expect(new Set(tints).size).toBe(tints.length);
    for (const [id, m] of Object.entries(monsters)) {
      expect(m.packSize[0], id).toBeLessThanOrEqual(m.packSize[1]);
      expect(m.appearance, id).toBe(`unit.monster.${id.slice("classic.monster.".length)}`);
    }
  });
});

describe("monster mods", () => {
  it("has nine mods and valid references", () => {
    expect(Object.keys(mods).length).toBeGreaterThanOrEqual(9);
    const problems: string[] = [];
    for (const [id, m] of Object.entries(mods)) {
      if (m.onDeathSkill)
        problems.push(...missing([[`${id}.onDeathSkill`, skills, m.onDeathSkill]]));
      if (m.onHitStatus)
        problems.push(...missing([[`${id}.onHitStatus`, statuses, m.onHitStatus.id]]));
    }
    expect(problems).toEqual([]);
    expect(mods["classic.mod.volley"]!.minDepth).toBe(3);
  });
});

describe("items", () => {
  const all: ItemCategory[] = [
    "weapon",
    "shield",
    "helm",
    "armor",
    "gloves",
    "boots",
    "ring",
    "amulet",
    "potion",
  ];

  it("has every item category", () => {
    const present = new Set(Object.values(items).map((i) => i.category));
    for (const c of all) expect(present.has(c), c).toBe(true);
  });

  it("names the ids the design asks for", () => {
    for (const id of [
      "classic.item.short_sword",
      "classic.item.buckler",
      "classic.item.leather_cap",
      "classic.item.hunting_bow",
      "classic.item.padded_vest",
      "classic.item.gnarled_staff",
      "classic.item.potion_life_1",
      "classic.item.potion_life_2",
      "classic.item.potion_life_3",
      "classic.item.potion_life_4",
      "classic.item.potion_mana_1",
      "classic.item.potion_mana_2",
      "classic.item.potion_mana_3",
      "classic.item.potion_rejuv",
    ]) {
      expect(items[id], id).toBeDefined();
    }
  });

  it("has weapon ranges and attack ticks, and ranged weapons with projectiles", () => {
    for (const [id, i] of Object.entries(items)) {
      if (i.category !== "weapon") continue;
      expect(i.attackTicks, id).toBeGreaterThan(0);
      expect(i.range, id).toBeGreaterThan(0);
      expect(i.dmgMin!, id).toBeLessThanOrEqual(i.dmgMax!);
      if (i.weaponClass === "bow" || i.weaponClass === "wand") {
        expect(i.projectile, id).toMatch(/^fx\./);
        expect(i.range!, id).toBeGreaterThan(400);
      }
    }
  });

  it("spans item levels up to depth 16 (ilvl >= 22)", () => {
    const maxIlvl = Math.max(...Object.values(items).map((i) => i.ilvl));
    expect(maxIlvl).toBeGreaterThanOrEqual(22);
  });

  it("has potions with a potion block and no slots", () => {
    for (const [id, i] of Object.entries(items)) {
      if (i.category === "potion") {
        expect(i.potion, id).toBeDefined();
        expect(i.slots, id).toEqual([]);
      }
    }
  });

  it("references only existing item bases from uniques, quests and vendors", () => {
    const problems = missing(
      Object.entries(uniques).map(([id, u]): [string, object, string] => [
        `${id}.base`,
        items,
        u.base,
      ]),
    );
    const potionIds = Object.entries(npcs).flatMap(([id, n]) =>
      (n.sells?.potions ?? []).map((p): [string, object, string] => [`${id}.potions`, items, p]),
    );
    problems.push(...missing(potionIds));
    expect(problems).toEqual([]);
  });
});

describe("affixes", () => {
  it("has at least 40 tiers of both kinds", () => {
    const list = Object.values(affixes);
    expect(list.length).toBeGreaterThanOrEqual(40);
    expect(list.some((a) => a.kind === "prefix")).toBe(true);
    expect(list.some((a) => a.kind === "suffix")).toBe(true);
  });

  it("covers the stats of the design", () => {
    const stats = new Set(Object.values(affixes).map((a) => a.stat));
    for (const s of [
      "life",
      "mana",
      "str",
      "dex",
      "mag",
      "vit",
      "armor",
      "dmgPct",
      "fireDmg",
      "attackSpeed",
      "castSpeed",
      "critPct",
      "resFire",
      "resCold",
      "resLightning",
      "resPoison",
      "lifeSteal",
      "manaSteal",
      "lifeRegen",
      "magicFind",
      "goldFind",
      "moveSpeed",
      "allSkills",
      "blockPct",
      "thorns",
      "lightRadius",
      "potionPct",
    ]) {
      expect(stats.has(s as AffixProto["stat"]), s).toBe(true);
    }
  });

  it("has sane ranges and ilvl gates", () => {
    for (const [id, a] of Object.entries(affixes)) {
      expect(a.min, id).toBeLessThanOrEqual(a.max);
      expect(a.categories.length, id).toBeGreaterThan(0);
      expect(id.startsWith(`classic.affix.${a.stat}.`), id).toBe(true);
    }
  });
});

describe("uniques, quests, npcs and themes", () => {
  it("has at least 12 uniques with flavour text and fitting ilvl", () => {
    const list = Object.entries(uniques);
    expect(list.length).toBeGreaterThanOrEqual(12);
    for (const [id, u] of list) {
      expect(u.flavor.length, id).toBeGreaterThan(0);
      expect(u.ilvl, id).toBeGreaterThanOrEqual(items[u.base]!.ilvl);
    }
  });

  it("has at least 8 quests with valid givers, targets and chains", () => {
    const list = Object.entries(quests);
    expect(list.length).toBeGreaterThanOrEqual(8);
    const problems: string[] = [];
    for (const [id, q] of list) {
      problems.push(...missing([[`${id}.giver`, npcs, q.giver]]));
      if (q.kind === "killBoss" || (q.kind === "killMonsters" && q.target !== "*")) {
        problems.push(...missing([[`${id}.target`, monsters, q.target]]));
      }
      if (q.after !== "") problems.push(...missing([[`${id}.after`, quests, q.after]]));
    }
    expect(problems).toEqual([]);
    expect(list.every(([, q]) => q.giver === "classic.npc.captain_hale")).toBe(true);
  });

  it("has five town NPCs with the design roles", () => {
    expect(Object.keys(npcs).sort()).toEqual([
      "classic.npc.brannoc",
      "classic.npc.captain_hale",
      "classic.npc.maren",
      "classic.npc.old_pell",
      "classic.npc.ysolde",
    ]);
    expect(npcs["classic.npc.brannoc"]!.sells).toEqual({
      categories: ["weapon", "shield", "helm", "armor", "gloves", "boots", "ring", "amulet"],
      count: 12,
      potions: [],
      tpScroll: false,
    });
    expect(npcs["classic.npc.ysolde"]!.sells!.tpScroll).toBe(true);
    expect(npcs["classic.npc.ysolde"]!.sells!.potions.length).toBe(8);
    expect(npcs["classic.npc.old_pell"]!.buyPct).toBe(10);
    expect(Object.values(npcs).filter((n) => n.buyPct > 0).length).toBe(1);
  });

  it("has four dungeon themes with tiers 0..3 once each, plus the town", () => {
    const dungeon = Object.entries(themes).filter(([id]) => id !== "classic.theme.town");
    expect(dungeon.map(([, t]) => t.tier).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(themes["classic.theme.town"]!.tier).toBe(0);
    expect(themes["classic.theme.town"]!.monsters).toEqual([]);
    for (const [id, t] of dungeon) {
      expect(t.monsters.length, id).toBeGreaterThan(0);
      expect(t.floor.length, id).toBeGreaterThan(0);
    }
  });

  it("has name tables of at least 20 entries", () => {
    for (const key of [NAMES_UNIQUE_MONSTER, NAMES_RARE_ITEM]) {
      expect(names[key]!.first.length, key).toBeGreaterThanOrEqual(20);
      expect(names[key]!.second.length, key).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("numbers", () => {
  it("keeps every numeric field a finite integer in every prototype", () => {
    const bad: string[] = [];
    for (const kind of reg.kinds()) {
      for (const [id, proto] of reg.all<object>(kind)) badNumbers(proto, `${kind}:${id}`, bad);
    }
    expect(bad).toEqual([]);
  });
});

describe("content hash", () => {
  it("is identical across two loads and pinned", () => {
    expect(reg.hash).toBe(loadMode(mode, [classicContent]).registry.hash);
    expect(reg.hash).toBe("15f3259875d8a384");
  });
});

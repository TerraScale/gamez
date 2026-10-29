/**
 * classic.combat with a party (docs/design/party.md §6.5, §7.1): no friendly
 * fire on any shape (nova, arc, chain, projectile, the resolve backstop),
 * heals with SkillProto.heal.allyRadius, isHeroSide for every member and
 * their summons, and hero deaths that stay on the field.
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type GameEvent,
  type LoadedMode,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf, pushHit } from "../src/bus.ts";
import { AreaTag, CastOrder, Dead, Faction, Life, Mana, Pos, Summoned } from "../src/components.ts";
import { tileCenter, tiles } from "../src/fixed.ts";
import { modules as classicModules } from "../src/index.ts";
import { KIND, type SkillProto } from "../src/types.ts";
import { isHeroSide } from "../src/combat/common.ts";
import { testContent } from "./support/content.ts";
import {
  ensureResources,
  spawnTestHero,
  spawnTestMonster,
  spawnTestParty,
  useOpenMap,
  type TestHeroOptions,
} from "./support/harness.ts";

const sk = (
  p: Partial<SkillProto> & Pick<SkillProto, "name" | "shape" | "target">,
): SkillProto => ({
  description: p.name,
  icon: "icon.skill.test",
  users: "hero",
  reqLevel: 1,
  maxRank: 20,
  range: 0,
  manaCost: 0,
  manaPerRank: 0,
  cooldown: 0,
  castTicks: 10,
  hitTick: 5,
  speedStat: "attack",
  weaponPct: 0,
  weaponPctPerRank: 0,
  damage: null,
  scaling: null,
  canMiss: false,
  effect: "fx.test",
  ai: { tags: ["single"], priority: 1 },
  ...p,
});

const flat = (element: "phys" | "lightning", n: number) => ({
  element,
  min: n,
  max: n,
  minPerRank: 0,
  maxPerRank: 0,
});

/** Party-test skills, plus Mend made party-aware like classic.party patches classic.skill.mend. */
const partyCombatExtras = defineModule({
  id: "test.partyCombat",
  version: "0.0.1",
  deps: ["test.content"],
  data(reg) {
    reg.define(
      KIND.skill,
      "test.skill.arc",
      sk({
        name: "Arc",
        shape: "arc",
        target: "enemy",
        range: tiles(2),
        arc: 16,
        damage: flat("phys", 10),
      }),
    );
    reg.define(
      KIND.skill,
      "test.skill.chain",
      sk({
        name: "Chain",
        shape: "chain",
        target: "enemy",
        range: tiles(9),
        damage: flat("lightning", 10),
        chain: { bounces: 3, range: tiles(4), falloffPct: 50 },
      }),
    );
  },
  dataUpdates(reg) {
    reg.patch<SkillProto>(KIND.skill, "test.skill.mend", (s) => {
      if (s.heal) s.heal.allyRadius = tiles(5);
    });
  },
});

let cache: LoadedMode | undefined;
function loaded(): LoadedMode {
  cache ??= loadMode(
    defineMode({
      id: "classic",
      name: "Classic (party combat test)",
      description: "test",
      world: null,
      modules: ["classic.core", "classic.combat", "test.content", "test.partyCombat"],
      tick: { kind: "fixed", hz: 20 },
    }),
    [...classicModules, testContent, partyCombatExtras],
  );
  return cache;
}

function newSim(seed = 1): Sim {
  const sim = createSim(loaded(), { seed });
  ensureResources(sim.world);
  useOpenMap(sim, 1, 32);
  return sim;
}

const SKILLS = [
  "test.skill.arc",
  "test.skill.bolt",
  "test.skill.chain",
  "test.skill.mend",
  "test.skill.nova",
  "test.skill.strike",
].map((skill) => ({ skill, rank: 1 }));

function party(sim: Sim, at: [number, number][], o: TestHeroOptions = {}): Entity[] {
  return spawnTestParty(
    sim.world,
    at.map(([x, y]) => ({ x, y, life: 300, mana: 200, skills: SKILLS, ...o })),
  );
}

function hp(sim: Sim, e: Entity): number {
  return sim.world.read(e, Life).hp;
}

function order(sim: Sim, caster: Entity, skill: string, target: Entity): void {
  const p = target !== 0 ? sim.world.read(target, Pos) : sim.world.read(caster, Pos);
  sim.world.add(caster, CastOrder, { skill, target, x: p.x, y: p.y });
}

function of(events: GameEvent[], type: string): GameEvent[] {
  return events.filter((e) => e.type === type);
}

describe("no friendly fire", () => {
  it("a nova next to allies hurts the monster only", () => {
    const sim = newSim();
    const [a, b, c] = party(sim, [
      [10, 10],
      [11, 10],
      [10, 11],
    ]) as [Entity, Entity, Entity];
    const m = spawnTestMonster(sim.world, { x: 11, y: 11, life: 500 });
    order(sim, a, "test.skill.nova", 0);
    const ev = sim.step(8);
    expect(hp(sim, m)).toBeLessThan(500);
    expect(hp(sim, b)).toBe(300);
    expect(hp(sim, c)).toBe(300);
    for (const h of of(ev, "classic.hit")) expect(h.target).toBe(m);
  });

  it("arc, chain and bolt never hit party members", () => {
    const sim = newSim();
    const [a, b, c] = party(sim, [
      [10, 10],
      [11, 10],
      [12, 10],
    ]) as [Entity, Entity, Entity];
    const m = spawnTestMonster(sim.world, { x: 11, y: 11, life: 900 });
    const m2 = spawnTestMonster(sim.world, { x: 13, y: 11, life: 900 });
    const ev: GameEvent[] = [];
    order(sim, a, "test.skill.arc", m);
    ev.push(...sim.step(12));
    order(sim, a, "test.skill.chain", m);
    ev.push(...sim.step(12));
    // A bolt fired straight through the allies' tiles toward the far monster.
    sim.world.add(a, CastOrder, {
      skill: "test.skill.bolt",
      target: 0,
      x: tileCenter(16),
      y: tileCenter(10),
    });
    ev.push(...sim.step(30));
    expect(hp(sim, b)).toBe(300);
    expect(hp(sim, c)).toBe(300);
    const targets = new Set(of(ev, "classic.hit").map((h) => h.target));
    expect(targets.has(b) || targets.has(c)).toBe(false);
    expect(targets.has(m)).toBe(true);
    expect(hp(sim, m) + hp(sim, m2)).toBeLessThan(1800);
  });

  it("drops hero-side hits on hero-team units before any roll (backstop)", () => {
    const sim = newSim();
    const [a, b] = party(sim, [
      [10, 10],
      [11, 10],
    ]) as [Entity, Entity];
    // A follower's summon is hero-side too.
    const pet = spawnTestMonster(sim.world, { x: 12, y: 12, life: 50 });
    sim.world.add(pet, Summoned, { owner: b, until: 0 });
    sim.world.update(pet, Life, { hp: 50 });
    const hit = (source: Entity, target: Entity) =>
      pushHit(sim.world, {
        source,
        target,
        skill: "",
        damage: { phys: 50, fire: 0, cold: 0, lightning: 0, poison: 0 },
        canMiss: false,
        crit: false,
        dot: false,
        statuses: [],
        knockback: 0,
      });
    // Make the summon hero-team like a real hero summon.
    sim.world.add(pet, Faction, { team: "hero" });
    hit(a, b);
    hit(b, a);
    hit(pet, a);
    const ev = sim.step(1);
    expect(hp(sim, a)).toBe(300);
    expect(hp(sim, b)).toBe(300);
    expect(of(ev, "classic.hit")).toHaveLength(0);
    expect(busOf(sim.world).hits).toHaveLength(0);
  });
});

describe("party heals", () => {
  it("Mend with allyRadius heals allies in radius, not the ones outside", () => {
    const sim = newSim();
    const [a, b, c] = party(sim, [
      [10, 10],
      [13, 10],
      [20, 10],
    ]) as [Entity, Entity, Entity];
    const m = spawnTestMonster(sim.world, { x: 14, y: 14, life: 100, awake: false });
    sim.world.update(m, Life, { hp: 40 });
    for (const h of [a, b, c]) sim.world.update(h, Life, { hp: 100 });
    order(sim, a, "test.skill.mend", 0);
    const ev = sim.step(10);
    // pct 25 of 300 + 10 = 85 for the caster and every ally in 5 tiles.
    expect(hp(sim, a)).toBe(185);
    expect(hp(sim, b)).toBe(185);
    expect(hp(sim, c)).toBe(100);
    expect(hp(sim, m)).toBe(40);
    const heals = of(ev, "classic.heal");
    expect(heals.map((h) => h.target).sort((x, y) => (x as number) - (y as number))).toEqual([
      a,
      b,
    ]);
    expect(sim.world.read(a, Mana).mp).toBeLessThan(200);
  });

  it("a solo hero's Mend heals only itself", () => {
    const sim = newSim();
    const a = spawnTestHero(sim.world, { x: 10, y: 10, life: 300, skills: SKILLS });
    sim.world.update(a, Life, { hp: 100 });
    order(sim, a, "test.skill.mend", 0);
    const ev = sim.step(10);
    expect(hp(sim, a)).toBe(185);
    expect(of(ev, "classic.heal")).toHaveLength(1);
  });

  it("does not heal downed members", () => {
    const sim = newSim();
    const [a, b] = party(sim, [
      [10, 10],
      [11, 10],
    ]) as [Entity, Entity];
    sim.world.add(b, Dead, { at: 0, killer: 0 });
    sim.world.update(b, Life, { hp: 0 });
    sim.world.update(a, Life, { hp: 100 });
    order(sim, a, "test.skill.mend", 0);
    sim.step(10);
    expect(hp(sim, b)).toBe(0);
  });
});

describe("hero side", () => {
  it("counts every member and the summons of any member", () => {
    const sim = newSim();
    const [a, b, c] = party(sim, [
      [10, 10],
      [11, 10],
      [12, 10],
    ]) as [Entity, Entity, Entity];
    const pet = spawnTestMonster(sim.world, { x: 15, y: 15 });
    sim.world.add(pet, Summoned, { owner: c, until: 0 });
    const stray = spawnTestMonster(sim.world, { x: 16, y: 15 });
    sim.world.add(stray, Summoned, { owner: 9999, until: 0 });
    const m = spawnTestMonster(sim.world, { x: 17, y: 15 });
    expect(isHeroSide(sim.world, a)).toBe(true);
    expect(isHeroSide(sim.world, b)).toBe(true);
    expect(isHeroSide(sim.world, c)).toBe(true);
    expect(isHeroSide(sim.world, pet)).toBe(true);
    expect(isHeroSide(sim.world, stray)).toBe(false);
    expect(isHeroSide(sim.world, m)).toBe(false);
    expect(isHeroSide(sim.world, 0)).toBe(false);
  });

  it("a follower's death is a hero death that stays on the field", () => {
    const sim = newSim();
    const [, b] = party(sim, [
      [10, 10],
      [11, 10],
    ]) as [Entity, Entity];
    sim.world.update(b, Life, { hp: 5 });
    const m = spawnTestMonster(sim.world, { x: 12, y: 10, life: 50 });
    pushHit(sim.world, {
      source: m,
      target: b,
      skill: "",
      damage: { phys: 100, fire: 0, cold: 0, lightning: 0, poison: 0 },
      canMiss: false,
      crit: false,
      dot: false,
      statuses: [],
      knockback: 0,
    });
    const ev = sim.step(1);
    expect(sim.world.has(b, Dead)).toBe(true);
    const death = of(ev, "classic.death")[0]!;
    expect(death).toMatchObject({ entity: b, isHero: true, hero: b });
    const hit = of(ev, "classic.hit")[0]!;
    expect(hit).toMatchObject({ target: b, heroHit: true, byHero: false, hero: b });
    sim.step(100);
    expect(sim.world.exists(b)).toBe(true);
    expect(sim.world.read(b, AreaTag).depth).toBe(1);
  });
});

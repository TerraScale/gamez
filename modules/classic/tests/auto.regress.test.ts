/**
 * Regression tests for the phase 2a playtest findings, on the real content
 * with every module loaded:
 * - town ping-pong livelocks (restock with too little gold, full stash),
 * - the progress watchdog (travel loops, kill droughts),
 * - bosses: hunted once ready, beaten by the auto hero, summons at 66/33 %,
 *   a rotating skill set (no stun lock), wounds kept across level re-entry,
 * - tank slams as every 4th attack, summoners only raise in reach,
 * - auto gear keeps the class's weapon style.
 */
import { createSim, loadMode, type Entity, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { pushCommand, pushSpawn, pushTransition } from "../src/bus.ts";
import {
  Ai,
  AreaTag,
  Attributes,
  AutoState,
  Belt,
  Dead,
  Equipment,
  Inventory,
  Level,
  Life,
  Monster,
  Npc,
  Pos,
  Supplies,
  Wallet,
} from "../src/components.ts";
import { BALANCE } from "../src/content/balance.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { placeNear } from "../src/monsters/spawn.ts";
import { areaOf, dungeonOf, heroOf, RES, stashOf, type StashState } from "../src/resources.ts";
import { bossPhase, monsterLevel, xpAtLevel } from "../src/rules.ts";
import { gridOf } from "../src/spatial.ts";
import type { ItemInstance } from "../src/types.ts";
import { getAreaMap } from "../src/world/maps.ts";

const loaded = loadMode(mode, modules);
const MIN = 1200;

function start(classId: string, seed: number, control: "auto" | "manual" = "auto"): Sim {
  const sim = createSim(loaded, { seed });
  expect(sim.dispatch("classic.newHero", { classId, name: "Tester" }, null).ok).toBe(true);
  expect(sim.dispatch("classic.setControl", { mode: control }, null).ok).toBe(true);
  return sim;
}

function play(sim: Sim, ticks: number): ClassicEvent[] {
  const out: ClassicEvent[] = [];
  for (let i = 0; i < ticks; i++)
    for (const e of sim.step(1) as GameEvent[]) out.push(e as ClassicEvent);
  return out;
}

function ofType<T extends ClassicEvent["type"]>(
  ev: readonly ClassicEvent[],
  type: T,
): Extract<ClassicEvent, { type: T }>[] {
  return ev.filter((e): e is Extract<ClassicEvent, { type: T }> => e.type === type);
}

function heroKills(ev: readonly ClassicEvent[], hero: Entity): number {
  return ofType(ev, "classic.death").filter((e) => !e.isHero && e.killer === hero).length;
}

function item(uid: number, base: string, rarity: ItemInstance["rarity"]): ItemInstance {
  return { uid, base, rarity, ilvl: 1, name: `Test ${uid}`, mods: [], affixes: [], value: 10 };
}

function liveBoss(sim: Sim): Entity {
  for (const e of sim.world.query(Monster, AreaTag)) {
    if (sim.world.has(e, Dead)) continue;
    if (sim.world.read(e, Monster).rarity === "boss") return e;
  }
  return 0;
}

/** Moves the hero onto a walkable tile next to (x, y) (sub) in the current area. */
function teleportHero(sim: Sim, hero: Entity, x: number, y: number): void {
  const at = placeNear(getAreaMap(sim.world, sim.loaded.registry), x, y);
  sim.world.update(hero, Pos, at);
  gridOf(sim.world).move(hero, at.x, at.y);
}

/** Grants XP up to `level`, gold and a full belt, then sends the hero to `depth`. */
function readyHero(sim: Sim, level: number, depth: number): Entity {
  const hero = heroOf(sim.world);
  pushCommand(sim.world, { op: "grantXp", amount: xpAtLevel(BALANCE, level), reason: "test" });
  pushCommand(sim.world, { op: "grantGold", amount: 2000, reason: "test" });
  sim.step(40);
  pushTransition(sim.world, { to: depth, via: "stairsDown" });
  sim.step(1);
  const belt = sim.world.read(hero, Belt);
  sim.world.update(hero, Belt, {
    slots: belt.slots.map(() => ({ base: "classic.item.potion_life_2", count: 5 })),
  });
  sim.world.update(hero, Supplies, { tpScrolls: 5 });
  return hero;
}

describe("town trips never livelock", () => {
  it("restocks with too little gold for the level's potion tier, without a ping-pong", () => {
    // Finding: L12, no life potion, 130 gold, no scroll -> 5,764 area changes and no kills.
    // Also covers the walk to the level's waypoint, which used to slide on a wall corner
    // forever (direct steering with a thin line of sight; slides now count as blocked).
    const sim = start("classic.warrior", 5);
    sim.step(400);
    expect(areaOf(sim.world).depth).toBeGreaterThan(0);
    const hero = heroOf(sim.world);
    sim.world.update(hero, Level, { level: 12 });
    const belt = sim.world.read(hero, Belt);
    sim.world.update(hero, Belt, { slots: belt.slots.map(() => ({ base: null, count: 0 })) });
    sim.world.update(hero, Wallet, { gold: 130 });
    sim.world.update(hero, Supplies, { tpScrolls: 0 });
    // The trip cooldown from the first town visit is over; floor potions do not count.
    sim.world.update(hero, AutoState, { tripAt: 0 });
    const cfg = { pickupPotions: false };
    expect(sim.dispatch("classic.setAutoConfig", { config: cfg }, null).ok).toBe(true);

    const ev = play(sim, 4 * MIN);
    const changes = ofType(ev, "classic.area.changed").length;
    expect(changes).toBeLessThanOrEqual(6);
    // The visit bought life potions (potions come before scrolls with an empty belt).
    expect(ofType(ev, "classic.vendor.bought").some((e) => e.name.includes("Life Potion"))).toBe(
      true,
    );
    expect(heroKills(ev, hero)).toBeGreaterThan(10);
  }, 120_000);

  it("sells kept rarities once the stash is full, so a bag-full trip frees the bag", () => {
    // Finding: full stash -> 'toTown bag full' / 'toDungeon' every few ticks with no kills.
    const sim = start("classic.warrior", 99);
    sim.step(400);
    const hero = heroOf(sim.world);
    const stash = stashOf(sim.world);
    const filler: ItemInstance[] = [];
    for (let i = stash.items.length; i < BALANCE.stashSize; i++)
      filler.push(item(800_000 + i, "classic.item.iron_ring", "rare"));
    sim.world.setResource<StashState>(RES.stash, { ...stash, items: [...stash.items, ...filler] });
    const inv = sim.world.read(hero, Inventory);
    const bag: { x: number; y: number; item: ItemInstance }[] = [];
    for (let y = 0; y < inv.rows; y++)
      for (let x = 0; x < inv.cols; x++)
        bag.push({
          x,
          y,
          item: item(900_000 + y * inv.cols + x, "classic.item.iron_ring", "rare"),
        });
    sim.world.update(hero, Inventory, { items: bag });

    const ev = play(sim, 5 * MIN);
    expect(ofType(ev, "classic.auto.notice").some((e) => e.code === "stash_full")).toBe(true);
    expect(ofType(ev, "classic.vendor.sold").length).toBeGreaterThanOrEqual(30);
    expect(ofType(ev, "classic.area.changed").length).toBeLessThanOrEqual(8);
    expect(sim.world.read(hero, Inventory).items.length).toBeLessThan(30);
    expect(heroKills(ev, hero)).toBeGreaterThan(10);
  }, 120_000);
});

describe("progress watchdog", () => {
  it("flags a travel loop (area changes without kills) and stops voluntary town trips", () => {
    const sim = start("classic.warrior", 3);
    sim.step(400);
    const hero = heroOf(sim.world);
    sim.world.update(hero, AutoState, { hops: 6 });
    const ev = play(sim, 2);
    expect(ofType(ev, "classic.auto.notice").map((e) => e.code)).toContain("travel_loop");
    const st = sim.world.read(hero, AutoState);
    expect(st.stallUntil).toBeGreaterThan(sim.tick);
    expect(st.hops).toBe(0);
  });

  it("flags a kill drought in a dungeon and heads for a fresh level", () => {
    const sim = start("classic.warrior", 3);
    sim.step(400);
    const hero = heroOf(sim.world);
    const killsSeen = sim.world.read(hero, AutoState).killsSeen;
    sim.world.update(hero, AutoState, { killAt: sim.tick - 2 * MIN - 5, killsSeen });
    const ev = play(sim, 2);
    expect(ofType(ev, "classic.auto.notice").map((e) => e.code)).toContain("no_kills");
    expect(sim.world.read(hero, AutoState).stallUntil).toBeGreaterThan(sim.tick);
  });
});

describe("bosses", () => {
  it("the auto sorcerer at level 12 finds and kills the depth-4 boss within 8 minutes", () => {
    // Finding: 0 boss kills in 9.5 h of sim; the boss stun-locked melee heroes.
    const sim = start("classic.sorcerer", 1);
    readyHero(sim, 12, 4);
    expect(liveBoss(sim)).not.toBe(0);
    const ev = play(sim, 8 * MIN);
    expect(ofType(ev, "classic.boss.killed").map((e) => e.depth)).toContain(4);
    expect(dungeonOf(sim.world).bossesKilled).toContain(4);
  }, 120_000);

  it("a hero not ready for the boss leaves its depth without a stairs ping-pong", () => {
    // Playtest: arriving on depth 4 under-levelled bounced 3 <-> 4 every tick (a new level each time).
    const sim = start("classic.rogue", 99);
    readyHero(sim, 5, 4);
    const ticks: number[] = [];
    for (let i = 0; i < MIN; i++)
      for (const e of sim.step(1) as GameEvent[])
        if ((e as ClassicEvent).type === "classic.area.changed") ticks.push(sim.tick);
    expect(ticks.length).toBeLessThanOrEqual(2);
    // Never two transitions in a row: the hero explores the level it arrives on first.
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBeGreaterThan(200);
  }, 60_000);

  it("summons once at 66 % and once at 33 % life, and slams on a cooldown", () => {
    const sim = start("classic.warrior", 2, "manual");
    const hero = readyHero(sim, 10, 4);
    sim.world.update(hero, Attributes, { vit: 500 });
    sim.step(2);
    sim.world.update(hero, Life, { hp: sim.world.read(hero, Life).max });
    const boss = liveBoss(sim);
    const bp = sim.world.read(boss, Pos);
    teleportHero(sim, hero, bp.x + 256, bp.y);
    const life = sim.world.read(boss, Life);
    sim.world.update(boss, Life, { hp: Math.floor((life.max * 60) / 100) });
    sim.world.update(boss, Ai, { state: "chase", target: hero });

    const casts = (ev: readonly ClassicEvent[], skill: string): number =>
      ofType(ev, "classic.cast").filter((e) => e.caster === boss && e.skill === skill).length;
    const first = play(sim, 200);
    expect(casts(first, "classic.mskill.raise")).toBe(1);
    expect(sim.world.read(boss, Ai).count).toBe(1);
    // No second summon while still above 33 %.
    const quiet = play(sim, 200);
    expect(casts(quiet, "classic.mskill.raise")).toBe(0);
    // The slam has a cooldown: at most one every 120 ticks.
    expect(casts([...first, ...quiet], "classic.mskill.boss_slam")).toBeLessThanOrEqual(4);
    expect(casts([...first, ...quiet], "classic.mskill.claw")).toBeGreaterThan(0);

    sim.world.update(boss, Life, { hp: Math.floor((life.max * 30) / 100) });
    const second = play(sim, 200);
    expect(casts(second, "classic.mskill.raise")).toBe(1);
    expect(sim.world.read(boss, Ai).count).toBe(2);
    expect(bossPhase(sim.world.read(boss, Life).hp, life.max)).toBe(2);
  }, 60_000);

  it("keeps a boss's wounds when its level is left and entered again", () => {
    const sim = start("classic.warrior", 4, "manual");
    readyHero(sim, 10, 4);
    const boss = liveBoss(sim);
    const max = sim.world.read(boss, Life).max;
    sim.world.update(boss, Life, { hp: max - 500 });
    // Another depth destroys the level; coming back rolls a new one with the same boss.
    pushTransition(sim.world, { to: 3, via: "stairsUp" });
    sim.step(2);
    expect(dungeonOf(sim.world).bossWound).toEqual({ depth: 4, lost: 500 });
    pushTransition(sim.world, { to: 4, via: "stairsDown" });
    sim.step(2);
    const again = liveBoss(sim);
    expect(again).not.toBe(0);
    expect(again).not.toBe(boss);
    expect(sim.world.read(again, Life)).toMatchObject({ hp: max - 500, max });
    expect(dungeonOf(sim.world).bossWound).toBeNull();
  }, 60_000);

  it("names a boss once ('Name, Title' without repeating the title)", () => {
    const sim = start("classic.warrior", 4, "manual");
    readyHero(sim, 10, 4);
    expect(sim.world.read(liveBoss(sim), Monster).name).toBe("Morrow, the Grave Warden");
  }, 60_000);
});

describe("monster behaviours", () => {
  function spawnNear(sim: Sim, hero: Entity, monster: string, dx: number): Entity {
    const p = sim.world.read(hero, Pos);
    const at = placeNear(getAreaMap(sim.world, sim.loaded.registry), p.x + dx, p.y);
    pushSpawn(sim.world, {
      monster,
      x: at.x,
      y: at.y,
      depth: areaOf(sim.world).depth,
      level: monsterLevel(areaOf(sim.world).depth),
      rarity: "normal",
      mods: [],
      pack: 0,
      name: "",
      owner: 0,
      team: "monster",
      until: 0,
      awake: true,
    });
    sim.step(1);
    let found = 0;
    for (const e of sim.world.query(Monster))
      if (sim.world.read(e, Monster).proto === monster) found = e;
    return found;
  }

  it("a tank slams as every 4th attack", () => {
    const sim = start("classic.warrior", 6, "manual");
    const hero = readyHero(sim, 10, 3);
    sim.world.update(hero, Attributes, { vit: 500 });
    // Clear the arrival area so the brute fights the hero alone.
    for (const e of sim.world.query(Monster)) sim.world.destroy(e);
    sim.step(2);
    const brute = spawnNear(sim, hero, "classic.monster.cairn_brute", 256);
    expect(brute).not.toBe(0);
    const ev = play(sim, 400);
    const mine = ofType(ev, "classic.cast").filter((e) => e.caster === brute);
    const claws = mine.filter((e) => e.skill === "classic.mskill.claw").length;
    const slams = mine.filter((e) => e.skill === "classic.mskill.slam").length;
    expect(claws).toBeGreaterThanOrEqual(6);
    // One slam per three claws (the slam may still be cooling down: allow one short).
    expect(slams).toBeGreaterThanOrEqual(Math.floor(claws / 3) - 1);
    expect(slams).toBeLessThanOrEqual(Math.ceil(claws / 3) + 1);
  }, 60_000);

  it("a summoner only raises while its target is within 9 tiles", () => {
    const sim = start("classic.warrior", 6, "manual");
    const hero = readyHero(sim, 10, 3);
    sim.world.update(hero, Attributes, { vit: 500 });
    for (const e of sim.world.query(Monster)) sim.world.destroy(e);
    sim.step(2);
    const cantor = spawnNear(sim, hero, "classic.monster.hollow_cantor", 7 * 256);
    expect(cantor).not.toBe(0);
    sim.world.update(cantor, Ai, { state: "chase", target: hero });
    let raises = 0;
    for (let i = 0; i < 600; i++) {
      for (const e of sim.step(1) as GameEvent[]) {
        const c = e as ClassicEvent;
        if (c.type !== "classic.cast" || c.caster !== cantor || c.skill !== "classic.mskill.raise")
          continue;
        raises++;
        const a = sim.world.read(cantor, Pos);
        const b = sim.world.read(hero, Pos);
        // Ordered within 9 tiles; the cast fires a few ticks later (it may have stepped).
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThanOrEqual(10 * 256);
      }
    }
    // It does raise once it walked into reach.
    expect(raises).toBeGreaterThan(0);
  }, 60_000);

  it("the auto hero kills a summoner behind its summons", () => {
    // Finding: summons give no XP while the Hollow Cantor kept raising them (kill drought).
    const sim = start("classic.rogue", 13);
    const hero = readyHero(sim, 6, 3);
    for (const e of sim.world.query(Monster)) sim.world.destroy(e);
    sim.step(2);
    const cantor = spawnNear(sim, hero, "classic.monster.hollow_cantor", 6 * 256);
    sim.world.update(cantor, Ai, { state: "chase", target: hero });
    const ev = play(sim, 2 * MIN);
    expect(
      ofType(ev, "classic.death").some((e) => e.monster === "classic.monster.hollow_cantor"),
    ).toBe(true);
  }, 60_000);
});

describe("auto gear", () => {
  it("a bow user never swaps the bow for a wand, however good the wand's mods", () => {
    const sim = start("classic.rogue", 7);
    sim.step(5);
    const hero = heroOf(sim.world);
    const wand: ItemInstance = {
      ...item(950_000, "classic.item.ash_wand", "rare"),
      mods: [
        { stat: "dex", value: 10 },
        { stat: "vit", value: 10 },
        { stat: "dmgPct", value: 30 },
      ],
    };
    const inv = sim.world.read(hero, Inventory);
    sim.world.update(hero, Inventory, { items: [...inv.items, { x: 9, y: 0, item: wand }] });
    sim.step(40);
    expect(sim.world.read(hero, Equipment).weapon?.base).toBe("classic.item.hunting_bow");
  });
});

describe("town rules", () => {
  /** The town NPC entity of `proto`, with the hero moved next to it. */
  function atNpc(sim: Sim, proto: string): Entity {
    const hero = heroOf(sim.world);
    for (const e of sim.world.query(Npc, Pos)) {
      if (sim.world.read(e, Npc).proto !== proto) continue;
      const p = sim.world.read(e, Pos);
      teleportHero(sim, hero, p.x + 128, p.y);
      return e;
    }
    throw new Error(`no npc ${proto}`);
  }

  it("the alchemist sells potion tiers by hero level (item level <= level + 2)", () => {
    const sim = start("classic.warrior", 8, "manual");
    sim.step(2);
    const hero = heroOf(sim.world);
    sim.world.update(hero, Wallet, { gold: 5000 });
    const npc = atNpc(sim, "classic.npc.ysolde");
    const buy = (potion: string) =>
      sim.dispatch("classic.buy", { npc, index: 0, potion, count: 1 }, null);
    const res = buy("classic.item.potion_life_4");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("bad_target");
    expect(buy("classic.item.potion_life_1").ok).toBe(true);
    sim.world.update(hero, Level, { level: 20 });
    expect(buy("classic.item.potion_life_4").ok).toBe(true);
  });

  it("quests are accepted only within reach of their giver", () => {
    const sim = start("classic.warrior", 8, "manual");
    sim.step(2);
    const quest = "classic.quest.rats_in_the_cellar";
    const far = sim.dispatch("classic.acceptQuest", { quest }, null);
    expect(far.error?.code).toBe("too_far");
    atNpc(sim, "classic.npc.captain_hale");
    expect(sim.dispatch("classic.acceptQuest", { quest }, null).ok).toBe(true);
  });
});

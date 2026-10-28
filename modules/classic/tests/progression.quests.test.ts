/**
 * Quest behaviour with the real classic catalog (docs/design/classic.md §16):
 * one test per quest kind, the retroactive killBoss and clearLevel rules, the
 * chain, reward overflow (bag, then stash, then sold), rejections that leave
 * the hash unchanged, and determinism. Monsters are real spawns (bus.spawns),
 * and kills are death records with Dead set, as the combat system leaves them.
 */
import { createSim, loadMode, type Entity, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf, pushCommand, pushSpawn, type DeathRecord } from "../src/bus.ts";
import { AreaTag, Dead, Inventory, Level, Monster, Npc, Pos, Wallet } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { mode, modules } from "../src/index.ts";
import { dungeonOf, heroOf, questsOf, RES, runStatsOf, type StashState } from "../src/resources.ts";
import type { ClassicEvent } from "../src/events.ts";

const loaded = loadMode(mode, modules);
const GIVER = "classic.npc.captain_hale";
const RATS = "classic.quest.rats_in_the_cellar";
const DEEPER = "classic.quest.deeper_still";
const WARDEN_QUEST = "classic.quest.wardens_rest";
const TUNNEL = "classic.quest.tunnel_mother";
const NINTH = "classic.quest.ninth_flame";
const CULL = "classic.quest.cull_the_flames";
const CRYPT = "classic.quest.clear_the_crypt";
const GNAWLING = "classic.monster.gnawling";
const ASH_SEER = "classic.monster.ash_seer";
const WARDEN = "classic.monster.boss_warden";

/** A new warrior in town, standing at the quest giver. */
function townSim(seed = 1): { sim: Sim; hero: Entity } {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch(
    "classic.newHero",
    { classId: "classic.warrior", name: "Qa" },
    "tester",
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  sim.step(2);
  const hero = heroOf(sim.world);
  expect(hero).toBeGreaterThan(0);
  stand(sim, hero, GIVER);
  return { sim, hero };
}

/** Moves the hero to the giver's position (within interaction range). */
function stand(sim: Sim, hero: Entity, giver: string): void {
  for (const e of sim.world.query(Npc, Pos)) {
    if (sim.world.read(e, Npc).proto !== giver) continue;
    const p = sim.world.read(e, Pos);
    sim.world.update(hero, Pos, { x: p.x, y: p.y });
    return;
  }
  throw new Error(`no NPC ${giver}`);
}

function setLevel(sim: Sim, hero: Entity, level: number): void {
  sim.world.update(hero, Level, { level });
}

function setDungeon(
  sim: Sim,
  patch: { live?: number; deepest?: number; bossesKilled?: number[] },
): void {
  const d = dungeonOf(sim.world);
  sim.world.setResource(RES.dungeon, { ...d, ...patch });
}

function progressOf(sim: Sim, quest: string): { progress: number; done: boolean } | undefined {
  const q = questsOf(sim.world).active.find((a) => a.id === quest);
  return q === undefined ? undefined : { progress: q.progress, done: q.done };
}

function eventsOf<T = GameEvent>(events: GameEvent[], type: string): T[] {
  return events.filter((e) => e.type === type) as unknown as T[];
}

function accept(sim: Sim, quest: string) {
  return sim.dispatch("classic.acceptQuest", { quest }, "tester");
}

/** Asserts that the action is rejected with `code`, leaving the hash unchanged. */
function rejects(sim: Sim, name: string, payload: unknown, code: string): void {
  const before = sim.hash();
  const res = sim.dispatch(name, payload, "tester");
  expect(res.ok).toBe(false);
  expect(res.error?.code).toBe(code);
  expect(res.events).toEqual([]);
  expect(sim.hash()).toBe(before);
}

/** Spawns `n` real monsters of `proto` at `depth` and returns their entities (one tick). */
function spawn(sim: Sim, proto: string, depth: number, n: number, rarity = "normal"): Entity[] {
  const before = new Set(sim.world.query(Monster));
  for (let i = 0; i < n; i++) {
    pushSpawn(sim.world, {
      monster: proto,
      x: tileCenter(20 + (i % 8)),
      y: tileCenter(20 + Math.floor(i / 8)),
      depth,
      level: 1,
      rarity: rarity as "normal",
      mods: [],
      pack: 0,
      name: "",
      owner: 0,
      team: "monster",
      until: 0,
      awake: false,
    });
  }
  sim.step(1);
  return [...sim.world.query(Monster)].filter(
    (e) => !before.has(e) && sim.world.read(e, AreaTag).depth === depth,
  );
}

/** Queues death records for the monsters (credited to the hero, or to themselves) and marks them dead. */
function kill(sim: Sim, monsters: Entity[], credited = true): void {
  const hero = heroOf(sim.world);
  for (const e of monsters) {
    const m = sim.world.read(e, Monster);
    const p = sim.world.read(e, Pos);
    const rec: DeathRecord = {
      entity: e,
      killer: credited ? hero : e,
      creditTeam: credited ? "hero" : "monster",
      team: "monster",
      isHero: false,
      x: p.x,
      y: p.y,
      depth: sim.world.read(e, AreaTag).depth,
      monster: m.proto,
      rarity: m.rarity,
      level: m.level,
      xp: m.xp,
      pack: m.pack,
    };
    sim.world.add(e, Dead, { at: 0, killer: rec.killer });
    busOf(sim.world).deaths.push(rec);
  }
}

describe("quest kinds (real content)", () => {
  it("killMonsters with a monster id counts only that monster and completes at the count", () => {
    const { sim } = townSim();
    expect(accept(sim, RATS).ok).toBe(true);
    const seers = spawn(sim, ASH_SEER, 1, 1);
    const gnawlings = spawn(sim, GNAWLING, 1, 19);
    kill(sim, [...seers, ...gnawlings]);
    sim.step(1);
    expect(progressOf(sim, RATS)).toEqual({ progress: 19, done: false });
    const last = spawn(sim, GNAWLING, 1, 1);
    kill(sim, last);
    const events = sim.step(1) as GameEvent[];
    expect(progressOf(sim, RATS)).toEqual({ progress: 20, done: true });
    expect(eventsOf(events, "classic.quest.done")).toEqual([
      { type: "classic.quest.done", quest: RATS },
    ]);
  });

  it("killMonsters with '*' counts every monster kill", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 10);
    expect(accept(sim, CULL).ok).toBe(true);
    const mixed = [...spawn(sim, GNAWLING, 1, 2), ...spawn(sim, ASH_SEER, 1, 1)];
    kill(sim, mixed);
    sim.step(1);
    expect(progressOf(sim, CULL)).toEqual({ progress: 3, done: false });
  });

  it("reachDepth follows the deepest depth and completes at the depth", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 4);
    expect(accept(sim, DEEPER).ok).toBe(true);
    setDungeon(sim, { deepest: 5 });
    sim.step(1);
    expect(progressOf(sim, DEEPER)).toEqual({ progress: 5, done: false });
    setDungeon(sim, { deepest: 6 });
    sim.step(1);
    expect(progressOf(sim, DEEPER)).toEqual({ progress: 6, done: true });
  });

  it("killBoss completes on a live kill of its boss", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 6);
    expect(accept(sim, WARDEN_QUEST).ok).toBe(true);
    const [boss] = spawn(sim, WARDEN, 4, 1, "boss");
    expect(boss).toBeDefined();
    kill(sim, [boss!]);
    const events = sim.step(1) as GameEvent[];
    expect(progressOf(sim, WARDEN_QUEST)).toEqual({ progress: 1, done: true });
    expect(eventsOf(events, "classic.quest.done")).toHaveLength(1);
  });

  it("killBoss accepted after its boss already died completes within one tick", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 6);
    setDungeon(sim, { bossesKilled: [4] });
    expect(accept(sim, WARDEN_QUEST).ok).toBe(true);
    const events = sim.step(1) as GameEvent[];
    expect(progressOf(sim, WARDEN_QUEST)).toEqual({ progress: 1, done: true });
    expect(eventsOf(events, "classic.quest.done")).toEqual([
      { type: "classic.quest.done", quest: WARDEN_QUEST },
    ]);
  });

  it("killBoss ignores a killed boss of another depth", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 6);
    setDungeon(sim, { bossesKilled: [8, 12] });
    expect(accept(sim, WARDEN_QUEST).ok).toBe(true);
    sim.step(3);
    expect(progressOf(sim, WARDEN_QUEST)).toEqual({ progress: 0, done: false });
  });

  it("clearLevel completes when the last monster dies to a credited kill", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 6);
    setDungeon(sim, { live: 3, deepest: 3 });
    const pair = spawn(sim, GNAWLING, 3, 2);
    expect(accept(sim, CRYPT).ok).toBe(true);
    sim.step(1);
    expect(progressOf(sim, CRYPT)).toEqual({ progress: 0, done: false });
    kill(sim, [pair[0]!]);
    sim.step(1);
    expect(progressOf(sim, CRYPT)).toEqual({ progress: 0, done: false });
    kill(sim, [pair[1]!]);
    sim.step(1);
    expect(progressOf(sim, CRYPT)).toEqual({ progress: 1, done: true });
  });

  it("clearLevel completes when the last monster dies without hero credit (self-kill)", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 6);
    setDungeon(sim, { live: 3, deepest: 3 });
    const [lone] = spawn(sim, GNAWLING, 3, 1);
    expect(accept(sim, CRYPT).ok).toBe(true);
    const kills = runStatsOf(sim.world).kills;
    kill(sim, [lone!], false);
    sim.step(1);
    expect(progressOf(sim, CRYPT)).toEqual({ progress: 1, done: true });
    // The death earned the hero no kill: the quest needed no credit.
    expect(runStatsOf(sim.world).kills).toBe(kills);
  });

  it("clearLevel accepted on an already empty live level completes at once", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 6);
    setDungeon(sim, { live: 3, deepest: 3 });
    const res = accept(sim, CRYPT);
    expect(res.ok).toBe(true);
    expect(eventsOf(res.events, "classic.quest.done")).toEqual([
      { type: "classic.quest.done", quest: CRYPT },
    ]);
    expect(progressOf(sim, CRYPT)).toEqual({ progress: 1, done: true });
  });

  it("clearLevel does not complete for a live level of another depth", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 6);
    setDungeon(sim, { live: 2, deepest: 3 });
    expect(accept(sim, CRYPT).ok).toBe(true);
    sim.step(2);
    expect(progressOf(sim, CRYPT)).toEqual({ progress: 0, done: false });
  });
});

describe("quest chain and turn-in", () => {
  it("a finished chain quest unlocks the next one and turn-in pays the rewards", () => {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 14);
    setDungeon(sim, { bossesKilled: [4] });
    expect(accept(sim, TUNNEL).ok).toBe(false);
    expect(accept(sim, WARDEN_QUEST).ok).toBe(true);
    sim.step(1);
    expect(progressOf(sim, WARDEN_QUEST)?.done).toBe(true);
    const gold = sim.world.read(hero, Wallet).gold;
    const turn = sim.dispatch("classic.completeQuest", { quest: WARDEN_QUEST }, "tester");
    expect(turn.ok, JSON.stringify(turn.error)).toBe(true);
    sim.step(2);
    expect(questsOf(sim.world).completed).toContain(WARDEN_QUEST);
    expect(sim.world.read(hero, Wallet).gold).toBe(gold + 400);
    expect(accept(sim, TUNNEL).ok).toBe(true);
    // Ninth Flame needs level 20 and Tunnel Mother finished: only the chain blocks it.
    setLevel(sim, hero, 20);
    rejects(sim, "classic.acceptQuest", { quest: NINTH }, "quest_state");
  });
});

describe("reward overflow", () => {
  /** A hero whose Deeper Still is done, with the bag full of other items. */
  function fullBagSim(): { sim: Sim; hero: Entity } {
    const { sim, hero } = townSim();
    setLevel(sim, hero, 4);
    expect(accept(sim, DEEPER).ok).toBe(true);
    setDungeon(sim, { deepest: 6 });
    sim.step(1);
    pushCommand(sim.world, {
      op: "grantItems",
      count: 200,
      ilvl: 4,
      minRarity: "normal",
      toStash: false,
      reason: "fill",
    });
    const filled = sim.step(1) as GameEvent[];
    expect(
      eventsOf<Extract<ClassicEvent, { type: "classic.gold" }>>(filled, "classic.gold").some(
        (e) => e.reason === "fill: overflow sold",
      ),
      "the bag never filled",
    ).toBe(true);
    return { sim, hero };
  }

  it("a quest reward with a full bag goes to the stash, not the sale", () => {
    const { sim, hero } = fullBagSim();
    const bagBefore = sim.world.read(hero, Inventory).items.length;
    const stashBefore = sim.world.getResource<StashState>(RES.stash)?.items.length ?? 0;
    const gold = sim.world.read(hero, Wallet).gold;
    expect(sim.dispatch("classic.completeQuest", { quest: DEEPER }, "tester").ok).toBe(true);
    const events = sim.step(2) as GameEvent[];
    expect(sim.world.read(hero, Inventory).items.length).toBe(bagBefore);
    expect(sim.world.getResource<StashState>(RES.stash)?.items.length).toBe(stashBefore + 1);
    expect(sim.world.read(hero, Wallet).gold).toBe(gold + 300);
    expect(
      eventsOf<Extract<ClassicEvent, { type: "classic.gold" }>>(events, "classic.gold").some(
        (e) => e.reason === "quest: overflow sold",
      ),
    ).toBe(false);
  });

  it("a quest reward is sold only when the bag and the stash are both full", () => {
    const { sim, hero } = fullBagSim();
    let stashFull = false;
    for (let round = 0; round < 10 && !stashFull; round++) {
      pushCommand(sim.world, {
        op: "grantItems",
        count: 200,
        ilvl: 4,
        minRarity: "normal",
        toStash: true,
        reason: "fill-stash",
      });
      const events = sim.step(1) as GameEvent[];
      stashFull = eventsOf<Extract<ClassicEvent, { type: "classic.gold" }>>(
        events,
        "classic.gold",
      ).some((e) => e.reason === "fill-stash: overflow sold");
    }
    expect(stashFull, "the stash never filled").toBe(true);
    const stashBefore = sim.world.getResource<StashState>(RES.stash)?.items.length ?? 0;
    const bagBefore = sim.world.read(hero, Inventory).items.length;
    pushCommand(sim.world, {
      op: "grantItems",
      count: 1,
      ilvl: 4,
      minRarity: "magic",
      toStash: false,
      reason: "quest",
    });
    const events = sim.step(1) as GameEvent[];
    expect(
      eventsOf<Extract<ClassicEvent, { type: "classic.gold" }>>(events, "classic.gold").some(
        (e) => e.reason === "quest: overflow sold",
      ),
    ).toBe(true);
    expect(sim.world.getResource<StashState>(RES.stash)?.items.length).toBe(stashBefore);
    expect(sim.world.read(hero, Inventory).items.length).toBe(bagBefore);
  });
});

describe("quest rejections leave the hash unchanged", () => {
  it("too_far, level_too_low, quest_state and not finished are rejected", () => {
    const { sim, hero } = townSim();
    const p = sim.world.read(hero, Pos);
    // Too far from the giver.
    sim.world.update(hero, Pos, { x: p.x + tileCenter(40), y: p.y });
    rejects(sim, "classic.acceptQuest", { quest: RATS }, "too_far");
    stand(sim, hero, GIVER);
    // Level too low (Warden's Rest needs 6, the hero is 1).
    rejects(sim, "classic.acceptQuest", { quest: WARDEN_QUEST }, "level_too_low");
    // Accepted once, then taken.
    expect(accept(sim, RATS).ok).toBe(true);
    rejects(sim, "classic.acceptQuest", { quest: RATS }, "quest_state");
    // Turned in before it is finished.
    rejects(sim, "classic.completeQuest", { quest: RATS }, "quest_state");
  });
});

describe("quest determinism", () => {
  function script(seed: number): string {
    const { sim, hero } = townSim(seed);
    setLevel(sim, hero, 4);
    expect(accept(sim, RATS).ok).toBe(true);
    expect(accept(sim, DEEPER).ok).toBe(true);
    const seers = spawn(sim, ASH_SEER, 1, 2);
    const gnawlings = spawn(sim, GNAWLING, 1, 5);
    kill(sim, [...seers, ...gnawlings]);
    sim.step(2);
    setDungeon(sim, { deepest: 6 });
    sim.step(2);
    expect(sim.dispatch("classic.completeQuest", { quest: DEEPER }, "tester").ok).toBe(true);
    sim.step(3);
    return sim.hash();
  }

  it("two sims with the same seed and script end with the same hash", () => {
    expect(script(7)).toBe(script(7));
  });
});

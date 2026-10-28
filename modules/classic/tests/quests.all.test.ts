/**
 * Quest coverage (docs/design/classic.md §16), on the real classic catalog and
 * every classic module. Data-driven over registry.all(KIND.quest), so a new
 * quest is covered without editing this file.
 *
 * Every quest goes through real actions: classic.interact to Captain Hale (the
 * hero walks there in the sim, here it is placed in reach), classic.acceptQuest,
 * classic.completeQuest. Kills are pushed as DeathRecords (the same path combat
 * takes), depth and level are set through the real transitions and resources.
 *
 * This suite is the TARGET behaviour of the quest fix wave and is never
 * weakened to pass; see tools/qa/README.md "Quest suite" for which tests wait
 * on which fix (retroactive killBoss credit, Auto clear route for Clear the
 * Crypt, same-visit chain acceptance for Auto).
 */
import {
  createSim,
  loadMode,
  type Entity,
  type GameEvent,
  type Sim,
  type World,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION, ERR } from "../src/actions.ts";
import { busOf, pushCommand, pushTransition, type DeathRecord } from "../src/bus.ts";
import {
  AreaTag,
  Dead,
  Faction,
  Inventory,
  Level,
  Life,
  Monster,
  Npc,
  Pos,
  Wallet,
} from "../src/components.ts";
import { ACHIEVEMENT_CHECK_EVERY } from "../src/achievements/index.ts";
import { buildHud } from "../src/client/hudModel.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import { BALANCE } from "../src/content/balance.ts";
import { placeNear } from "../src/monsters/spawn.ts";
import {
  currentDepth,
  dungeonOf,
  heroOf,
  questsOf,
  RES,
  stashOf,
  type QuestState,
} from "../src/resources.ts";
import { xpAtLevel } from "../src/rules.ts";
import { gridOf } from "../src/spatial.ts";
import {
  KIND,
  ITEM_RARITIES,
  type ItemInstance,
  type MonsterProto,
  type QuestProto,
} from "../src/types.ts";
import { placeItem } from "../src/items/inventory.ts";
import { getAreaMap } from "../src/world/maps.ts";

const SEED = 4242;
const HALE = "classic.npc.captain_hale";
const RATS = "classic.quest.rats_in_the_cellar";
const DEEPER = "classic.quest.deeper_still";
const WARDENS = "classic.quest.wardens_rest";
const TUNNEL = "classic.quest.tunnel_mother";
const CLEAR = "classic.quest.clear_the_crypt";
const CULL = "classic.quest.cull_the_flames";
const NINTH = "classic.quest.into_the_ninth";
const NINTH_FLAME = "classic.quest.ninth_flame";
const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer"] as const;
/**
 * Ticks within which Auto turns in Clear the Crypt at level 18 with 6 rare items
 * (seed 4242, measured: sorcerer about 6800, rogue 8500, warrior 10000); about 30 % margin.
 */
const CRYPT_BUDGET = 13_000;
/** Distance (sub units) that is out of reach of the giver: 8 tiles, INTERACT_RANGE is 3. */
const FAR = 2048;
/** Depth of the Clear the Crypt level. */
const CRYPT_DEPTH = 3;

const loaded = loadMode(mode, modules);
const QUESTS = [...loaded.registry.all<QuestProto>(KIND.quest)];
const quest = (id: string): QuestProto => loaded.registry.require<QuestProto>(KIND.quest, id);
const monster = (id: string): MonsterProto =>
  loaded.registry.require<MonsterProto>(KIND.monster, id);
const BOSS_IDS = [...loaded.registry.all<MonsterProto>(KIND.monster)]
  .filter(([, m]) => m.boss !== undefined)
  .map(([id]) => id);

/** Rarity rank for "at least this rare" checks. */
const rank = (r: string): number => ITEM_RARITIES.indexOf(r as (typeof ITEM_RARITIES)[number]);

/** A sim driven by real actions, with every event kept for the assertions. */
class Driver {
  readonly sim: Sim;
  readonly events: ClassicEvent[] = [];

  constructor(classId: string, control: "manual" | "idle" | "auto" = "manual", seed = SEED) {
    this.sim = createSim(loaded, { seed });
    const created = this.sim.dispatch(ACTION.newHero, { classId, name: "Quester" }, null);
    if (!created.ok) throw new Error(`newHero failed: ${created.error?.message}`);
    const set = this.sim.dispatch(ACTION.setControl, { mode: control }, null);
    if (!set.ok) throw new Error(`setControl failed: ${set.error?.message}`);
    this.step(2);
  }

  get world(): World {
    return this.sim.world;
  }

  get hero(): Entity {
    return heroOf(this.sim.world);
  }

  /** Steps `n` ticks; every event is recorded and returned. */
  step(n = 1): ClassicEvent[] {
    const out: ClassicEvent[] = [];
    for (let i = 0; i < n; i++) {
      for (const raw of this.sim.step(1) as GameEvent[]) {
        const e = raw as ClassicEvent;
        out.push(e);
        this.events.push(e);
      }
    }
    return out;
  }

  /** Steps one tick at a time until `done` matches or `budget` ticks pass. */
  until(budget: number, done: (e: ClassicEvent) => boolean): ClassicEvent | undefined {
    for (let i = 0; i < budget; i++) {
      for (const e of this.step(1)) if (done(e)) return e;
    }
    return undefined;
  }

  dispatch(name: string, payload: unknown) {
    const res = this.sim.dispatch(name, payload, null);
    for (const raw of res.events as GameEvent[]) this.events.push(raw as ClassicEvent);
    return res;
  }

  /** Grants 6 rare items of item level `ilvl` into the bag (applied on the next step). */
  grantGear(ilvl: number): void {
    pushCommand(this.world, {
      op: "grantItems",
      count: 6,
      ilvl,
      minRarity: "rare",
      toStash: false,
      reason: "test",
    });
    this.step(1);
  }

  /** Grants XP up to `level` (queued command, applied on the next step). */
  setLevel(level: number): void {
    const cur = this.world.read(this.hero, Level);
    const need = xpAtLevel(BALANCE, level) - cur.xp;
    if (need > 0) pushCommand(this.world, { op: "grantXp", amount: need, reason: "test" });
    this.step(1);
    expect(this.world.read(this.hero, Level).level).toBeGreaterThanOrEqual(level);
  }

  /** The hero walks to town (the transition and one tick). */
  toTown(): void {
    if (currentDepth(this.world) === 0) return;
    pushTransition(this.world, { to: 0, via: "stairsUp" });
    this.step(1);
  }

  /** Places the hero in reach of Captain Hale (in town). */
  nearHale(): void {
    this.toTown();
    const hale = this.hale();
    const p = this.world.read(hale, Pos);
    this.teleport(p.x + 128, p.y);
  }

  /** Places the hero 8 tiles from Captain Hale, out of reach. */
  farFromHale(): void {
    this.toTown();
    const hale = this.hale();
    const p = this.world.read(hale, Pos);
    this.teleport(p.x - FAR, p.y);
  }

  hale(): Entity {
    for (const e of this.world.query(Npc, Pos)) {
      if (this.world.read(e, Npc).proto === HALE) return e;
    }
    throw new Error("Captain Hale is not in the town");
  }

  teleport(x: number, y: number): void {
    const at = placeNear(getAreaMap(this.world, this.sim.loaded.registry), x, y);
    this.world.update(this.hero, Pos, at);
    gridOf(this.world).move(this.hero, at.x, at.y);
  }

  /** Enters a dungeon depth through the stairs and lets its population spawn. */
  enter(depth: number): void {
    pushTransition(this.world, { to: depth, via: "stairsDown" });
    this.step(3);
  }

  /** Accepts a quest in town near Hale; expects success. */
  accept(id: string): void {
    this.nearHale();
    const res = this.dispatch(ACTION.acceptQuest, { quest: id });
    expect(res.ok, `accept ${id}: ${res.error?.code} ${res.error?.message}`).toBe(true);
    this.step(1);
  }

  /** Turns a finished quest in near Hale, then steps once so the grants land. */
  turnIn(id: string): ReturnType<Driver["dispatch"]> {
    this.nearHale();
    const res = this.dispatch(ACTION.completeQuest, { quest: id });
    this.step(1);
    return res;
  }

  /** Records a credited (or not) monster death, the way combat reports them. */
  death(over: Partial<DeathRecord>): void {
    busOf(this.world).deaths.push({
      entity: 0,
      killer: 0,
      creditTeam: "hero",
      team: "monster",
      isHero: false,
      x: 0,
      y: 0,
      depth: 1,
      monster: "",
      rarity: "normal",
      level: 1,
      xp: 10,
      pack: 0,
      ...over,
    });
  }

  /** The state of a quest as the HUD model shows it (null = hidden / locked). */
  hudState(id: string): string | null {
    const hud = buildHud(this.world, this.sim.loaded.registry, {
      tick: this.sim.tick,
      hovered: 0,
      vendor: 0,
      prev: null,
    });
    return hud.quests.find((q) => q.id === id)?.state ?? null;
  }

  quests(): QuestState {
    return questsOf(this.world);
  }

  /** Live (alive, not corpses or summons) monsters of one depth. */
  liveMonsters(depth: number): Entity[] {
    const out: Entity[] = [];
    for (const e of this.world.query(Monster, Faction, AreaTag, Life)) {
      if (this.world.read(e, Faction).team !== "monster") continue;
      if (this.world.read(e, AreaTag).depth !== depth) continue;
      if (this.world.has(e, Dead) || this.world.read(e, Life).hp <= 0) continue;
      out.push(e);
    }
    return out;
  }

  /** Kills every live monster of `depth` as a credited hero kill (one death record each). */
  killLevel(depth: number, skip = 0): void {
    const alive = this.liveMonsters(depth);
    for (const e of alive.slice(0, alive.length - skip)) {
      const m = this.world.read(e, Monster);
      this.world.add(e, Dead, { at: this.sim.tick, killer: 0 });
      this.death({ entity: e, depth, monster: m.proto, rarity: m.rarity, level: m.level });
    }
  }
}

/** Makes `id` finished, using only what the game counts (kills, deepest depth, a cleared level). */
function finish(d: Driver, id: string, partial = false): void {
  const qp = quest(id);
  const need = partial ? qp.count - 1 : qp.count;
  switch (qp.kind) {
    case "killMonsters": {
      const target = qp.target === "*" ? "classic.monster.gnawling" : qp.target;
      for (let i = 0; i < need; i++) {
        d.death({ monster: target, rarity: "normal", depth: 1 });
      }
      d.step(1);
      return;
    }
    case "killBoss": {
      if (partial) return;
      const depth = monster(qp.target).boss?.depth ?? 1;
      d.death({ monster: qp.target, rarity: "boss", depth });
      d.step(1);
      return;
    }
    case "reachDepth": {
      dungeonOf(d.world).deepest = Math.max(dungeonOf(d.world).deepest, need);
      d.step(1);
      return;
    }
    case "clearLevel": {
      d.enter(qp.count);
      expect(d.liveMonsters(qp.count).length).toBeGreaterThan(0);
      d.killLevel(qp.count, partial ? 1 : 0);
      d.step(1);
      d.toTown();
      return;
    }
  }
}

/** Quests in an order the chain allows: the lowest level whose prerequisites are finished. */
function chainOrder(): string[] {
  const done = new Set<string>();
  const out: string[] = [];
  while (out.length < QUESTS.length) {
    const next = QUESTS.map(([id, q]) => ({ id, q }))
      .filter(({ id, q }) => !done.has(id) && (q.after === "" || done.has(q.after)))
      .sort((a, b) => a.q.reqLevel - b.q.reqLevel || (a.id < b.id ? -1 : 1))[0];
    if (!next) throw new Error("the quest chain has a cycle or a missing prerequisite");
    out.push(next.id);
    done.add(next.id);
  }
  return out;
}

/** Runs the whole chain (every quest accepted, finished and turned in), in chain order. */
function runChain(d: Driver): void {
  for (const id of chainOrder()) {
    const qp = quest(id);
    d.setLevel(qp.reqLevel);
    d.accept(id);
    finish(d, id);
    d.nearHale();
    const turn = d.dispatch(ACTION.completeQuest, { quest: id });
    expect(turn.ok, `turn in ${id}: ${turn.error?.code} ${turn.error?.message}`).toBe(true);
    d.step(1);
  }
}

describe("quests: content", () => {
  it("every quest is given by Captain Hale and names a real kind and target", () => {
    expect(QUESTS.length).toBe(10);
    for (const [id, q] of QUESTS) {
      expect(q.giver, id).toBe(HALE);
      expect(["killMonsters", "killBoss", "reachDepth", "clearLevel"]).toContain(q.kind);
      if (q.kind === "killBoss") expect(monster(q.target).boss).toBeDefined();
      if (q.kind === "killMonsters" && q.target !== "*") {
        expect(loaded.registry.has(KIND.monster, q.target), id).toBe(true);
      }
      if (q.after !== "") expect(loaded.registry.has(KIND.quest, q.after), id).toBe(true);
    }
  });

  it("the chain order is a full order (every quest reachable, prerequisites first)", () => {
    const order = chainOrder();
    expect(new Set(order).size).toBe(QUESTS.length);
    for (const [i, id] of order.entries()) {
      const after = quest(id).after;
      if (after !== "") expect(order.indexOf(after)).toBeLessThan(i);
    }
  });
});

describe("quests: offered by level and chain (HUD and actions agree)", () => {
  for (const [id, qp] of QUESTS) {
    it(`${qp.name} is hidden below level ${qp.reqLevel} and refused with level_too_low`, () => {
      if (qp.reqLevel <= 1) return;
      const d = new Driver("classic.warrior");
      // Chain satisfied, level short by one: locked.
      if (qp.after !== "") {
        d.world.setResource(RES.quests, { active: [], completed: [qp.after] });
      }
      d.setLevel(qp.reqLevel - 1);
      d.nearHale();
      expect(d.hudState(id)).toBeNull();
      const res = d.dispatch(ACTION.acceptQuest, { quest: id });
      expect(res.error?.code).toBe(ERR.levelTooLow);
    });

    it(`${qp.name} is hidden until its chain is finished and refused with quest_state`, () => {
      if (qp.after === "") return;
      const d = new Driver("classic.warrior");
      d.setLevel(qp.reqLevel);
      d.nearHale();
      expect(d.hudState(id)).toBeNull();
      const before = d.sim.hash();
      const res = d.dispatch(ACTION.acceptQuest, { quest: id });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe(ERR.questState);
      expect(d.sim.hash()).toBe(before);
    });

    it(`${qp.name} is offered at its level once its chain is finished`, () => {
      const d = new Driver("classic.warrior");
      d.setLevel(qp.reqLevel);
      if (qp.after !== "") d.world.setResource(RES.quests, { active: [], completed: [qp.after] });
      d.nearHale();
      expect(d.hudState(id)).toBe("available");
    });
  }
});

describe("quests: accept and reject", () => {
  for (const [id, qp] of QUESTS) {
    it(`${qp.name}: far from Hale is too_far and leaves the hash unchanged`, () => {
      const d = new Driver("classic.warrior");
      d.setLevel(qp.reqLevel);
      if (qp.after !== "") d.world.setResource(RES.quests, { active: [], completed: [qp.after] });
      d.farFromHale();
      const before = d.sim.hash();
      const res = d.dispatch(ACTION.acceptQuest, { quest: id });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe(ERR.tooFar);
      expect(d.sim.hash()).toBe(before);
      expect(d.quests().active.some((q) => q.id === id)).toBe(false);
    });

    it(`${qp.name}: accepted near Hale, once; a second accept is quest_state`, () => {
      const d = new Driver("classic.warrior");
      d.setLevel(qp.reqLevel);
      if (qp.after !== "") d.world.setResource(RES.quests, { active: [], completed: [qp.after] });
      d.nearHale();
      const res = d.dispatch(ACTION.acceptQuest, { quest: id });
      expect(res.ok, res.error?.message).toBe(true);
      expect(res.events).toContainEqual({ type: "classic.quest.accepted", quest: id });
      const entry = d.quests().active.find((q) => q.id === id);
      expect(entry).toEqual({ id, progress: 0, done: false });
      const again = d.dispatch(ACTION.acceptQuest, { quest: id });
      expect(again.error?.code).toBe(ERR.questState);
    });
  }
});

describe("quests: progress is counted for the right things", () => {
  it("killMonsters ignores other monsters and counts the named one", () => {
    const d = new Driver("classic.warrior");
    d.accept(RATS);
    d.death({ monster: "classic.monster.ash_seer", rarity: "normal" });
    d.step(1);
    expect(d.quests().active.find((q) => q.id === RATS)?.progress).toBe(0);
    for (let i = 0; i < 19; i++) d.death({ monster: "classic.monster.gnawling", rarity: "normal" });
    d.step(1);
    expect(d.quests().active.find((q) => q.id === RATS)).toEqual({
      id: RATS,
      progress: 19,
      done: false,
    });
    expect(d.events).not.toContainEqual(expect.objectContaining({ type: "classic.quest.done" }));
    d.death({ monster: "classic.monster.gnawling", rarity: "normal" });
    const done = d.step(1);
    expect(done).toContainEqual({ type: "classic.quest.done", quest: RATS });
    expect(d.quests().active.find((q) => q.id === RATS)?.done).toBe(true);
  });

  it("killMonsters with '*' counts any monster kind (Cull the Flames, 200)", () => {
    const d = new Driver("classic.warrior");
    d.setLevel(10);
    d.accept(CULL);
    for (let i = 0; i < 199; i++) {
      d.death({ monster: i % 2 === 0 ? "classic.monster.gnawling" : "classic.monster.ash_seer" });
    }
    d.step(1);
    expect(d.quests().active.find((q) => q.id === CULL)?.progress).toBe(199);
    d.death({ monster: "classic.monster.ash_seer", rarity: "champion" });
    d.step(1);
    expect(d.quests().active.find((q) => q.id === CULL)?.done).toBe(true);
  });

  it("killBoss ignores a namesake of normal rarity and another boss", () => {
    const d = new Driver("classic.warrior");
    d.setLevel(6);
    d.accept(WARDENS);
    const other = BOSS_IDS.find((b) => b !== "classic.monster.boss_warden")!;
    d.death({ monster: "classic.monster.boss_warden", rarity: "normal", depth: 4 });
    d.death({ monster: other, rarity: "boss", depth: 4 });
    d.step(1);
    expect(d.quests().active.find((q) => q.id === WARDENS)?.progress).toBe(0);
    expect(d.quests().active.find((q) => q.id === WARDENS)?.done).toBe(false);
    d.death({ monster: "classic.monster.boss_warden", rarity: "boss", depth: 4 });
    const done = d.step(1);
    expect(done).toContainEqual({ type: "classic.quest.done", quest: WARDENS });
  });

  it("reachDepth follows the deepest depth ever reached, not the current one", () => {
    const d = new Driver("classic.rogue");
    d.setLevel(4);
    d.accept(DEEPER);
    dungeonOf(d.world).deepest = 5;
    d.step(1);
    expect(d.quests().active.find((q) => q.id === DEEPER)?.progress).toBe(5);
    expect(d.quests().active.find((q) => q.id === DEEPER)?.done).toBe(false);
    dungeonOf(d.world).deepest = 6;
    d.step(1);
    expect(d.quests().active.find((q) => q.id === DEEPER)?.done).toBe(true);
  });

  it("clearLevel stays open while a monster lives on the depth, then completes", () => {
    const d = new Driver("classic.warrior");
    d.setLevel(6);
    d.accept(CLEAR);
    d.enter(CRYPT_DEPTH);
    expect(d.liveMonsters(CRYPT_DEPTH).length).toBeGreaterThan(1);
    d.killLevel(CRYPT_DEPTH, 1);
    d.step(1);
    expect(d.quests().active.find((q) => q.id === CLEAR)?.done).toBe(false);
    d.killLevel(CRYPT_DEPTH);
    const done = d.step(1);
    expect(done).toContainEqual({ type: "classic.quest.done", quest: CLEAR });
  });

  it("clearLevel completes on an uncredited last death (a monster death that empties the depth)", () => {
    // Target behaviour: the completion check runs on any monster death, not only on
    // credited (hero) kills (progression/quests.ts advanceLevelQuests).
    const d = new Driver("classic.warrior");
    d.setLevel(6);
    d.accept(CLEAR);
    d.enter(CRYPT_DEPTH);
    d.killLevel(CRYPT_DEPTH, 1);
    d.step(1);
    const [last] = d.liveMonsters(CRYPT_DEPTH);
    expect(last).toBeDefined();
    const m = d.world.read(last!, Monster);
    d.world.add(last!, Dead, { at: d.sim.tick, killer: 0 });
    d.death({
      entity: last!,
      depth: CRYPT_DEPTH,
      monster: m.proto,
      rarity: m.rarity,
      creditTeam: "monster",
    });
    const done = d.step(1);
    expect(done).toContainEqual({ type: "classic.quest.done", quest: CLEAR });
  });
});

describe("quests: finish, turn in, reward, chain", () => {
  for (const [id, qp] of QUESTS) {
    it(`${qp.name}: finished by its objective, turned in for gold and xp, then locked as completed`, () => {
      const d = new Driver("classic.warrior");
      d.setLevel(qp.reqLevel);
      if (qp.after !== "") d.world.setResource(RES.quests, { active: [], completed: [qp.after] });
      d.accept(id);
      finish(d, id);
      expect(d.quests().active.find((q) => q.id === id)?.done, `${id} done`).toBe(true);
      expect(d.hudState(id)).toBe("done");

      d.nearHale();
      const gold0 = d.world.read(d.hero, Wallet).gold;
      const xp0 = d.world.read(d.hero, Level).xp;
      const bagBefore = new Set(bagUids(d.world));
      const turn = d.dispatch(ACTION.completeQuest, { quest: id });
      expect(turn.ok, turn.error?.message).toBe(true);
      expect(turn.events).toContainEqual({
        type: "classic.quest.completed",
        quest: id,
        gold: qp.reward.gold,
        xp: qp.reward.xp,
      });
      // XP is granted by the op at once; gold is a queued command, applied on the next tick.
      expect(d.world.read(d.hero, Level).xp - xp0).toBe(qp.reward.xp);
      d.step(1);
      expect(d.world.read(d.hero, Wallet).gold - gold0).toBe(qp.reward.gold);
      if (qp.reward.item !== null) {
        const fresh = bagUids(d.world).filter((uid) => !bagBefore.has(uid));
        expect(fresh.length, "reward item in the bag").toBeGreaterThanOrEqual(1);
        const item = itemOf(d.world, fresh[0]!);
        expect(rank(item.rarity)).toBeGreaterThanOrEqual(rank(qp.reward.item));
      }

      expect(d.quests().completed).toContain(id);
      expect(d.quests().active.some((q) => q.id === id)).toBe(false);
      expect(d.hudState(id)).toBe("completed");
      const second = d.dispatch(ACTION.completeQuest, { quest: id });
      expect(second.error?.code).toBe(ERR.questState);
      const again = d.dispatch(ACTION.acceptQuest, { quest: id });
      expect(again.error?.code).toBe(ERR.questState);
    });
  }

  it("turning in before the objective is done is quest_state and changes nothing", () => {
    const d = new Driver("classic.warrior");
    d.setLevel(1);
    d.accept(RATS);
    d.nearHale();
    const before = d.sim.hash();
    const res = d.dispatch(ACTION.completeQuest, { quest: RATS });
    expect(res.error?.code).toBe(ERR.questState);
    expect(d.sim.hash()).toBe(before);
  });

  it("the chain: Tunnel Mother needs The Warden's Rest turned in first, and then unlocks", () => {
    const d = new Driver("classic.warrior");
    d.setLevel(14);
    d.nearHale();
    expect(d.hudState(TUNNEL)).toBeNull();
    expect(d.dispatch(ACTION.acceptQuest, { quest: TUNNEL }).error?.code).toBe(ERR.questState);

    d.accept(WARDENS);
    finish(d, WARDENS);
    expect(d.turnIn(WARDENS).ok).toBe(true);
    expect(d.hudState(TUNNEL)).toBe("available");
    d.accept(TUNNEL);
    expect(d.quests().active.some((q) => q.id === TUNNEL)).toBe(true);
  });

  it("Ninth Flame needs Tunnel Mother; Into the Ninth needs Deeper Still", () => {
    const d = new Driver("classic.warrior");
    d.setLevel(20);
    d.world.setResource(RES.quests, {
      active: [],
      completed: [WARDENS, DEEPER],
    });
    d.nearHale();
    expect(d.hudState(NINTH_FLAME)).toBeNull();
    expect(d.hudState(NINTH)).toBe("available");
    expect(d.dispatch(ACTION.acceptQuest, { quest: NINTH_FLAME }).error?.code).toBe(ERR.questState);
  });

  it("retroactive: Tunnel Mother accepted after depth 8's boss is already in bossesKilled completes and turns in", () => {
    // Target behaviour: a killBoss quest counts a boss killed before it was accepted.
    // (progression/quests.ts advanceLevelQuests, settled on the tick after the accept).
    const d = new Driver("classic.warrior");
    d.setLevel(14);
    dungeonOf(d.world).bossesKilled = [
      monster("classic.monster.boss_tunnel_mother").boss?.depth ?? 8,
    ];
    d.world.setResource(RES.quests, { active: [], completed: [WARDENS] });
    // accept() dispatches and steps one tick: the quest must be done within that tick.
    const from = d.events.length;
    d.accept(TUNNEL);
    expect(d.events.slice(from)).toContainEqual({ type: "classic.quest.done", quest: TUNNEL });
    expect(d.turnIn(TUNNEL).ok).toBe(true);
    expect(d.quests().completed).toContain(TUNNEL);
  });

  it("retroactive: every killBoss quest completes at once when its boss depth was already cleared", () => {
    // Collects every failing quest (not just the first), so one report lists them all.
    const failing: string[] = [];
    for (const [id, qp] of QUESTS) {
      if (qp.kind !== "killBoss") continue;
      const d = new Driver("classic.warrior");
      d.setLevel(qp.reqLevel);
      dungeonOf(d.world).bossesKilled = [monster(qp.target).boss?.depth ?? 1];
      if (qp.after !== "") d.world.setResource(RES.quests, { active: [], completed: [qp.after] });
      // accept() dispatches and steps one tick: the quest must be done within that tick.
      const from = d.events.length;
      d.accept(id);
      const done = d.events
        .slice(from)
        .some((e) => e.type === "classic.quest.done" && e.quest === id);
      if (!done) failing.push(id);
    }
    expect(failing).toEqual([]);
  });

  it("reward item falls back to the stash when the bag is full", () => {
    // Quest rewards never vanish: a full bag sends the reward item to the stash.
    const d = new Driver("classic.warrior");
    d.setLevel(6);
    d.accept(WARDENS);
    finish(d, WARDENS);
    fillBag(d.world, d.sim.loaded.registry);
    const stashBefore = stashOf(d.world).items.length;
    expect(d.turnIn(WARDENS).ok).toBe(true);
    expect(stashOf(d.world).items.length).toBe(stashBefore + 1);
  });
});

describe("quests: the whole chain", () => {
  it("runs every quest to completed, with every id in QuestState.completed and Trusted by the Town unlocked", () => {
    const d = new Driver("classic.warrior");
    runChain(d);
    // Achievements are checked every ACHIEVEMENT_CHECK_EVERY ticks.
    d.step(ACHIEVEMENT_CHECK_EVERY);
    const completed = d.quests().completed;
    for (const [id] of QUESTS) expect(completed, id).toContain(id);
    expect(completed.length).toBe(QUESTS.length);
    expect(d.quests().active).toEqual([]);
    const unlocked = d.events.filter(
      (e) => e.type === "classic.achievement.unlocked" && e.name === "Trusted by the Town",
    );
    expect(unlocked.length, "Trusted by the Town unlocked").toBe(1);
  }, 120_000);

  it("the same script gives the same hash (determinism)", () => {
    const a = new Driver("classic.sorcerer");
    const b = new Driver("classic.sorcerer");
    runChain(a);
    runChain(b);
    expect(a.sim.hash()).toBe(b.sim.hash());
    expect(a.sim.tick).toBe(b.sim.tick);
  }, 120_000);
});

describe("quests: Idle and Auto, per class", () => {
  for (const cls of CLASSES) {
    it(`${cls}: Idle accepts and turns in Rats in the Cellar and accepts Deeper Still on its own`, () => {
      const d = new Driver(cls, "idle");
      const turned = d.until(9000, (e) => e.type === "classic.quest.completed" && e.quest === RATS);
      expect(turned, "Idle never turned in Rats in the Cellar in 9000 ticks").toBeDefined();
      // Deeper Still may be accepted in the same tick as the turn-in (same visit).
      const isDeeper = (e: ClassicEvent): boolean =>
        e.type === "classic.quest.accepted" && e.quest === DEEPER;
      const deeper =
        d.events.slice(d.events.indexOf(turned!) + 1).find(isDeeper) ?? d.until(6000, isDeeper);
      expect(deeper, "Idle never accepted Deeper Still in 6000 more ticks").toBeDefined();
    }, 90_000);

    it(`${cls}: Auto completes Clear the Crypt once it is active and the hero reached depth 4`, () => {
      // A hero that really reached depth 4 has the waypoints of depths 1 and 3.
      // Level 18 and 6 rare items keep the run short (see CRYPT_BUDGET).
      const d = new Driver(cls, "auto");
      d.setLevel(18);
      d.grantGear(18);
      const dungeon = dungeonOf(d.world);
      dungeon.deepest = 4;
      dungeon.waypoints = [0, 1, 3];
      d.world.setResource(RES.quests, {
        active: [{ id: CLEAR, progress: 0, done: false }],
        completed: [],
      });
      const done = d.until(
        CRYPT_BUDGET,
        (e) => e.type === "classic.quest.completed" && e.quest === CLEAR,
      );
      expect(done, `Auto never turned in Clear the Crypt in ${CRYPT_BUDGET} ticks`).toBeDefined();
      expect(d.events).toContainEqual({ type: "classic.quest.done", quest: CLEAR });
      expect(d.quests().completed).toContain(CLEAR);
    }, 120_000);

    it(`${cls}: Auto accepts a chained quest in the same visit its prerequisite is turned in`, () => {
      const d = new Driver(cls, "auto");
      d.setLevel(14);
      dungeonOf(d.world).deepest = 4;
      d.world.setResource(RES.quests, {
        active: [{ id: WARDENS, progress: 1, done: true }],
        completed: [],
      });
      const turnedIn = d.until(
        6000,
        (e) => e.type === "classic.quest.completed" && e.quest === WARDENS,
      );
      expect(turnedIn, "Auto never turned in The Warden's Rest").toBeDefined();
      // The same visit: no change of area into the dungeon between the turn-in and the accept.
      // The accept can come in the same tick as the turn-in, so the events already
      // recorded after the turn-in are looked at first.
      const sameVisit = (e: ClassicEvent): boolean =>
        (e.type === "classic.quest.accepted" && e.quest === TUNNEL) ||
        (e.type === "classic.area.changed" && e.depth > 0);
      const from = d.events.indexOf(turnedIn!);
      const accepted = d.events.slice(from + 1).find(sameVisit) ?? d.until(600, sameVisit);
      expect(accepted?.type, "Auto left town before accepting The Tunnel Mother").toBe(
        "classic.quest.accepted",
      );
    }, 120_000);
  }
});

/** Ids of the bag and stash items (for "a new item appeared" checks). */
function bagUids(world: World): number[] {
  const inv = world.get(heroOf(world), Inventory);
  const bag = inv?.items.map((e) => e.item.uid) ?? [];
  return [...bag, ...stashOf(world).items.map((i) => i.uid)];
}

function itemOf(world: World, uid: number): ItemInstance {
  const inv = world.get(heroOf(world), Inventory);
  const hit = inv?.items.find((e) => e.item.uid === uid)?.item;
  if (hit) return hit;
  const stash = stashOf(world).items.find((i) => i.uid === uid);
  if (stash) return stash;
  throw new Error(`item ${uid} not found`);
}

/** Fills the hero's bag so the next item cannot be placed (asserted with a probe item at the end). */
function fillBag(world: World, registry: Sim["loaded"]["registry"]): void {
  const hero = heroOf(world);
  const base = [...loaded.registry.all(KIND.itemBase)]
    .map(([id]) => id)
    .find((id) => !id.includes("potion"));
  if (base === undefined) throw new Error("no equipment base to fill the bag with");
  const template = (uid: number): ItemInstance => ({
    uid,
    base,
    rarity: "normal",
    ilvl: 1,
    name: "Filler",
    mods: [],
    affixes: [],
    value: 1,
  });
  let bag = world.read(hero, Inventory);
  for (let uid = 900_000; uid < 900_500; uid++) {
    const next = placeItem(registry, bag, template(uid));
    if (!next) break;
    bag = next;
  }
  world.update(hero, Inventory, { items: bag.items });
  expect(placeItem(registry, bag, template(999_999))).toBeNull();
}

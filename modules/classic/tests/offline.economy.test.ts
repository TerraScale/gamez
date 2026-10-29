/**
 * Offline economy, second pass (docs/design/offline-idle.md §3, §4.1-§4.4, §12).
 * Real classic catalog, every module. OWNER: T2-sim.
 *
 *  - upkeep measurement: alchemist potions and scrolls and smith repairs paid on
 *    Auto/Idle ticks go to AutoRate.upkeep; manual-mode purchases, smith item
 *    purchases, gambling and upgrades never do; the window halving includes it;
 *  - the grant's gold is ground + junk - upkeep, floored at 0 and capped at 3x
 *    the model (hand-built rates, concrete pinned numbers: review #8);
 *  - the model's gold factor (offlineModelGoldPct) applies;
 *  - classic.offline.summary always carries `upkeep`;
 *  - the same-tick guard (offline_twice) and a pinned-hash determinism script;
 *  - low-level calibration: per class, at L1 the model's XP before the factor is
 *    0.6-1.5x the online kill XP per minute over the following 10 minutes of
 *    Idle x1; after 5 minutes the rate path pays the measured online kill XP
 *    per minute of those 5 minutes (0.95-1.05x; no model floor, §4.3).
 */
import {
  createSim,
  defineMode,
  defineModule,
  loadMode,
  type Entity,
  type GameEvent,
  type Sim,
} from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { offlineGrant } from "../src/auto/offline.ts";
import { AUTO_RATE_WINDOW_TICKS } from "../src/auto/rate.ts";
import { Belt, Equipment, Npc, Pos, Wallet } from "../src/components.ts";
import type { ClassicEvent } from "../src/events.ts";
import { mode, modules } from "../src/index.ts";
import {
  currentDepth,
  heroOf,
  noteUpkeepGold,
  RES,
  type AutoRate,
  type RunStats,
} from "../src/resources.ts";
import { BALANCE_ID, EQUIP_SLOTS, KIND, type BalanceProto, type NpcProto } from "../src/types.ts";

const loaded = loadMode(mode, modules);
const HOUR = 3_600_000;
const MINUTE = 60_000;
const POTION = "classic.item.potion_life_1";

type Summary = Extract<ClassicEvent, { type: "classic.offline.summary" }>;

function newSim(classId: string, seed: number, control: "manual" | "idle" | "auto"): Sim {
  const sim = createSim(loaded, { seed });
  const created = sim.dispatch(ACTION.newHero, { classId, name: "Upkeep" }, null);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const ctl = sim.dispatch(ACTION.setControl, { mode: control }, null);
  expect(ctl.ok, JSON.stringify(ctl.error)).toBe(true);
  return sim;
}

function rateOf(sim: Sim): AutoRate {
  const r = sim.world.getResource<AutoRate>(RES.autoRate);
  expect(r, "classic.autoRate").toBeDefined();
  return r!;
}

function setRate(sim: Sim, r: AutoRate): void {
  sim.world.setResource<AutoRate>(RES.autoRate, r);
}

/** The town NPC entity whose proto has `role`. */
function npcOf(sim: Sim, role: NpcProto["role"]): Entity {
  for (const e of sim.world.query(Npc)) {
    const proto = sim.loaded.registry.get<NpcProto>(KIND.npc, sim.world.read(e, Npc).proto);
    if (proto?.role === role) return e;
  }
  throw new Error(`no ${role} in town`);
}

/** Puts the hero on the NPC's cell, rich, with an empty belt. */
function besideNpc(sim: Sim, npc: Entity): Entity {
  const hero = heroOf(sim.world);
  sim.world.update(hero, Pos, { ...sim.world.read(npc, Pos) });
  sim.world.update(hero, Wallet, { gold: 100_000 });
  const belt = sim.world.read(hero, Belt);
  sim.world.update(hero, Belt, {
    slots: belt.slots.map(() => ({ base: null, count: 0 })),
  });
  return hero;
}

/** Gold the step's events say was paid for upkeep (alchemist buys + repairs). */
function upkeepPaid(sim: Sim, events: readonly GameEvent[]): number {
  let sum = 0;
  for (const e of events as ClassicEvent[]) {
    if (e.type === "classic.repaired") sum += e.cost;
    if (e.type === "classic.vendor.bought") {
      const role = sim.loaded.registry.get<NpcProto>(KIND.npc, e.npc)?.role;
      if (role === "alchemist") sum += e.price;
    }
  }
  return sum;
}

function act(sim: Sim, name: string, payload: unknown): ClassicEvent[] {
  const r = sim.dispatch(name, payload, null);
  expect(r.ok, `${name}: ${JSON.stringify(r.error)}`).toBe(true);
  return r.events as ClassicEvent[];
}

function offline(sim: Sim, elapsedMs: number, xpPct?: number) {
  const payload = xpPct === undefined ? { elapsedMs } : { elapsedMs, xpPct };
  const r = sim.dispatch(ACTION.offlineProgress, payload, null);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  const summary = (r.events as ClassicEvent[]).find(
    (e): e is Summary => e.type === "classic.offline.summary",
  );
  expect(summary, "classic.offline.summary").toBeDefined();
  return summary!;
}

describe("upkeep measurement (AutoRate.upkeep, §4.1)", () => {
  it("alchemist potions and scrolls bought on an Idle tick count, folded on the tick", () => {
    const sim = newSim("classic.warrior", 7, "idle");
    sim.step(1);
    const hero = besideNpc(sim, npcOf(sim, "alchemist"));
    const before = { ...rateOf(sim) };
    expect(before.spent).toBe(0);

    const potion = act(sim, ACTION.buy, {
      npc: npcOf(sim, "alchemist"),
      index: 0,
      potion: POTION,
      count: 2,
    });
    expect(potion).toContainEqual(
      expect.objectContaining({ type: "classic.vendor.bought", price: 40 }),
    );
    const scroll = act(sim, ACTION.buy, {
      npc: npcOf(sim, "alchemist"),
      index: 0,
      potion: "tp",
      count: 1,
    });
    expect(scroll).toContainEqual(
      expect.objectContaining({ type: "classic.vendor.bought", price: 50 }),
    );
    // Noted as soon as the gold is paid; the upkeep itself moves on the next rate run.
    expect(rateOf(sim)).toMatchObject({ spent: 90, upkeep: before.upkeep });
    expect(sim.world.read(hero, Wallet).gold).toBe(100_000 - 90);

    const events = sim.step(1);
    // Whatever the controller itself bought on this tick is upkeep too.
    expect(rateOf(sim).upkeep).toBe((before.upkeep ?? 0) + 90 + upkeepPaid(sim, events));
    expect(rateOf(sim).spent).toBe(0);
  });

  it("a purchase in Manual never counts (dropped on the manual tick)", () => {
    const sim = newSim("classic.warrior", 7, "idle");
    sim.step(1);
    expect(act(sim, ACTION.setControl, { mode: "manual" })).toBeDefined();
    besideNpc(sim, npcOf(sim, "alchemist"));
    const before = { ...rateOf(sim) };
    act(sim, ACTION.buy, { npc: npcOf(sim, "alchemist"), index: 0, potion: POTION, count: 3 });
    expect(rateOf(sim).spent).toBe(60);
    sim.step(1);
    expect(rateOf(sim)).toMatchObject({ upkeep: before.upkeep, spent: 0, ticks: before.ticks });
  });

  it("a smith repair counts; a smith item purchase, a gamble and an upgrade do not", () => {
    const sim = newSim("classic.warrior", 7, "idle");
    sim.step(1);
    const smith = npcOf(sim, "smith");
    const hero = besideNpc(sim, smith);
    // Wear every durable equipped item down to 1.
    const eq = { ...sim.world.read(hero, Equipment) };
    let worn = 0;
    for (const slot of EQUIP_SLOTS) {
      const it = eq[slot];
      if (it?.dur) {
        eq[slot] = { ...it, dur: { cur: 1, max: it.dur.max } };
        worn++;
      }
    }
    expect(worn).toBeGreaterThan(0);
    sim.world.update(hero, Equipment, eq);

    const repaired = act(sim, ACTION.repair, { npc: smith, uid: 0 });
    const cost = repaired.find((e) => e.type === "classic.repaired");
    expect(cost?.type === "classic.repaired" && cost.cost).toBeGreaterThan(0);
    const paid = cost?.type === "classic.repaired" ? cost.cost : 0;
    expect(rateOf(sim).spent).toBe(paid);

    // Discretionary spending: never upkeep.
    const weapon = sim.world.read(hero, Equipment).weapon;
    expect(weapon, "the warrior starts with a weapon").toBeTruthy();
    act(sim, ACTION.upgradeItem, { npc: smith, uid: weapon!.uid });
    expect(rateOf(sim).spent).toBe(paid);
    const smithBuy = sim.dispatch(
      ACTION.buy,
      { npc: smith, index: 0, potion: null, count: 1 },
      null,
    );
    if (smithBuy.ok) expect(rateOf(sim).spent).toBe(paid);
    const gambler = npcOf(sim, "gambler");
    besideNpc(sim, gambler);
    const gambled = act(sim, ACTION.gamble, { npc: gambler, category: "ring" });
    expect(gambled.some((e) => e.type === "classic.gambled")).toBe(true);
    expect(rateOf(sim).spent).toBe(paid);

    const before = rateOf(sim).upkeep ?? 0;
    const events = sim.step(1);
    expect(rateOf(sim).upkeep).toBe(before + paid + upkeepPaid(sim, events));
  });

  it("over 6 000 Idle ticks the upkeep is exactly the potions, scrolls and repairs paid (pinned)", () => {
    const sim = newSim("classic.warrior", 7, "idle");
    let paid = 0;
    for (let i = 0; i < 6000; i++) paid += upkeepPaid(sim, sim.step(1));
    const r = rateOf(sim);
    expect(r.ticks).toBe(6000);
    expect(r.upkeep).toBe(paid);
    expect(r.upkeep).toBe(60);
  }, 120_000);

  it("noteUpkeepGold is a no-op without a rate, and the window halving includes upkeep", () => {
    const sim = newSim("classic.warrior", 7, "manual");
    noteUpkeepGold(sim.world, 99);
    expect(sim.world.getResource<AutoRate>(RES.autoRate)).toBeUndefined();

    const idle = newSim("classic.warrior", 7, "idle");
    // Deep in the dungeon nothing is bought, so the folded upkeep is ours alone.
    for (let i = 0; i < 6000 && currentDepth(idle.world) === 0; i++) idle.step(1);
    expect(currentDepth(idle.world)).toBeGreaterThan(0);
    setRate(idle, {
      ticks: AUTO_RATE_WINDOW_TICKS,
      kills: 10,
      xp: 100,
      gold: 1000,
      loot: 0,
      upkeep: 777,
      spent: 0,
    });
    noteUpkeepGold(idle.world, 25);
    const events = idle.step(1);
    expect(upkeepPaid(idle, events)).toBe(0);
    // 777 + 25 = 802, halved (floor) with the window: 401.
    expect(rateOf(idle)).toMatchObject({ ticks: 18_000, upkeep: 401, spent: 0, gold: 500 });
  }, 120_000);
});

describe("the grant's gold is net of upkeep (§4.2)", () => {
  // A fresh warrior (seed 2027), depth 1. Its model for an hour: 540 kills, 1 809 gold.
  // The rate below: 800 ground gold per 12 000 ticks = 4 800 an hour; 1 620 kills
  // (capped at 3 x 540) drop 194 normal items, 20 kept, 174 sold at 2 = 348 junk gold.
  const base = { ticks: 12_000, kills: 300, xp: 9000, gold: 800, loot: 0, spent: 0 };

  function grantWith(upkeep: number | undefined, gold = base.gold) {
    const sim = newSim("classic.warrior", 2027, "idle");
    setRate(sim, upkeep === undefined ? { ...base, gold } : { ...base, gold, upkeep });
    return offlineGrant(sim.world, sim.loaded.registry, heroOf(sim.world), HOUR, 100);
  }

  it("no upkeep: ground + junk", () => {
    expect(grantWith(0)).toMatchObject({
      source: "rate",
      kills: 1620,
      gold: 5148,
      upkeep: 0,
      found: 5148,
    });
    // A rate saved before the upkeep fields reads 0.
    expect(grantWith(undefined)).toMatchObject({ gold: 5148, upkeep: 0, found: 5148 });
  });

  it("upkeep is extrapolated like the gold and deducted", () => {
    // 300 per 12 000 ticks = 1 800 an hour: 5 148 - 1 800 = 3 348.
    expect(grantWith(300)).toMatchObject({ gold: 3348, upkeep: 1800, found: 5148 });
  });

  it("is floored at 0 when the upkeep exceeds the income", () => {
    // found 5 148 - upkeep 12 000: 0, and the card shows both (offline-idle.md §6).
    expect(grantWith(2000)).toMatchObject({ gold: 0, upkeep: 12_000, found: 5148 });
  });

  it("is still capped at 3x the model's gold after the deduction", () => {
    expect(grantWith(300, 1_000_000)).toMatchObject({
      gold: 5427,
      upkeep: 1800,
      // Capped with the gold (5 427 + 1 800), so gold = found - upkeep still holds.
      found: 7227,
    });
  });

  it("the summary always carries upkeep and found: the measured ones, and 0 / gold for the model", () => {
    const rated = newSim("classic.warrior", 2027, "idle");
    setRate(rated, { ...base, upkeep: 300 });
    expect(offline(rated, HOUR)).toMatchObject({
      source: "rate",
      gold: 3348,
      upkeep: 1800,
      found: 5148,
    });
    const broke = newSim("classic.warrior", 2027, "idle");
    setRate(broke, { ...base, upkeep: 2000 });
    expect(offline(broke, HOUR)).toMatchObject({ gold: 0, upkeep: 12_000, found: 5148 });
    const fresh = newSim("classic.warrior", 2027, "idle");
    expect(offline(fresh, HOUR)).toMatchObject({
      source: "model",
      gold: 1809,
      upkeep: 0,
      found: 1809,
    });
  });
});

describe("the model's gold factor (offlineModelGoldPct)", () => {
  const half = defineModule({
    id: "test.economy.goldpct",
    version: "0.0.1",
    deps: ["classic.content"],
    dataUpdates(reg) {
      reg.patch<BalanceProto>(KIND.balance, BALANCE_ID, (b) => {
        b.offlineModelGoldPct = 50;
      });
    },
  });
  const halfLoaded = loadMode(
    defineMode({ ...mode, modules: [...mode.modules, "test.economy.goldpct"] }),
    [...modules, half],
  );

  it("the shipped value is 100 and a patch to 50 halves the model's gold only", () => {
    expect(
      loaded.registry.require<BalanceProto>(KIND.balance, BALANCE_ID).offlineModelGoldPct,
    ).toBe(100);
    const sim = createSim(halfLoaded, { seed: 2027 });
    act(sim, ACTION.newHero, { classId: "classic.warrior", name: "Upkeep" });
    const g = offlineGrant(sim.world, sim.loaded.registry, heroOf(sim.world), HOUR, 100);
    // 1 809 x 50 % (floor) = 904; kills and XP unchanged (540 kills, 4 860 x 200 % XP).
    expect(g).toMatchObject({ source: "model", kills: 540, xp: 9720, gold: 904, upkeep: 0 });
  });
});

describe("the same-tick guard (offline_twice, §4.4)", () => {
  it("a second grant on the same tick is rejected and changes nothing; the next tick is fine", () => {
    const sim = newSim("classic.rogue", 51, "idle");
    sim.step(10);
    const first = offline(sim, HOUR);
    expect(first.xp).toBeGreaterThan(0);
    expect(sim.world.getResource<RunStats>(RES.stats)!.offlineAt).toBe(sim.tick);
    const hash = sim.hash();
    const again = sim.dispatch(ACTION.offlineProgress, { elapsedMs: HOUR }, null);
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe("offline_twice");
    expect(sim.hash()).toBe(hash);
    sim.step(1);
    expect(offline(sim, 5 * MINUTE).ms).toBe(5 * MINUTE);
    expect(sim.world.getResource<RunStats>(RES.stats)!.offlineMs).toBe(HOUR + 5 * MINUTE);
  });

  it("a zero-minute grant also sets the guard", () => {
    const sim = newSim("classic.rogue", 51, "idle");
    sim.step(1);
    expect(offline(sim, 30_000)).toMatchObject({ ms: 30_000, xp: 0, gold: 0, upkeep: 0 });
    expect(sim.world.getResource<RunStats>(RES.stats)!.offlineAt).toBe(sim.tick);
    expect(sim.dispatch(ACTION.offlineProgress, { elapsedMs: HOUR }, null).error?.code).toBe(
      "offline_twice",
    );
  });
});

describe("low-level calibration (§4.3)", () => {
  // Seed 2026, Idle x1. Pre-factor XP (xpPct 100) per minute of a 10-minute grant,
  // against the online kill XP per minute over the following 10 minutes.
  const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer"] as const;
  for (const classId of CLASSES) {
    it(`${classId}: at L1 the model is 0.6-1.5x online; after 5 minutes the rate is the online rate`, () => {
      const sim = newSim(classId, 2026, "idle");
      const grantPerMin: number[] = [];
      const killXp: number[] = [];
      for (let min = 0; min < 15; min++) {
        if (min === 0 || min === 5) {
          const g = offlineGrant(
            sim.world,
            sim.loaded.registry,
            heroOf(sim.world),
            10 * MINUTE,
            100,
          );
          expect(g.source).toBe(min === 0 ? "model" : "rate");
          grantPerMin.push(g.xp / 10);
        }
        let xp = 0;
        for (const e of sim.step(1200) as ClassicEvent[])
          if (e.type === "classic.xp" && e.reason === "kill") xp += e.amount;
        killXp.push(xp);
      }
      const online = (from: number) =>
        killXp.slice(from, from + 10).reduce((a, b) => a + b, 0) / 10;
      const trailing = killXp.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const model = grantPerMin[0]! / online(0);
      const rate = grantPerMin[1]! / trailing;
      console.log(
        `[offline.economy] ${classId}: L1 ${grantPerMin[0]}/${online(0).toFixed(1)} = ` +
          `${model.toFixed(2)}, 5 min ${grantPerMin[1]}/${trailing.toFixed(1)} (measured) = ${rate.toFixed(2)}`,
      );
      expect(model).toBeGreaterThanOrEqual(0.6);
      expect(model).toBeLessThanOrEqual(1.5);
      expect(rate).toBeGreaterThanOrEqual(0.95);
      expect(rate).toBeLessThanOrEqual(1.05);
    }, 180_000);
  }
});

/** A fixed script: 6 000 Idle ticks (rate path), an offline hour, 100 ticks. */
function script(): Sim {
  const sim = newSim("classic.sorcerer", 53, "idle");
  sim.step(6000);
  expect(offline(sim, HOUR).source).toBe("rate");
  sim.step(100);
  return sim;
}

describe("determinism", () => {
  it("same seed and script give the same hash, pinned", () => {
    const a = script();
    expect(script().hash()).toBe(a.hash());
    expect(a.hash()).toBe("1747be8492f3c640");
  }, 120_000);
});

/**
 * Requirement (offline-idle.md §3, QA verifier "gold for rogue and warrior is
 * zero"): offline gold is the online Idle farming net, not a bonus. Over the
 * same 20 minutes a hero earns online (ground gold + vendor sales - alchemist
 * potions/scrolls - smith repairs), the 20-minute grant pays about that, and 0
 * when the online net is negative. Quest and achievement gold are one-offs a
 * grant never repeats; smith purchases and gambling are discretionary.
 * Measured (seed: online farm net -> grant gold): warrior 7: -662 -> 0,
 * rogue 41: 702 -> 680; 60-minute probes show the online wallet flat for both
 * classes (potions eat what Idle finds), so a 0 here matches the online play.
 */
describe("offline gold tracks the online Idle farming net (requirement)", () => {
  const SPAN = 24_000; // 20 min at x1: inside the rate window, which is not halved yet.

  function farm(classId: string, seed: number) {
    const sim = newSim(classId, seed, "idle");
    let found = 0;
    let upkeep = 0;
    for (let i = 0; i < SPAN; i++) {
      const events = sim.step(1);
      upkeep += upkeepPaid(sim, events);
      for (const e of events as ClassicEvent[]) {
        if (e.type === "classic.gold" && e.reason === "pickup") found += e.amount;
        else if (e.type === "classic.vendor.sold") found += e.price;
      }
    }
    expect(rateOf(sim).upkeep).toBe(upkeep);
    const g = offlineGrant(sim.world, sim.loaded.registry, heroOf(sim.world), 20 * MINUTE, 100);
    return { sim, online: found - upkeep, pickupAndSales: found, upkeep, g };
  }

  it.each([
    ["classic.warrior", 7, 0, -662],
    ["classic.rogue", 41, 680, 702],
  ] as const)(
    "%s seed %i: grant gold %i for an online farm net of %i",
    (classId, seed, gold, online) => {
      const r = farm(classId, seed);
      expect(r.g.source).toBe("rate");
      // The upkeep deducted is exactly what was paid online over the span.
      expect(r.g.upkeep).toBe(r.upkeep);
      expect(r.online).toBe(online);
      expect(r.g.gold).toBe(gold);
      // The card's numbers add up, and the grant is the online net within the
      // junk-sale estimate (found = ground gold + estimated junk sales).
      expect(r.g.gold).toBe(Math.max(0, r.g.found - r.g.upkeep));
      expect(Math.abs(r.g.gold - Math.max(0, r.online))).toBeLessThanOrEqual(
        Math.max(100, Math.floor(r.pickupAndSales * 0.15)),
      );
    },
    120_000,
  );
});

/**
 * Wave A event -> visual table (docs/design/wave-A.md §10.1): every new event
 * has visuals, the new EFFECT_TABLE rows carry a particle style, telegraphs
 * fill for ticks x 50 / speed ms and their shapes keep the classic angles.
 */
import type { GameEvent } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import {
  EFFECT_TABLE,
  planEvent,
  STEP_RAD,
  telegraphSpec,
  type EffectEnv,
  type Visual,
} from "../src/client/effects.ts";
import { RARITY_COLOR } from "../src/client/contract.ts";
import { spawnTestHero, testSim, useOpenMap } from "./support/harness.ts";
import { SUB } from "../src/fixed.ts";
import { Talents } from "../src/components.ts";

const STYLES = [
  "spark",
  "ember",
  "frost",
  "poison",
  "arcane",
  "holy",
  "shadow",
  "blood",
  "dust",
  "gold",
];

const NEW_ROWS = [
  "fx.quake_stomp",
  "fx.iron_skin",
  "fx.sky_leap",
  "fx.piercing_shot",
  "fx.caltrops",
  "fx.night_volley",
  "fx.glacial_spike",
  "fx.storm_call",
  "fx.falling_star",
  "fx.boss_quake",
  "fx.boss_cleave",
  "fx.boss_rush",
  "fx.boss_meteor",
  "fx.boss_frost_nova",
  "fx.telegraph",
];

function setup(speed?: number) {
  const sim = testSim([]);
  useOpenMap(sim, 1);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
  const env: EffectEnv = {
    world: sim.world,
    registry: sim.loaded.registry,
    hero,
    heroX: 5.5,
    heroY: 5.5,
    showDamageNumbers: true,
    manual: true,
    ...(speed !== undefined ? { speed } : {}),
  };
  return { sim, hero, env };
}

const ev = (e: Record<string, unknown>): GameEvent => e as GameEvent;
const logs = (out: Visual[]): string[] => out.flatMap((v) => (v.kind === "log" ? [v.text] : []));
const toasts = (out: Visual[]) => out.flatMap((v) => (v.kind === "toast" ? [v] : []));
const floats = (out: Visual[]) => out.flatMap((v) => (v.kind === "float" ? [v] : []));

describe("effect table (wave A rows)", () => {
  it("has a row with a particle style for every new effect id", () => {
    for (const fx of NEW_ROWS) {
      const row = EFFECT_TABLE[fx];
      expect(row, fx).toBeDefined();
      expect(STYLES, fx).toContain(row?.style);
    }
  });

  it("gives every existing row a particle style too", () => {
    for (const [fx, row] of Object.entries(EFFECT_TABLE)) {
      expect(STYLES, fx).toContain(row.style);
    }
  });
});

describe("telegraph visuals", () => {
  const circle = (speed: number, ticks = 20) =>
    planEvent(
      ev({
        type: "classic.telegraph",
        entity: 0,
        caster: 0,
        skill: "classic.skill.quake",
        effect: "fx.boss_quake",
        shape: "circle",
        x: 8 * SUB,
        y: 9 * SUB,
        radius: 2 * SUB,
        angle: 0,
        arc: 0,
        length: 0,
        width: 0,
        ticks,
        fireAt: 100,
      }),
      setup(speed).env,
    );

  it("fills a circle for ticks x 50 ms at x1 and shortens with the sim speed", () => {
    const at1 = circle(1);
    expect(at1).toHaveLength(1);
    expect(at1[0]).toMatchObject({
      kind: "effect",
      spec: { kind: "telegraph", x: 8, y: 9, radius: 2, durationMs: 1000 },
    });
    const at4 = circle(4);
    expect(at4[0]).toMatchObject({ kind: "effect", spec: { durationMs: 250 } });
    const at8 = circle(8);
    expect(at8[0]).toMatchObject({ kind: "effect", spec: { durationMs: 125 } });
  });

  it("uses the telegraph colour of the effect row", () => {
    const out = circle(1);
    const spec = out[0] && out[0].kind === "effect" ? out[0].spec : null;
    expect(spec?.color).toBe(EFFECT_TABLE["fx.boss_quake"]?.color);
  });

  it("turns 64ths of a turn into radians for cones and lines", () => {
    const cone = telegraphSpec(
      {
        type: "classic.telegraph",
        entity: 0,
        caster: 0,
        skill: "",
        effect: "fx.boss_cleave",
        shape: "cone",
        x: 0,
        y: 0,
        radius: 0,
        angle: 16,
        arc: 8,
        length: 3 * SUB,
        width: 0,
        ticks: 20,
        fireAt: 0,
      },
      1,
    );
    expect(cone.kind).toBe("telegraph");
    expect(cone.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(cone.arc).toBeCloseTo(8 * STEP_RAD, 6);
    expect(cone.radius).toBe(3);
    const line = telegraphSpec(
      {
        type: "classic.telegraph",
        entity: 0,
        caster: 0,
        skill: "",
        effect: "fx.boss_rush",
        shape: "line",
        x: SUB,
        y: 2 * SUB,
        radius: 0,
        angle: 32,
        arc: 0,
        length: 4 * SUB,
        width: SUB / 2,
        ticks: 10,
        fireAt: 0,
      },
      2,
    );
    expect(line.angle).toBeCloseTo(Math.PI, 6);
    expect(line.length).toBe(4);
    expect(line.width).toBe(0.5);
    expect(line.durationMs).toBe(250);
  });
});

describe("planEvent wave A events", () => {
  it("shows a boss phase as a toast, a log line and a camera shake", () => {
    const { env } = setup();
    const out = planEvent(
      ev({
        type: "classic.boss.phase",
        entity: 0,
        monster: "classic.monster.none",
        phase: 2,
        message: "The ground splits",
        enraged: false,
      }),
      env,
    );
    expect(toasts(out)[0]).toMatchObject({ toastKind: "info", body: "The ground splits" });
    expect(logs(out)).toEqual([expect.stringContaining("The ground splits")]);
    expect(out).toContainEqual({ kind: "shake", strength: 6, ms: 400 });
  });

  it("names an enraged boss in the toast title", () => {
    const { env } = setup();
    const out = planEvent(
      ev({
        type: "classic.boss.phase",
        entity: 0,
        monster: "x",
        phase: 3,
        message: "",
        enraged: true,
      }),
      env,
    );
    expect(toasts(out)[0]?.title).toContain("enraged");
  });

  it("logs a worn item and flashes an error when an item breaks", () => {
    const { env } = setup();
    const worn = planEvent(
      ev({ type: "classic.item.worn", uid: 4, slot: "weapon", name: "Test Sword" }),
      env,
    );
    expect(logs(worn)).toEqual([expect.stringContaining("Test Sword")]);
    const broke = planEvent(
      ev({ type: "classic.item.broken", uid: 4, slot: "weapon", name: "Test Sword" }),
      env,
    );
    expect(logs(broke)).toEqual([expect.stringContaining("broke")]);
    expect(broke).toContainEqual({ kind: "error", code: "broken", message: "Test Sword broke" });
  });

  it("logs a gamble and toasts only the unique and set results", () => {
    const { env } = setup();
    const common = planEvent(
      ev({
        type: "classic.gambled",
        npc: "classic.npc.mirelle",
        category: "armor",
        name: "Plain Vest",
        rarity: "normal",
        price: 40,
      }),
      env,
    );
    expect(logs(common)).toEqual([expect.stringContaining("Plain Vest")]);
    expect(toasts(common)).toHaveLength(0);
    const unique = planEvent(
      ev({
        type: "classic.gambled",
        npc: "classic.npc.mirelle",
        category: "weapon",
        name: "Gift",
        rarity: "unique",
        price: 900,
      }),
      env,
    );
    expect(toasts(unique)).toHaveLength(1);
  });

  it("toasts a set bonus with the active piece count", () => {
    const { env } = setup();
    const out = planEvent(
      ev({
        type: "classic.set.bonus",
        set: "classic.set.none",
        name: "Ember Guard",
        pieces: 3,
        active: 3,
      }),
      env,
    );
    expect(toasts(out)[0]).toMatchObject({ toastKind: "loot", body: "Ember Guard: 3 pieces worn" });
    expect(logs(out)).toEqual([expect.stringContaining("Ember Guard")]);
  });

  it("floats crafting results at the hero", () => {
    const { env } = setup();
    const repaired = planEvent(ev({ type: "classic.repaired", uids: [1, 2], cost: 30 }), env);
    expect(floats(repaired)[0]).toMatchObject({ text: "Repaired", x: 5.5, y: 5.5 });
    expect(logs(repaired)[0]).toContain("2 items");
    const up = planEvent(
      ev({ type: "classic.upgraded", uid: 1, name: "Sword", level: 3, success: true, cost: 90 }),
      env,
    );
    expect(floats(up)[0]?.text).toBe("+3!");
    const failed = planEvent(
      ev({ type: "classic.upgraded", uid: 1, name: "Sword", level: 2, success: false, cost: 90 }),
      env,
    );
    expect(floats(failed)[0]?.text).toBe("Upgrade failed");
    expect(
      floats(planEvent(ev({ type: "classic.rerolled", uid: 1, name: "Sword", cost: 50 }), env))[0]
        ?.text,
    ).toBe("Rerolled");
    expect(
      floats(planEvent(ev({ type: "classic.socket.added", uid: 1, sockets: 2, cost: 60 }), env))[0]
        ?.text,
    ).toBe("Socket added");
    expect(
      floats(
        planEvent(
          ev({ type: "classic.gem.socketed", uid: 1, gem: "classic.item.gem.ruby.1", slot: 0 }),
          env,
        ),
      )[0]?.text,
    ).toBe("Socketed");
    expect(
      floats(planEvent(ev({ type: "classic.gems.removed", uid: 1, gems: ["a"], cost: 10 }), env))[0]
        ?.text,
    ).toBe("Gems removed");
    const combined = planEvent(
      ev({ type: "classic.gems.combined", from: "a", to: "b", cost: 120 }),
      env,
    );
    expect(floats(combined)[0]?.text).toBe("Combined!");
    expect(logs(combined)[0]).toContain("Combined");
  });

  it("toasts a talent point with the count and logs learned and reset talents", () => {
    const { env } = setup();
    const pts = planEvent(ev({ type: "classic.talent.points", points: 2, gained: 1 }), env);
    expect(toasts(pts)[0]).toMatchObject({ toastKind: "info", title: "Talent point (2)" });
    const learned = planEvent(
      ev({ type: "classic.talent.learned", node: "classic.talent.warrior.iron", rank: 2 }),
      env,
    );
    expect(logs(learned)[0]).toContain("(rank 2)");
    const reset = planEvent(ev({ type: "classic.talents.reset", refunded: 5, cost: 500 }), env);
    expect(logs(reset)[0]).toContain("5 points refunded");
  });

  it("toasts only the talent points still unspent after the step (Auto spends them)", () => {
    const { sim, hero, env } = setup();
    sim.world.add(hero, Talents, { points: 0, spent: 3, ranks: [], levelSeen: 4 });
    const spent = planEvent(ev({ type: "classic.talent.points", points: 1, gained: 1 }), env);
    expect(toasts(spent)).toEqual([]);
    sim.world.update(hero, Talents, { points: 2 });
    const left = planEvent(ev({ type: "classic.talent.points", points: 3, gained: 1 }), env);
    expect(toasts(left)[0]?.title).toBe("Talent point (2)");
  });

  it("opens the rift panel on the obelisk and reports the rift life cycle", () => {
    const { env } = setup();
    expect(planEvent(ev({ type: "classic.rift.panel" }), env)).toContainEqual({
      kind: "panel",
      panel: "rift",
    });
    expect(toasts(planEvent(ev({ type: "classic.rift.unlocked" }), env))[0]?.title).toBe(
      "Rift unlocked",
    );
    expect(
      toasts(
        planEvent(
          ev({ type: "classic.rift.opened", level: 2, depth: 100002, fee: 5, run: 1 }),
          env,
        ),
      )[0]?.title,
    ).toBe("Rift level 2");
    expect(logs(planEvent(ev({ type: "classic.rift.progress", pct: 40 }), env))[0]).toContain(
      "40%",
    );
    expect(
      toasts(
        planEvent(
          ev({ type: "classic.rift.guardian", entity: 0, monster: "m", name: "Warden" }),
          env,
        ),
      )[0]?.body,
    ).toBe("Warden");
    const record = {
      level: 1,
      ticks: 900,
      score: 1234,
      deaths: 0,
      completed: true,
      reason: "",
      heroLevel: 12,
      classId: "classic.warrior",
      heroName: "Tester",
      worldSeed: 1,
      endTick: 999,
      run: 1,
    };
    const done = planEvent(
      ev({ type: "classic.rift.completed", record, gold: 300, items: 2 }),
      env,
    );
    expect(toasts(done)[0]).toMatchObject({ title: "Rift complete", ms: 7000 });
    expect(toasts(done)[0]?.body).toContain("1234");
    const failed = planEvent(
      ev({ type: "classic.rift.failed", record: { ...record, completed: false, reason: "death" } }),
      env,
    );
    expect(toasts(failed)[0]?.title).toBe("Rift failed");
    expect(logs(failed)[0]).toContain("fell");
  });

  it("toasts an achievement with its reward and the title it grants", () => {
    const { env } = setup();
    const out = planEvent(
      ev({
        type: "classic.achievement.unlocked",
        id: "a",
        name: "First Blood",
        gold: 50,
        title: "the Bold",
      }),
      env,
    );
    expect(toasts(out)[0]).toMatchObject({
      title: "Achievement: First Blood",
      body: '+50 gold - title "the Bold"',
    });
    const plain = planEvent(
      ev({ type: "classic.achievement.unlocked", id: "b", name: "Tidy", gold: 10, title: null }),
      env,
    );
    expect(toasts(plain)[0]?.body).toBe("+10 gold");
  });

  it("opens the gamble panel for the gambler and vendors for the others", () => {
    const { env } = setup();
    const gambler = planEvent(
      ev({ type: "classic.npc.opened", npc: 9, proto: "classic.npc.mirelle", role: "gambler" }),
      env,
    );
    expect(gambler).toContainEqual({ kind: "gambler", npc: 9 });
    expect(gambler).toContainEqual({ kind: "panel", panel: "gamble" });
    expect(gambler.some((v) => v.kind === "vendor")).toBe(false);
  });

  it("keeps rarity colours for set and gem loot labels", () => {
    expect(RARITY_COLOR.set).toBeGreaterThan(0);
    const { env } = setup();
    const out = planEvent(
      ev({
        type: "classic.loot.dropped",
        entity: 0,
        kind: "item",
        name: "Set Gem",
        rarity: "set",
        x: 0,
        y: 0,
      }),
      env,
    );
    expect(out.some((v) => v.kind === "log")).toBe(true);
  });
});

/** Event -> visual table of the client (docs/design/classic.md §12.3). */
import type { GameEvent } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { EFFECT_TABLE, effectSpec, planEvent, type EffectEnv } from "../src/client/effects.ts";
import { ELEMENT_COLOR, GOLD_COLOR } from "../src/client/contract.ts";
import { spawnTestHero, spawnTestMonster, testSim, useOpenMap } from "./support/harness.ts";
import { tileCenter } from "../src/fixed.ts";
import { SKILLS } from "../src/content/skills.ts";

function setup() {
  const sim = testSim([]);
  useOpenMap(sim, 1);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
  const monster = spawnTestMonster(sim.world, { x: 8, y: 5 });
  const env: EffectEnv = {
    world: sim.world,
    registry: sim.loaded.registry,
    hero,
    heroX: 5.5,
    heroY: 5.5,
    showDamageNumbers: true,
    manual: true,
  };
  return { sim, hero, monster, env };
}

const ev = (e: Record<string, unknown>): GameEvent => e as GameEvent;

describe("planEvent", () => {
  it("turns a critical hit into a large element-coloured float and a log line", () => {
    const { monster, hero, env } = setup();
    const out = planEvent(
      ev({
        type: "classic.hit",
        source: hero,
        target: monster,
        skill: "test.skill.strike",
        amount: 12,
        element: "fire",
        crit: true,
        dot: false,
        heroHit: false,
        byHero: true,
        x: tileCenter(8),
        y: tileCenter(5),
      }),
      env,
    );
    const float = out.find((v) => v.kind === "float");
    expect(float).toMatchObject({
      text: "12!",
      size: "l",
      color: ELEMENT_COLOR.fire,
      x: 8.5,
      y: 5.5,
    });
    expect(out).toContainEqual(
      expect.objectContaining({ kind: "log", logKind: "combat", color: GOLD_COLOR }),
    );
  });

  it("hides damage numbers when the setting is off", () => {
    const { monster, hero, env } = setup();
    const out = planEvent(
      ev({
        type: "classic.hit",
        source: hero,
        target: monster,
        skill: "x",
        amount: 3,
        element: "phys",
        crit: false,
        dot: false,
        heroHit: false,
        byHero: true,
        x: 0,
        y: 0,
      }),
      { ...env, showDamageNumbers: false },
    );
    expect(out.some((v) => v.kind === "float")).toBe(false);
  });

  it("opens the vendor panel for a smith and the quest panel for the quest giver", () => {
    const { env } = setup();
    const smith = planEvent(
      ev({ type: "classic.npc.opened", npc: 3, proto: "test.npc.smith", role: "smith" }),
      env,
    );
    expect(smith).toContainEqual({ kind: "vendor", npc: 3 });
    expect(smith).toContainEqual({ kind: "panel", panel: "vendor" });
    const quest = planEvent(
      ev({ type: "classic.npc.opened", npc: 4, proto: "test.npc.quest", role: "quest" }),
      env,
    );
    expect(quest).toContainEqual({ kind: "panel", panel: "quests" });
  });

  it("raises a level-up toast and an effect at the hero", () => {
    const { env } = setup();
    const out = planEvent(
      ev({ type: "classic.levelUp", level: 3, statPoints: 5, skillPoints: 1 }),
      env,
    );
    expect(out.find((v) => v.kind === "toast")).toMatchObject({
      toastKind: "levelUp",
      title: "Level 3",
    });
    expect(out).toContainEqual(expect.objectContaining({ kind: "effect" }));
  });

  it("shows command failures as errors only in manual mode", () => {
    const { env } = setup();
    const failed = ev({
      type: "classic.command.failed",
      op: "pickup",
      code: "too_far",
      message: "Too far",
    });
    expect(planEvent(failed, env).some((v) => v.kind === "error")).toBe(true);
    expect(planEvent(failed, { ...env, manual: false }).some((v) => v.kind === "error")).toBe(
      false,
    );
  });

  it("ignores unknown events", () => {
    const { env } = setup();
    expect(planEvent(ev({ type: "steps.attack" }), env)).toEqual([]);
  });
});

describe("effect table", () => {
  it("maps effect ids to renderer kinds with element colours", () => {
    expect(effectSpec("fx.frost_ring", 1, 2)).toMatchObject({
      kind: "nova",
      color: ELEMENT_COLOR.cold,
    });
    expect(effectSpec("fx.arc_chain", 1, 2).kind).toBe("chain");
    expect(effectSpec("fx.unknown", 1, 2)).toMatchObject({ kind: "cast" });
    expect(Object.keys(EFFECT_TABLE)).toContain("fx.charge");
  });

  it("uses the event radius in sub units when given", () => {
    expect(effectSpec("fx.frost_ring", 0, 0, 512).radius).toBe(2);
  });
});

describe("effect table coverage (regression)", () => {
  it("has a row for every effect id a classic skill declares", () => {
    const missing = Object.entries(SKILLS)
      .map(([, s]) => s.effect)
      .filter((fx) => fx !== "" && EFFECT_TABLE[fx] === undefined);
    expect([...new Set(missing)]).toEqual([]);
  });

  it("logs controller notices (stash full, travel loop, kill drought)", () => {
    const { env } = setup();
    const out = planEvent(
      ev({ type: "classic.auto.notice", code: "stash_full", message: "Stash is full" }),
      env,
    );
    expect(out).toContainEqual(expect.objectContaining({ kind: "log", text: "Stash is full" }));
  });
});

/** Event -> visual table of the client (docs/design/classic.md §12.3). */
import type { GameEvent } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import {
  EFFECT_TABLE,
  HEAL_COLOR,
  castFailMessage,
  effectSpec,
  floatPolicy,
  planEvent,
  type EffectEnv,
} from "../src/client/effects.ts";
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

  it("shows the hero's failed casts as an error with a readable message", () => {
    const { env, hero } = setup();
    const out = planEvent(
      ev({
        type: "classic.cast.failed",
        caster: hero,
        skill: "test.skill.strike",
        code: "no_mana",
      }),
      env,
    );
    expect(out).toContainEqual({ kind: "error", code: "no_mana", message: "Not enough mana" });
    for (const [code, message] of [
      ["cooldown", "Not ready yet"],
      ["too_far", "Out of range"],
      ["busy", "You are busy"],
    ] as const) {
      const o = planEvent(ev({ type: "classic.cast.failed", caster: hero, skill: "x", code }), env);
      expect(o).toContainEqual(expect.objectContaining({ kind: "error", message }));
    }
  });

  it("falls back to naming the skill for unmapped cast failure codes", () => {
    expect(castFailMessage("something_new", "Cleave")).toBe("Cannot cast Cleave");
  });

  it("shows nothing for a failed cast by a monster", () => {
    const { env, monster } = setup();
    const out = planEvent(
      ev({ type: "classic.cast.failed", caster: monster, skill: "x", code: "cooldown" }),
      env,
    );
    expect(out).toEqual([]);
  });

  it("skips the heal float when nothing was healed", () => {
    const { env, hero } = setup();
    const none = planEvent(ev({ type: "classic.heal", target: hero, amount: 0, x: 0, y: 0 }), env);
    expect(none.some((v) => v.kind === "float")).toBe(false);
    const some = planEvent(ev({ type: "classic.heal", target: hero, amount: 7, x: 0, y: 0 }), env);
    expect(some).toContainEqual(
      expect.objectContaining({ kind: "float", text: "+7", color: HEAL_COLOR }),
    );
  });

  it("pluralises the level-up toast body", () => {
    const { env } = setup();
    const one = planEvent(
      ev({ type: "classic.levelUp", level: 2, statPoints: 1, skillPoints: 1 }),
      env,
    );
    expect(one.find((v) => v.kind === "toast")).toMatchObject({
      body: "+1 attribute point, +1 skill point",
    });
    const many = planEvent(
      ev({ type: "classic.levelUp", level: 3, statPoints: 5, skillPoints: 2 }),
      env,
    );
    expect(many.find((v) => v.kind === "toast")).toMatchObject({
      body: "+5 attribute points, +2 skill points",
    });
  });
});

/** True when every channel is at least 0xc0 (a near-white colour). */
function isNearWhite(color: number): boolean {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return Math.min(r, g, b) >= 0xc0;
}

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

  it("keeps rally off the level-up visual and mend off the poison colour", () => {
    expect(EFFECT_TABLE["fx.rally"]?.kind).not.toBe("levelup");
    expect(EFFECT_TABLE["fx.mend"]?.color).not.toBe(ELEMENT_COLOR.poison);
    expect(EFFECT_TABLE["fx.mend"]?.color).toBe(HEAL_COLOR);
  });

  it("gives whirl, charge, tumble and claw readable colours on sand and stone", () => {
    for (const fx of ["fx.whirl", "fx.charge", "fx.tumble", "fx.claw"]) {
      const color = EFFECT_TABLE[fx]?.color ?? 0;
      expect(isNearWhite(color), fx).toBe(false);
      expect(color, fx).not.toBe(0xffffff);
    }
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

describe("float volume by sim speed", () => {
  it("keeps every float at x1/x2 and thins them out from x4", () => {
    expect(floatPolicy(1)).toEqual({
      dropMinor: false,
      ms: undefined,
      perBatch: Number.POSITIVE_INFINITY,
    });
    expect(floatPolicy(2).dropMinor).toBe(false);
    const x4 = floatPolicy(4);
    const x8 = floatPolicy(8);
    expect(x4.dropMinor && x8.dropMinor).toBe(true);
    expect(x8.ms!).toBeLessThan(x4.ms!);
    expect(x4.ms!).toBeLessThan(900);
    expect(x8.perBatch).toBeLessThanOrEqual(x4.perBatch);
  });
});

describe("hits on the hero", () => {
  it("names the attacker, or says 'You are hit' when the source is gone", () => {
    const { monster, hero, env, sim } = setup();
    const hit = (source: number) =>
      planEvent(
        ev({
          type: "classic.hit",
          source,
          target: hero,
          skill: "test.mskill.bite",
          amount: 4,
          element: "phys",
          crit: false,
          dot: false,
          heroHit: true,
          byHero: false,
          x: tileCenter(5),
          y: tileCenter(5),
        }),
        env,
      ).find((v) => v.kind === "log");
    expect(hit(monster)).toMatchObject({ text: "Dummy hits you for 4" });
    sim.world.destroy(monster);
    expect(hit(monster)).toMatchObject({ text: "You are hit for 4" });
  });
});

describe("arc swings (cleave) and oriented slashes", () => {
  /** Real content (classic.skill.cleave is an arc skill). */
  function realSetup() {
    const sim = testSim([], { content: "real" });
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
    };
    return { sim, hero, env };
  }

  it("draws a cleave classic.effect as a slash oriented at the aim tip, not a ring", () => {
    const { env } = realSetup();
    const effect = SKILLS["classic.skill.cleave"]!.effect;
    const out = planEvent(
      ev({
        type: "classic.effect",
        effect,
        x: tileCenter(5),
        y: tileCenter(5),
        radius: 461,
        points: [{ x: tileCenter(5) + 461, y: tileCenter(5) }],
      }),
      env,
    );
    const fx = out.filter((v) => v.kind === "effect");
    expect(fx).toHaveLength(1);
    const spec = (fx[0] as Extract<(typeof out)[number], { kind: "effect" }>).spec;
    expect(spec.kind).toBe("slash");
    expect(spec).toMatchObject({ x: 5.5, y: 5.5, y2: 5.5, sprite: effect });
    expect(spec.x2).toBeCloseTo(5.5 + 461 / 256, 6);
    expect(spec.radius).toBeCloseTo(461 / 256, 6);
    expect(spec.points).toBeUndefined();
    expect(spec.color).toBe(EFFECT_TABLE[effect]!.color);
  });

  it("skips the cast-time visual of an arc skill by a real caster (no double slash)", () => {
    const { env, hero } = realSetup();
    const cast = (caster: number) =>
      planEvent(
        ev({
          type: "classic.cast",
          caster,
          skill: "classic.skill.cleave",
          effect: SKILLS["classic.skill.cleave"]!.effect,
          x: tileCenter(5),
          y: tileCenter(5),
          tx: tileCenter(6),
          ty: tileCenter(5),
        }),
        env,
      ).filter((v) => v.kind === "effect");
    expect(cast(hero)).toHaveLength(0);
    // Without a live caster (the art gallery's previews) the cast still draws it.
    expect(cast(0)).toHaveLength(1);
  });

  it("orients a melee cast slash toward its target point", () => {
    const { env, hero } = realSetup();
    const out = planEvent(
      ev({
        type: "classic.cast",
        caster: hero,
        skill: "classic.skill.attack",
        effect: "fx.attack",
        x: tileCenter(5),
        y: tileCenter(5),
        tx: tileCenter(5),
        ty: tileCenter(7),
      }),
      env,
    );
    const fx = out.find((v) => v.kind === "effect");
    expect(fx).toMatchObject({ spec: { kind: "slash", x: 5.5, y: 5.5, x2: 5.5, y2: 7.5 } });
  });
});

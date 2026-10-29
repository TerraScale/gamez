/** Party feedback in effects.ts: per-hero floats, levels, logs and heals on allies (docs/design/party.md §10.5). */
import type { GameEvent } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import type { Entity } from "@gamez/kernel";
import { Dead, Hero } from "../src/components.ts";
import { HEAL_COLOR, planEvent, XP_COLOR, type EffectEnv } from "../src/client/effects.ts";
import { GOLD_COLOR } from "../src/client/contract.ts";
import { spawnTestParty, testSim, useOpenMap } from "./support/harness.ts";

const ev = (e: Record<string, unknown>): GameEvent => e as GameEvent;

/** Warrior (controlled), Brannoc the rogue and Celene the sorcerer. */
function setup() {
  const sim = testSim([]);
  useOpenMap(sim, 1);
  const [warrior, rogue, sorcerer] = spawnTestParty(sim.world, [
    { classId: "classic.warrior", x: 5, y: 5 },
    { classId: "classic.rogue", x: 6, y: 5 },
    { classId: "classic.sorcerer", x: 7, y: 5 },
  ]);
  sim.world.update(rogue!, Hero, { name: "Brannoc" });
  sim.world.update(sorcerer!, Hero, { name: "Celene" });
  const env: EffectEnv = {
    world: sim.world,
    registry: sim.loaded.registry,
    hero: warrior!,
    heroX: 5.5,
    heroY: 5.5,
    showDamageNumbers: true,
    manual: false,
  };
  return {
    sim,
    env,
    warrior: warrior as Entity,
    rogue: rogue as Entity,
    sorcerer: sorcerer as Entity,
  };
}

describe("party feedback: floats belong to the controlled hero", () => {
  it("XP floats only for the controlled hero (no hero field = the controlled hero)", () => {
    const { env, rogue } = setup();
    const mine = planEvent(ev({ type: "classic.xp", amount: 12, total: 12, reason: "kill" }), env);
    expect(mine).toContainEqual(
      expect.objectContaining({ kind: "float", text: "+12 XP", color: XP_COLOR }),
    );
    const theirs = planEvent(
      ev({ type: "classic.xp", amount: 12, total: 12, reason: "kill", hero: rogue }),
      env,
    );
    expect(theirs.some((v) => v.kind === "float")).toBe(false);
  });

  it("gold floats only for the controlled hero", () => {
    const { env, rogue, warrior } = setup();
    const theirs = planEvent(
      ev({ type: "classic.gold", amount: 9, total: 30, reason: "loot", hero: rogue }),
      env,
    );
    expect(theirs.some((v) => v.kind === "float")).toBe(false);
    const mine = planEvent(
      ev({ type: "classic.gold", amount: 9, total: 30, reason: "loot", hero: warrior }),
      env,
    );
    expect(mine).toContainEqual(
      expect.objectContaining({ kind: "float", text: "+9 gold", color: GOLD_COLOR }),
    );
  });

  it("heals on allies show a green number, smaller than the controlled hero's", () => {
    const { env, rogue, warrior } = setup();
    const ally = planEvent(
      ev({ type: "classic.heal", target: rogue, amount: 7, x: 6 * 256, y: 5 * 256 }),
      env,
    );
    expect(ally).toContainEqual(
      expect.objectContaining({ kind: "float", text: "+7", color: HEAL_COLOR, size: "s" }),
    );
    const own = planEvent(
      ev({ type: "classic.heal", target: warrior, amount: 7, x: 5 * 256, y: 5 * 256 }),
      env,
    );
    expect(own).toContainEqual(expect.objectContaining({ kind: "float", size: "m" }));
  });
});

describe("party feedback: levels, downs and logs", () => {
  it("a follower's level-up is a sparkle and a log line, with no toast", () => {
    const { env, rogue } = setup();
    const out = planEvent(
      ev({ type: "classic.levelUp", level: 5, statPoints: 2, skillPoints: 1, hero: rogue }),
      env,
    );
    expect(out.some((v) => v.kind === "toast")).toBe(false);
    expect(out).toContainEqual(
      expect.objectContaining({
        kind: "effect",
        spec: expect.objectContaining({ kind: "levelup", radius: 1 }),
      }),
    );
    expect(out).toContainEqual(
      expect.objectContaining({ kind: "log", text: "Brannoc reached level 5" }),
    );
  });

  it("the controlled hero's level-up keeps the toast and the big effect", () => {
    const { env, warrior } = setup();
    const out = planEvent(
      ev({ type: "classic.levelUp", level: 5, statPoints: 2, skillPoints: 1, hero: warrior }),
      env,
    );
    expect(out.find((v) => v.kind === "toast")).toMatchObject({ toastKind: "levelUp" });
    expect(out).toContainEqual(
      expect.objectContaining({ kind: "effect", spec: expect.objectContaining({ radius: 2 }) }),
    );
  });

  it("a follower going down is announced by name, not as your own death", () => {
    const { env, rogue } = setup();
    expect(
      planEvent(
        ev({ type: "classic.hero.died", goldLost: 0, xpLost: 0, killer: "Ogre", hero: rogue }),
        env,
      ),
    ).toEqual([]);
    const down = planEvent(ev({ type: "classic.party.downed", hero: rogue, name: "Brannoc" }), env);
    expect(down).toContainEqual(
      expect.objectContaining({ kind: "toast", title: "Brannoc is down" }),
    );
    expect(down).toContainEqual(expect.objectContaining({ kind: "log", text: "Brannoc is down" }));
  });

  it("logs the controlled hero's hits, but not hits made by a follower", () => {
    const { env, rogue, warrior, sim } = setup();
    sim.world.add(rogue, Dead, { at: 0, killer: 0 });
    const hit = (source: Entity) =>
      ev({
        type: "classic.hit",
        source,
        target: 0,
        skill: "test.skill.strike",
        amount: 4,
        element: "phys",
        crit: false,
        dot: false,
        heroHit: false,
        byHero: true,
        x: 0,
        y: 0,
      });
    expect(planEvent(hit(warrior), env).some((v) => v.kind === "log")).toBe(true);
    expect(planEvent(hit(rogue), env).some((v) => v.kind === "log")).toBe(false);
    // The float stays for everyone.
    expect(planEvent(hit(rogue), env).some((v) => v.kind === "float")).toBe(true);
  });

  it("a control switch logs whose hero is in control", () => {
    const { env, sorcerer } = setup();
    const out = planEvent(
      ev({ type: "classic.party.control", hero: sorcerer, previous: 0, reason: "player" }),
      env,
    );
    expect(out).toContainEqual(
      expect.objectContaining({ kind: "log", text: "Controlling Celene" }),
    );
  });

  it("a wiped party logs once and shows no toast", () => {
    const { env } = setup();
    const out = planEvent(ev({ type: "classic.party.wiped" }), env);
    expect(out.some((v) => v.kind === "toast")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ kind: "log" }));
  });
});

describe("party feedback: sounds follow the controlled hero", () => {
  it("a follower's hurt sound is quieter, a follower's level-up is a chime, not the fanfare", async () => {
    const { sim, warrior, rogue } = setup();
    const { cueFor } = await import("../src/client/audio/cues.ts");
    const env = { registry: sim.loaded.registry, hero: warrior };
    const hurt = (target: Entity) =>
      cueFor(
        ev({
          type: "classic.hit",
          source: 0,
          target,
          skill: "test.skill.strike",
          amount: 3,
          element: "phys",
          crit: false,
          dot: false,
          heroHit: true,
          byHero: false,
          x: 0,
          y: 0,
        }),
        env,
      );
    const mine = hurt(warrior);
    const theirs = hurt(rogue);
    expect(mine?.key).toBe("hit.hero");
    expect(theirs?.key).toBe("hit.party");
    expect(theirs!.vol).toBeLessThan(mine!.vol);
    const up = cueFor(
      ev({ type: "classic.levelUp", level: 5, statPoints: 1, skillPoints: 1, hero: rogue }),
      env,
    );
    expect(up?.key).toBe("levelUp.party");
    expect(up?.prio).toBeLessThan(2);
    expect(
      cueFor(ev({ type: "classic.party.downed", hero: rogue, name: "Brannoc" }), env)?.key,
    ).toBe("party.downed");
    expect(cueFor(ev({ type: "classic.party.wiped" }), env)?.key).toBe("party.wiped");
  });
});

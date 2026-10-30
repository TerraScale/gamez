/**
 * Balance rules of arena.core 1.1.0 (docs/bench/2026-10-arena-balance.md):
 * a skill shares the attack slot with the basic attack, and a caster's basic
 * attack reaches as far as its longest damaging skill.
 */
import { describe, expect, it } from "vite-plus/test";
import { fight } from "../src/index.ts";
import { ARENA_MAX_TICKS } from "../src/constants.ts";
import { build, skill } from "./helpers.ts";

describe("shared attack slot and caster reach (arena.core 1.1.0)", () => {
  it("a skill takes the attack slot: strikes never beat one attack per interval", () => {
    // attackRate 20 gives one basic every 5 ticks. A 1-cooldown skill would add a
    // strike every tick if skills did not share the slot.
    const busy = build({
      maxHp: 100_000,
      dmgMin: 1,
      dmgMax: 1,
      attackRate: 20,
      armor: 0,
      resist: 0,
      critPct: 0,
      skills: [skill({ power: 100, cooldown: 1, range: 1 })],
    });
    const dummy = build({
      accountId: "acc-d",
      maxHp: 100_000,
      dmgMin: 1,
      dmgMax: 1,
      attackRate: 1,
      armor: 0,
      resist: 0,
      critPct: 0,
    });
    const r = fight(busy, dummy, 4, { frames: true });
    expect(r.ticks).toBe(ARENA_MAX_TICKS);
    const strikes = r.frames!.filter(
      (f) => f.attacker.action !== null && f.attacker.action !== "Advance",
    );
    expect(strikes.length).toBeLessThanOrEqual(Math.ceil(ARENA_MAX_TICKS / 5) + 1);
    expect(strikes.length).toBeGreaterThan(ARENA_MAX_TICKS / 5 - 5);
  });

  it("a caster's first basic attack comes from its skill range, not from melee", () => {
    const caster = build({
      maxHp: 1000,
      dmgMin: 1,
      dmgMax: 1,
      attackRate: 10,
      moveSpeed: 1,
      armor: 0,
      resist: 0,
      critPct: 0,
      skills: [skill({ kind: "projectile", power: 100, cooldown: 400, range: 8 })],
    });
    const tank = build({
      accountId: "acc-t",
      maxHp: 100_000,
      dmgMin: 1,
      dmgMax: 1,
      attackRate: 1,
      moveSpeed: 1,
      armor: 0,
      resist: 0,
      critPct: 0,
    });
    const r = fight(caster, tank, 6, { frames: true });
    const first = r.frames!.find((f) => f.attacker.action === "Attack");
    expect(first).toBeDefined();
    expect(Math.abs(first!.defender.x - first!.attacker.x)).toBeGreaterThan(10);
  });
});

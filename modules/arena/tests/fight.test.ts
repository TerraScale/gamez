import { createSim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { arenaLoaded, fight, type ArenaFrame } from "../src/index.ts";
import { ARENA_MAX_TICKS } from "../src/constants.ts";
import { build, lcg, skill } from "./helpers.ts";
import { Fighter } from "../src/core.ts";

const WARRIOR = build();
const ROGUE = build({
  accountId: "acc-b",
  name: "Rogue",
  classId: "classic.rogue",
  appearance: "unit.hero.rogue",
  maxHp: 170,
  dmgMin: 6,
  dmgMax: 8,
  attackRate: 14,
  armor: 4,
  resist: 15,
  critPct: 12,
  moveSpeed: 5,
  skills: [
    skill({
      id: "classic.skill.multishot",
      name: "Multishot",
      kind: "projectile",
      power: 90,
      cooldown: 24,
      range: 8,
    }),
  ],
});

/** Pinned fight: change only with a deliberate rules change (bump arena.core version). */
const PINNED = { winner: "defender", ticks: 233, hash: "41b3d3cf7704bf65" };

describe("fight determinism", () => {
  it("same seed and builds give the same hash and result", () => {
    const a = fight(WARRIOR, ROGUE, 42, { frames: true });
    const b = fight(WARRIOR, ROGUE, 42, { frames: true });
    expect(a.hash).toBe(b.hash);
    expect(a.winner).toBe(b.winner);
    expect(a.ticks).toBe(b.ticks);
    expect(a.frames).toEqual(b.frames);
    expect(a.contentHash).toBe(arenaLoaded().contentHash);
  });

  it("pins the hash of a fixed fight (warrior vs rogue, seed 42)", () => {
    const r = fight(WARRIOR, ROGUE, 42);
    expect({ winner: r.winner, ticks: r.ticks, hash: r.hash }).toEqual({
      winner: PINNED.winner,
      ticks: PINNED.ticks,
      hash: PINNED.hash,
    });
  });

  it("different seeds can produce different fights", () => {
    const hashes = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) hashes.add(fight(WARRIOR, ROGUE, seed).hash);
    expect(hashes.size).toBeGreaterThan(1);
  });

  it("does not depend on the frames option", () => {
    expect(fight(WARRIOR, ROGUE, 9, { frames: true }).hash).toBe(fight(WARRIOR, ROGUE, 9).hash);
  });
});

describe("fight end conditions", () => {
  it("a fighter at 0 hp loses (the one that cannot be killed wins)", () => {
    const tank = build({
      maxHp: 1000,
      dmgMin: 60,
      dmgMax: 60,
      attackRate: 100,
      armor: 0,
      resist: 0,
      critPct: 0,
    });
    const glass = build({
      maxHp: 1,
      dmgMin: 1,
      dmgMax: 1,
      attackRate: 1,
      armor: 0,
      resist: 0,
      critPct: 0,
    });
    const r = fight(tank, glass, 3, { frames: true });
    expect(r.winner).toBe("attacker");
    expect(r.ticks).toBeLessThan(ARENA_MAX_TICKS);
    const last = r.frames!.at(-1)!;
    expect(last.defender.hp).toBe(0);
    expect(last.attacker.hp).toBeGreaterThan(0);
  });

  it("both fighters dying in the same tick is a draw", () => {
    // Mirror fights: the first seed with a mutual kill ends in a draw with both hp at 0.
    let found: { seed: number; frames: ArenaFrame[] } | null = null;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const r = fight(WARRIOR, WARRIOR, seed, { frames: true });
      if (r.winner === "draw" && r.ticks < ARENA_MAX_TICKS) found = { seed, frames: r.frames! };
    }
    expect(found).not.toBeNull();
    const last = found!.frames.at(-1)!;
    expect(last.attacker.hp).toBe(0);
    expect(last.defender.hp).toBe(0);
  });

  it("at the tick cap the higher hp percent wins", () => {
    // Attacker hits every tick for 1, defender only every 100 ticks: the cap favours the attacker.
    const pounder = build({
      maxHp: 1000,
      dmgMin: 1,
      dmgMax: 1,
      attackRate: 100,
      armor: 0,
      resist: 0,
      critPct: 0,
    });
    const slow = build({
      maxHp: 1000,
      dmgMin: 1,
      dmgMax: 1,
      attackRate: 1,
      armor: 0,
      resist: 0,
      critPct: 0,
    });
    const r = fight(pounder, slow, 5, { frames: true });
    expect(r.winner).toBe("attacker");
    expect(r.ticks).toBe(ARENA_MAX_TICKS);
    const last = r.frames!.at(-1)!;
    expect(last.attacker.hp).toBeGreaterThan(0);
    expect(last.defender.hp).toBeGreaterThan(0);
  });

  it("equal hp percent at the cap is a draw", () => {
    const even = build({
      maxHp: 1000,
      dmgMin: 1,
      dmgMax: 1,
      attackRate: 1,
      armor: 0,
      resist: 0,
      critPct: 0,
    });
    const r = fight(even, even, 11);
    expect(r.winner).toBe("draw");
    expect(r.ticks).toBe(ARENA_MAX_TICKS);
  });
});

describe("arena.start clamping", () => {
  it("clamps absurd builds instead of throwing and still terminates", () => {
    const absurd = build({
      maxHp: -50,
      dmgMin: Number.NaN,
      dmgMax: 1e12,
      attackRate: 1e9,
      armor: -4,
      resist: 900,
      critPct: 1000,
      moveSpeed: 1e6,
      skills: [
        skill({ kind: "bogus" as never }),
        skill({ power: 1e12, cooldown: 0, range: 99 }),
        skill({ kind: "heal", power: 1e9, cooldown: 1e9, range: 5 }),
        skill({ kind: "shield", power: -3, cooldown: 2, range: 7 }),
        skill(),
        skill(),
      ],
    });
    const r = fight(absurd, WARRIOR, 77, { frames: true });
    expect(r.ticks).toBeLessThanOrEqual(ARENA_MAX_TICKS);
    expect(["attacker", "defender", "draw"]).toContain(r.winner);
    const sim = createSim(arenaLoaded(), { seed: 77 });
    expect(sim.dispatch("arena.start", { attacker: absurd, defender: WARRIOR }, null).ok).toBe(
      true,
    );
  });

  it("rejects a non-object payload with a code and leaves the world empty", () => {
    const sim = createSim(arenaLoaded(), { seed: 1 });
    const before = sim.hash();
    const res = sim.dispatch("arena.start", "nope", null);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("bad_payload");
    expect(sim.hash()).toBe(before);
  });

  it("starts only once", () => {
    const sim = createSim(arenaLoaded(), { seed: 1 });
    expect(sim.dispatch("arena.start", { attacker: WARRIOR, defender: ROGUE }, null).ok).toBe(true);
    const again = sim.dispatch("arena.start", { attacker: WARRIOR, defender: ROGUE }, null);
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe("already_started");
  });
});

describe("combat events", () => {
  it("shields absorb first: hp drops by exactly the part of each hit the shield did not take", () => {
    const shielder = build({
      maxHp: 300,
      dmgMin: 8,
      dmgMax: 12,
      skills: [
        skill({
          id: "classic.skill.iron_skin",
          name: "Iron Skin",
          kind: "shield",
          power: 40,
          cooldown: 20,
          range: 0,
        }),
      ],
    });
    const sim = createSim(arenaLoaded(), { seed: 21 });
    expect(sim.dispatch("arena.start", { attacker: WARRIOR, defender: shielder }, null).ok).toBe(
      true,
    );
    const match = sim.world.getResource<{ attacker: number; defender: number }>("arena.match")!;
    let hp = sim.world.read(match.defender, Fighter).hp;
    let hits = 0;
    let absorbedTotal = 0;
    while (!sim.world.getResource("arena.result") && sim.tick < ARENA_MAX_TICKS) {
      const events = sim.step(1);
      const hitsNow = events.filter((ev) => ev.type === "arena.hit" && ev.side === "defender");
      const hpLoss = hitsNow.reduce((sum, ev) => sum + Number(ev.amount) - Number(ev.absorbed), 0);
      for (const ev of hitsNow) {
        hits++;
        absorbedTotal += Number(ev.absorbed);
        expect(Number(ev.absorbed)).toBeLessThanOrEqual(Number(ev.amount));
      }
      const now = sim.world.read(match.defender, Fighter).hp;
      expect(now).toBe(hp - hpLoss);
      hp = now;
    }
    expect(hits).toBeGreaterThan(0);
    expect(absorbedTotal).toBeGreaterThan(0);
  });

  it("emits arena.end exactly once with the winner and ticks", () => {
    const sim = createSim(arenaLoaded(), { seed: 8 });
    sim.dispatch("arena.start", { attacker: WARRIOR, defender: ROGUE }, null);
    const ends: { winner: unknown; ticks: unknown }[] = [];
    while (!sim.world.getResource("arena.result") && sim.tick < ARENA_MAX_TICKS) {
      for (const ev of sim.step(1))
        if (ev.type === "arena.end") ends.push({ winner: ev.winner, ticks: ev.ticks });
    }
    expect(ends).toHaveLength(1);
    const result = sim.world.getResource<{ winner: string; ticks: number }>("arena.result");
    expect(ends[0]).toEqual({ winner: result!.winner, ticks: result!.ticks });
  });
});

describe("fight properties", () => {
  it("terminates for 200 random builds, including extremes", () => {
    const rnd = lcg(2026);
    const pick = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo + 1));
    for (let i = 0; i < 200; i++) {
      const mk = () =>
        build({
          maxHp: pick(1, 4000),
          dmgMin: pick(0, 300),
          dmgMax: pick(0, 400),
          attackRate: pick(1, 100),
          armor: pick(0, 2000),
          resist: pick(0, 100),
          critPct: pick(0, 100),
          moveSpeed: pick(0, 12),
          skills:
            rnd() < 0.5
              ? []
              : [
                  skill({
                    kind: "nova",
                    range: pick(0, 12),
                    power: pick(1, 900),
                    cooldown: pick(1, 400),
                  }),
                ],
        });
      const r = fight(mk(), mk(), pick(0, 0xffffffff));
      expect(r.ticks).toBeGreaterThan(0);
      expect(r.ticks).toBeLessThanOrEqual(ARENA_MAX_TICKS);
    }
  });

  it("mirror builds are close to 50/50 over 200 seeds (fairness)", () => {
    let attacker = 0;
    let defender = 0;
    let draws = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = fight(WARRIOR, WARRIOR, seed);
      if (r.winner === "attacker") attacker++;
      else if (r.winner === "defender") defender++;
      else draws++;
    }
    // Measured when written: attacker 86, defender 83, draw 31 of 200.
    const attackerShare = (attacker + draws / 2) / 200;
    expect(attackerShare).toBeGreaterThan(0.4);
    expect(attackerShare).toBeLessThan(0.6);
    expect(attacker + defender + draws).toBe(200);
  });
});

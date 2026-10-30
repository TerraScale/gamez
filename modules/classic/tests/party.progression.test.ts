/**
 * classic.progression with a party (docs/design/party.md §7.2, T-progress):
 * shared kill XP for standing members, killer credit (life on kill,
 * PartyMember.kills, summons), member deaths vs a wipe (gold only on the
 * wipe), respawn of the whole party, per-member stats and regen, follower
 * commands acting on the follower, and a pinned party hash.
 */
import type { Entity, GameEvent, Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { busOf, pushCommand, type DeathRecord } from "../src/bus.ts";
import {
  Attributes,
  Dead,
  HeroStats,
  Intent,
  Level,
  Life,
  Mana,
  PartyMember,
  Summoned,
  Wallet,
} from "../src/components.ts";
import { setBonusSource } from "../src/bonus.ts";
import { RES, runStatsOf } from "../src/resources.ts";
import { partyKillXp, partyProtoOf, xpForKill } from "../src/rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../src/types.ts";
import { spawnTestMonster, spawnTestParty, testSim, useOpenMap } from "./support/harness.ts";

const MODULES = ["classic.core", "classic.progression", "classic.party"];

function partySim(n: number, seed = 1, controlled = 0): { sim: Sim; heroes: Entity[] } {
  const sim = testSim(MODULES, { seed });
  useOpenMap(sim, 1);
  const heroes = spawnTestParty(
    sim.world,
    Array.from({ length: n }, (_, i) => ({ depth: 1, gold: i === 0 ? 1000 : 0 })),
    { controlled },
  );
  return { sim, heroes };
}

function deathOf(over: Partial<DeathRecord> = {}): DeathRecord {
  return {
    entity: 0,
    killer: 0,
    creditTeam: "hero",
    team: "monster",
    isHero: false,
    x: 0,
    y: 0,
    depth: 1,
    monster: "test.monster.dummy",
    rarity: "normal",
    level: 1,
    xp: 100,
    pack: 0,
    ...over,
  };
}

function eventsOf<T = GameEvent & Record<string, unknown>>(events: GameEvent[], type: string): T[] {
  return events.filter((e) => e.type === type) as unknown as T[];
}

const balOf = (sim: Sim) => sim.loaded.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
const xpOf = (sim: Sim, e: Entity) => sim.world.read(e, Level).xp;

describe("party kill XP", () => {
  it("every standing member gets its partyKillXp share; a downed member gets none", () => {
    const { sim, heroes } = partySim(3);
    sim.step(1);
    const [a, b, c] = heroes as [Entity, Entity, Entity];
    sim.world.add(c, Dead, { at: 0, killer: 0 });
    const xpC = xpOf(sim, c);
    busOf(sim.world).deaths.push(deathOf({ killer: b, xp: 100, level: 1 }));
    const events = sim.step(1);

    const bal = balOf(sim);
    const proto = partyProtoOf(sim.loaded.registry);
    const share = partyKillXp(bal, proto, 3, 1, 1, 100);
    expect(share).toBeLessThan(xpForKill(bal, 1, 1, 100));
    expect(xpOf(sim, a)).toBe(share);
    expect(xpOf(sim, b)).toBe(share);
    expect(xpOf(sim, c)).toBe(xpC);
    const xpEvents = eventsOf<{ hero?: Entity; amount: number }>(events, "classic.xp");
    expect(xpEvents.map((e) => [e.hero, e.amount])).toEqual([
      [a, share],
      [b, share],
    ]);
    // Run stats and quests advance once per kill.
    expect(runStatsOf(sim.world).kills).toBe(1);
  });

  it("each member's share follows its own level", () => {
    const { sim, heroes } = partySim(2);
    const [a, b] = heroes as [Entity, Entity];
    const bal = balOf(sim);
    sim.world.update(b, Level, { level: 12, xp: 30_000 });
    busOf(sim.world).deaths.push(deathOf({ killer: a, xp: 100, level: 1 }));
    sim.step(1);
    const proto = partyProtoOf(sim.loaded.registry);
    expect(xpOf(sim, a)).toBe(partyKillXp(bal, proto, 2, 1, 1, 100));
    expect(xpOf(sim, b)).toBe(30_000 + partyKillXp(bal, proto, 2, 12, 1, 100));
  });

  it("life on kill and PartyMember.kills go to the killer, or to a killing summon's owner", () => {
    const { sim, heroes } = partySim(3);
    const [a, b, c] = heroes as [Entity, Entity, Entity];
    for (const h of heroes) {
      setBonusSource(sim.world, h, "test.bonus", [{ stat: "lifeOnKill", value: 7 }], []);
    }
    sim.step(1);
    for (const h of heroes) sim.world.update(h, Life, { hp: 10 });
    expect(sim.world.read(b, HeroStats).lifeOnKill).toBe(7);

    // xp 0: no level up (a level up heals to full).
    busOf(sim.world).deaths.push(deathOf({ killer: b, xp: 0 }));
    sim.step(1);
    expect(sim.world.read(b, Life).hp).toBe(17);
    expect(sim.world.read(a, Life).hp).toBe(10);
    expect(sim.world.read(c, Life).hp).toBe(10);
    expect(heroes.map((h) => sim.world.read(h, PartyMember).kills)).toEqual([0, 1, 0]);

    // A summon of c kills: c is credited.
    const wolf = sim.world.create();
    sim.world.add(wolf, Summoned, { owner: c, until: 0 });
    busOf(sim.world).deaths.push(deathOf({ killer: wolf, xp: 0 }));
    sim.step(1);
    expect(sim.world.read(c, Life).hp).toBe(17);
    expect(heroes.map((h) => sim.world.read(h, PartyMember).kills)).toEqual([0, 1, 1]);

    // An unknown killer (projectile entity gone): the controlled hero.
    busOf(sim.world).deaths.push(deathOf({ killer: 99_999, xp: 0 }));
    sim.step(1);
    expect(heroes.map((h) => sim.world.read(h, PartyMember).kills)).toEqual([1, 1, 1]);
    expect(runStatsOf(sim.world).kills).toBe(3);
  });
});

describe("party deaths", () => {
  it("a member death in a party of 3 costs its XP share only; the wipe costs gold once", () => {
    const { sim, heroes } = partySim(3);
    const [a, b, c] = heroes as [Entity, Entity, Entity];
    for (const h of heroes) sim.world.update(h, Level, { level: 2, xp: 150 });
    sim.world.update(b, Intent, { kind: "move", source: "auto", at: 0, x: 1, y: 1 });
    const killer = spawnTestMonster(sim.world, { x: 9, y: 9 });

    sim.world.add(b, Dead, { at: sim.tick, killer });
    const first = sim.step(1);
    expect(eventsOf(first, "classic.hero.died")).toEqual([
      { type: "classic.hero.died", goldLost: 0, xpLost: 2, killer: "Dummy", hero: b },
    ]);
    expect(sim.world.read(a, Wallet).gold).toBe(1000);
    expect(xpOf(sim, b)).toBe(148);
    expect(xpOf(sim, a)).toBe(150);
    expect(sim.world.read(b, Intent)).toMatchObject({ kind: "idle", source: "auto" });
    expect(runStatsOf(sim.world).deaths).toBe(1);
    expect(sim.world.read(b, PartyMember).deaths).toBe(1);

    // a and c fall on the same tick: the wipe costs 10 % of the purse, once.
    sim.world.add(a, Dead, { at: sim.tick, killer });
    sim.world.add(c, Dead, { at: sim.tick, killer });
    const wipe = sim.step(1);
    expect(eventsOf(wipe, "classic.hero.died")).toEqual([
      { type: "classic.hero.died", goldLost: 100, xpLost: 2, killer: "Dummy", hero: a },
      { type: "classic.hero.died", goldLost: 0, xpLost: 2, killer: "Dummy", hero: c },
    ]);
    expect(sim.world.read(a, Wallet).gold).toBe(900);
    expect(runStatsOf(sim.world).deaths).toBe(3);
    expect(heroes.map((h) => sim.world.read(h, PartyMember).deaths)).toEqual([1, 1, 1]);
    // No member other than the founder ever holds gold.
    expect(sim.world.has(b, Wallet)).toBe(false);

    const later = sim.step(1);
    expect(eventsOf(later, "classic.hero.died")).toEqual([]);
  });

  it("respawn revives every downed member at full life and moves the party to town once", () => {
    const { sim, heroes } = partySim(3);
    sim.step(1);
    for (const h of heroes) {
      sim.world.add(h, Dead, { at: 0, killer: 0 });
      sim.world.update(h, Life, { hp: 0 });
      sim.world.update(h, Mana, { mp: 0 });
    }
    const bal = balOf(sim);
    sim.step(bal.respawnDelay);
    expect(busOf(sim.world).transitions).toEqual([]);
    const res = sim.dispatch("classic.respawn", {}, "p1");
    expect(res.ok).toBe(true);
    for (const h of heroes) {
      expect(sim.world.has(h, Dead)).toBe(false);
      const life = sim.world.read(h, Life);
      expect(life.hp).toBe(life.max);
      const mana = sim.world.read(h, Mana);
      expect(mana.mp).toBe(mana.max);
      expect(sim.world.read(h, Intent).kind).toBe("idle");
    }
    expect(busOf(sim.world).transitions).toEqual([{ to: 0, via: "respawn" }]);
    expect(
      eventsOf<{ hero?: Entity }>(res.events, "classic.hero.respawned").map((e) => e.hero),
    ).toEqual(heroes);
    expect(eventsOf(res.events, "classic.party.revived")).toEqual(
      heroes.map((hero) => ({ type: "classic.party.revived", hero, by: 0, via: "respawn" })),
    );
  });

  it("respawn needs the controlled hero down; standing members are left alone", () => {
    const { sim, heroes } = partySim(3);
    const [a, b, c] = heroes as [Entity, Entity, Entity];
    sim.step(1);
    sim.world.add(b, Dead, { at: 0, killer: 0 });
    sim.step(balOf(sim).respawnDelay);
    const before = sim.hash();
    const no = sim.dispatch("classic.respawn", {}, "p1");
    expect(no.ok).toBe(false);
    expect(no.error?.code).toBe("not_dead");
    expect(sim.hash()).toBe(before);
    // A downed follower's own respawn command cannot pull the party to town either.
    pushCommand(sim.world, { op: "respawn", hero: b });
    const cmd = sim.step(1);
    expect(eventsOf<{ code: string }>(cmd, "classic.command.failed").map((e) => e.code)).toEqual([
      "not_dead",
    ]);
    expect(sim.world.has(b, Dead)).toBe(true);
    expect(busOf(sim.world).transitions).toEqual([]);

    // The controlled hero goes down too: respawn revives a and b, c keeps its state.
    sim.world.add(a, Dead, { at: 0, killer: 0 });
    sim.world.update(c, Life, { hp: 5 });
    const res = sim.dispatch("classic.respawn", {}, "p1");
    expect(res.ok).toBe(true);
    expect(sim.world.has(a, Dead)).toBe(false);
    expect(sim.world.has(b, Dead)).toBe(false);
    expect(sim.world.read(c, Life).hp).toBe(5);
    expect(
      eventsOf<{ hero?: Entity }>(res.events, "classic.hero.respawned").map((e) => e.hero),
    ).toEqual([a, b]);
    expect(busOf(sim.world).transitions).toEqual([{ to: 0, via: "respawn" }]);
  });
});

describe("per-member stats, regen and commands", () => {
  it("stats and regen update a follower", () => {
    const { sim, heroes } = partySim(2);
    const f = heroes[1]!;
    sim.step(1);
    const lifeMax = sim.world.read(f, HeroStats).lifeMax;
    sim.world.update(f, Attributes, { vit: sim.world.read(f, Attributes).vit + 40 });
    sim.step(1);
    expect(sim.world.read(f, HeroStats).lifeMax).toBeGreaterThan(lifeMax);
    expect(sim.world.read(f, Life).max).toBe(sim.world.read(f, HeroStats).lifeMax);

    sim.world.update(f, Life, { hp: 10, acc: 0 });
    sim.step(40);
    expect(sim.world.read(f, Life).hp).toBeGreaterThan(10);
  });

  it("a follower's allocate command (hero set) changes the follower, not the controlled hero", () => {
    const { sim, heroes } = partySim(2);
    const [a, f] = heroes as [Entity, Entity];
    sim.world.update(f, Level, { statPoints: 5 });
    sim.world.update(a, Level, { statPoints: 5 });
    const strA = sim.world.read(a, Attributes).str;
    const strF = sim.world.read(f, Attributes).str;
    pushCommand(sim.world, { op: "allocate", attr: "str", points: 2, hero: f });
    const events = sim.step(1);
    expect(sim.world.read(f, Attributes).str).toBe(strF + 2);
    expect(sim.world.read(f, Level).statPoints).toBe(3);
    expect(sim.world.read(a, Attributes).str).toBe(strA);
    expect(sim.world.read(a, Level).statPoints).toBe(5);
    expect(eventsOf(events, "classic.statAllocated")).toEqual([
      { type: "classic.statAllocated", attr: "str", points: 2, hero: f },
    ]);
  });

  it("a command for a hero outside the party fails with not_member", () => {
    const { sim, heroes } = partySim(2);
    const stranger = sim.world.create();
    sim.world.update(heroes[0]!, Level, { statPoints: 5 });
    pushCommand(sim.world, { op: "allocate", attr: "str", points: 1, hero: stranger });
    pushCommand(sim.world, { op: "grantXp", amount: 10, reason: "test", hero: stranger });
    const events = sim.step(1);
    expect(
      eventsOf<{ op: string; code: string }>(events, "classic.command.failed").map((e) => [
        e.op,
        e.code,
      ]),
    ).toEqual([
      ["allocate", "not_member"],
      ["grantXp", "not_member"],
    ]);
    expect(sim.world.read(heroes[0]!, Level).statPoints).toBe(5);
  });

  it("grantXp for a follower levels the follower with normal level-up points", () => {
    const { sim, heroes } = partySim(2);
    const f = heroes[1]!;
    const bal = balOf(sim);
    pushCommand(sim.world, { op: "grantXp", amount: 1000, reason: "test", hero: f });
    const events = sim.step(1);
    const lvl = sim.world.read(f, Level);
    expect(lvl.level).toBeGreaterThan(1);
    expect(lvl.statPoints).toBe((lvl.level - 1) * bal.statPointsPerLevel);
    expect(sim.world.read(heroes[0]!, Level).xp).toBe(0);
    const ups = eventsOf<{ hero?: Entity }>(events, "classic.levelUp");
    expect(ups.length).toBe(lvl.level - 1);
    expect(ups.every((e) => e.hero === f)).toBe(true);
  });
});

describe("party determinism", () => {
  function script(seed: number): Sim {
    const { sim, heroes } = partySim(3, seed, 1);
    const [a, b, c] = heroes as [Entity, Entity, Entity];
    const m = spawnTestMonster(sim.world, { x: 9, y: 9 });
    sim.step(2);
    for (let i = 0; i < 6; i++) {
      busOf(sim.world).deaths.push(
        deathOf({ killer: heroes[i % 3]!, xp: 40 + 10 * i, level: 1 + i }),
      );
      sim.step(1);
    }
    pushCommand(sim.world, { op: "allocate", attr: "vit", points: 3, hero: a });
    sim.step(1);
    sim.world.add(c, Dead, { at: sim.tick, killer: m });
    sim.step(5);
    sim.world.add(b, Dead, { at: sim.tick, killer: m });
    sim.world.add(a, Dead, { at: sim.tick, killer: m });
    sim.step(balOf(sim).respawnDelay + 1);
    expect(sim.dispatch("classic.respawn", {}, "p1").ok).toBe(true);
    sim.step(10);
    return sim;
  }

  it("same seed and script give the same hash (pinned)", () => {
    const one = script(7);
    const two = script(7);
    expect(one.hash()).toBe(two.hash());
    expect(one.world.read(one.world.getResource<{ hero: Entity }>(RES.game)!.hero, Level)).toEqual(
      two.world.read(two.world.getResource<{ hero: Entity }>(RES.game)!.hero, Level),
    );
    expect(one.hash()).toBe("397bf34f2eb71d8f");
  });
});

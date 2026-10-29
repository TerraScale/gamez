/**
 * Admin analytics per hero in a party (admin-dashboard.md §5 with party.md §5):
 * classicAnalytics.fold reads the `hero` tag of per-hero events, so XP is
 * banded by that member's level, a level-up counts that member's class, a
 * member's death takes its own killer, and every member's casts count.
 */
import { createSim, loadMode, type Entity, type GameEvent, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Level, Monster, Wallet } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { partyMembers, purseOf } from "../src/party/shared.ts";
import { classicAnalytics } from "../src/platform/analytics.ts";

const loaded = loadMode(mode, modules);

function collector() {
  const counts = new Map<string, number>();
  return {
    add: (metric: string, k1: string, k2: string, amount: number): void => {
      const key = `${metric}|${k1}|${k2}`;
      counts.set(key, (counts.get(key) ?? 0) + amount);
    },
    get: (metric: string, k1: string, k2 = ""): number => counts.get(`${metric}|${k1}|${k2}`) ?? 0,
  };
}

function party(): { sim: Sim; members: Entity[] } {
  const sim = createSim(loaded, { seed: 3 });
  expect(
    sim.dispatch("classic.newHero", { classId: "classic.warrior", name: "Lead" }, null).ok,
  ).toBe(true);
  sim.step(2);
  sim.world.update(purseOf(sim.world), Wallet, { gold: 1_000_000 });
  expect(sim.dispatch("classic.party.buySlot", {}, null).ok).toBe(true);
  expect(
    sim.dispatch("classic.party.recruit", { classId: "classic.sorcerer", name: "Mage" }, null).ok,
  ).toBe(true);
  sim.step(2);
  return { sim, members: partyMembers(sim.world) };
}

const ev = (type: string, extra: Record<string, unknown> = {}): GameEvent => ({ type, ...extra });

function monster(sim: Sim, proto: string): Entity {
  const e = sim.world.create();
  sim.world.add(e, Monster, {
    proto,
    level: 1,
    rarity: "normal",
    mods: [],
    pack: 0,
    name: proto,
  } as never);
  return e;
}

describe("classic analytics in a party", () => {
  it("bands XP by the member's level, counts its class and its own killer, and every member's casts", () => {
    const { sim, members } = party();
    const [lead, mage] = members as [Entity, Entity];
    sim.world.update(mage, Level, { ...sim.world.read(mage, Level), level: 12 });
    const wolf = monster(sim, "classic.mob_wolf");
    const bat = monster(sim, "classic.mob_bat");
    const c = collector();
    classicAnalytics.fold(
      [
        ev("classic.xp", { amount: 10, total: 10, reason: "kill", hero: lead }),
        ev("classic.xp", { amount: 7, total: 7, reason: "kill", hero: mage }),
        ev("classic.levelUp", { level: 13, statPoints: 5, skillPoints: 1, hero: mage }),
        ev("classic.death", {
          entity: lead,
          isHero: true,
          killer: wolf,
          monster: "",
          rarity: "hero",
        }),
        ev("classic.death", {
          entity: mage,
          isHero: true,
          killer: bat,
          monster: "",
          rarity: "hero",
        }),
        ev("classic.hero.died", { goldLost: 0, xpLost: 0, killer: "", hero: lead }),
        ev("classic.hero.died", { goldLost: 0, xpLost: 0, killer: "", hero: mage }),
        ev("classic.cast", { caster: mage, skill: "classic.skill.firebolt", effect: "" }),
        ev("classic.cast", { caster: lead, skill: "classic.skill.bash", effect: "" }),
      ],
      sim.world,
      c.add,
    );
    expect(c.get("xp", "1-9", "kill")).toBe(10);
    expect(c.get("xp", "10-19", "kill")).toBe(7);
    expect(c.get("level", "10-19", "classic.sorcerer")).toBe(1);
    expect(c.get("death", "town", "classic.mob_wolf")).toBe(1);
    expect(c.get("death", "town", "classic.mob_bat")).toBe(1);
    expect(c.get("cast", "classic.skill.firebolt")).toBe(1);
    expect(c.get("cast", "classic.skill.bash")).toBe(1);
  });
});

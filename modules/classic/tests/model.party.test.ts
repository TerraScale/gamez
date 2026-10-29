/**
 * Party HUD model (client/model/party.ts, docs/design/party.md §10.1): PartyView for a solo hero and
 * a party, the recruit blockers, the slot fields, reviving progress, XP per mille, the controlled
 * flags, the minimap party dots and the party field of buildHud. Pure: no React.
 */
import { describe, expect, it } from "vite-plus/test";
import { Dead, Level, Life, Reviving, Statuses } from "../src/components.ts";
import { buildHud, minimapData } from "../src/client/hudModel.ts";
import { buildPartyView } from "../src/client/model/party.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../src/types.ts";
import { DEFAULT_PARTY_PROTO, recruitFee, recruitLevel, xpAtLevel } from "../src/rules.ts";
import {
  RES,
  type AreaState,
  type ControlState,
  type DungeonState,
  type GameState,
} from "../src/resources.ts";
import { spawnTestHero, spawnTestParty, testSim, useOpenMap } from "./support/harness.ts";

function ctx(tick = 0) {
  return { tick, hovered: 0, vendor: 0, prev: null };
}

function balanceOf(sim: ReturnType<typeof testSim>): BalanceProto {
  return sim.loaded.registry.get<BalanceProto>(KIND.balance, BALANCE_ID)!;
}

describe("party view on a solo hero", () => {
  it("is null before any hero exists", () => {
    const sim = testSim([]);
    sim.world.getResource<GameState>(RES.game)!.phase = "choose";
    expect(buildPartyView(sim.world, sim.loaded.registry, 0)).toBeNull();
    expect(buildHud(sim.world, sim.loaded.registry, ctx()).party).toBeNull();
  });

  it("is a party of one: founder, leader and controlled, with slot F1", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, classId: "test.class.fighter" });
    sim.world.getResource<GameState>(RES.game)!.hero = hero;
    const view = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(view.members).toHaveLength(1);
    const m = view.members[0]!;
    expect(m.entity).toBe(hero);
    expect(m.slot).toBe(0);
    expect(m.key).toBe("F1");
    expect(m.name).toBe("Tester");
    expect(m.controlled && m.leader && m.founder).toBe(true);
    expect(m.dead).toBe(false);
    expect(m.reviving).toBeNull();
    expect(m.plan).toBe("none");
    expect(view.slots).toBe(1);
    expect(view.maxMembers).toBe(4);
    expect(view.partyAuto).toBe(false);
    expect(view.config.formation).toBe("wedge");
  });

  it("is also in the HUD snapshot", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
    sim.world.getResource<GameState>(RES.game)!.hero = hero;
    const hud = buildHud(sim.world, sim.loaded.registry, ctx());
    expect(hud.party?.members).toHaveLength(1);
  });
});

describe("party view of several heroes", () => {
  function setup(size: number, controlled = 1) {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const heroes = Array.from({ length: size }, (_, i) => ({
      classId: "test.class.fighter",
      level: 3 + i,
    }));
    const ents = spawnTestParty(sim.world, heroes, { controlled });
    return { sim, ents };
  }

  it("lists members in slot order with keys F1..F4 and the controlled flag", () => {
    const { sim, ents } = setup(3, 1);
    const view = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(view.members.map((m) => m.entity)).toEqual(ents);
    expect(view.members.map((m) => m.key)).toEqual(["F1", "F2", "F3"]);
    expect(view.members.map((m) => m.controlled)).toEqual([false, true, false]);
    expect(view.members.map((m) => m.founder)).toEqual([true, false, false]);
    // The acting leader is the controlled hero while it stands.
    expect(view.members.map((m) => m.leader)).toEqual([false, true, false]);
    expect(view.members[1]!.level).toBe(4);
  });

  it("reports the role of each member from its PartyMember record", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestParty(
      sim.world,
      [{ classId: "test.class.fighter" }, { classId: "test.class.fighter" }],
      {
        roles: ["front", "back"],
      },
    );
    const view = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(view.members.map((m) => m.role)).toEqual(["front", "back"]);
  });

  it("gives the XP progress inside the level as per mille", () => {
    const { sim, ents } = setup(2, 0);
    const bal = balanceOf(sim);
    const start = xpAtLevel(bal, 3);
    const span = xpAtLevel(bal, 4) - start;
    sim.world.update(ents[0]!, Level, { xp: start + Math.floor(span / 2) });
    const view = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(view.members[0]!.xpPermille).toBe(Math.floor((Math.floor(span / 2) * 1000) / span));
    expect(view.members[0]!.xpPermille).toBeGreaterThan(400);
    expect(view.members[0]!.xpPermille).toBeLessThan(600);
  });

  it("marks a downed member and the reviver progress (pct = elapsed / total)", () => {
    const { sim, ents } = setup(3, 0);
    sim.world.add(ents[1]!, Dead, { at: 0, killer: 0 });
    sim.world.add(ents[0]!, Reviving, { target: ents[1]!, startedAt: 10, until: 70 });
    const view = buildPartyView(sim.world, sim.loaded.registry, 40)!;
    expect(view.members[1]!.dead).toBe(true);
    expect(view.members[1]!.reviving).toEqual({ by: ents[0], pct: 50 });
    expect(view.members[0]!.reviving).toBeNull();
    // Past the end the progress is clamped at 100.
    const late = buildPartyView(sim.world, sim.loaded.registry, 999)!;
    expect(late.members[1]!.reviving?.pct).toBe(100);
  });

  it("sums unspent stat, skill and talent points for the badge", () => {
    const { sim, ents } = setup(2, 0);
    sim.world.update(ents[1]!, Level, { statPoints: 2, skillPoints: 1 });
    const view = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(view.members[0]!.unspent).toBe(0);
    expect(view.members[1]!.unspent).toBe(3);
  });

  it("gives life and mana of every member and the statuses, at most four", () => {
    const { sim, ents } = setup(2, 0);
    sim.world.update(ents[1]!, Life, { hp: 30 });
    const list = Array.from({ length: 6 }, (_, i) => ({
      id: `test.status.${i}`,
      until: 20 * (i + 2),
    }));
    sim.world.add(ents[1]!, Statuses, { list } as never);
    const view = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(view.members[1]!.life).toBe(30);
    expect(view.members[1]!.lifeMax).toBeGreaterThan(30);
    expect(view.members[1]!.statuses).toHaveLength(4);
    expect(view.members[1]!.statuses[0]!.secondsLeft).toBe(2);
  });
});

describe("party view: slots, recruit and gold", () => {
  it("counts boss unlocks: the next slot is the depth of the next boss", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestParty(sim.world, [{ classId: "test.class.fighter" }]);
    const dungeon = sim.world.getResource<DungeonState>(RES.dungeon)!;
    dungeon.bossesKilled = [];
    const first = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(first.slots).toBe(1);
    expect(first.nextSlotBossDepth).toBe(DEFAULT_PARTY_PROTO.unlockBossDepths[0]);
    expect(first.nextSlotPrice).toBe(DEFAULT_PARTY_PROTO.slotPrices[0]);

    dungeon.bossesKilled = [DEFAULT_PARTY_PROTO.unlockBossDepths[0]!];
    const second = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(second.slots).toBe(2);
    expect(second.nextSlotBossDepth).toBe(DEFAULT_PARTY_PROTO.unlockBossDepths[1]);
    expect(second.nextSlotPrice).toBe(DEFAULT_PARTY_PROTO.slotPrices[1]);
  });

  it("has no next boss and no price once every slot is unlocked", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestParty(sim.world, [{ classId: "test.class.fighter" }], { slotsBought: 3 });
    const view = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(view.slots).toBe(DEFAULT_PARTY_PROTO.maxMembers);
    expect(view.nextSlotPrice).toBeNull();
    expect(view.nextSlotBossDepth).toBeNull();
  });

  it("recruit is blocked by the town first, then the slots, then the gold", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestParty(sim.world, [{ classId: "test.class.fighter", gold: 9999 }]);
    const area = sim.world.getResource<AreaState>(RES.area)!;
    const level = recruitLevel(DEFAULT_PARTY_PROTO, 1);
    const fee = recruitFee(DEFAULT_PARTY_PROTO, level);
    // Depth 1: never in town, whatever the slots and gold.
    expect(buildPartyView(sim.world, sim.loaded.registry, 0)!.recruit).toEqual({
      level,
      fee,
      blocked: "town",
    });
    // Town, one slot, one member: the slot is the blocker.
    area.depth = 0;
    expect(buildPartyView(sim.world, sim.loaded.registry, 0)!.recruit.blocked).toBe("slots");
    // Town, a second slot bought, but no gold for the fee.
    const sim2 = testSim([]);
    spawnTestParty(sim2.world, [{ classId: "test.class.fighter", gold: 0 }], { slotsBought: 1 });
    const broke = buildPartyView(sim2.world, sim2.loaded.registry, 0)!;
    expect(broke.inTown).toBe(true);
    expect(broke.recruit).toEqual({ level, fee, blocked: "gold" });
  });

  it("recruit reports the slots blocker when the party is full", () => {
    const sim = testSim([]);
    const [hero] = spawnTestParty(sim.world, [{ classId: "test.class.fighter", gold: 9999 }]);
    void hero;
    const view = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(view.inTown).toBe(true);
    expect(view.slots).toBe(1);
    expect(view.recruit.blocked).toBe("slots");
  });

  it("recruit is open in town with a free slot and enough gold", () => {
    const sim = testSim([]);
    const [hero] = spawnTestParty(sim.world, [{ classId: "test.class.fighter", gold: 5000 }], {
      slotsBought: 1,
    });
    void hero;
    const view = buildPartyView(sim.world, sim.loaded.registry, 0)!;
    expect(view.slots).toBe(2);
    expect(view.recruit.blocked).toBeNull();
    expect(view.gold).toBe(5000);
  });

  it("follows the ControlState for partyAuto", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestParty(sim.world, [{ classId: "test.class.fighter" }]);
    const control = sim.world.getResource<ControlState>(RES.control)!;
    control.mode = "auto";
    expect(buildPartyView(sim.world, sim.loaded.registry, 0)!.partyAuto).toBe(true);
    control.mode = "manual";
    expect(buildPartyView(sim.world, sim.loaded.registry, 0)!.partyAuto).toBe(false);
  });
});

describe("minimap party dots", () => {
  it("lists the other members on this depth with their dead flags", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const ents = spawnTestParty(
      sim.world,
      [
        { classId: "test.class.fighter", x: 5, y: 5 },
        { classId: "test.class.fighter", x: 9, y: 7 },
        { classId: "test.class.fighter", x: 11, y: 3 },
      ],
      { controlled: 0 },
    );
    sim.world.add(ents[2]!, Dead, { at: 0, killer: 0 });
    const data = minimapData(sim.world, sim.loaded.registry)!;
    expect(data.party).toEqual([
      { x: 9, y: 7, dead: false },
      { x: 11, y: 3, dead: true },
    ]);
  });

  it("is empty for a solo hero", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestHero(sim.world, { x: 5, y: 5 });
    sim.world.getResource<GameState>(RES.game)!.hero = sim.world.query(Life)[0]!;
    expect(minimapData(sim.world, sim.loaded.registry)!.party).toEqual([]);
  });
});

describe("model determinism", () => {
  it("the same world gives the same party view", () => {
    const build = () => {
      const sim = testSim([]);
      useOpenMap(sim, 1);
      spawnTestParty(sim.world, [
        { classId: "test.class.fighter", level: 2 },
        { classId: "test.class.fighter", level: 5 },
      ]);
      return buildPartyView(sim.world, sim.loaded.registry, 7);
    };
    expect(build()).toEqual(build());
  });
});

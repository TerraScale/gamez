/**
 * Architect-owned tests of the party contract (docs/design/party.md):
 * rules.ts party helpers, party/shared.ts on solo and party worlds, the
 * lazy migration (ensureParty) and the classic.party content patches.
 */
import { createSim, loadMode } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { Dead, PartyMember, Wallet } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import {
  actingLeaderOf,
  aliveMembers,
  commandHero,
  ensureParty,
  followersOf,
  founderOf,
  isPartyHero,
  leaderMode,
  partyGold,
  partyMembers,
  partySize,
  partyWiped,
  purseOf,
  roleOf,
  slotsOf,
} from "../src/party/shared.ts";
import { RES, partyStateOf, type ControlState, type GameState } from "../src/resources.ts";
import {
  DEFAULT_PARTY_PROTO,
  formationOffsets,
  nextSlotPrice,
  partyKillXp,
  partyScale,
  partySlots,
  recruitFee,
  recruitLevel,
  xpForKill,
} from "../src/rules.ts";
import {
  KIND,
  PARTY_ID,
  type BalanceProto,
  type ClassProto,
  type SkillProto,
} from "../src/types.ts";
import { BALANCE_ID } from "../src/types.ts";
import { spawnTestHero, spawnTestParty, testSim } from "./support/harness.ts";

describe("party rules", () => {
  it("a party of one is the identity", () => {
    const s = partyScale(DEFAULT_PARTY_PROTO, 1);
    expect(s).toEqual({
      lifePct: 100,
      damagePct: 100,
      xpPct: 100,
      xpSharePct: 100,
      lootPct: 100,
      densityPct: 100,
    });
    // Sizes are clamped to 1..maxMembers.
    expect(partyScale(DEFAULT_PARTY_PROTO, 0)).toEqual(s);
    expect(partyScale(DEFAULT_PARTY_PROTO, 9)).toEqual(partyScale(DEFAULT_PARTY_PROTO, 4));
  });

  it("bigger parties scale monsters up and each member's xp share down", () => {
    for (let n = 2; n <= 4; n++) {
      const a = partyScale(DEFAULT_PARTY_PROTO, n - 1);
      const b = partyScale(DEFAULT_PARTY_PROTO, n);
      expect(b.lifePct).toBeGreaterThan(a.lifePct);
      expect(b.xpSharePct).toBeLessThan(a.xpSharePct);
      // The whole party still earns more xp per kill than one hero.
      expect((b.xpPct * b.xpSharePct * n) / 100).toBeGreaterThan(100);
    }
  });

  it("partyKillXp is xpForKill for size 1 and never 0 for a kill worth xp", () => {
    const sim = testSim(["classic.core"], { content: "real" });
    const bal = sim.loaded.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
    expect(partyKillXp(bal, DEFAULT_PARTY_PROTO, 1, 5, 5, 40)).toBe(xpForKill(bal, 5, 5, 40));
    // xpForKill x 210 % pool x 48 % share (docs/design/party.md §8).
    expect(partyKillXp(bal, DEFAULT_PARTY_PROTO, 4, 5, 5, 40)).toBe(19);
    expect(partyKillXp(bal, DEFAULT_PARTY_PROTO, 4, 50, 1, 1)).toBe(1);
  });

  it("slots: boss kills unlock for free, gold buys ahead", () => {
    const p = DEFAULT_PARTY_PROTO;
    expect(partySlots(p, [], 0)).toBe(1);
    expect(partySlots(p, [4], 0)).toBe(2);
    expect(partySlots(p, [4, 8, 12, 16], 0)).toBe(4);
    expect(partySlots(p, [4], 2)).toBe(3);
    expect(partySlots(p, [], 9)).toBe(4);
    expect(nextSlotPrice(p, 1)).toBe(1500);
    expect(nextSlotPrice(p, 3)).toBe(30000);
    expect(nextSlotPrice(p, 4)).toBeNull();
    expect(recruitLevel(p, 1)).toBe(1);
    expect(recruitLevel(p, 20)).toBe(17);
    expect(recruitFee(p, 17)).toBe(850);
  });

  it("formation: fronts take forward spots, offsets follow the facing", () => {
    const off = formationOffsets("wedge", 2, "se", ["back", "front", "back"]);
    // se = tile +x forward, right = +y. Front member: spot (-1,-1) -> (-2, -2).
    expect(off[1]).toEqual({ dx: -2, dy: -2 });
    expect(off[0]).toEqual({ dx: -2, dy: 2 });
    expect(off[2]).toEqual({ dx: -4, dy: 0 });
    // Every offset is distinct and integer.
    const keys = new Set(off.map((o) => `${o.dx},${o.dy}`));
    expect(keys.size).toBe(3);
    for (const f of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const) {
      for (const form of ["wedge", "line", "ring"] as const) {
        const o = formationOffsets(form, 1, f, ["front", "front", "back"]);
        expect(new Set(o.map((v) => `${v.dx},${v.dy}`)).size).toBe(3);
        for (const v of o) expect(v.dx !== 0 || v.dy !== 0).toBe(true);
      }
    }
  });
});

describe("party/shared on a solo world", () => {
  it("is a party of one made of GameState.hero and never creates state", () => {
    const sim = testSim(["classic.core"]);
    const w = sim.world;
    expect(partyMembers(w)).toEqual([]);
    expect(partySize(w)).toBe(0);
    const hero = spawnTestHero(w, { gold: 77 });
    expect(partyMembers(w)).toEqual([hero]);
    expect(partySize(w)).toBe(1);
    expect(isPartyHero(w, hero)).toBe(true);
    expect(isPartyHero(w, hero + 99)).toBe(false);
    expect(followersOf(w)).toEqual([]);
    expect(actingLeaderOf(w)).toBe(hero);
    expect(founderOf(w)).toBe(hero);
    expect(purseOf(w)).toBe(hero);
    expect(partyGold(w)).toBe(77);
    expect(commandHero(w, {})).toBe(hero);
    expect(commandHero(w, { hero })).toBe(hero);
    expect(commandHero(w, { hero: 999 })).toBe(0);
    expect(partyStateOf(w)).toBeNull();
    expect(slotsOf(w, sim.loaded.registry)).toBe(1);
  });
});

describe("party/shared on a party world", () => {
  it("members, followers, purse, leader and wipe", () => {
    const sim = testSim(["classic.core"]);
    const w = sim.world;
    const [a, b, c] = spawnTestParty(w, [{ gold: 500 }, {}, {}], { controlled: 1 });
    expect(partyMembers(w)).toEqual([a, b, c]);
    expect(partySize(w)).toBe(3);
    expect(w.getResource<GameState>(RES.game)!.hero).toBe(b);
    expect(followersOf(w)).toEqual([a, c]);
    expect(founderOf(w)).toBe(a);
    expect(purseOf(w)).toBe(a);
    expect(w.has(b!, Wallet)).toBe(false);
    expect(partyGold(w)).toBe(500);
    expect(commandHero(w, { hero: c })).toBe(c);
    expect(actingLeaderOf(w)).toBe(b);
    w.add(b!, Dead, { at: 0, killer: 0 });
    expect(actingLeaderOf(w)).toBe(a);
    expect(aliveMembers(w)).toEqual([a, c]);
    expect(partyWiped(w)).toBe(false);
    w.add(a!, Dead, { at: 0, killer: 0 });
    w.add(c!, Dead, { at: 0, killer: 0 });
    expect(partyWiped(w)).toBe(true);
    expect(actingLeaderOf(w)).toBe(b);
  });

  it("leaderMode follows control mode and downed state", () => {
    const sim = testSim(["classic.core"]);
    const w = sim.world;
    const [a, b] = spawnTestParty(w, [{}, {}]);
    const ctl = w.getResource<ControlState>(RES.control)!;
    ctl.mode = "manual";
    expect(leaderMode(w, 0)).toBe("off");
    ctl.mode = "auto";
    expect(leaderMode(w, 0)).toBe("full");
    ctl.overrideUntil = 10;
    expect(leaderMode(w, 5)).toBe("off");
    ctl.mode = "manual";
    w.add(a!, Dead, { at: 0, killer: 0 });
    expect(leaderMode(w, 20)).toBe("defend");
    ctl.mode = "idle";
    expect(leaderMode(w, 20)).toBe("full");
    w.add(b!, Dead, { at: 0, killer: 0 });
    expect(leaderMode(w, 20)).toBe("off");
  });
});

describe("classic.party module and lazy migration", () => {
  const loaded = loadMode(mode, modules);

  it("defines PartyProto and patches roles and Mend", () => {
    const reg = loaded.registry;
    expect(reg.require(KIND.party, PARTY_ID)).toEqual(DEFAULT_PARTY_PROTO);
    expect(reg.require<ClassProto>(KIND.class, "classic.warrior").partyRole).toBe("front");
    expect(reg.require<ClassProto>(KIND.class, "classic.sorcerer").partyRole).toBe("back");
    expect(reg.require<SkillProto>(KIND.skill, "classic.skill.mend").heal?.allyRadius).toBe(
      5 * 256,
    );
  });

  it("a new game has no party resource until a party action runs", () => {
    const sim = createSim(loaded, { seed: 3 });
    expect(
      sim.dispatch("classic.newHero", { classId: "classic.rogue", name: "Ash" }, null).ok,
    ).toBe(true);
    sim.step(40);
    expect(partyStateOf(sim.world)).toBeNull();
  });

  it("ensureParty migrates a solo hero into a party of one", () => {
    const sim = createSim(loaded, { seed: 3 });
    sim.dispatch("classic.newHero", { classId: "classic.rogue", name: "Ash" }, null);
    sim.step(3);
    const w = sim.world;
    const hero = w.getResource<GameState>(RES.game)!.hero;
    // ensureParty only reads ctx.registry.
    const ctx = { registry: sim.loaded.registry } as Parameters<typeof ensureParty>[1];
    const p = ensureParty(w, ctx)!;
    expect(p.members).toEqual([hero]);
    expect(p.founder).toBe(hero);
    expect(p.nextUid).toBe(1);
    expect(w.read(hero, PartyMember)).toMatchObject({ uid: 0, role: "back", kills: 0 });
    expect(roleOf(w, sim.loaded.registry, hero)).toBe("back");
    // Idempotent.
    expect(ensureParty(w, ctx)!.members).toEqual([hero]);
  });
});

/**
 * classic.party actions (docs/design/party.md §4.1): every action accepts valid
 * input and rejects each invalid case with the right code, leaving the sim hash
 * unchanged. Full classic mode plus the QA cheat for setup (party grants, gold,
 * boss kills, levels, items).
 */
import { createSim, loadMode, type Sim } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import {
  AreaTag,
  Equipment,
  Hero,
  Inventory,
  Level,
  PartyMember,
  Pos,
  Wallet,
} from "../src/components.ts";
import { DEBUG_GRANT } from "../src/debug/index.ts";
import { mode, modules, debugModules } from "../src/index.ts";
import { partyGold, partyMembers, purseOf } from "../src/party/shared.ts";
import { heroOf, RES, stashOf, partyStateOf, type AreaState } from "../src/resources.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../src/types.ts";
import { xpAtLevel } from "../src/rules.ts";

const LOADED = loadMode({ ...mode }, [...modules, ...debugModules]);

/** A fresh hero in town (after the first step). */
function start(seed = 11): Sim {
  const sim = createSim(LOADED, { seed });
  const r = sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Tester" }, null);
  expect(r.ok).toBe(true);
  sim.step(1);
  return sim;
}

/** Applies a QA grant and runs one step so the queued parts land. */
function grant(sim: Sim, payload: Record<string, unknown>): void {
  const r = sim.dispatch(DEBUG_GRANT, payload, null);
  expect(r.ok, r.error?.message).toBe(true);
  sim.step(1);
}

function dispatch(sim: Sim, name: string, payload: unknown) {
  return sim.dispatch(name, payload, null);
}

/** The action is rejected with `code` and the sim hash does not move. */
function rejected(sim: Sim, name: string, payload: unknown, code: string): void {
  const before = sim.hash();
  const r = dispatch(sim, name, payload);
  expect(r.ok).toBe(false);
  expect(r.error?.code).toBe(code);
  expect(sim.hash()).toBe(before);
}

/** A party of two: the founder and a rogue named Rita (boss 4 unlocks slot 2). */
function duo(seed = 11): { sim: Sim; founder: number; rita: number } {
  const sim = start(seed);
  grant(sim, { bossesKilled: [4], gold: 2000 });
  const r = dispatch(sim, ACTION.partyRecruit, { classId: "classic.rogue", name: "Rita" });
  expect(r.ok, r.error?.message).toBe(true);
  const rita = partyMembers(sim.world)[1]!;
  return { sim, founder: heroOf(sim.world), rita };
}

function setArea(sim: Sim, depth: number): void {
  const area = sim.world.getResource<AreaState>(RES.area)!;
  sim.world.setResource(RES.area, { ...area, depth });
}

function setPurseGold(sim: Sim, gold: number): void {
  sim.world.update(purseOf(sim.world), Wallet, { gold });
}

describe("classic.party.recruit", () => {
  it("recruits a rogue next to the hero, pays the fee and records the member", () => {
    const sim = start();
    grant(sim, { bossesKilled: [4], gold: 2000 });
    const w = sim.world;
    const before = partyGold(w);
    const r = dispatch(sim, ACTION.partyRecruit, { classId: "classic.rogue", name: "Rita" });
    expect(r.ok, r.error?.message).toBe(true);

    const rita = partyMembers(w)[1]!;
    expect(partyGold(w)).toBe(before - 50); // level 1 recruit: 50 gold per level
    expect(w.read(rita, Hero)).toMatchObject({ classId: "classic.rogue", name: "Rita" });
    expect(w.read(rita, PartyMember)).toMatchObject({ uid: 1, role: "back", kills: 0, deaths: 0 });
    expect(w.has(rita, Wallet)).toBe(false);
    expect(w.read(rita, AreaTag).depth).toBe(0);
    const near = w.read(heroOf(w), Pos);
    const at = w.read(rita, Pos);
    expect(
      Math.abs((at.x >> 8) - (near.x >> 8)) + Math.abs((at.y >> 8) - (near.y >> 8)),
    ).toBeLessThanOrEqual(4);
    expect(partyStateOf(w)?.nextUid).toBe(2);
    expect(
      r.events.some(
        (e) =>
          e.type === "classic.party.recruited" &&
          e.hero === rita &&
          e.slot === 1 &&
          e.level === 1 &&
          e.fee === 50,
      ),
    ).toBe(true);
  });

  it("starts a recruit at the recruit level with the level-up points", () => {
    const sim = start();
    grant(sim, { bossesKilled: [4], gold: 5000, levels: 6 });
    const bal = sim.loaded.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
    const w = sim.world;
    const founderLevel = w.read(heroOf(w), Level).level;
    expect(founderLevel).toBe(7);
    const r = dispatch(sim, ACTION.partyRecruit, { classId: "classic.sorcerer", name: "Mira" });
    expect(r.ok, r.error?.message).toBe(true);
    const mira = partyMembers(w)[1]!;
    const lvl = w.read(mira, Level);
    expect(lvl.level).toBe(4); // highest 7 - recruitLevelGap 3
    expect(lvl.xp).toBe(xpAtLevel(bal, 4));
    expect(lvl.statPoints).toBe(3 * bal.statPointsPerLevel);
    expect(lvl.skillPoints).toBe(3 * bal.skillPointsPerLevel);
  });

  it("rejects a recruit outside town with not_in_town", () => {
    const sim = duo();
    setArea(sim.sim, 1);
    rejected(
      sim.sim,
      ACTION.partyRecruit,
      { classId: "classic.warrior", name: "Bo" },
      "not_in_town",
    );
  });

  it("rejects a recruit when every unlocked slot is taken with party_full", () => {
    const sim = start();
    grant(sim, { gold: 9000 });
    rejected(sim, ACTION.partyRecruit, { classId: "classic.rogue", name: "Rita" }, "party_full");
  });

  it("rejects a recruit the purse cannot pay with no_gold", () => {
    const sim = start();
    grant(sim, { bossesKilled: [4] });
    setPurseGold(sim, 10);
    rejected(sim, ACTION.partyRecruit, { classId: "classic.rogue", name: "Rita" }, "no_gold");
  });

  it("rejects an unknown class, a bad name and extra fields", () => {
    const sim = start();
    grant(sim, { bossesKilled: [4], gold: 2000 });
    rejected(sim, ACTION.partyRecruit, { classId: "classic.nope", name: "Rita" }, "unknown_id");
    rejected(sim, ACTION.partyRecruit, { classId: "classic.rogue", name: "R!ta" }, "bad_payload");
    rejected(sim, ACTION.partyRecruit, { classId: "classic.rogue", name: "" }, "bad_payload");
    rejected(
      sim,
      ACTION.partyRecruit,
      { classId: "classic.rogue", name: "Rita", extra: 1 },
      "bad_payload",
    );
  });

  it("rejects a recruit with no hero yet with no_hero", () => {
    const sim = createSim(LOADED, { seed: 3 });
    rejected(sim, ACTION.partyRecruit, { classId: "classic.rogue", name: "Rita" }, "no_hero");
  });
});

describe("classic.party.dismiss", () => {
  it("moves the gear to the stash and removes the member", () => {
    const { sim, rita } = duo();
    const w = sim.world;
    const eq = w.get(rita, Equipment);
    const worn = eq ? Object.values(eq).filter((x) => x !== null).length : 0;
    const bag = w.get(rita, Inventory)?.items.length ?? 0;
    const stashBefore = stashOf(w).items.length;
    const r = dispatch(sim, ACTION.partyDismiss, { hero: rita });
    expect(r.ok, r.error?.message).toBe(true);
    expect(w.exists(rita)).toBe(false);
    expect(partyMembers(w).length).toBe(1);
    expect(stashOf(w).items.length).toBe(stashBefore + worn + bag);
    expect(r.events.some((e) => e.type === "classic.party.dismissed" && e.hero === rita)).toBe(
      true,
    );
  });

  it("refuses the founder with founder", () => {
    const { sim, founder } = duo();
    rejected(sim, ACTION.partyDismiss, { hero: founder }, "founder");
  });

  it("refuses an entity that is not a member with not_member", () => {
    const { sim } = duo();
    rejected(sim, ACTION.partyDismiss, { hero: 999_999 }, "not_member");
  });

  it("refuses to dismiss outside town with not_in_town", () => {
    const { sim, rita } = duo();
    setArea(sim, 1);
    rejected(sim, ACTION.partyDismiss, { hero: rita }, "not_in_town");
  });

  it("hands control to the first member when the controlled hero is dismissed", () => {
    const { sim, founder, rita } = duo();
    expect(dispatch(sim, ACTION.partyControl, { hero: rita }).ok).toBe(true);
    const r = dispatch(sim, ACTION.partyDismiss, { hero: rita });
    expect(r.ok, r.error?.message).toBe(true);
    expect(heroOf(sim.world)).toBe(founder);
    expect(
      r.events.some(
        (e) => e.type === "classic.party.control" && e.reason === "dismiss" && e.hero === founder,
      ),
    ).toBe(true);
  });
});

describe("classic.party.rename / reorder", () => {
  it("renames a member", () => {
    const { sim, rita } = duo();
    const r = dispatch(sim, ACTION.partyRename, { hero: rita, name: "Rit" });
    expect(r.ok, r.error?.message).toBe(true);
    expect(sim.world.read(rita, Hero).name).toBe("Rit");
    rejected(sim, ACTION.partyRename, { hero: rita, name: "bad?" }, "bad_payload");
    rejected(sim, ACTION.partyRename, { hero: 999_999, name: "Ok" }, "not_member");
  });

  it("reorders the members as an exact permutation", () => {
    const { sim, founder, rita } = duo();
    const r = dispatch(sim, ACTION.partyReorder, { order: [rita, founder] });
    expect(r.ok, r.error?.message).toBe(true);
    expect(partyMembers(sim.world)).toEqual([rita, founder]);
    rejected(sim, ACTION.partyReorder, { order: [rita] }, "bad_order");
    rejected(sim, ACTION.partyReorder, { order: [rita, rita] }, "bad_order");
    rejected(sim, ACTION.partyReorder, { order: [rita, 999_999] }, "bad_order");
    rejected(sim, ACTION.partyReorder, { order: [rita, founder, founder] }, "bad_order");
  });
});

describe("classic.party.control", () => {
  it("switches GameState.hero to the chosen member", () => {
    const { sim, rita } = duo();
    const r = dispatch(sim, ACTION.partyControl, { hero: rita });
    expect(r.ok, r.error?.message).toBe(true);
    expect(heroOf(sim.world)).toBe(rita);
    expect(r.events.some((e) => e.type === "classic.party.control" && e.reason === "player")).toBe(
      true,
    );
  });

  it("rejects the controlled hero again with bad_target and strangers with not_member", () => {
    const { sim, rita } = duo();
    dispatch(sim, ACTION.partyControl, { hero: rita });
    rejected(sim, ACTION.partyControl, { hero: rita }, "bad_target");
    rejected(sim, ACTION.partyControl, { hero: 999_999 }, "not_member");
  });
});

describe("classic.party.config", () => {
  it("merges a partial config", () => {
    const { sim } = duo();
    const r = dispatch(sim, ACTION.partyConfig, {
      config: { formation: "line", spread: 3, focusFire: false },
    });
    expect(r.ok, r.error?.message).toBe(true);
    expect(partyStateOf(sim.world)?.config).toMatchObject({
      formation: "line",
      spread: 3,
      focusFire: false,
      revive: true,
      autoSwitch: true,
    });
  });

  it("rejects bad keys and values with bad_payload", () => {
    const { sim } = duo();
    rejected(sim, ACTION.partyConfig, { config: { formation: "circle" } }, "bad_payload");
    rejected(sim, ACTION.partyConfig, { config: { spread: 9 } }, "bad_payload");
    rejected(sim, ACTION.partyConfig, { config: { spread: 2.5 } }, "bad_payload");
    rejected(sim, ACTION.partyConfig, { config: { focusFire: "yes" } }, "bad_payload");
    rejected(sim, ACTION.partyConfig, { config: { gold: 1 } }, "bad_payload");
  });
});

describe("classic.party.buySlot", () => {
  it("buys the next slot with gold and pays the price", () => {
    const sim = start();
    grant(sim, { gold: 5000 });
    const w = sim.world;
    const before = partyGold(w);
    const r = dispatch(sim, ACTION.partyBuySlot, {});
    expect(r.ok, r.error?.message).toBe(true);
    expect(partyGold(w)).toBe(before - 1500);
    expect(partyStateOf(w)?.slotsBought).toBe(1);
    expect(
      r.events.some((e) => e.type === "classic.party.slots" && e.slots === 2 && e.cost === 1500),
    ).toBe(true);
  });

  it("rejects a purchase the purse cannot cover with no_gold", () => {
    const sim = start();
    setPurseGold(sim, 100);
    rejected(sim, ACTION.partyBuySlot, {}, "no_gold");
  });

  it("rejects a purchase outside town with not_in_town", () => {
    const sim = start();
    grant(sim, { gold: 5000 });
    setArea(sim, 1);
    rejected(sim, ACTION.partyBuySlot, {}, "not_in_town");
  });

  it("rejects a purchase when every slot is unlocked with party_full", () => {
    const sim = start();
    grant(sim, { bossesKilled: [4, 8, 12], gold: 99_999 });
    rejected(sim, ACTION.partyBuySlot, {}, "party_full");
  });
});

describe("classic.party.give", () => {
  it("moves a bag item of the controlled hero into another member's bag", () => {
    const { sim, founder, rita } = duo();
    grant(sim, { items: { count: 2, rarity: "normal", ilvl: 1 } });
    const w = sim.world;
    const bag = w.read(founder, Inventory);
    expect(bag.items.length).toBeGreaterThan(0);
    const uid = bag.items[0]!.item.uid;
    const name = bag.items[0]!.item.name;
    const ritaBefore = w.read(rita, Inventory).items.length;
    const r = dispatch(sim, ACTION.partyGive, { uid, to: rita });
    expect(r.ok, r.error?.message).toBe(true);
    expect(w.read(founder, Inventory).items.some((en) => en.item.uid === uid)).toBe(false);
    expect(w.read(rita, Inventory).items.length).toBe(ritaBefore + 1);
    expect(
      r.events.some(
        (e) =>
          e.type === "classic.party.itemGiven" && e.uid === uid && e.name === name && e.to === rita,
      ),
    ).toBe(true);
  });

  it("rejects an unknown uid, giving to self and a non-member", () => {
    const { sim, founder, rita } = duo();
    rejected(sim, ACTION.partyGive, { uid: 999_999, to: rita }, "unknown_id");
    rejected(sim, ACTION.partyGive, { uid: 1, to: founder }, "not_member");
    rejected(sim, ACTION.partyGive, { uid: 1, to: 999_999 }, "not_member");
  });
});

describe("payload strictness", () => {
  it("rejects non-object and extra-field payloads on every action", () => {
    const { sim, rita } = duo();
    const names: { name: string; payload: unknown }[] = [
      { name: ACTION.partyDismiss, payload: { hero: rita, x: 1 } },
      { name: ACTION.partyControl, payload: "rita" },
      { name: ACTION.partyReorder, payload: { order: "all" } },
      { name: ACTION.partyGive, payload: { uid: -1, to: rita } },
      { name: ACTION.partyBuySlot, payload: { now: true } },
    ];
    for (const { name, payload } of names) {
      const before = sim.hash();
      const r = dispatch(sim, name, payload);
      expect(r.ok, name).toBe(false);
      expect(r.error?.code, name).toBe("bad_payload");
      expect(sim.hash(), name).toBe(before);
    }
  });
});

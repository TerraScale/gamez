/**
 * Saves, snapshots and offline progress with a party (docs/design/party.md §9):
 * a) an old solo save (no party state) is carried over to the current content
 *    and keeps working; once it recruits (a party action) the founder is the
 *    old hero and its kills and deaths are preserved in PartyMember;
 * b) a party snapshot round-trips through the save store: restoring it and
 *    stepping N more ticks gives the same hash as the uninterrupted sim;
 * c) offline progress on a party splits XP across the members and pays the
 *    purse (the founder's Wallet).
 */
import { createSim, loadMode, type Sim, type SimSnapshot } from "@gamez/kernel";
import { VERIFIED_ACTOR } from "@gamez/protocol";
import { describe, expect, it } from "vite-plus/test";
import { ACTION } from "../src/actions.ts";
import { Hero, Level, PartyMember, Wallet } from "../src/components.ts";
import { mode, modules } from "../src/index.ts";
import { partyMembers } from "../src/party/shared.ts";
import {
  CARRY_TICKS,
  createSaveStore,
  DEFAULT_SETTINGS,
  decodeCarryable,
  decodeSave,
  LEGACY_MODULE_IDS,
  restoreCarried,
  type KeyValueStorage,
  type SaveRecord,
} from "../src/client/persist.ts";
import {
  partyStateOf,
  RES,
  type DungeonState,
  type GameState,
  type RunStats,
} from "../src/resources.ts";
import { spawnTestParty, type TestHeroOptions } from "./support/harness.ts";

const SEED = 6060;
const OLD_HASH = "fedcba9876543210";
const loaded = loadMode(mode, modules);

class MemoryStorage implements KeyValueStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** A solo save made by the current build, relabelled as an older content version. */
function oldSoloRecord(): SaveRecord {
  const sim = createSim(loaded, { seed: SEED });
  const r = sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Ardane" }, "local");
  if (!r.ok) throw new Error(`newHero failed: ${r.error?.message}`);
  sim.step(5);
  sim.world.getResource<RunStats>(RES.stats)!.kills = 7;
  sim.world.getResource<RunStats>(RES.stats)!.deaths = 2;
  const snap = sim.snapshot();
  return {
    v: 1,
    savedAt: 1_700_000_000_000,
    snapshot: { ...snap, contentHash: OLD_HASH },
    settings: { ...DEFAULT_SETTINGS },
    // No module list: the pre-wave-A module set, which every current build still has.
    modules: [...LEGACY_MODULE_IDS],
  };
}

describe("solo save carry-over with the party build", () => {
  it("an old solo save carries over, steps as a solo hero and has no party state", () => {
    const text = JSON.stringify(oldSoloRecord());
    const got = decodeCarryable(
      text,
      loaded.contentHash,
      loaded.modules.map((m) => m.id),
    );
    expect(got).not.toBeNull();
    const sim = restoreCarried(loaded, got!);
    expect(sim).not.toBeNull();
    expect(sim!.snapshot().contentHash).toBe(loaded.contentHash);
    expect(sim!.tick).toBe(5 + CARRY_TICKS);
    expect(partyStateOf(sim!.world)).toBeNull();
    expect(partyMembers(sim!.world)).toHaveLength(1);
    expect(sim!.world.has(partyMembers(sim!.world)[0]!, PartyMember)).toBe(false);
    expect(sim!.world.get(partyMembers(sim!.world)[0]!, Hero)!.name).toBe("Ardane");
    // The solo run stats survive the carry-over.
    expect(sim!.world.getResource<RunStats>(RES.stats)!.kills).toBe(7);
  });

  it("the carried solo save keeps its hash across a save and a restore", () => {
    const got = decodeCarryable(
      JSON.stringify(oldSoloRecord()),
      loaded.contentHash,
      loaded.modules.map((m) => m.id),
    )!;
    const sim = restoreCarried(loaded, got)!;
    const store = createSaveStore(new MemoryStorage());
    store.save({
      v: 1,
      savedAt: 1,
      snapshot: sim.snapshot(),
      settings: { ...DEFAULT_SETTINGS },
    });
    const back = store.load(loaded.contentHash);
    expect(back).not.toBeNull();
    const restored = createSim(loaded, { seed: 0, from: back!.snapshot });
    expect(restored.hash()).toBe(sim.hash());
  });

  it("a carried solo save accepts recruit: founder = the old hero, its kills and deaths kept", () => {
    const got = decodeCarryable(
      JSON.stringify(oldSoloRecord()),
      loaded.contentHash,
      loaded.modules.map((m) => m.id),
    )!;
    const sim = restoreCarried(loaded, got)!;
    // Gold and a slot unlock: boss at depth 4 killed (the rule of the second slot).
    sim.world.update(partyMembers(sim.world)[0]!, Wallet, { gold: 5000 });
    sim.world.getResource<DungeonState>(RES.dungeon)!.bossesKilled = [4];
    const founder = partyMembers(sim.world)[0]!;
    const r = sim.dispatch(
      ACTION.partyRecruit,
      { classId: "classic.rogue", name: "Shade" },
      "local",
    );
    expect(r.ok, r.error?.message).toBe(true);
    const members = partyMembers(sim.world);
    expect(members).toHaveLength(2);
    expect(members[0]).toBe(founder);
    expect(sim.world.get(founder, PartyMember)).toMatchObject({ uid: 0, kills: 7, deaths: 2 });
    expect(partyStateOf(sim.world)?.founder).toBe(founder);
  });
});

/** A party of three made by the harness, a few ticks in, on Auto. */
function partyWorld(): Sim {
  const heroes: TestHeroOptions[] = [
    { classId: "classic.warrior", level: 5, gold: 3000 },
    { classId: "classic.rogue", level: 4 },
    { classId: "classic.sorcerer", level: 3 },
  ];
  const sim = createSim(loaded, { seed: SEED });
  spawnTestParty(sim.world, heroes, { controlled: 1 });
  expect(sim.dispatch(ACTION.setControl, { mode: "auto" }, "local").ok).toBe(true);
  sim.step(200);
  return sim;
}

describe("party snapshot round-trip", () => {
  it("save, restore, then N more ticks gives the same hash as the uninterrupted sim", () => {
    const a = partyWorld();
    const storage = new MemoryStorage();
    const store = createSaveStore(storage);
    store.save({ v: 1, savedAt: 1, snapshot: a.snapshot(), settings: { ...DEFAULT_SETTINGS } });
    const saved = store.load(loaded.contentHash);
    expect(saved).not.toBeNull();
    const b = createSim(loaded, { seed: 0, from: saved!.snapshot });
    expect(b.hash()).toBe(a.hash());
    expect(partyMembers(b.world)).toHaveLength(3);

    a.step(300);
    b.step(300);
    expect(b.hash()).toBe(a.hash());
  });

  it("the party state survives the JSON encoding of a save record", () => {
    const a = partyWorld();
    const text = JSON.stringify({
      v: 1,
      savedAt: 2,
      snapshot: a.snapshot(),
      settings: { ...DEFAULT_SETTINGS },
    });
    const back = decodeSave(text, loaded.contentHash);
    expect(back).not.toBeNull();
    const b = createSim(loaded, { seed: 0, from: back!.snapshot as SimSnapshot });
    expect(partyStateOf(b.world)?.members).toHaveLength(3);
    expect(b.hash()).toBe(a.hash());
  });

  it("a restored party keeps its formation and control choice", () => {
    const a = partyWorld();
    const b = createSim(loaded, { seed: 0, from: a.snapshot() });
    expect(partyStateOf(b.world)?.founder).toBe(partyStateOf(a.world)?.founder);
    expect(b.world.getResource<GameState>(RES.game)!.hero).toBe(
      a.world.getResource<GameState>(RES.game)!.hero,
    );
  });
});

describe("offline progress on a party", () => {
  /** XP plus level as one comparable number. */
  function xpScore(sim: Sim, e: number): number {
    const l = sim.world.get(e, Level)!;
    return l.level * 1_000_000 + l.xp;
  }

  it("a solo offline grant is unchanged (the founder is the only hero)", () => {
    const sim = createSim(loaded, { seed: SEED });
    sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Solo" }, "local");
    sim.step(2);
    const hero = partyMembers(sim.world)[0]!;
    const before = xpScore(sim, hero);
    const r = sim.dispatch(ACTION.offlineProgress, { elapsedMs: 3_600_000 }, VERIFIED_ACTOR);
    expect(r.ok).toBe(true);
    sim.step(1);
    expect(xpScore(sim, hero)).toBeGreaterThan(before);
  });

  it("splits XP across every member and pays the gold to the founder's purse", () => {
    const sim = partyWorld();
    const members = partyMembers(sim.world);
    const before = members.map((e) => xpScore(sim, e));
    const goldBefore = sim.world.get(members[0]!, Wallet)!.gold;
    const r = sim.dispatch(ACTION.offlineProgress, { elapsedMs: 3_600_000 }, VERIFIED_ACTOR);
    expect(r.ok).toBe(true);
    sim.step(1);
    // Every member earns a share of the kills (party XP split), not only the controlled hero.
    members.forEach((e, i) => expect(xpScore(sim, e)).toBeGreaterThan(before[i]!));
    // The gold lands on the purse (the founder), not on the controlled member (who has none).
    expect(sim.world.get(members[0]!, Wallet)!.gold).toBeGreaterThan(goldBefore);
    expect(sim.world.has(members[1]!, Wallet)).toBe(false);
  });
});

/**
 * Onboarding tips (client/tips/**): trigger rules over the facts, one tip at a time, facts read
 * from a real built snapshot, and the remembered dismissals (fake storage, throwing storage).
 */
import { describe, expect, it } from "vite-plus/test";
import { Level, Equipment } from "../src/components.ts";
import { buildHud } from "../src/client/hudModel.ts";
import { TIP_IDS, TIPS } from "../src/client/tips/catalog.ts";
import { tipFacts, type TipFacts } from "../src/client/tips/facts.ts";
import { TIP_TIMEOUT_MS, pickTip, tipsSatisfied } from "../src/client/tips/rules.ts";
import {
  TIPS_STORAGE_KEY,
  createTipsStore,
  parseDismissed,
  type TipStorage,
} from "../src/client/tips/store.ts";
import type { HudSnapshot, ItemView } from "../src/client/contract.ts";
import type { ItemInstance } from "../src/types.ts";
import { spawnTestHero, testSim, useOpenMap } from "./support/harness.ts";

const PLAIN: TipFacts = {
  playing: true,
  heroX: 10,
  heroY: 10,
  overridden: false,
  level: 9,
  skillPoints: 0,
  talentPoints: 0,
  isTown: false,
  deepest: 0,
  wornGear: false,
  setOrUnique: false,
  bagFull: false,
  bossAlive: false,
  riftUnlocked: false,
  mode: "manual",
  speed: 1,
};

const ON = { enabled: true, panels: [], dismissed: new Set<string>() } as const;

function memoryStorage(
  initial: Record<string, string> = {},
): TipStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("tip triggers", () => {
  it("shows nothing for a plain manual hero with no news", () => {
    expect(pickTip(PLAIN, ON)).toBeNull();
  });

  it("welcomes a new hero (level 3 or less) in every control mode", () => {
    expect(pickTip({ ...PLAIN, level: 1 }, ON)).toBe("welcome");
    expect(pickTip({ ...PLAIN, level: 1, mode: "auto" }, ON)).toBe("welcome");
    expect(pickTip({ ...PLAIN, level: 3, mode: "idle" }, ON)).toBe("welcome");
    expect(pickTip({ ...PLAIN, level: 4 }, ON)).toBeNull();
  });

  it("shows the first skill point, then the first talent point", () => {
    expect(pickTip({ ...PLAIN, skillPoints: 1 }, ON)).toBe("skillPoint");
    expect(pickTip({ ...PLAIN, talentPoints: 1 }, ON)).toBe("talentPoint");
  });

  it("explains the town services (smith, gambler, stash) on the first return to town", () => {
    expect(pickTip({ ...PLAIN, isTown: true, deepest: 1 }, ON)).toBe("town");
    // Not before the first dungeon trip, not in the dungeon, and not over an open panel.
    expect(pickTip({ ...PLAIN, isTown: true, deepest: 0 }, ON)).toBeNull();
    expect(pickTip({ ...PLAIN, isTown: false, deepest: 3 }, ON)).toBeNull();
    expect(
      pickTip({ ...PLAIN, isTown: true, deepest: 1 }, { ...ON, panels: ["stash"] }),
    ).toBeNull();
  });

  it("covers worn gear, sets and uniques, a full bag, a boss, the rift and Idle speed", () => {
    expect(pickTip({ ...PLAIN, wornGear: true }, ON)).toBe("wornGear");
    expect(pickTip({ ...PLAIN, setOrUnique: true }, ON)).toBe("setOrUnique");
    expect(pickTip({ ...PLAIN, bagFull: true }, ON)).toBe("bagFull");
    expect(pickTip({ ...PLAIN, bossAlive: true }, ON)).toBe("boss");
    expect(pickTip({ ...PLAIN, riftUnlocked: true }, ON)).toBe("rift");
    expect(pickTip({ ...PLAIN, mode: "idle", speed: 1 }, ON)).toBe("idleSpeed");
    expect(pickTip({ ...PLAIN, mode: "idle", speed: 4 }, ON)).toBeNull();
  });

  it("shows one tip at a time, in catalogue order", () => {
    const busy: TipFacts = { ...PLAIN, level: 1, skillPoints: 2, talentPoints: 1, bossAlive: true };
    expect(pickTip(busy, ON)).toBe("welcome");
    expect(pickTip({ ...busy, level: 9 }, ON)).toBe("skillPoint");
  });

  it("skips a dismissed tip and shows the next due one", () => {
    const f: TipFacts = { ...PLAIN, skillPoints: 1, talentPoints: 1 };
    expect(pickTip(f, { ...ON, dismissed: new Set(["skillPoint"]) })).toBe("talentPoint");
  });

  it("is hidden when tips are off, while a panel is open, and while the hero is dead or not playing", () => {
    const f: TipFacts = { ...PLAIN, skillPoints: 1 };
    expect(pickTip(f, { ...ON, enabled: false })).toBeNull();
    expect(pickTip(f, { ...ON, panels: ["character"] })).toBeNull();
    expect(pickTip({ ...f, playing: false }, ON)).toBeNull();
  });

  it("has a title and a body for every tip, with no internal ids in the text", () => {
    for (const id of TIP_IDS) {
      expect(TIPS[id].title.length).toBeGreaterThan(0);
      expect(TIPS[id].body.length).toBeGreaterThan(20);
      expect(TIPS[id].body).not.toMatch(/classic\.|test\.|\.skill\./);
    }
  });
});

describe("tip facts from a built snapshot", () => {
  function snapshot(): HudSnapshot {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestHero(sim.world, { x: 5, y: 5 });
    return buildHud(sim.world, sim.loaded.registry, { tick: 1, hovered: 0, vendor: 0, prev: null });
  }

  it("reads a fresh hero as playing, level 1, no points, not in town", () => {
    const f = tipFacts(snapshot());
    expect(f).toMatchObject({
      playing: true,
      level: 1,
      skillPoints: 0,
      talentPoints: 0,
      isTown: false,
      bagFull: false,
      mode: "manual",
    });
  });

  it("counts skill points from the hero", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
    sim.world.update(hero, Level, { skillPoints: 2 });
    const hud = buildHud(sim.world, sim.loaded.registry, {
      tick: 1,
      hovered: 0,
      vendor: 0,
      prev: null,
    });
    expect(tipFacts(hud).skillPoints).toBe(2);
  });

  it("flags worn or broken gear (durability below max, or broken) from the item views", () => {
    const hud = snapshot();
    const worn: ItemView = {
      uid: 7,
      base: "test.item.sword",
      name: "Worn",
      rarity: "normal",
      category: "weapon",
      slots: ["weapon"],
      ilvl: 1,
      reqLevel: 1,
      lines: [],
      value: 1,
      sellPrice: 0,
      icon: "icon.item.weapon",
      w: 1,
      h: 1,
      usable: true,
      upgrade: 0,
      durability: { cur: 10, max: 60 },
    };
    expect(tipFacts(hud).wornGear).toBe(false);
    expect(tipFacts({ ...hud, equipment: { ...hud.equipment, weapon: worn } }).wornGear).toBe(true);
    expect(
      tipFacts({
        ...hud,
        equipment: { ...hud.equipment, weapon: { ...worn, durability: null, broken: true } },
      }).wornGear,
    ).toBe(true);
  });

  it("flags set and unique items by rarity, and reports a full bag", () => {
    const hud = snapshot();
    const unique: ItemView = {
      uid: 8,
      base: "test.item.sword",
      name: "Unique",
      rarity: "unique",
      category: "weapon",
      slots: ["weapon"],
      ilvl: 1,
      reqLevel: 1,
      lines: [],
      value: 1,
      sellPrice: 0,
      icon: "icon.item.weapon",
      w: 1,
      h: 1,
      usable: true,
      upgrade: 0,
    };
    expect(
      tipFacts({ ...hud, inventory: { ...hud.inventory, items: [{ x: 0, y: 0, item: unique }] } })
        .setOrUnique,
    ).toBe(true);
    const full = {
      ...hud,
      inventory: {
        cols: 2,
        rows: 1,
        items: [
          { x: 0, y: 0, item: unique },
          { x: 1, y: 0, item: { ...unique, uid: 9, rarity: "normal" as const } },
        ],
      },
    };
    expect(tipFacts(full).bagFull).toBe(true);
  });

  it("is quiet for a bag of normal items", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5 });
    const item: ItemInstance = {
      uid: 3,
      base: "test.item.sword",
      rarity: "normal",
      ilvl: 1,
      name: "Plain",
      mods: [],
      affixes: [],
      value: 1,
    };
    sim.world.update(hero, Equipment, { weapon: item });
    const hud = buildHud(sim.world, sim.loaded.registry, {
      tick: 1,
      hovered: 0,
      vendor: 0,
      prev: null,
    });
    expect(tipFacts(hud).setOrUnique).toBe(false);
  });
});

describe("tips answered by an action", () => {
  const moved: TipFacts = { ...PLAIN, level: 1, heroX: 12.5, heroY: 10 };

  it("dismisses the welcome card after the first walk under manual control", () => {
    expect(tipsSatisfied({ ...PLAIN, level: 1 }, moved, [])).toEqual(["welcome"]);
  });

  it("dismisses the welcome card when the player takes over from Auto or Idle", () => {
    for (const mode of ["auto", "idle"] as const) {
      const before = { ...PLAIN, level: 1, mode };
      expect(tipsSatisfied(before, { ...before, overridden: true }, [])).toEqual(["welcome"]);
      // Only the switch counts: an override that was already on when the card appeared does not.
      const held = { ...before, overridden: true };
      expect(tipsSatisfied(held, held, [])).toEqual([]);
      expect(tipsSatisfied(null, held, [])).toEqual([]);
    }
  });

  it("reads whole tiles, so a mid-step snapshot is not a walk", () => {
    const sim = testSim([]);
    useOpenMap(sim, 1);
    spawnTestHero(sim.world, { x: 5, y: 5 });
    const hud = buildHud(sim.world, sim.loaded.registry, {
      tick: 1,
      hovered: 0,
      vendor: 0,
      prev: null,
    });
    const hero = hud.hero;
    expect(hero).not.toBeNull();
    if (hero === null) return;
    const at = (x: number, y: number) => tipFacts({ ...hud, hero: { ...hero, x, y } });
    expect(at(5.25, 5.75)).toMatchObject({ heroX: 5, heroY: 5 });
    expect(tipsSatisfied(at(5, 5), at(5.75, 5.5), [])).toEqual([]);
    expect(at(5, 5).overridden).toBe(hud.control.overridden);
  });

  it("keeps the welcome card while the hero is still, or moves under automation or idle", () => {
    expect(tipsSatisfied(PLAIN, { ...PLAIN, level: 1 }, [])).toEqual([]);
    expect(tipsSatisfied(null, moved, [])).toEqual([]);
    expect(tipsSatisfied({ ...PLAIN, mode: "auto" }, { ...moved, mode: "auto" }, [])).toEqual([]);
    expect(tipsSatisfied({ ...PLAIN, mode: "idle" }, { ...moved, mode: "idle" }, [])).toEqual([]);
  });

  it("dismisses the skill point tip once a point is spent", () => {
    const before = { ...PLAIN, skillPoints: 2 };
    expect(tipsSatisfied(before, { ...PLAIN, skillPoints: 1 }, [])).toEqual(["skillPoint"]);
    expect(tipsSatisfied(before, before, [])).toEqual([]);
  });

  it("dismisses the skill point tip when the Skills panel opens while a point is unspent", () => {
    expect(tipsSatisfied(PLAIN, { ...PLAIN, skillPoints: 1 }, ["skills"])).toEqual(["skillPoint"]);
    // No point to spend: opening Skills does not answer a tip that is not due.
    expect(tipsSatisfied(PLAIN, PLAIN, ["skills"])).toEqual([]);
  });

  it("answers the talent point the same way (spent, or the Talents panel open)", () => {
    const before = { ...PLAIN, talentPoints: 1 };
    expect(tipsSatisfied(before, { ...PLAIN, talentPoints: 0 }, [])).toEqual(["talentPoint"]);
    expect(tipsSatisfied(PLAIN, { ...PLAIN, talentPoints: 1 }, ["talents"])).toEqual([
      "talentPoint",
    ]);
    expect(tipsSatisfied(PLAIN, PLAIN, ["talents"])).toEqual([]);
  });

  it("gives the picker a bounded timeout for a tip nobody answers", () => {
    expect(TIP_TIMEOUT_MS).toBe(30_000);
  });

  it("a skill point tip answered by the Skills panel is no longer picked", () => {
    const f: TipFacts = { ...PLAIN, skillPoints: 1 };
    expect(
      pickTip(f, { enabled: true, panels: [], dismissed: new Set(["skillPoint"]) }),
    ).toBeNull();
  });
});

describe("remembered dismissals", () => {
  it("starts empty and remembers a dismissal under the versioned key", () => {
    const storage = memoryStorage();
    const store = createTipsStore(storage);
    expect(store.dismissed().size).toBe(0);
    store.dismiss("skillPoint");
    expect(store.dismissed().has("skillPoint")).toBe(true);
    expect(storage.data.get(TIPS_STORAGE_KEY)).toBe('["skillPoint"]');
    expect(TIPS_STORAGE_KEY).toBe("gamez.classic.tips.v1");
  });

  it("reads the dismissals back in a new store on the same storage", () => {
    const storage = memoryStorage();
    createTipsStore(storage).dismiss("boss");
    expect(createTipsStore(storage).dismissed().has("boss")).toBe(true);
  });

  it("keeps the same Set object until something changes, and notifies subscribers", () => {
    const store = createTipsStore(memoryStorage());
    const before = store.dismissed();
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.dismiss("rift");
    expect(calls).toBe(1);
    expect(store.dismissed()).not.toBe(before);
    store.dismiss("rift");
    expect(calls).toBe(1);
    off();
    store.dismiss("boss");
    expect(calls).toBe(1);
  });

  it("reset forgets every dismissal and clears the stored key", () => {
    const storage = memoryStorage();
    const store = createTipsStore(storage);
    store.dismiss("welcome");
    store.reset();
    expect(store.dismissed().size).toBe(0);
    expect(storage.data.has(TIPS_STORAGE_KEY)).toBe(false);
    expect(createTipsStore(storage).dismissed().size).toBe(0);
  });

  it("works in memory when storage throws (private windows, blocked storage)", () => {
    const broken: TipStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const store = createTipsStore(broken);
    expect(store.dismissed().size).toBe(0);
    store.dismiss("welcome");
    expect(store.dismissed().has("welcome")).toBe(true);
    expect(() => store.reset()).not.toThrow();
  });

  it("works without any storage at all", () => {
    const store = createTipsStore(null);
    store.dismiss("idleSpeed");
    expect(store.dismissed().has("idleSpeed")).toBe(true);
  });

  it("parses only a JSON array of strings, capped in length", () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed("not json")).toEqual([]);
    expect(parseDismissed('{"welcome": true}')).toEqual([]);
    expect(parseDismissed('["welcome", 3, null, "boss"]')).toEqual(["welcome", "boss"]);
    expect(
      parseDismissed(JSON.stringify(Array.from({ length: 500 }, (_, i) => `t${i}`))),
    ).toHaveLength(100);
  });
});

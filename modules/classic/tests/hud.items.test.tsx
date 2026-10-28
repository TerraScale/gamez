/**
 * Item HUD render tests (T-items-hud): tooltip, inventory cells, smith, gambler,
 * stash tabs and loot filter. The snapshots come from the real sim (buildHud on
 * the item fixture) and are rendered with react-dom/server. Button payloads and
 * disabled reasons are checked on the pure option builders the panels use.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createSlotRegistry } from "@gamez/ui-host";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Entity } from "@gamez/kernel";
import { ACTION } from "../src/actions.ts";
import type {
  ClassicClientApi,
  CraftItemView,
  HudSnapshot,
  ItemView,
  LogLine,
  MinimapData,
  Store,
  UiState,
} from "../src/client/contract.ts";
import { buildHud } from "../src/client/hudModel.ts";
import { ClassicHud, registerDefaultHud } from "../src/client/hud/index.tsx";
import {
  combineOption,
  craftOptions,
  pickGem,
  repairAllOption,
} from "../src/client/hud/panels/CraftPanel.tsx";
import { gambleOptions } from "../src/client/hud/panels/GamblePanel.tsx";
import { InventoryPanel, CellMarks } from "../src/client/hud/panels/InventoryPanel.tsx";
import {
  FILTER_NOTE,
  flagPatch,
  goldChoices,
  MIN_RARITY_CHOICES,
  minRarityPatch,
  resetPatch,
} from "../src/client/hud/panels/LootFilterPanel.tsx";
import { clampTab, selectStashTab, tabsOrDefault } from "../src/client/hud/panels/StashPanel.tsx";
import { VendorPanel } from "../src/client/hud/panels/VendorPanel.tsx";
import { durabilityText, socketSummary, Tooltip } from "../src/client/hud/widgets/Tooltip.tsx";
import { DEFAULT_LOOT_FILTER, RES, type StashState } from "../src/resources.ts";
import {
  GAMBLER,
  GEM_RUBY_1,
  GEM_RUBY_2,
  GEM_RUBY_5,
  GEM_TOPAZ_1,
  JUNK,
  OAK_CAP,
  OAK_STAFF,
  SMITH,
  itemOf,
  itemsSim,
  setBag,
  setLootFilter,
  setWorn,
  spawnHero,
  spawnLoot,
  spawnNpc,
} from "./model.items.fixture.ts";
import type { Sim } from "@gamez/kernel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function staticStore<T>(value: T): Store<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

function makeUi(over: Partial<UiState> = {}): UiState {
  return {
    panels: [],
    toasts: [],
    settings: {
      showDamageNumbers: true,
      showLootLabels: true,
      showMinimap: false,
      zoom: 1,
      lighting: true,
      showPerf: false,
      masterVolume: 70,
      sfxVolume: 80,
      musicVolume: 45,
      muted: false,
      quality: "auto",
      tips: true,
      outlineHero: true,
    },
    hover: null,
    compact: false,
    perf: { fps: 60, tickMs: 0.5, ticksPerSecond: 20, entities: 310, monsters: 42 },
    error: null,
    ...over,
  };
}

interface Call {
  name: string;
  payload: unknown;
}

function fakeApi(hud: HudSnapshot, ui: Partial<UiState> = {}) {
  const calls: Call[] = [];
  const log: LogLine[] = [];
  const api: ClassicClientApi = {
    hud: staticStore(hud),
    log: staticStore(log),
    ui: staticStore(makeUi(ui)),
    act(name, payload) {
      calls.push({ name, payload });
      return { ok: true, events: [], tick: hud.tick };
    },
    togglePanel() {},
    openPanel() {},
    closePanel() {},
    closeAll() {},
    setHover() {},
    updateSettings() {},
    dismissToast() {},
    minimap: (): MinimapData | null => null,
    castSlot() {},
    drink() {},
    newGame() {},
    exit() {},
  };
  return { api, calls };
}

function renderHud(api: ClassicClientApi): string {
  const slots = createSlotRegistry();
  registerDefaultHud(slots);
  return renderToStaticMarkup(<ClassicHud api={api} slots={slots} />);
}

function snap(sim: Sim, vendor: Entity = 0): HudSnapshot {
  return buildHud(sim.world, sim.loaded.registry, { tick: 300, hovered: 0, vendor, prev: null });
}

/** A sim with a hero (gold 1000 unless told, level 10), a smith, a gambler and a junk buyer in town. */
function townSim(gold = 1000) {
  const sim = itemsSim();
  const hero = spawnHero(sim.world, { gold, level: 10 });
  const smith = spawnNpc(sim.world, SMITH, 6, 5);
  const gambler = spawnNpc(sim.world, GAMBLER, 7, 5);
  const junk = spawnNpc(sim.world, JUNK, 8, 5);
  return { sim, hero, smith, gambler, junk };
}

afterEach(() => {
  selectStashTab(0);
});

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

describe("tooltip: set, sockets, durability, upgrade and filter", () => {
  it("shows the set pieces with worn marks and the bonus as inactive, then active when both are worn", () => {
    const { sim, hero } = townSim();
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", {
        rarity: "set",
        set: OAK_STAFF,
        name: "Oak Staff of Ash",
      }),
    });
    setBag(sim.world, hero, [
      itemOf(2, "test.item.cap", { rarity: "set", set: OAK_CAP, name: "Oak Cap of Ash" }),
    ]);
    const first = fakeApi(snap(sim), { hover: { uid: 2, x: 10, y: 10 } });
    const markup = renderHud(first.api);
    expect(markup).toContain("Ash Circle");
    expect(markup).toContain("✓ Oak Staff of Ash");
    expect(markup).toContain("✗ Oak Cap of Ash");
    expect(markup).toContain("2 pieces (inactive): +5 to Strength");

    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", {
        rarity: "set",
        set: OAK_STAFF,
        name: "Oak Staff of Ash",
      }),
      helm: itemOf(3, "test.item.cap", { rarity: "set", set: OAK_CAP, name: "Oak Cap of Ash" }),
    });
    const worn = fakeApi(snap(sim), { hover: { uid: 2, x: 10, y: 10 } });
    expect(renderHud(worn.api)).toContain("2 pieces (active): +5 to Strength");
  });

  it("shows sockets as glyphs with the gem lines, the upgrade badge and the durability", () => {
    const { sim, hero } = townSim();
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", {
        sockets: [GEM_RUBY_1, null],
        upgrade: 2,
        dur: { cur: 45, max: 60 },
      }),
    });
    const { api } = fakeApi(snap(sim), { hover: { uid: 1, x: 10, y: 10 } });
    const markup = renderHud(api);
    expect(markup).toContain('aria-label="Socket 1: Chipped Ruby"');
    expect(markup).toContain('aria-label="Socket 2: empty"');
    expect(markup).toContain("1 of 2 sockets filled");
    expect(markup).toContain("Chipped Ruby</span>: +3 Fire Damage");
    expect(markup).toContain(">+2<");
    expect(markup).toContain("Durability 45 / 60");
    expect(markup).toContain("+12% Damage (upgrade +2)");
  });

  it("does not repeat the +L badge when the item name already shows the level", () => {
    const { sim, hero } = townSim();
    setBag(sim.world, hero, [
      itemOf(2, "test.item.sword", { name: "Fiery Dagger +2", upgrade: 2 }),
      itemOf(3, "test.item.sword", { name: "Fiery Dagger", upgrade: 2 }),
    ]);
    const named = renderHud(fakeApi(snap(sim), { hover: { uid: 2, x: 10, y: 10 } }).api);
    expect(named).toContain("Fiery Dagger +2");
    expect(named).not.toContain('data-testid="tooltip-upgrade"');
    const plain = renderHud(fakeApi(snap(sim), { hover: { uid: 3, x: 10, y: 10 } }).api);
    expect(plain).toContain('data-testid="tooltip-upgrade"');
  });

  it("says Broken in red when durability is gone and hides the loot filter note on worn items", () => {
    const { sim, hero } = townSim();
    setLootFilter(sim.world, { minRarity: { ...DEFAULT_LOOT_FILTER.minRarity, weapon: "magic" } });
    setBag(sim.world, hero, [
      itemOf(2, "test.item.sword", { dur: { cur: 0, max: 60 } }),
      itemOf(3, "test.item.sword"),
    ]);
    const bag = fakeApi(snap(sim), { hover: { uid: 2, x: 10, y: 10 } });
    const markup = renderHud(bag.api);
    expect(markup).toContain("Broken: no stats until repaired");
    expect(markup).toContain("Hidden by the loot filter");
    const normal = fakeApi(snap(sim), { hover: { uid: 3, x: 10, y: 10 } });
    expect(renderHud(normal.api)).toContain("Hidden by the loot filter");
  });

  it("does not show the filter note for an equipped item the filter would hide", () => {
    const { sim, hero } = townSim();
    setLootFilter(sim.world, { minRarity: { ...DEFAULT_LOOT_FILTER.minRarity, weapon: "magic" } });
    setWorn(sim.world, hero, { weapon: itemOf(1, "test.item.sword") });
    const { api } = fakeApi(snap(sim), { hover: { uid: 1, x: 10, y: 10 } });
    expect(renderHud(api)).not.toContain("Hidden by the loot filter");
  });

  it("durabilityText and socketSummary format the lines", () => {
    expect(durabilityText({ cur: 40, max: 60 }, false)).toBe("Durability 40 / 60");
    expect(durabilityText({ cur: 0, max: 60 }, true)).toBe("Broken: no stats until repaired");
    expect(socketSummary([{ gem: "x" }, { gem: null }])).toBe("1 of 2 sockets filled");
    expect(socketSummary([{ gem: null }])).toBe("0 of 1 socket filled");
  });

  it("is only a tooltip when the hovered item exists", () => {
    const { sim } = townSim();
    const { api } = fakeApi(snap(sim), { hover: { uid: 999, x: 1, y: 1 } });
    expect(renderToStaticMarkup(<Tooltip api={api} />)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Inventory cells
// ---------------------------------------------------------------------------

describe("inventory cells", () => {
  it("tints broken items, lists sockets in the label, and shows the gem tier", () => {
    const { sim, hero } = townSim();
    setBag(sim.world, hero, [
      itemOf(2, "test.item.sword", { dur: { cur: 0, max: 60 } }),
      itemOf(3, "test.item.cap", { sockets: [GEM_RUBY_1, null] }),
      itemOf(4, GEM_RUBY_2, { name: "Flawed Ruby" }),
    ]);
    const { api } = fakeApi(snap(sim));
    const markup = renderToStaticMarkup(<InventoryPanel api={api} />);
    expect(markup).toContain(", broken");
    expect(markup).toContain(", 2 sockets");
    expect(markup).toContain(">T2<");
  });

  it("CellMarks draws a durability tick only for worn items, and socket dots for sockets", () => {
    const worn = {
      uid: 1,
      base: "test.item.sword",
      name: "Sword",
      rarity: "normal",
      category: "weapon",
      durability: { cur: 30, max: 60 },
      sockets: [{ gem: null, name: "Empty socket", lines: [] }],
    } as unknown as ItemView;
    const full = {
      ...worn,
      durability: { cur: 60, max: 60 },
      sockets: undefined,
    } as unknown as ItemView;
    expect(renderToStaticMarkup(<CellMarks item={worn} />)).toContain("width:50%");
    expect(renderToStaticMarkup(<CellMarks item={full} />)).not.toContain("width:");
  });
});

// ---------------------------------------------------------------------------
// Vendor entry points
// ---------------------------------------------------------------------------

describe("vendor panel entry points", () => {
  it("the smith opens Smithing, the gambler opens Gamble, the junk buyer keeps its sell list", () => {
    const { sim, smith, gambler, junk } = townSim();
    const panelMarkup = (vendor: Entity) =>
      renderToStaticMarkup(
        <VendorPanel api={fakeApi(snap(sim, vendor), { panels: ["vendor"] }).api} />,
      );
    expect(panelMarkup(smith)).toContain("Smithing");
    expect(panelMarkup(smith)).not.toContain(">Gamble<");
    expect(panelMarkup(gambler)).toContain("Gamble");
    expect(panelMarkup(gambler)).not.toContain("Smithing");
    expect(panelMarkup(junk)).toContain("Pays 10% of an item");
    expect(panelMarkup(junk)).not.toContain("Smithing");
  });
});

// ---------------------------------------------------------------------------
// Smith
// ---------------------------------------------------------------------------

function craftRow(over: Partial<CraftItemView> = {}): CraftItemView {
  return {
    item: {
      uid: 1,
      base: "test.item.sword",
      name: "Test Sword",
      rarity: "normal",
      category: "weapon",
      slots: ["weapon"],
      ilvl: 3,
      reqLevel: 1,
      lines: [],
      value: 30,
      sellPrice: 0,
      icon: "icon.item.weapon",
      w: 1,
      h: 3,
      usable: true,
      upgrade: 0,
      durability: { cur: 30, max: 60 },
    } as unknown as ItemView,
    where: "equipped",
    repairCost: 15,
    upgradeCost: 30,
    upgradeChance: 90,
    rerollCost: null,
    socketCost: 100,
    canSocket: false,
    unsocketCost: null,
    ...over,
  };
}

describe("smith options", () => {
  it("repair is enabled with its payload when the gold covers it", () => {
    const opts = craftOptions(craftRow(), 7, 1000, null);
    const repair = opts.find((o) => o.key === "repair")!;
    expect(repair).toMatchObject({ label: "Repair", enabled: true, caption: "15 g" });
    expect(repair.act).toEqual({ name: ACTION.repair, payload: { npc: 7, uid: 1 } });
  });

  it("disables with 'Not enough gold' and no payload when the gold is short", () => {
    const repair = craftOptions(craftRow(), 7, 10, null).find((o) => o.key === "repair")!;
    expect(repair.enabled).toBe(false);
    expect(repair.caption).toBe("15 g · Not enough gold");
    expect(repair.act).toBeNull();
  });

  it("upgrade shows the next level and the chance; max level and no-price reasons", () => {
    const up = craftOptions(craftRow(), 7, 1000, null).find((o) => o.key === "upgrade")!;
    expect(up.label).toBe("Upgrade to +1");
    expect(up.caption).toBe("30 g · 90% chance");
    expect(up.act).toEqual({ name: ACTION.upgradeItem, payload: { npc: 7, uid: 1 } });
    const max = craftOptions(
      craftRow({
        upgradeCost: null,
        upgradeChance: null,
        item: { ...craftRow().item, upgradeLevel: 3 },
      }),
      7,
      1000,
      null,
    ).find((o) => o.key === "upgrade")!;
    expect(max).toMatchObject({ label: "Upgrade to +4", enabled: false, caption: "Max level" });
    expect(max.act).toBeNull();
  });

  it("reroll explains that only magic and rare items can be rerolled", () => {
    const reroll = craftOptions(craftRow(), 7, 1000, null).find((o) => o.key === "reroll")!;
    expect(reroll).toMatchObject({ enabled: false, caption: "Only magic and rare items" });
  });

  it("socket gem needs a bag gem, an empty socket and a sockets list", () => {
    const noGem = craftOptions(craftRow({ canSocket: false }), 7, 1000, null).find(
      (o) => o.key === "socket",
    )!;
    expect(noGem).toMatchObject({ enabled: false, caption: "No gem in your bag" });
    const noSocket = craftOptions(craftRow({ canSocket: false }), 7, 1000, 99).find(
      (o) => o.key === "socket",
    )!;
    expect(noSocket.caption).toBe("Add a socket first");
    const ok = craftOptions(
      craftRow({
        canSocket: true,
        item: { ...craftRow().item, sockets: [null] } as unknown as ItemView,
      }),
      7,
      1000,
      99,
    ).find((o) => o.key === "socket")!;
    expect(ok).toMatchObject({ enabled: true, caption: "Free" });
    expect(ok.act).toEqual({ name: ACTION.socketGem, payload: { npc: 7, uid: 1, gem: 99 } });
  });

  it("removing gems is disabled without gems and costs the flat unsocket price with them", () => {
    const none = craftOptions(craftRow({ unsocketCost: null }), 7, 1000, null).find(
      (o) => o.key === "unsocket",
    )!;
    expect(none).toMatchObject({ enabled: false, caption: "No gems socketed" });
    const some = craftOptions(craftRow({ unsocketCost: 40 }), 7, 1000, null).find(
      (o) => o.key === "unsocket",
    )!;
    expect(some.act).toEqual({ name: ACTION.unsocketGems, payload: { npc: 7, uid: 1 } });
  });

  it("repair all carries uid 0 and is disabled when nothing needs repair", () => {
    const yes = repairAllOption(7, 120, 1000);
    expect(yes).toMatchObject({ label: "Repair all", enabled: true, caption: "120 g" });
    expect(yes.act).toEqual({ name: ACTION.repair, payload: { npc: 7, uid: 0 } });
    expect(repairAllOption(7, 0, 1000)).toMatchObject({
      enabled: false,
      caption: "Nothing to repair",
    });
  });

  it("combine needs three of a kind, not radiant, and the gold for the combine price", () => {
    const gem = { base: GEM_RUBY_1, name: "Chipped Ruby", tier: 1, count: 2, combineCost: null };
    expect(combineOption(gem, 7, 1000)).toMatchObject({
      enabled: false,
      caption: "Needs 3 of this gem",
    });
    const three = { ...gem, count: 3, combineCost: 60 };
    expect(combineOption(three, 7, 1000)).toMatchObject({
      enabled: true,
      caption: "60 g · 3 into tier 2",
    });
    expect(combineOption(three, 7, 1000).act).toEqual({
      name: ACTION.combineGems,
      payload: { npc: 7, base: GEM_RUBY_1 },
    });
    expect(combineOption(three, 7, 10).caption).toBe("60 g · 3 into tier 2 · Not enough gold");
    const top = { base: GEM_RUBY_5, name: "Radiant Ruby", tier: 5, count: 4, combineCost: null };
    expect(combineOption(top, 7, 1000)).toMatchObject({
      enabled: false,
      caption: "Already radiant",
    });
  });

  it("pickGem chooses the named group or the first, null without gems", () => {
    const gems = [
      { base: GEM_RUBY_1, uids: [1] },
      { base: GEM_TOPAZ_1, uids: [2] },
    ];
    expect(pickGem(gems, GEM_TOPAZ_1)?.uids).toEqual([2]);
    expect(pickGem(gems, "missing")?.uids).toEqual([1]);
    expect(pickGem([], null)).toBeNull();
  });

  it("renders the smith panel from the real snapshot: sections, prices and disabled states", () => {
    const { sim, hero, smith } = townSim();
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", { value: 30, dur: { cur: 30, max: 60 } }),
    });
    setBag(sim.world, hero, [itemOf(5, GEM_RUBY_1), itemOf(6, GEM_RUBY_1), itemOf(7, GEM_RUBY_1)]);
    const { api } = fakeApi(snap(sim, smith), { panels: ["craft"] });
    const markup = renderHud(api);
    expect(markup).toContain("Smithing");
    expect(markup).toContain("Repair all");
    expect(markup).toContain("Upgrade to +1");
    expect(markup).toContain("30 g · 90% chance");
    expect(markup).toContain("Remove gems");
    expect(markup).toContain("Chipped Ruby (tier 1) × 3");
    expect(markup).toContain("Combine");
    expect(markup).toContain("Gem to socket");
  });

  it("the smith panel says so when nothing is open", () => {
    const { sim } = townSim();
    const { api } = fakeApi(snap(sim), { panels: ["craft"] });
    expect(renderHud(api)).toContain("The smith is not working right now.");
  });
});

// ---------------------------------------------------------------------------
// Gambler
// ---------------------------------------------------------------------------

describe("gamble panel", () => {
  it("offers one option per category with price, affordability and the buy payload", () => {
    const { sim, gambler } = townSim();
    const view = snap(sim, gambler).gamble!;
    const offers = gambleOptions(view);
    expect(offers.map((o) => [o.label, o.caption, o.enabled])).toEqual([
      ["Random weapon", "400 g", true],
      ["Random ring", "200 g", true],
    ]);
    expect(offers[0]!.act).toEqual({
      name: ACTION.gamble,
      payload: { npc: gambler, category: "weapon" },
    });
  });

  it("an offer costing more than the gold is disabled, with the reason and no payload", () => {
    const { sim, gambler } = townSim(300);
    const offers = gambleOptions(snap(sim, gambler).gamble!);
    expect(offers.map((o) => [o.label, o.enabled])).toEqual([
      ["Random weapon", false],
      ["Random ring", true],
    ]);
    expect(offers[0]).toMatchObject({ caption: "400 g · Not enough gold", act: null });
    const markup = renderHud(fakeApi(snap(sim, gambler), { panels: ["gamble"] }).api);
    expect(markup).toContain("Feeling lucky?");
    expect(markup).toContain("Buy Random weapon");
  });

  it("renders the Gambler panel with cards and says so when no gambler is open", () => {
    const { sim, gambler } = townSim();
    expect(renderHud(fakeApi(snap(sim, gambler), { panels: ["gamble"] }).api)).toContain(
      "Each item is rolled at your level",
    );
    expect(renderHud(fakeApi(snap(sim, 0), { panels: ["gamble"] }).api)).toContain(
      "Nobody is gambling right now.",
    );
  });
});

// ---------------------------------------------------------------------------
// Stash tabs
// ---------------------------------------------------------------------------

describe("stash tabs", () => {
  it("falls back to one tab of the whole stash, and clamps the selected tab into range", () => {
    expect(tabsOrDefault([], 3, 50)).toEqual([{ index: 0, name: "Stash", count: 3, size: 50 }]);
    expect(clampTab(7, 4)).toBe(3);
    expect(clampTab(-1, 4)).toBe(0);
    expect(clampTab(2, 0)).toBe(0);
  });

  it("shows the tab strip with counts and only the selected tab's items", () => {
    const { sim, hero } = townSim();
    sim.world.setResource<StashState>(RES.stash, {
      items: [
        itemOf(4, "test.item.sword", { tab: 0, name: "Keen Sword" }),
        itemOf(5, "test.item.ring", { tab: 2, name: "Silver Ring" }),
      ],
      tabNames: ["Gear"],
    });
    setBag(sim.world, hero, [itemOf(6, "test.item.cap", { name: "Iron Cap" })]);
    const first = renderHud(fakeApi(snap(sim), { panels: ["stash"] }).api);
    expect(first).toContain("Gear · 1/50");
    expect(first).toContain("Tab 3 · 1/50");
    expect(first).toContain("In Gear");
    expect(first).toContain("Keen Sword");
    expect(first).not.toContain("Silver Ring");
    // the move select lists the other tabs
    expect(first).toContain('aria-label="Move Keen Sword to tab"');
    expect(first).toContain("Tab 3");
    expect(first).toContain("Put Iron Cap into Gear");

    selectStashTab(2);
    const third = renderHud(fakeApi(snap(sim), { panels: ["stash"] }).api);
    expect(third).toContain("In Tab 3");
    expect(third).toContain("Silver Ring");
    expect(third).not.toContain("Keen Sword");
    expect(third).toContain("Put Iron Cap into Tab 3");
  });

  it("shows an empty tab plainly", () => {
    const { sim } = townSim();
    selectStashTab(1);
    const markup = renderHud(fakeApi(snap(sim), { panels: ["stash"] }).api);
    expect(markup).toContain("This tab is empty.");
  });
});

// ---------------------------------------------------------------------------
// Loot filter
// ---------------------------------------------------------------------------

describe("loot filter", () => {
  it("builds one patch per edit, always with the full rarity map", () => {
    const filter = { ...DEFAULT_LOOT_FILTER, minRarity: { ...DEFAULT_LOOT_FILTER.minRarity } };
    expect(minRarityPatch(filter, "weapon", "magic")).toEqual({
      filter: { minRarity: { ...DEFAULT_LOOT_FILTER.minRarity, weapon: "magic" } },
    });
    expect(flagPatch({ showGold: false })).toEqual({ filter: { showGold: false } });
    expect(flagPatch({ minGold: 250 })).toEqual({ filter: { minGold: 250 } });
    expect(resetPatch().filter).toEqual(DEFAULT_LOOT_FILTER);
  });

  it("offers the presets and keeps the current minimum gold in the list, sorted", () => {
    expect(goldChoices(275)).toEqual([0, 50, 100, 250, 275, 500, 1000]);
    expect(goldChoices(50)).toEqual([0, 50, 100, 250, 500, 1000]);
    expect(MIN_RARITY_CHOICES.map((c) => c.value)).toEqual(["none", "normal", "magic", "rare"]);
  });

  it("renders the segmented rarity choices (pressed) and the hidden count", () => {
    const { sim, hero } = townSim();
    setLootFilter(sim.world, { minRarity: { ...DEFAULT_LOOT_FILTER.minRarity, weapon: "magic" } });
    setBag(sim.world, hero, []);
    spawnLoot(sim.world, itemOf(20, "test.item.sword", { rarity: "normal" }));
    spawnLoot(sim.world, itemOf(21, "test.item.sword", { rarity: "normal" }));
    const markup = renderHud(fakeApi(snap(sim), { panels: ["lootFilter"] }).api);
    expect(markup).toContain("Hidden on the ground here: 2");
    expect(markup).toContain('aria-label="Weapon: show Magic and better" aria-pressed="true"');
    expect(markup).toContain('aria-label="Weapon: show nothing" aria-pressed="false"');
    expect(markup).toContain("Sets and uniques (Set, Unique) always show");
    expect(markup).toContain("Reset to defaults");
    expect(markup).toContain(FILTER_NOTE.slice(0, 40));
  });

  it("the filter panel says so when the view is missing", () => {
    const { api } = fakeApi(
      { ...snap(townSim().sim), lootFilter: null },
      { panels: ["lootFilter"] },
    );
    expect(renderHud(api)).toContain("The loot filter is not available right now.");
  });
});

// ---------------------------------------------------------------------------
// Phone width (390 px): nothing in these panels is wider than the viewport
// ---------------------------------------------------------------------------

describe("compact layout", () => {
  it("the item panels never ask for a width over 390 px in their inline styles", () => {
    const { sim, hero, smith, gambler } = townSim();
    setWorn(sim.world, hero, {
      weapon: itemOf(1, "test.item.sword", { value: 30, dur: { cur: 30, max: 60 } }),
    });
    setBag(sim.world, hero, [itemOf(5, GEM_RUBY_1), itemOf(6, GEM_RUBY_1), itemOf(7, GEM_RUBY_1)]);
    sim.world.setResource<StashState>(RES.stash, {
      items: [itemOf(8, "test.item.ring", { tab: 1, name: "Ring" })],
    });
    const cases: [string, HudSnapshot][] = [
      ["craft", snap(sim, smith)],
      ["gamble", snap(sim, gambler)],
      ["stash", snap(sim)],
      ["lootFilter", snap(sim)],
      ["vendor", snap(sim, smith)],
    ];
    for (const [panel, hud] of cases) {
      const markup = renderHud(
        fakeApi(hud, { panels: [panel as UiState["panels"][number]], compact: true }).api,
      );
      // Only the panel itself (the XP bar and other widgets are not in the panel frame).
      const frame = /<section role="dialog"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
      expect(frame, panel).not.toBe("");
      const widths = [...frame.matchAll(/(?:^|[;"\s])(?:min-)?width:(\d+)px/g)].map((m) =>
        Number(m[1]),
      );
      for (const w of widths) expect(w, panel).toBeLessThanOrEqual(390);
      expect(markup, panel).toContain('role="dialog"');
    }
  });
});

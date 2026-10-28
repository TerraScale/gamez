/**
 * HUD render tests (T9). A fake ClassicClientApi with static stores (fixture
 * below) is rendered with react-dom/server; behaviour is asserted on markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createSlotRegistry } from "@gamez/ui-host";
import { describe, expect, it } from "vite-plus/test";
import type { HeroStatsValue } from "../src/components.ts";
import type {
  ClassicClientApi,
  HeroView,
  HudSnapshot,
  ItemView,
  LogLine,
  MinimapData,
  Store,
  UiState,
} from "../src/client/contract.ts";
import { ClassicHud, registerDefaultHud } from "../src/client/hud/index.tsx";
import { CharacterPanel } from "../src/client/hud/panels/CharacterPanel.tsx";
import { InventoryPanel } from "../src/client/hud/panels/InventoryPanel.tsx";
import { SkillsPanel } from "../src/client/hud/panels/SkillsPanel.tsx";
import { QuestsPanel } from "../src/client/hud/panels/QuestsPanel.tsx";
import { VendorPanel } from "../src/client/hud/panels/VendorPanel.tsx";
import { StashPanel } from "../src/client/hud/panels/StashPanel.tsx";
import { WaypointPanel } from "../src/client/hud/panels/WaypointPanel.tsx";
import { SettingsPanel } from "../src/client/hud/panels/SettingsPanel.tsx";
import { LogPanel } from "../src/client/hud/panels/LogPanel.tsx";
import { DeathScreen } from "../src/client/hud/widgets/DeathScreen.tsx";
import { NewHeroScreen } from "../src/client/hud/widgets/NewHeroScreen.tsx";
import type { EquipSlot } from "../src/types.ts";
import { DEFAULT_AUTO_CONFIG } from "../src/resources.ts";
import type { PanelId } from "../src/client/contract.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function staticStore<T>(value: T): Store<T> {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  };
}

const NO_EQUIPMENT: Record<EquipSlot, ItemView | null> = {
  weapon: null,
  offhand: null,
  helm: null,
  armor: null,
  gloves: null,
  boots: null,
  amulet: null,
  ring1: null,
  ring2: null,
};

export function makeItem(over: Partial<ItemView> = {}): ItemView {
  return {
    uid: 1,
    base: "classic.item.short-sword",
    name: "Rusted Short Sword",
    rarity: "normal",
    category: "weapon",
    slots: ["weapon"],
    ilvl: 3,
    reqLevel: 1,
    lines: ["4-7 damage", "+2 to Strength"],
    value: 40,
    sellPrice: 12,
    icon: "icon.item.weapon",
    w: 1,
    h: 2,
    usable: true,
    upgrade: 0,
    ...over,
  };
}

export function makeHero(over: Partial<HeroView> = {}): HeroView {
  const attrs = { str: 25, dex: 20, mag: 10, vit: 30 };
  const sheet: HeroStatsValue = {
    attrs,
    lifeMax: 150,
    manaMax: 80,
    lifeRegen: 15,
    manaRegen: 20,
    magicFind: 12,
    goldFind: 8,
    lightRadius: 6,
    lifeOnKill: 0,
    manaOnKill: 0,
    allSkills: 0,
    potionPct: 0,
    twoHanded: false,
    primary: "str",
  };
  return {
    entity: 1,
    name: "Aria",
    classId: "classic.warrior",
    className: "Warrior",
    level: 5,
    xp: 900,
    xpLevelStart: 700,
    xpNextLevel: 1100,
    life: 120,
    lifeMax: 150,
    mana: 40,
    manaMax: 80,
    gold: 1234,
    tpScrolls: 2,
    statPoints: 0,
    skillPoints: 0,
    attrs,
    baseAttrs: attrs,
    sheet,
    armor: 30,
    dmgMin: 4,
    dmgMax: 9,
    toHit: 80,
    critPct: 5,
    attackSpeed: 100,
    castSpeed: 100,
    moveSpeed: 100,
    res: { fire: 10, cold: 5, lightning: 0, poison: -10 },
    dead: false,
    respawnIn: 0,
    x: 10.5,
    y: 12.25,
    statuses: [],
    ...over,
  };
}

/** "classic.skill.cleave" -> "Cleave" (fixture helper). */
function displayName(id: string): string {
  const last = id.split(".").pop() ?? id;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function skillBarSlots(names: (string | null)[]): HudSnapshot["skillBar"] {
  const keys = ["1", "2", "3", "4", "5", "6"];
  return keys.map((key, i) => {
    const skill = names[i] ?? null;
    return {
      slot: i,
      key,
      skill,
      name: skill ? displayName(skill) : "",
      icon: skill ? `icon.skill.${skill}` : "",
      manaCost: skill ? 6 : 0,
      cooldownLeft: i === 2 ? 5 : 0,
      cooldown: i === 2 ? 10 : 0,
      usable: skill !== null,
    };
  });
}

export function makePlaySnapshot(over: Partial<HudSnapshot> = {}): HudSnapshot {
  return {
    tick: 1200,
    phase: "play",
    classes: [
      { id: "classic.warrior", name: "Warrior", description: "Strong in melee." },
      { id: "classic.rogue", name: "Rogue", description: "Quick and precise." },
      { id: "classic.sorcerer", name: "Sorcerer", description: "Spells from afar." },
    ],
    hero: makeHero(),
    area: {
      depth: 3,
      name: "Crypt - Level 3",
      theme: "classic.theme.crypt",
      isTown: false,
      exploredPct: 42,
      bossAlive: false,
      killed: 17,
      spawned: 40,
      waypoints: [0, 1, 3],
      deepest: 3,
      portalOpen: false,
    },
    control: {
      mode: "auto",
      speed: 1,
      config: DEFAULT_AUTO_CONFIG,
      overridden: false,
      plan: "fight",
    },
    skillBar: skillBarSlots([
      "classic.skill.cleave",
      "classic.skill.fireball",
      null,
      null,
      null,
      null,
    ]),
    belt: [
      {
        slot: 0,
        key: "Q",
        base: "classic.item.minor-life",
        name: "Minor Life Potion",
        kind: "life",
        count: 5,
      },
      { slot: 1, key: "W", base: null, name: "", kind: null, count: 0 },
      {
        slot: 2,
        key: "E",
        base: "classic.item.rejuv",
        name: "Rejuvenation Potion",
        kind: "rejuv",
        count: 1,
      },
      { slot: 3, key: "R", base: null, name: "", kind: null, count: 0 },
    ],
    target: null,
    inventory: {
      cols: 10,
      rows: 4,
      items: [
        { x: 0, y: 0, item: makeItem({ uid: 1, name: "Rusted Short Sword", w: 1, h: 2 }) },
        {
          x: 3,
          y: 1,
          item: makeItem({
            uid: 2,
            name: "Iron Helm",
            category: "helm",
            slots: ["helm"],
            rarity: "rare",
            w: 2,
            h: 2,
          }),
        },
      ],
    },
    equipment: {
      ...NO_EQUIPMENT,
      weapon: makeItem({
        uid: 9,
        name: "Oak Staff",
        category: "weapon",
        slots: ["weapon"],
        rarity: "magic",
        w: 1,
        h: 3,
      }),
    },
    stash: [
      makeItem({
        uid: 30,
        name: "Stashed Ring",
        category: "ring",
        slots: ["ring1", "ring2"],
        rarity: "magic",
        w: 1,
        h: 1,
      }),
    ],
    stashSize: 40,
    skills: [
      {
        id: "classic.skill.cleave",
        name: "Cleave",
        description: "A wide melee swing.",
        icon: "icon.skill.cleave",
        rank: 2,
        maxRank: 5,
        reqLevel: 1,
        learnable: true,
        manaCost: 6,
        cooldown: 10,
        onBar: 0,
        tags: ["melee", "aoe"],
      },
      {
        id: "classic.skill.fireball",
        name: "Fireball",
        description: "A bolt of fire.",
        icon: "icon.skill.fireball",
        rank: 0,
        maxRank: 5,
        reqLevel: 4,
        learnable: true,
        manaCost: 9,
        cooldown: 0,
        onBar: 1,
        tags: ["ranged", "single"],
      },
    ],
    quests: [
      {
        id: "classic.quest.first-blood",
        name: "First Blood",
        description: "Slay ten monsters.",
        giver: "Elder Mara",
        state: "active",
        progress: 4,
        count: 10,
        reward: "120 gold",
      },
      {
        id: "classic.quest.boss-hunt",
        name: "Boss Hunt",
        description: "Slay the crypt lord.",
        giver: "Elder Mara",
        state: "done",
        progress: 1,
        count: 1,
        reward: "1 rare item",
      },
      {
        id: "classic.quest.intro",
        name: "Welcome",
        description: "Talk to the smith.",
        giver: "Elder Mara",
        state: "available",
        progress: 0,
        count: 1,
        reward: "50 gold",
      },
    ],
    vendor: null,
    ...over,
  };
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
    },
    hover: null,
    compact: false,
    perf: { fps: 60, tickMs: 0.5, ticksPerSecond: 20, entities: 310, monsters: 42 },
    error: null,
    ...over,
  };
}

export interface FakeOptions {
  hud?: Partial<HudSnapshot>;
  ui?: Partial<UiState>;
  log?: LogLine[];
  minimap?: MinimapData | null;
}

/** A ClassicClientApi with static stores. `calls` records every act(). */
export function makeApi(opts: FakeOptions = {}) {
  const calls: { name: string; payload: unknown }[] = [];
  const hud = makePlaySnapshot(opts.hud);
  const ui = makeUi(opts.ui);
  const api: ClassicClientApi = {
    hud: staticStore(hud),
    log: staticStore(opts.log ?? []),
    ui: staticStore(ui),
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
    minimap: () => opts.minimap ?? null,
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

function withPanels(panels: PanelId[], ui: Partial<UiState> = {}, hud: Partial<HudSnapshot> = {}) {
  return makeApi({ ui: { panels, ...ui }, hud });
}

function count(markup: string, re: RegExp): number {
  return (markup.match(re) ?? []).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("new hero screen", () => {
  it("shows class cards and the name field in phase choose, and nothing else", () => {
    const { api } = makeApi({
      hud: { phase: "choose", hero: null, area: null, skillBar: skillBarSlots([]) },
    });
    const markup = renderHud(api);
    expect(markup).toContain("Create your hero");
    expect(markup).toContain("Warrior");
    expect(markup).toContain("Sorcerer");
    expect(markup).toContain("Hero name");
    expect(markup).toContain("Begin the journey");
    expect(markup).not.toContain("Skill bar");
    expect(markup).not.toContain("Experience");
  });

  it("preselects the first class and a default name", () => {
    const { api } = makeApi({ hud: { phase: "choose", hero: null, area: null } });
    const markup = renderToStaticMarkup(<NewHeroScreen api={api} />);
    expect(markup).toMatch(/role="radio" aria-checked="true"/);
    expect(markup).toContain('value="Hero"');
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Begin the journey/);
  });
});

describe("orbs and bars", () => {
  it("shows life and mana numbers with thousands separators", () => {
    const { api } = makeApi({
      hud: { hero: makeHero({ life: 1234, lifeMax: 1500, mana: 40, manaMax: 80 }) },
    });
    const markup = renderHud(api);
    expect(markup).toContain('aria-label="Life"');
    expect(markup).toContain(">1,234<");
    expect(markup).toContain("/ 1,500");
    expect(markup).toContain('aria-label="Mana"');
    expect(markup).toContain(">40<");
    expect(markup).toContain("/ 80");
  });

  it("shows experience between the level start and the next level", () => {
    const { api } = makeApi();
    const markup = renderHud(api);
    expect(markup).toContain("Lv 5");
    expect(markup).toContain("900 / 1,100");
  });
});

describe("skill bar", () => {
  it("shows six slots with key labels 1-6 and mana costs", () => {
    const { api } = makeApi();
    const markup = renderHud(api);
    // Filled slots name their key; empty slots show their key as a label only.
    expect(count(markup, /aria-label="[^"]*\(key \d\)"/g)).toBe(2);
    expect(count(markup, /aria-label="Empty skill slot \d"/g)).toBe(4);
    expect(markup).toContain("Cleave (key 1)");
    expect(markup).toContain("Fireball (key 2)");
    expect(markup).toContain("Empty skill slot 6");
    for (const key of ["3", "4", "5", "6"]) {
      expect(markup).toContain(`>${key}</span>`);
    }
  });

  it("draws a cooldown sweep for the slot on cooldown", () => {
    const { api } = makeApi();
    const markup = renderHud(api);
    // Slot 3 (index 2) has cooldownLeft 5 of 10 ticks: half a turn of dark sweep.
    expect(markup).toContain("conic-gradient(rgba(0, 0, 0, 0.62) 180deg");
  });
});

describe("belt", () => {
  it("shows counts and the Q W E R keys", () => {
    const { api } = makeApi();
    const markup = renderHud(api);
    expect(markup).toContain("Minor Life Potion x5 (key Q)");
    expect(markup).toContain("Rejuvenation Potion x1 (key E)");
    expect(markup).toContain("Empty belt slot W");
    expect(markup).toContain("Empty belt slot R");
    expect(markup).toContain(">5<");
  });
});

describe("control bar", () => {
  it("marks the active mode and shows speeds only in idle", () => {
    const auto = renderHud(makeApi().api);
    expect(auto).toMatch(/aria-label="Auto mode" aria-pressed="true"/);
    expect(auto).toMatch(/aria-label="Manual mode" aria-pressed="false"/);
    expect(auto).not.toContain('aria-label="Speed x2"');
    expect(auto).toContain("Fighting");

    const idle = renderHud(
      makeApi({ hud: { control: { ...makePlaySnapshot().control, mode: "idle", speed: 4 } } }).api,
    );
    expect(idle).toMatch(/aria-label="Idle mode" aria-pressed="true"/);
    expect(idle).toMatch(/aria-label="Speed x4" aria-pressed="true"/);
    expect(idle).toContain('aria-label="Speed x1"');
    expect(idle).toContain('aria-label="Speed x8"');
    expect(idle).toContain("×2");
  });

  it("shows the overridden badge when a manual command pauses auto play", () => {
    const { api } = makeApi({
      hud: { control: { ...makePlaySnapshot().control, overridden: true } },
    });
    expect(renderHud(api)).toContain("Overridden");
    expect(renderHud(makeApi().api)).not.toContain("Overridden");
  });
});

describe("target, quests, log and area", () => {
  it("shows the target name in its rarity colour with mods and life", () => {
    const { api } = makeApi({
      hud: {
        target: {
          entity: 77,
          name: "Ghoul Champion",
          rarity: "champion",
          level: 9,
          life: 30,
          lifeMax: 90,
          mods: ["Mighty", "Rimebound"],
        },
      },
    });
    const markup = renderHud(api);
    expect(markup).toContain("Ghoul Champion");
    expect(markup).toContain("Mighty · Rimebound");
    expect(markup).toContain("#5aa0ff");
    expect(markup).toContain("30 / 90");
  });

  it("lists active and ready quests in the tracker", () => {
    const markup = renderHud(makeApi().api);
    expect(markup).toContain("First Blood");
    expect(markup).toContain("4 / 10");
    expect(markup).toContain("Ready: return to Elder Mara");
    expect(markup).not.toContain("Welcome");
  });

  it("shows the last eight log lines in the combat log", () => {
    const log: LogLine[] = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      tick: i,
      kind: "combat",
      text: `Line ${i}`,
      color: 0xe6e6e6,
    }));
    const markup = renderHud(makeApi({ log }).api);
    expect(markup).toContain("Line 9");
    expect(markup).toContain("Line 2");
    expect(markup).not.toContain("Line 1<");
  });

  it("shows the area banner with depth and explored share", () => {
    const markup = renderHud(makeApi().api);
    expect(markup).toContain("Crypt - Level 3");
    expect(markup).toContain("Depth 3");
    expect(markup).toContain("42% explored");
    expect(markup).toContain("17/40 slain");
  });
});

describe("panel buttons and host", () => {
  it("renders C I S L and settings buttons, marking open panels", () => {
    const markup = renderHud(withPanels(["inventory"]).api);
    expect(markup).toMatch(/aria-label="Inventory \(I\)" aria-pressed="true"/);
    expect(markup).toMatch(/aria-label="Character \(C\)" aria-pressed="false"/);
    for (const letter of ["C", "I", "S", "L"]) expect(markup).toContain(`>${letter}</button>`);
    expect(markup).toContain('aria-label="Settings"');
  });

  it("renders nothing for panels that are not open", () => {
    const markup = renderHud(makeApi().api);
    expect(markup).not.toContain('role="region" aria-label="Panels"');
    expect(markup).not.toContain('role="dialog" aria-label="Character"');
  });

  it("renders every open panel from its slot", () => {
    const markup = renderHud(withPanels(["character", "quests"]).api);
    expect(markup).toContain('aria-label="Character"');
    expect(markup).toContain('aria-label="Quests"');
  });

  it("marks the root compact when ui.compact is set", () => {
    expect(renderHud(makeApi({ ui: { compact: true } }).api)).toContain('data-compact="true"');
    expect(renderHud(makeApi().api)).toContain('data-compact="false"');
  });
});

describe("panels", () => {
  it("character: attributes with + buttons only when points are free", () => {
    const spend = makeApi({ hud: { hero: makeHero({ statPoints: 2 }) } });
    const markup = renderToStaticMarkup(<CharacterPanel api={spend.api} />);
    expect(markup).toContain("Strength");
    expect(markup).toContain("Add a point to Strength");
    expect(markup).toContain("Critical chance");
    expect(markup).toContain("Fire");

    const none = renderToStaticMarkup(<CharacterPanel api={makeApi().api} />);
    expect(none).not.toContain("Add a point to Strength");
  });

  it("inventory: grid cells, items and equipped items", () => {
    const { api } = withPanels(["inventory"]);
    const markup = renderHud(api);
    expect(markup).toContain('aria-label="Bag grid"');
    expect(markup).toContain("Rusted Short Sword, Normal, 1 by 2");
    expect(markup).toContain("Iron Helm, Rare, 2 by 2");
    // 40 cells minus 2 (sword) and 4 (helm) covered footprint cells.
    expect(count(markup, /aria-label="Empty cell /g)).toBe(34);
    expect(markup).toContain("Empty cell 2, 1");
    expect(markup).toContain("Weapon slot: Oak Staff");
    expect(markup).toContain("Helm slot: empty");
  });

  it("inventory: the component renders on its own too", () => {
    const { api } = makeApi({ ui: { panels: ["inventory"] } });
    const markup = renderToStaticMarkup(<InventoryPanel api={api} />);
    expect(markup).toContain("Inventory");
    expect(markup).toContain("Oak Staff");
  });

  it("skills: rank, learn button and bar slots", () => {
    const { api } = makeApi({ hud: { hero: makeHero({ skillPoints: 1 }) } });
    const markup = renderToStaticMarkup(<SkillsPanel api={api} />);
    expect(markup).toContain("Cleave");
    expect(markup).toContain("2 / 5");
    expect(markup).toContain("Learn Fireball");
    expect(markup).toContain("Put Cleave on slot 6");
    expect(markup).toContain("Clear Cleave from the bar");
    expect(markup).toContain("1 skill point to spend");
  });

  it("skills: learning is disabled without points", () => {
    const markup = renderToStaticMarkup(<SkillsPanel api={makeApi().api} />);
    expect(markup).toMatch(/aria-label="Learn Fireball"[^>]*disabled=""/);
  });

  it("quests: accept and turn in in town, a hint outside it", () => {
    const town = makeApi({
      hud: {
        area: { ...makePlaySnapshot().area!, depth: 0, isTown: true, name: "Town" },
      },
    });
    const inTown = renderToStaticMarkup(<QuestsPanel api={town.api} />);
    expect(inTown).toContain("Accept");
    expect(inTown).toContain("Turn in");
    expect(inTown).toContain("In town: accept and turn in quests here");

    const outside = renderToStaticMarkup(<QuestsPanel api={makeApi().api} />);
    expect(outside).toContain("Return to town to accept or turn in quests");
    expect(outside).toMatch(/>Accept<\/button>/);
    expect(outside).toMatch(/<button[^>]*disabled=""[^>]*>Accept<\/button>/);
  });

  it("vendor: smith stock with prices and buy buttons", () => {
    const stock = [
      {
        ...makeItem({ uid: 50, name: "Iron Axe", category: "weapon", rarity: "magic" }),
        price: 320,
      },
    ];
    const { api } = makeApi({
      hud: {
        vendor: {
          npc: 7,
          proto: "classic.npc.smith",
          name: "Brannoc",
          role: "smith",
          greeting: "Fine steel",
          stock,
          potions: [],
          buyPct: 0,
        },
      },
    });
    const markup = renderToStaticMarkup(<VendorPanel api={api} />);
    expect(markup).toContain("Brannoc");
    expect(markup).toContain("For sale");
    expect(markup).toContain("Iron Axe");
    expect(markup).toContain("320 g");
    expect(markup).toContain("Buy Iron Axe");
  });

  it("vendor: alchemist potions buy one or five", () => {
    const { api } = makeApi({
      hud: {
        vendor: {
          npc: 8,
          proto: "classic.npc.alchemist",
          name: "Ysolde",
          role: "alchemist",
          greeting: "Potions!",
          stock: [],
          potions: [
            { base: "classic.item.minor-life", name: "Minor Life Potion", price: 30 },
            { base: "tp", name: "Town Portal Scroll", price: 25 },
          ],
          buyPct: 0,
        },
      },
    });
    const markup = renderToStaticMarkup(<VendorPanel api={api} />);
    expect(markup).toContain("Potions and scrolls");
    expect(markup).toContain("Town Portal Scroll");
    expect(markup).toContain(">x5</button>");
    expect(markup).toContain("Buy five Town Portal Scroll");
  });

  it("vendor: junk buyer lists sellable bag items with prices", () => {
    const { api } = makeApi({
      hud: {
        vendor: {
          npc: 9,
          proto: "classic.npc.junk",
          name: "Pim",
          role: "junk",
          greeting: "Anything to sell?",
          stock: [],
          potions: [],
          buyPct: 25,
        },
        inventory: {
          cols: 10,
          rows: 4,
          items: [{ x: 0, y: 0, item: makeItem({ uid: 1, sellPrice: 12 }) }],
        },
      },
    });
    const markup = renderToStaticMarkup(<VendorPanel api={api} />);
    expect(markup).toContain("Sell");
    expect(markup).toContain("Rusted Short Sword");
    expect(markup).toContain("12 g");
    expect(markup).toContain("Pays 25%");
  });

  it("vendor: without a vendor the panel explains how to trade", () => {
    const markup = renderToStaticMarkup(<VendorPanel api={makeApi().api} />);
    expect(markup).toContain("Nobody is trading right now");
  });

  it("stash: items to take and bag items to put", () => {
    const markup = renderToStaticMarkup(<StashPanel api={makeApi().api} />);
    expect(markup).toContain("Stashed Ring");
    expect(markup).toContain("Take Stashed Ring");
    expect(markup).toContain("Put Rusted Short Sword");
    expect(markup).toContain("1 / 40 slots");
  });

  it("waypoint: unlocked depths, current depth marked and not travellable", () => {
    const markup = renderToStaticMarkup(<WaypointPanel api={makeApi().api} />);
    expect(markup).toContain("Town");
    expect(markup).toContain("Depth 1");
    expect(markup).toContain("You are here");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Travel<\/button>/);
    expect(markup).toContain("Travel to depth 1");
  });

  it("settings: toggles, zoom, automation editor and game buttons", () => {
    const markup = renderToStaticMarkup(<SettingsPanel api={makeApi().api} />);
    expect(markup).toContain("Damage numbers");
    expect(markup).toContain("Minimap (M)");
    expect(markup).toContain('aria-label="Zoom"');
    expect(markup).toContain("Drink a life potion below");
    expect(markup).toContain("Apply automation");
    expect(markup).toContain("New game");
    expect(markup).toContain("Exit");
  });

  it("log: the full log newest first", () => {
    const log: LogLine[] = [
      { id: 1, tick: 1, kind: "loot", text: "You found a sword", color: 0x6b8cff },
      { id: 2, tick: 2, kind: "level", text: "Level 5 reached", color: 0xffd75e },
    ];
    const markup = renderToStaticMarkup(<LogPanel api={makeApi({ log }).api} />);
    expect(markup.indexOf("Level 5 reached")).toBeLessThan(markup.indexOf("You found a sword"));
  });

  it("map: the automap canvas", () => {
    const markup = renderHud(withPanels(["map"]).api);
    expect(markup).toContain('aria-label="Automap"');
  });
});

describe("death, toasts, errors and tooltip", () => {
  it("shows the death screen with a countdown and a disabled respawn button", () => {
    const { api } = makeApi({ hud: { hero: makeHero({ dead: true, respawnIn: 40 }) } });
    const markup = renderHud(api);
    expect(markup).toContain("You died");
    expect(markup).toContain("Respawn in 2.0s");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Respawn \(waiting\)<\/button>/);
  });

  it("enables respawn when the countdown is over", () => {
    const { api } = makeApi({ hud: { hero: makeHero({ dead: true, respawnIn: 0 }) } });
    const markup = renderToStaticMarkup(<DeathScreen api={api} />);
    expect(markup).toContain("Ready to respawn in town.");
    expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Respawn<\/button>/);
  });

  it("shows no death screen for a living hero", () => {
    expect(renderHud(makeApi().api)).not.toContain("You died");
  });

  it("shows toasts that have not expired and hides expired ones", () => {
    const { api } = makeApi({
      ui: {
        toasts: [
          { id: 1, kind: "levelUp", title: "Level 6", body: "Skill points gained", until: 1e12 },
          { id: 2, kind: "quest", title: "Old news", body: "", until: 0 },
        ],
      },
    });
    const markup = renderHud(api);
    expect(markup).toContain("Level 6");
    expect(markup).toContain("Skill points gained");
    expect(markup).not.toContain("Old news");
  });

  it("flashes the last error", () => {
    const { api } = makeApi({
      ui: { error: { code: "no_gold", message: "Not enough gold", until: 1e12 } },
    });
    expect(renderHud(api)).toContain("Not enough gold");
    expect(renderHud(makeApi().api)).not.toContain("Not enough gold");
  });

  it("shows the item under the pointer with the upgrade delta", () => {
    const { api } = makeApi({
      ui: { hover: { uid: 1, x: 100, y: 120 } },
      hud: {
        inventory: {
          cols: 10,
          rows: 4,
          items: [
            { x: 0, y: 0, item: makeItem({ uid: 1, name: "Rusted Short Sword", upgrade: 3 }) },
          ],
        },
      },
    });
    const markup = renderHud(api);
    expect(markup).toContain('role="tooltip"');
    expect(markup).toContain("Rusted Short Sword");
    expect(markup).toContain("Upgrade +3");
  });

  it("shows the equipped item the tooltip compares with", () => {
    const { api } = makeApi({
      ui: { hover: { uid: 1, x: 100, y: 120 } },
      hud: {
        inventory: {
          cols: 10,
          rows: 4,
          items: [
            { x: 0, y: 0, item: makeItem({ uid: 1, name: "Rusted Short Sword", upgrade: -2 }) },
          ],
        },
      },
    });
    const markup = renderHud(api);
    expect(markup).toContain("Downgrade -2");
    expect(markup).toContain("Equipped (Weapon): Oak Staff");
  });

  it("shows no tooltip when nothing is hovered", () => {
    expect(renderHud(makeApi().api)).not.toContain('role="tooltip"');
  });
});

describe("optional widgets", () => {
  it("hides the minimap unless settings.showMinimap is on", () => {
    expect(renderHud(makeApi().api)).not.toContain('aria-label="Minimap panel"');
    const on = makeApi({ ui: { settings: { ...makeUi().settings, showMinimap: true } } });
    expect(renderHud(on.api)).toContain('aria-label="Minimap panel"');
  });

  it("shows the perf overlay only when settings.showPerf is on", () => {
    expect(renderHud(makeApi().api)).not.toContain("ms/tick");
    const on = makeApi({ ui: { settings: { ...makeUi().settings, showPerf: true } } });
    expect(renderHud(on.api)).toContain("60 fps");
  });
});

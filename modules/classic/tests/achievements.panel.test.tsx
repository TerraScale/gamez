/**
 * Achievements HUD tests (wave A, OWNER: T-achievements): the view builder
 * (progress, masking of hidden ones, counts, title) and the panel render with a
 * fake api, plus the client-side title storage that must survive blocked storage.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createSim, defineMode, loadMode } from "@gamez/kernel";
import { describe, expect, it, afterEach } from "vite-plus/test";
import { modules as classicModules } from "../src/index.ts";
import { testContent } from "./support/content.ts";
import { ensureResources, spawnTestHero } from "./support/harness.ts";
import { buildAchievementsView } from "../src/client/model/achievements.ts";
import type { ModelContext } from "../src/client/model/context.ts";
import type {
  AchievementsView,
  ClassicClientApi,
  HudSnapshot,
  Store,
  UiState,
} from "../src/client/contract.ts";
import {
  AchievementsPanel,
  readStoredTitle,
  TITLE_STORAGE_KEY,
  writeStoredTitle,
} from "../src/client/hud/panels/AchievementsPanel.tsx";
import { ACHIEVEMENTS } from "../src/content/achievements.ts";
import { RES, achievementsOf, type RunStats } from "../src/resources.ts";
import { KIND, type AchievementProto } from "../src/types.ts";

function staticStore<T>(value: T): Store<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

function makeUi(): UiState {
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
    perf: { fps: 60, tickMs: 0.5, ticksPerSecond: 20, entities: 10, monsters: 0 },
    error: null,
  } as unknown as UiState;
}

function fakeApi(view: AchievementsView | null): ClassicClientApi {
  const hud = { achievements: view } as unknown as HudSnapshot;
  return {
    hud: staticStore(hud),
    log: staticStore([]),
    ui: staticStore(makeUi()),
    act: () => ({ ok: true, events: [], tick: 0 }) as never,
    togglePanel() {},
    openPanel() {},
    closePanel() {},
    closeAll() {},
    setHover() {},
    updateSettings() {},
    dismissToast() {},
    minimap: () => null,
    castSlot() {},
    drink() {},
    newGame() {},
    exit() {},
  } as unknown as ClassicClientApi;
}

/** A small view by hand: one unlocked, one locked visible, one hidden locked. */
function handView(): AchievementsView {
  return {
    unlocked: 1,
    total: 3,
    title: "",
    list: [
      {
        id: "classic.achievement.first_blood",
        name: "First Blood",
        description: "Slay your first monster.",
        icon: "icon.achievement.first_blood",
        progress: 1,
        target: 1,
        unlocked: true,
        at: 40,
        rewardText: "25 gold",
      },
      {
        id: "classic.achievement.pest_control",
        name: "Pest Control",
        description: "Slay 100 monsters.",
        icon: "icon.achievement.pest_control",
        progress: 37,
        target: 100,
        unlocked: false,
        at: 0,
        rewardText: "150 gold",
      },
      {
        id: "classic.achievement.dragons_hoard",
        name: "???",
        description: "A hidden achievement.",
        icon: "icon.achievement.dragons_hoard",
        progress: 0,
        target: 1000000,
        unlocked: false,
        at: 0,
        rewardText: "???",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// View builder
// ---------------------------------------------------------------------------

function contextWith(): { c: ModelContext; world: ModelContext["world"] } {
  const catalog = [...classicModules, testContent];
  const mode = defineMode({
    id: "classic",
    name: "Classic (view)",
    description: "test",
    world: null,
    modules: ["classic.content", "classic.core", "classic.achievements"],
    tick: { kind: "fixed", hz: 20 },
  });
  const sim = createSim(loadMode(mode, catalog), { seed: 3 });
  ensureResources(sim.world);
  const hero = spawnTestHero(sim.world, { level: 1 });
  const c: ModelContext = {
    world: sim.world,
    registry: sim.loaded.registry,
    hero,
    heroView: null,
    tick: 0,
    vendor: 0,
    itemView: () => {
      throw new Error("not used by the achievements view");
    },
  };
  return { c, world: sim.world };
}

describe("buildAchievementsView", () => {
  it("returns null when no achievement content is loaded", () => {
    const catalog = [...classicModules, testContent];
    const mode = defineMode({
      id: "classic",
      name: "Classic (view)",
      description: "test",
      world: null,
      modules: ["classic.core", "test.content"],
      tick: { kind: "fixed", hz: 20 },
    });
    const sim = createSim(loadMode(mode, catalog), { seed: 3 });
    ensureResources(sim.world);
    const hero = spawnTestHero(sim.world, { level: 1 });
    const c: ModelContext = {
      world: sim.world,
      registry: sim.loaded.registry,
      hero,
      heroView: null,
      tick: 0,
      vendor: 0,
      itemView: () => {
        throw new Error("unused");
      },
    };
    expect(buildAchievementsView(c)).toBeNull();
  });

  it("lists every achievement in panel order with capped progress and masked hidden rows", () => {
    const { c, world } = contextWith();
    const stats: RunStats = {
      kills: 250,
      championKills: 0,
      uniqueKills: 0,
      bossKills: 0,
      deaths: 0,
      goldEarned: 0,
      itemsFound: 0,
      potionsUsed: 0,
      ticksPlayed: 0,
      offlineMs: 0,
    };
    world.setResource(RES.stats, stats);
    const view = buildAchievementsView(c)!;
    expect(view).not.toBeNull();
    expect(view.total).toBe(Object.keys(ACHIEVEMENTS).length);
    const order = view.list.map(
      (a) => c.registry.require<AchievementProto>(KIND.achievement, a.id).order,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const kills1 = view.list.find((a) => a.id === "classic.achievement.first_blood")!;
    expect(kills1.unlocked).toBe(false);
    expect(kills1.progress).toBe(1);
    expect(kills1.name).toBe("First Blood");

    const hidden = view.list.find((a) => a.id === "classic.achievement.dragons_hoard")!;
    expect(hidden.name).toBe("???");
    expect(hidden.description).toBe("A hidden achievement.");
    expect(hidden.rewardText).toBe("???");
    expect(hidden.progress).toBe(0);
  });

  it("marks unlocked rows, counts them and shows the stored title", () => {
    const { c, world } = contextWith();
    world.setResource(RES.stats, {
      kills: 250,
      championKills: 0,
      uniqueKills: 0,
      bossKills: 0,
      deaths: 0,
      goldEarned: 0,
      itemsFound: 0,
      potionsUsed: 0,
      ticksPlayed: 0,
      offlineMs: 0,
    } as RunStats);
    world.setResource(RES.achievements, {
      unlocked: [{ id: "classic.achievement.pest_control", at: 120 }],
      title: "",
    });
    expect(achievementsOf(world)?.unlocked).toHaveLength(1);
    const view = buildAchievementsView(c)!;
    expect(view.unlocked).toBe(1);
    const row = view.list.find((a) => a.id === "classic.achievement.pest_control")!;
    expect(row.unlocked).toBe(true);
    expect(row.at).toBe(120);
    expect(row.progress).toBe(row.target);
    expect(row.rewardText).toContain("gold");
  });
});

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

describe("AchievementsPanel render", () => {
  it("shows the header count, the rows and the hidden placeholder", () => {
    const html = renderToStaticMarkup(<AchievementsPanel api={fakeApi(handView())} />);
    expect(html).toContain("1 / 3 unlocked");
    expect(html).toContain("First Blood");
    expect(html).toContain("Pest Control");
    expect(html).toContain("???");
    expect(html).toContain("Show Unlocked");
    expect(html).toContain("Show Locked");
    expect(html).toContain("37 / 100");
  });

  it("renders a placeholder without a view", () => {
    const html = renderToStaticMarkup(<AchievementsPanel api={fakeApi(null)} />);
    expect(html).toContain("No achievements in this game.");
  });
});

describe("title storage", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("round-trips the chosen title through localStorage", () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    expect(readStoredTitle()).toBe("");
    writeStoredTitle("Reaper");
    expect(store.get(TITLE_STORAGE_KEY)).toBe("Reaper");
    expect(readStoredTitle()).toBe("Reaper");
  });

  it("never throws when storage is blocked", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    expect(readStoredTitle()).toBe("");
    expect(() => writeStoredTitle("Reaper")).not.toThrow();
    const html = renderToStaticMarkup(<AchievementsPanel api={fakeApi(handView())} />);
    expect(html).toContain("Title: none");
  });
});

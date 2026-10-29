/**
 * Quest HUD (client): the QuestView count and progress for every quest kind
 * and state, the quest giver's reach (the sim's INTERACT_RANGE rule), the quest
 * panel's walk / accept / turn-in buttons, and the NPC quest marker. The HUD
 * reads a real sim (real content: Captain Hale and the classic quest chain).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { INTERACT_RANGE } from "../src/actions.ts";
import { AreaTag, Level, Npc, Pos } from "../src/components.ts";
import { tileCenter } from "../src/fixed.ts";
import { QuestsPanel } from "../src/client/hud/panels/QuestsPanel.tsx";
import { buildHud, questGiverOf } from "../src/client/hudModel.ts";
import type {
  ClassicClientApi,
  HudSnapshot,
  Store,
  UiState,
  QuestView,
} from "../src/client/contract.ts";
import { questMarker } from "../src/client/scene.ts";
import { RES, type QuestState } from "../src/resources.ts";
import { spawnTestHero, testSim, useOpenMap } from "./support/harness.ts";
import type { Sim } from "@gamez/kernel";

const HALE = "classic.npc.captain_hale";
const RATS = "classic.quest.rats_in_the_cellar";
const DEEPER = "classic.quest.deeper_still";
const WARDEN = "classic.quest.wardens_rest";
const TUNNEL = "classic.quest.tunnel_mother";
const CRYPT = "classic.quest.clear_the_crypt";

/** A town sim with the real content (quests, Captain Hale) and a hero at tile (5, 5). */
function townSim(quests: QuestState = { active: [], completed: [] }): {
  sim: Sim;
  hero: number;
  hale: number;
} {
  const sim = testSim([], { content: "real" });
  useOpenMap(sim, 0);
  const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
  sim.world.setResource(RES.quests, quests);
  const hale = sim.world.create();
  sim.world.add(hale, Npc, { proto: HALE });
  sim.world.add(hale, Pos, { x: tileCenter(10), y: tileCenter(10) });
  sim.world.add(hale, AreaTag, { depth: 0 });
  return { sim, hero, hale };
}

function viewOf(sim: Sim, id: string): QuestView | undefined {
  const hud = buildHud(sim.world, sim.loaded.registry, {
    tick: 0,
    hovered: 0,
    vendor: 0,
    prev: null,
  });
  return hud.quests.find((q) => q.id === id);
}

describe("quest views: count, progress and state per kind", () => {
  it("lists the level-1 chain head as available with its real target", () => {
    const { sim } = townSim();
    expect(viewOf(sim, RATS)).toMatchObject({
      state: "available",
      progress: 0,
      count: 20,
      giver: "Captain Hale",
    });
    // Level 4 and chained quests are not offered yet.
    expect(viewOf(sim, DEEPER)).toBeUndefined();
    expect(viewOf(sim, TUNNEL)).toBeUndefined();
  });

  it("killMonsters: count is the kill target and progress follows the active entry", () => {
    const { sim } = townSim({ active: [{ id: RATS, progress: 7, done: false }], completed: [] });
    expect(viewOf(sim, RATS)).toMatchObject({ state: "active", progress: 7, count: 20 });
  });

  it("killMonsters: done quest shows the ready state with the full target", () => {
    const { sim } = townSim({ active: [{ id: RATS, progress: 20, done: true }], completed: [] });
    expect(viewOf(sim, RATS)).toMatchObject({ state: "done", progress: 20, count: 20 });
  });

  it("reachDepth: count is the depth target (6 for Deeper Still)", () => {
    const { sim } = townSim({ active: [{ id: DEEPER, progress: 3, done: false }], completed: [] });
    expect(viewOf(sim, DEEPER)).toMatchObject({ state: "active", progress: 3, count: 6 });
  });

  it("killBoss: one kill, active then ready", () => {
    const { sim } = townSim({ active: [{ id: WARDEN, progress: 0, done: false }], completed: [] });
    expect(viewOf(sim, WARDEN)).toMatchObject({ state: "active", progress: 0, count: 1 });
    sim.world.setResource(RES.quests, {
      active: [{ id: WARDEN, progress: 1, done: true }],
      completed: [],
    });
    expect(viewOf(sim, WARDEN)).toMatchObject({ state: "done", progress: 1, count: 1 });
  });

  it("clearLevel: count is the target 1 (not the depth 3) and done shows 1 / 1", () => {
    const { sim } = townSim({ active: [{ id: CRYPT, progress: 0, done: false }], completed: [] });
    expect(viewOf(sim, CRYPT)).toMatchObject({ state: "active", progress: 0, count: 1 });
    sim.world.setResource(RES.quests, {
      active: [{ id: CRYPT, progress: 1, done: true }],
      completed: [],
    });
    expect(viewOf(sim, CRYPT)).toMatchObject({ state: "done", progress: 1, count: 1 });
  });

  it("completed quests show the full target for every kind", () => {
    const { sim } = townSim({
      active: [],
      completed: [RATS, WARDEN, CRYPT],
    });
    expect(viewOf(sim, RATS)).toMatchObject({ state: "completed", progress: 20, count: 20 });
    expect(viewOf(sim, WARDEN)).toMatchObject({ state: "completed", progress: 1, count: 1 });
    expect(viewOf(sim, CRYPT)).toMatchObject({ state: "completed", progress: 1, count: 1 });
  });

  it("unlocks a chained quest once its predecessor is completed and the level is met", () => {
    const { sim, hero } = townSim({ active: [], completed: [WARDEN] });
    sim.world.update(hero, Level, { level: 13 });
    expect(viewOf(sim, TUNNEL)).toBeUndefined();
    sim.world.update(hero, Level, { level: 14 });
    expect(viewOf(sim, TUNNEL)).toMatchObject({ state: "available", count: 1 });
  });

  it("does not offer a chained quest whose predecessor is still open", () => {
    const { sim, hero } = townSim({ active: [], completed: [] });
    sim.world.update(hero, Level, { level: 20 });
    expect(viewOf(sim, TUNNEL)).toBeUndefined();
  });
});

describe("quest giver reach", () => {
  it("reports Captain Hale out of reach at the town spawn", () => {
    const { sim, hero, hale } = townSim();
    const giver = questGiverOf(sim.world, sim.loaded.registry, hero);
    expect(giver).toEqual({ entity: hale, proto: HALE, name: "Captain Hale", inReach: false });
  });

  it("reports in reach next to him and uses the sim's inclusive INTERACT_RANGE", () => {
    const { sim, hero, hale } = townSim();
    const hp = sim.world.read(hale, Pos);
    sim.world.update(hero, Pos, { x: hp.x - INTERACT_RANGE, y: hp.y });
    expect(questGiverOf(sim.world, sim.loaded.registry, hero)?.inReach).toBe(true);
    sim.world.update(hero, Pos, { x: hp.x - INTERACT_RANGE - 1, y: hp.y });
    expect(questGiverOf(sim.world, sim.loaded.registry, hero)?.inReach).toBe(false);
  });

  it("is null when no quest giver stands in the area", () => {
    const sim = testSim([], { content: "real" });
    useOpenMap(sim, 0);
    const hero = spawnTestHero(sim.world, { x: 5, y: 5, depth: 0 });
    expect(questGiverOf(sim.world, sim.loaded.registry, hero)).toBeNull();
  });

  it("is null in a dungeon even when Hale is in town", () => {
    const { sim, hero } = townSim();
    useOpenMap(sim, 1);
    sim.world.update(hero, AreaTag, { depth: 1 });
    expect(questGiverOf(sim.world, sim.loaded.registry, hero)).toBeNull();
  });

  it("is exposed on the snapshot (questGiver) and follows the hero", () => {
    const { sim, hero, hale } = townSim();
    const far = buildHud(sim.world, sim.loaded.registry, {
      tick: 0,
      hovered: 0,
      vendor: 0,
      prev: null,
    });
    expect(far.questGiver?.inReach).toBe(false);
    const hp = sim.world.read(hale, Pos);
    sim.world.update(hero, Pos, { x: hp.x, y: hp.y });
    const near = buildHud(sim.world, sim.loaded.registry, {
      tick: 1,
      hovered: 0,
      vendor: 0,
      prev: far,
    });
    expect(near.questGiver?.inReach).toBe(true);
  });
});

describe("quest marker (NPC '!' and '?')", () => {
  const reg = testSim([], { content: "real" }).loaded.registry;

  it("'!' when a quest of the giver can be accepted now", () => {
    expect(questMarker(reg, { active: [], completed: [] }, HALE, 1)).toBe("!");
  });

  it("no marker when nothing is available at this level and chain", () => {
    expect(questMarker(reg, { active: [], completed: [RATS] }, HALE, 1)).toBeNull();
  });

  it("'!' once the level reaches a quest that was locked", () => {
    expect(questMarker(reg, { active: [], completed: [RATS] }, HALE, 4)).toBe("!");
  });

  it("'?' when one of the giver's active quests is done", () => {
    const qs = { active: [{ id: RATS, progress: 20, done: true }], completed: [] };
    expect(questMarker(reg, qs, HALE, 1)).toBe("?");
  });

  it("an active quest that is not done adds no marker", () => {
    const qs = { active: [{ id: RATS, progress: 3, done: false }], completed: [] };
    expect(questMarker(reg, qs, HALE, 1)).toBeNull();
  });

  it("other NPCs get no quest marker", () => {
    expect(questMarker(reg, { active: [], completed: [] }, "classic.npc.maren", 9)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Quest panel
// ---------------------------------------------------------------------------

function staticStore<T>(value: T): Store<T> {
  return { getSnapshot: () => value, subscribe: () => () => {} };
}

function uiFixture(): UiState {
  return {
    panels: ["quests"],
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
    perf: { fps: 60, tickMs: 0.5, ticksPerSecond: 20, entities: 0, monsters: 0 },
    error: null,
  } as unknown as UiState;
}

/** The quest panel against the real model of a town sim (hero placed by the caller). */
function panelFor(sim: Sim, quests?: QuestState): string {
  if (quests) sim.world.setResource(RES.quests, quests);
  const snap = buildHud(sim.world, sim.loaded.registry, {
    tick: 1,
    hovered: 0,
    vendor: 0,
    prev: null,
  });
  const api = {
    hud: staticStore(snap as HudSnapshot),
    log: staticStore([]),
    ui: staticStore(uiFixture()),
    act() {
      return { ok: true, events: [], tick: snap.tick };
    },
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
  return renderToStaticMarkup(<QuestsPanel api={api} />);
}

function buttonOf(markup: string, label: string): string | null {
  const m = new RegExp(`<button[^>]*>${label}</button>`).exec(markup);
  return m ? m[0] : null;
}

describe("quest panel: walk, accept and turn in", () => {
  it("far from Hale in town: a walk button, and Accept disabled", () => {
    const { sim } = townSim();
    const markup = panelFor(sim);
    expect(markup).toContain("Talk to Captain Hale to accept or turn in quests");
    const walk = buttonOf(markup, "Go to Captain Hale");
    expect(walk).not.toBeNull();
    expect(walk).not.toMatch(/disabled=""/);
    const accept = buttonOf(markup, "Accept");
    expect(accept).toMatch(/disabled=""/);
  });

  it("in reach: no walk button, Accept enabled, the in-town hint", () => {
    const { sim, hero, hale } = townSim();
    const hp = sim.world.read(hale, Pos);
    sim.world.update(hero, Pos, { x: hp.x - 256, y: hp.y });
    const markup = panelFor(sim);
    expect(markup).toContain("In town: accept and turn in quests here");
    expect(markup).not.toContain("Go to Captain Hale");
    expect(buttonOf(markup, "Accept")).not.toMatch(/disabled=""/);
  });

  it("far with a finished quest: Turn in disabled, near it is enabled", () => {
    const quests = { active: [{ id: RATS, progress: 20, done: true }], completed: [] };
    const { sim, hero, hale } = townSim();
    const far = panelFor(sim, quests);
    expect(buttonOf(far, "Turn in")).toMatch(/disabled=""/);
    const hp = sim.world.read(hale, Pos);
    sim.world.update(hero, Pos, { x: hp.x, y: hp.y - 256 });
    const near = panelFor(sim);
    expect(buttonOf(near, "Turn in")).not.toMatch(/disabled=""/);
    expect(near).not.toContain("Go to Captain Hale");
  });

  it("outside town: the return hint, no walk button, Accept disabled", () => {
    const { sim, hero } = townSim();
    useOpenMap(sim, 1);
    sim.world.update(hero, AreaTag, { depth: 1 });
    const markup = panelFor(sim);
    expect(markup).toContain("Return to town to accept or turn in quests");
    expect(markup).not.toContain("Go to Captain Hale");
    expect(buttonOf(markup, "Accept")).toMatch(/disabled=""/);
  });
});

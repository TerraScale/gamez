/**
 * Local play (no server) offline grant on return (docs/design/offline-idle.md §7):
 * a visibility return after >= 60 s dispatches one grant and saves; a reload
 * right after does not grant again; short absences and Manual heroes get nothing.
 * Uses the real game controller with fake clocks (client.game.test.ts pattern).
 */
import { createSim, loadMode, type GameEvent } from "@gamez/kernel";
import { describe, expect, it } from "vite-plus/test";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  EffectSpec,
  FloatTextSpec,
  PointerInfo,
  RendererStats,
} from "@gamez/ui-host";
import type { AssetManifest } from "@gamez/assets";
import type { TileMap } from "@gamez/world";
import { createClassicGame, type ClassicGame } from "../src/client/game.ts";
import { awayStore } from "../src/client/hudModel.ts";
import {
  bootAwayGrant,
  grantedThisTick,
  grantLocalAway,
  localAwayDue,
} from "../src/client/index.ts";
import {
  createSaveStore,
  DEFAULT_SETTINGS,
  SAVE_KEY,
  type KeyValueStorage,
} from "../src/client/persist.ts";
import { ACTION } from "../src/actions.ts";
import { mode, modules } from "../src/index.ts";
import { RES, type ControlState } from "../src/resources.ts";

/** A renderer that draws nothing; `frame(dt)` runs the game's frame callback. */
class NullRenderer implements ArpgWorldRenderer {
  #frame: ((dtMs: number) => void) | null = null;
  frame(dtMs: number): void {
    this.#frame?.(dtMs);
  }
  readonly arpg = true as const;
  async init(_host: HTMLElement, _manifest: AssetManifest, _baseUrl: string): Promise<void> {}
  setMap(_map: TileMap): void {}
  upsertEntity(_e: ArpgRenderEntity): void {}
  removeEntity(_id: string): void {}
  follow(_x: number, _y: number): void {}
  onTileTap(_cb: (x: number, y: number) => void): void {}
  showTapMarker(_x: number, _y: number): void {}
  onFrame(cb: (dtMs: number) => void): void {
    this.#frame = cb;
  }
  destroy(): void {}
  floatText(_spec: FloatTextSpec): void {}
  playEffect(_spec: EffectSpec): void {}
  onPointer(_cb: (p: PointerInfo) => void): void {}
  snapCamera(_x: number, _y: number): void {}
  setZoom(_z: number): void {}
  getZoom(): number {
    return 1;
  }
  setLighting(_opts: { darkness: number; radius: number }): void {}
  tileAtClient(_x: number, _y: number): { x: number; y: number } | null {
    return null;
  }
  stats(): RendererStats {
    return { fps: 0, entities: 0, chunks: 0, props: 0, drawMs: 0 };
  }
}

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

/** A local game (the real classic mode) with a new hero in the given control mode (idle by default). */
function setup(controlMode: "idle" | "auto" | "manual" = "idle") {
  const sim = createSim(loadMode(mode, modules), { seed: 4242 });
  const made = sim.dispatch(ACTION.newHero, { classId: "classic.warrior", name: "Away" }, "local");
  if (!made.ok) throw new Error(`newHero failed: ${made.error?.message}`);
  const control = sim.world.getResource<ControlState>(RES.control);
  if (!control) throw new Error("control resource missing");
  sim.world.setResource(RES.control, { ...control, mode: controlMode, speed: 1 });
  const events: GameEvent[] = [];
  const storage = new MemoryStorage();
  const clock = { now: 1000, wall: 1_700_000_000_000 };
  const renderer = new NullRenderer();
  const game: ClassicGame = createClassicGame({
    loaded: sim.loaded,
    sim,
    renderer,
    save: createSaveStore(storage),
    settings: { ...DEFAULT_SETTINGS },
    now: () => clock.now,
    wall: () => clock.wall,
    newSeed: () => 99,
    viewportWidth: () => 1024,
    exit: () => {},
    onEvents: (evs) => {
      events.push(...evs);
    },
  });
  /**
   * One 50 ms frame: one sim step. A grant's events are fanned out after the
   * step that applies its queued commands (game.ts), so tests run one frame
   * before they read them.
   */
  const step = (): void => {
    clock.now += 50;
    clock.wall += 50;
    renderer.frame(50);
  };
  return { sim, game, storage, clock, events, step };
}

function summaries(events: readonly GameEvent[]): GameEvent[] {
  return events.filter((e) => e.type === "classic.offline.summary");
}

describe("local play: return from a hidden tab", () => {
  it("a return after 2 min dispatches exactly one grant and saves", () => {
    const { game, storage, clock, events, step } = setup("idle");
    expect(storage.items.has(SAVE_KEY)).toBe(false);
    const savedWall = clock.wall;
    const granted = grantLocalAway(game, 2 * 60_000);
    expect(granted).toBe(true);
    step();
    const sums = summaries(events);
    expect(sums).toHaveLength(1);
    expect(sums[0]?.ms).toBe(2 * 60_000);
    expect(sums[0]?.awayMs).toBe(2 * 60_000);
    // The save happened right after the grant, stamped with the wall clock.
    const saved = createSaveStore(storage).load(game.currentSim().loaded.contentHash);
    expect(saved?.savedAt).toBe(savedWall);
    // The card store received the same grant (game.ts applies the "away" visual).
    expect(awayStore.getSnapshot()?.creditedMs).toBe(2 * 60_000);
    expect(awayStore.getSnapshot()?.source).toBe("model");
  });

  it("a reload right after the grant does not grant again", () => {
    const { game, storage, clock, events, step } = setup("idle");
    expect(grantLocalAway(game, 2 * 60_000)).toBe(true);
    step();
    const saved = createSaveStore(storage).load(game.currentSim().loaded.contentHash);
    expect(saved).not.toBeNull();
    // Boot measures from the save made by the grant: the absence is ~0.
    const bootAway = clock.wall - (saved?.savedAt ?? 0);
    expect(localAwayDue(game.currentSim().world, bootAway)).toBe(false);
    expect(grantLocalAway(game, bootAway)).toBe(false);
    expect(summaries(events)).toHaveLength(1);
  });

  it("the card waits for the step that applies the grant: HUD XP and level already include it", () => {
    const { game, events, step } = setup("idle");
    awayStore.set(null);
    step();
    const before = game.api.hud.getSnapshot().hero;
    expect(before).not.toBeNull();
    expect(grantLocalAway(game, 30 * 60_000)).toBe(true);
    // Dispatched, but its grantXp command has not run: nothing is shown yet.
    expect(summaries(events)).toHaveLength(0);
    expect(awayStore.getSnapshot()).toBeNull();
    expect(game.api.hud.getSnapshot().hero?.xp).toBe(before?.xp);
    step();
    const sum = summaries(events)[0] as Extract<GameEvent, { type: string }> & {
      xp: number;
      levels: number;
    };
    expect(sum).toBeDefined();
    expect(sum.xp).toBeGreaterThan(0);
    expect(sum.levels).toBeGreaterThan(0);
    // Shown together with the HUD that has the grant (QA classic-offline C and D).
    const card = awayStore.getSnapshot();
    expect(card?.xp).toBe(sum.xp);
    const hero = game.api.hud.getSnapshot().hero;
    expect(hero?.level).toBe((before?.level ?? 0) + sum.levels);
    expect(game.currentSim().world.getResource<ControlState>(RES.control)?.mode).toBe("idle");
  });

  it("a return under 60 s does nothing", () => {
    const { game, storage, events } = setup("idle");
    awayStore.set(null);
    expect(grantLocalAway(game, 59_000)).toBe(false);
    expect(summaries(events)).toHaveLength(0);
    expect(storage.items.has(SAVE_KEY)).toBe(false);
    expect(awayStore.getSnapshot()).toBeNull();
  });

  it("a Manual hero gets nothing", () => {
    const { game, storage, events } = setup("manual");
    expect(grantLocalAway(game, 2 * 60_000)).toBe(false);
    expect(summaries(events)).toHaveLength(0);
    expect(storage.items.has(SAVE_KEY)).toBe(false);
  });

  it("an Auto hero is credited like an Idle one", () => {
    const { game, events, step } = setup("auto");
    expect(grantLocalAway(game, 2 * 60_000)).toBe(true);
    step();
    expect(summaries(events)).toHaveLength(1);
  });

  it("caps the credited time at the 7-day payload limit", () => {
    const { game, events, step } = setup("idle");
    const eightDays = 8 * 24 * 3600 * 1000;
    expect(grantLocalAway(game, eightDays)).toBe(true);
    step();
    const sums = summaries(events);
    expect(sums).toHaveLength(1);
    // The sim caps the credit again at offlineCapMs (8 h).
    expect(sums[0]?.ms).toBe(8 * 3600 * 1000);
    expect(sums[0]?.awayMs).toBe(7 * 24 * 3600 * 1000);
  });
});

describe("local play: a second absence on the tick of a grant (same-tick guard)", () => {
  it("is not dispatched or saved but handed to `later`, and paid after one step", () => {
    const { game, storage, clock, events, step } = setup("idle");
    expect(grantLocalAway(game, 2 * 60_000)).toBe(true);
    expect(grantedThisTick(game.currentSim())).toBe(true);
    const contentHash = game.currentSim().loaded.contentHash;
    const savedAt = createSaveStore(storage).load(contentHash)?.savedAt;
    // The player leaves again before a frame ran and returns 5 min later.
    clock.wall += 5 * 60_000;
    const owed: number[] = [];
    expect(grantLocalAway(game, 5 * 60_000, (ms) => owed.push(ms))).toBe(false);
    expect(owed).toEqual([5 * 60_000]);
    // No error from the sim's guard, no save over the absence.
    expect(game.api.ui.getSnapshot().error).toBeNull();
    expect(createSaveStore(storage).load(contentHash)?.savedAt).toBe(savedAt);
    step();
    expect(grantedThisTick(game.currentSim())).toBe(false);
    expect(grantLocalAway(game, owed[0]!)).toBe(true);
    step();
    const away = summaries(events).map((e) => (e as unknown as { awayMs: number }).awayMs);
    expect(away).toEqual([2 * 60_000, 5 * 60_000]);
  });

  it("a boot from a save made on the grant's tick retries instead of losing the absence", () => {
    const { game, clock, events, step } = setup("idle");
    expect(grantLocalAway(game, 2 * 60_000)).toBe(true);
    const owed: number[] = [];
    const boot = { server: false, fresh: false, savedAt: clock.wall - 3 * 60_000, wall: clock.wall };
    expect(bootAwayGrant(game, boot, (ms) => owed.push(ms))).toBe(false);
    expect(owed).toEqual([3 * 60_000]);
    step();
    expect(grantLocalAway(game, owed[0]!)).toBe(true);
    step();
    expect(summaries(events)).toHaveLength(2);
  });
});

describe("local play: boot-time grant", () => {
  /** Wraps the controller so the test counts the act and save calls the boot path makes. */
  function counted(game: ClassicGame) {
    const acts: string[] = [];
    let saves = 0;
    const countingAct = ((name: string, payload: unknown) => {
      acts.push(name);
      return game.api.act(name as never, payload as never);
    }) as ClassicGame["api"]["act"];
    const wrapped: Pick<ClassicGame, "api" | "currentSim" | "save"> = {
      currentSim: () => game.currentSim(),
      api: { ...game.api, act: countingAct },
      save: () => {
        saves += 1;
        return game.save();
      },
    };
    return { wrapped, acts, saves: () => saves };
  }

  it("an absence since the last save dispatches exactly one grant and saves once", () => {
    const { game, storage, clock, events, step } = setup("idle");
    const { wrapped, acts, saves } = counted(game);
    const savedAt = clock.wall - 3 * 60_000;
    const bootWall = clock.wall;
    const granted = bootAwayGrant(wrapped, {
      server: false,
      fresh: false,
      savedAt,
      wall: clock.wall,
    });
    expect(granted).toBe(true);
    expect(acts).toEqual([ACTION.offlineProgress]);
    expect(saves()).toBe(1);
    step();
    expect(summaries(events)).toHaveLength(1);
    expect(summaries(events)[0]?.ms).toBe(3 * 60_000);
    const saved = createSaveStore(storage).load(game.currentSim().loaded.contentHash);
    expect(saved?.savedAt).toBe(bootWall);
  });

  it("a fresh hero, a missing save, or an absence under 60 s does nothing", () => {
    const { game, events, clock } = setup("idle");
    const { wrapped, acts, saves } = counted(game);
    expect(
      bootAwayGrant(wrapped, {
        server: false,
        fresh: true,
        savedAt: clock.wall - 600_000,
        wall: clock.wall,
      }),
    ).toBe(false);
    expect(
      bootAwayGrant(wrapped, { server: false, fresh: false, savedAt: null, wall: clock.wall }),
    ).toBe(false);
    expect(
      bootAwayGrant(wrapped, {
        server: false,
        fresh: false,
        savedAt: clock.wall - 59_000,
        wall: clock.wall,
      }),
    ).toBe(false);
    expect(acts).toEqual([]);
    expect(saves()).toBe(0);
    expect(summaries(events)).toHaveLength(0);
  });

  it("server mode never grants on boot, the server does", () => {
    const { game, clock, events } = setup("idle");
    const { wrapped, acts } = counted(game);
    expect(
      bootAwayGrant(wrapped, {
        server: true,
        fresh: false,
        savedAt: clock.wall - 600_000,
        wall: clock.wall,
      }),
    ).toBe(false);
    expect(acts).toEqual([]);
    expect(summaries(events)).toHaveLength(0);
  });
});

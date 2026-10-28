/**
 * Client entry of the classic mode (docs/design/classic.md §12.1). mount():
 * world and HUD layers, the renderer from services (must be an
 * ArpgWorldRenderer), the local sim restored from the save or created fresh,
 * an offline-progress dispatch after a long absence, the game loop (game.ts),
 * keyboard bindings (input.ts), the React HUD (ClassicHud) on a layer above
 * the world, and save timers. Unmount tears everything down.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createSim, loadMode, type Sim, type SimSnapshot } from "@gamez/kernel";
import {
  createSlotRegistry,
  isArpgRenderer,
  type ClientModeView,
  type ClientServices,
  type WorldRenderer,
} from "@gamez/ui-host";
import { mode, modules } from "../index.ts";
import { ACTION } from "../actions.ts";
import { RES, type ControlState } from "../resources.ts";
import { ClassicHud, registerDefaultHud } from "./hud/index.tsx";
import type { ClassicClientApi, Settings } from "./contract.ts";
import { createClassicGame, type ClassicGame } from "./game.ts";
import { bindKeyboard, nextMode, stepSpeed, type KeyCommand } from "./input.ts";
import { browserStorage, createSaveStore, DEFAULT_SETTINGS, type SaveRecord } from "./persist.ts";

/** Absences longer than this (ms) are credited as offline progress. */
export const OFFLINE_MIN_MS = 60_000;
/** Longest offline credit the action accepts (7 days; the sim caps it again). */
const OFFLINE_MAX_MS = 7 * 24 * 3600 * 1000;
/** Autosave period (ms). */
const SAVE_EVERY_MS = 10_000;

function layer(extraCss: string): HTMLDivElement {
  const div = document.createElement("div");
  div.style.cssText = `position:absolute;inset:0;${extraCss}`;
  return div;
}

function showFatal(host: HTMLElement, err: unknown): void {
  const div = document.createElement("div");
  div.setAttribute("role", "alert");
  div.style.cssText =
    "position:absolute;inset:0;display:grid;place-items:center;padding:16px;text-align:center;" +
    "color:#f6d7d7;font:15px system-ui;pointer-events:auto;background:#140c0c";
  const msg = err instanceof Error ? err.message : String(err);
  div.textContent = `Classic mode could not start: ${msg}`;
  host.appendChild(div);
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

/** Restores the saved sim when it still matches the loaded content; otherwise a new game. */
function startSim(
  loaded: ReturnType<typeof loadMode>,
  saved: SaveRecord | null,
): { sim: Sim; fresh: boolean } {
  if (saved) {
    try {
      return {
        sim: createSim(loaded, { seed: 0, from: saved.snapshot as SimSnapshot }),
        fresh: false,
      };
    } catch {
      // A snapshot that does not restore is treated as no save.
    }
  }
  return { sim: createSim(loaded, { seed: randomSeed() }), fresh: true };
}

function onKey(api: ClassicClientApi, cmd: KeyCommand): void {
  const hud = api.hud.getSnapshot();
  const playing = hud.phase === "play";
  switch (cmd.kind) {
    case "cast":
      if (playing) api.castSlot(cmd.slot);
      return;
    case "drink":
      if (playing) api.drink(cmd.slot);
      return;
    case "panel":
      api.togglePanel(cmd.panel);
      return;
    case "closeAll":
      api.closeAll();
      return;
    case "portal":
      if (playing) api.act(ACTION.townPortal, {});
      return;
    case "cycleMode":
      if (playing) api.act(ACTION.setControl, { mode: nextMode(hud.control.mode) });
      return;
    case "speed":
      if (playing && hud.control.mode === "idle") {
        api.act(ACTION.setSpeed, { speed: stepSpeed(hud.control.speed, cmd.delta) });
      }
      return;
    case "minimap": {
      const s = api.ui.getSnapshot().settings;
      api.updateSettings({ showMinimap: !s.showMinimap });
      return;
    }
    case "automap":
      api.togglePanel("map");
      return;
  }
}

export const classicView: ClientModeView = {
  modeId: "classic",
  mount(host: HTMLElement, services: ClientServices) {
    const worldLayer = layer("");
    const hudLayer = layer("pointer-events:none");
    host.append(worldLayer, hudLayer);

    let renderer: WorldRenderer | null = null;
    let game: ClassicGame | null = null;
    let root: ReturnType<typeof createRoot> | null = null;
    let unbindKeys: (() => void) | null = null;
    let saveTimer: number | null = null;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") game?.save();
    };
    const onPageHide = (): void => {
      game?.save();
    };
    const teardown = (): void => {
      if (saveTimer !== null) window.clearInterval(saveTimer);
      saveTimer = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      unbindKeys?.();
      unbindKeys = null;
      game?.save();
      game?.destroy();
      game = null;
      root?.unmount();
      root = null;
      renderer?.destroy();
      renderer = null;
      worldLayer.remove();
      hudLayer.remove();
    };

    const start = async (): Promise<void> => {
      const created = services.createWorldRenderer();
      if (!isArpgRenderer(created)) {
        created.destroy();
        throw new Error(
          "the world renderer has no ARPG extension (isArpgRenderer); classic needs the ARPG renderer",
        );
      }
      renderer = created;
      await created.init(worldLayer, services.manifest, services.assetBaseUrl);

      const loaded = loadMode(mode, modules);
      const store = createSaveStore(browserStorage());
      const saved = store.load(loaded.contentHash);
      const { sim, fresh } = startSim(loaded, saved);
      const settings: Settings = saved?.settings ?? { ...DEFAULT_SETTINGS };
      const wall = Date.now();

      game = createClassicGame({
        loaded,
        sim,
        renderer: created,
        save: store,
        settings,
        now: () => performance.now(),
        wall: () => Date.now(),
        newSeed: randomSeed,
        viewportWidth: () => window.innerWidth,
        exit: () => services.exit(),
      });

      // Offline progress for a long absence, when the hero is in play and the controller drives it.
      if (!fresh && saved && wall - saved.savedAt > OFFLINE_MIN_MS) {
        const control = sim.world.getResource<ControlState>(RES.control);
        if (control && control.mode !== "manual" && game.api.hud.getSnapshot().phase === "play") {
          const elapsedMs = Math.min(wall - saved.savedAt, OFFLINE_MAX_MS);
          game.api.act(ACTION.offlineProgress, { elapsedMs });
        }
      }

      const slots = createSlotRegistry();
      registerDefaultHud(slots);
      root = createRoot(hudLayer);
      root.render(createElement(ClassicHud, { api: game.api, slots }));

      const api = game.api;
      unbindKeys = bindKeyboard(window, (cmd) => onKey(api, cmd));
      saveTimer = window.setInterval(() => {
        game?.save();
      }, SAVE_EVERY_MS);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);
    };

    let mounted = true;
    return start().then(
      () => () => {
        if (!mounted) return;
        mounted = false;
        teardown();
      },
      (err: unknown) => {
        showFatal(hudLayer, err);
        if (renderer) {
          renderer.destroy();
          renderer = null;
        }
        return () => {
          mounted = false;
          teardown();
        };
      },
    );
  },
};

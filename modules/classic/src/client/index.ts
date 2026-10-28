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
  type ArpgWorldRenderer,
  type ClientModeView,
  type ClientServices,
  type WorldRenderer,
} from "@gamez/ui-host";
import { mode, modules } from "../index.ts";
import { ACTION } from "../actions.ts";
import { RES, type ControlState } from "../resources.ts";
import { ClassicHud, registerDefaultHud } from "./hud/index.tsx";
import { hudLayoutFor } from "./hud/layout.ts";
import { labelInsetsFor } from "./scene.ts";
import type { ClassicClientApi, Settings } from "./contract.ts";
import { createClassicGame, type ClassicGame } from "./game.ts";
import { bindKeyboard, nextMode, stepSpeed, type KeyCommand } from "./input.ts";
import { browserStorage, createSaveStore, DEFAULT_SETTINGS, type SaveRecord } from "./persist.ts";
import {
  defaultHeroName,
  EventProbe,
  installClassicDebug,
  readDebugParams,
  type DebugParams,
} from "./debug.ts";

export { classicGalleryView } from "./gallery.ts";

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
  seed: number,
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
  return { sim: createSim(loaded, { seed }), fresh: true };
}

/** `?class=…&autostart=1`: creates the hero (replacing a saved one of another class). */
function autostart(api: ClassicClientApi, params: DebugParams): void {
  const classId = params.classId;
  if (!params.autostart || classId === null) return;
  const hud = api.hud.getSnapshot();
  if (hud.phase === "play" && hud.hero?.classId === classId) return;
  if (hud.phase === "play") api.newGame();
  api.act(ACTION.newHero, { classId, name: params.name ?? defaultHeroName(classId) });
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

/**
 * Keeps the renderer's world-label insets (setLabelInsets, optional) in step
 * with the HUD layout: recomputed on resize and on UI changes, but only sent
 * when the layout or the minimap visibility actually changed.
 */
function trackLabelInsets(renderer: ArpgWorldRenderer, api: ClassicClientApi): (() => void) | null {
  if (!renderer.setLabelInsets) return null;
  let key = "";
  const update = (): void => {
    const ui = api.ui.getSnapshot();
    // Same inputs as the HUD's useHudLayout: ui.compact and the viewport height.
    const layout = hudLayoutFor(ui.compact, window.innerHeight);
    const minimap = ui.settings.showMinimap;
    const next = `${layout}|${minimap ? 1 : 0}`;
    if (next === key) return;
    key = next;
    renderer.setLabelInsets?.(labelInsetsFor(layout, minimap));
  };
  update();
  const unsub = api.ui.subscribe(update);
  window.addEventListener("resize", update);
  return () => {
    unsub();
    window.removeEventListener("resize", update);
  };
}

export const classicView: ClientModeView = {
  modeId: "classic",
  // The HUD draws its own Modes control (PanelButtons), so the shell skips its back button.
  ownsExitControl: true,
  mount(host: HTMLElement, services: ClientServices) {
    const worldLayer = layer("");
    const hudLayer = layer("pointer-events:none");
    host.append(worldLayer, hudLayer);

    let renderer: WorldRenderer | null = null;
    let game: ClassicGame | null = null;
    let root: ReturnType<typeof createRoot> | null = null;
    let unbindKeys: (() => void) | null = null;
    let saveTimer: number | null = null;
    let uninstallDebug: (() => void) | null = null;
    let unsubInsets: (() => void) | null = null;
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
      uninstallDebug?.();
      uninstallDebug = null;
      unsubInsets?.();
      unsubInsets = null;
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
      const params = readDebugParams(globalThis.location?.search ?? "");
      // A seeded run is a throwaway: it neither restores nor overwrites the local save.
      const store = createSaveStore(params.seed === null ? browserStorage() : null);
      const saved = store.load(loaded.contentHash);
      let seed = params.seed ?? randomSeed();
      const { sim, fresh } = startSim(loaded, saved, seed);
      const probe = params.debug ? new EventProbe() : null;
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
        newSeed: () => {
          seed = params.seed ?? randomSeed();
          return seed;
        },
        viewportWidth: () => window.innerWidth,
        exit: () => services.exit(),
        onEvents: probe ? (events) => probe.push(events, game?.currentSim().tick ?? 0) : undefined,
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
      unsubInsets = trackLabelInsets(created, api);
      if (probe) {
        uninstallDebug = installClassicDebug({
          game,
          registry: loaded.registry,
          probe,
          seed: () => (fresh || game?.currentSim() !== sim ? seed : 0),
        });
      }
      autostart(api, params);
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

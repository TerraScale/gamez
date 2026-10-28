/**
 * Client entry of the classic mode (docs/design/classic.md §12.1). mount():
 * world and HUD layers, the renderer from services (must be an
 * ArpgWorldRenderer), the local sim restored from the save or created fresh,
 * an offline-progress dispatch after a long absence, the game loop (game.ts),
 * keyboard bindings (input.ts), the React HUD (ClassicHud) on a layer above
 * the world, and save timers. Unmount tears everything down.
 *
 * Wave B (docs/design/wave-B.md §2.5): when the host can connect a verified
 * instance (services.connectVerified) and the run is neither seeded nor
 * cheats, the hero lives on the server: ServerSync (sync/) starts from the
 * account cache or the first server state (waiting up to 8 s behind
 * "Connecting…", else falling back to local mode), records and submits input
 * segments, and replaces the sim on resync. Otherwise local mode is exactly
 * the wave A behaviour. Town presence (presence/) runs when the host has it.
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
import { debugModules, mode, modules } from "../index.ts";
import { ACTION } from "../actions.ts";
import { RES, type ControlState } from "../resources.ts";
import { ClassicHud, registerDefaultHud } from "./hud/index.tsx";
import { hudLayoutFor } from "./hud/layout.ts";
import { labelInsetsFor } from "./scene.ts";
import type { ClassicClientApi, Settings } from "./contract.ts";
import { createClassicGame, type ClassicGame } from "./game.ts";
import { bindKeyboard, nextMode, stepSpeed, type KeyCommand } from "./input.ts";
import {
  browserStorage,
  CHEATS_SAVE_KEY,
  createSaveStore,
  DEFAULT_SETTINGS,
  legacySaveForImport,
  markLegacyMigrated,
  restoreCarried,
  SAVE_KEY,
  type SaveRecord,
  type SaveStore,
} from "./persist.ts";
import { TownPresence } from "./presence/index.ts";
import {
  serverSaveStore,
  ServerSync,
  SYNC_TEXT,
  wantsServer,
  type SyncBoot,
} from "./sync/index.ts";
import {
  defaultHeroName,
  EventProbe,
  installClassicDebug,
  readDebugParams,
  type DebugParams,
} from "./debug.ts";

export { classicGalleryView } from "./gallery.ts";

/** Notice shown after a save of another content version was carried over. */
export const CARRY_TOAST = {
  title: "Save carried over",
  body: "Your hero was carried over to the new version",
  ms: 7000,
} as const;

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

/** "Connecting…" notice while the first server state is awaited (no local cache). */
function showConnecting(host: HTMLElement): HTMLDivElement {
  const div = document.createElement("div");
  div.setAttribute("role", "status");
  div.style.cssText =
    "position:absolute;inset:0;display:grid;place-items:center;padding:16px;text-align:center;" +
    "color:#d9cfb8;font:600 16px system-ui;letter-spacing:.04em;background:#0d0b0a";
  div.textContent = "Connecting…";
  host.appendChild(div);
  return div;
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
    let sync: ServerSync | null = null;
    let presence: TownPresence | null = null;
    let hiddenAt: number | null = null;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        sync?.flush();
        game?.save();
      } else if (hiddenAt !== null) {
        const away = Date.now() - hiddenAt;
        hiddenAt = null;
        sync?.visible(away);
      }
    };
    const onPageHide = (): void => {
      sync?.flush();
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
      sync?.flush();
      game?.save();
      game?.destroy();
      game = null;
      sync?.destroy();
      sync = null;
      presence?.destroy();
      presence = null;
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

      const params = readDebugParams(globalThis.location?.search ?? "");
      // ?debug=1&cheats=1 loads the QA cheat module too: a different content hash and its own save slot.
      const cheats = params.debug && params.cheats;
      const loaded = cheats
        ? loadMode({ ...mode }, [...modules, ...debugModules])
        : loadMode(mode, modules);
      const storage = browserStorage();

      // Wave B: the server-backed hero (sync/), unless this is a throwaway run.
      let booted: SyncBoot | null = null;
      let fellBack = false;
      if (
        services.connectVerified &&
        wantsServer({ canConnect: true, seed: params.seed, cheats: cheats })
      ) {
        const s = new ServerSync({
          loaded,
          accountId: services.session.accountId,
          connect: () => {
            if (!services.connectVerified) throw new Error("no verified connection");
            return services.connectVerified("classic");
          },
          storage,
          now: () => performance.now(),
          wall: () => Date.now(),
          legacy: {
            load: () => legacySaveForImport(storage, loaded),
            markMigrated: () => {
              markLegacyMigrated(storage);
            },
          },
        });
        sync = s;
        const connecting = showConnecting(hudLayer);
        try {
          booted = await s.boot();
        } finally {
          connecting.remove();
        }
        if (booted === null) {
          // No server within the boot timeout: play locally (today's behaviour).
          s.destroy();
          sync = null;
          fellBack = true;
        }
      }
      const activeSync = sync;

      // A seeded run is a throwaway: it neither restores nor overwrites the local save.
      const store = createSaveStore(
        params.seed === null ? storage : null,
        cheats ? CHEATS_SAVE_KEY : SAVE_KEY,
      );
      const local = booted === null;
      const saved = local ? store.load(loaded.contentHash) : null;
      // A save of another content version whose modules all still exist is carried over (dev convenience).
      const carriedRecord =
        local && saved === null && !params.fresh && params.seed === null
          ? store.loadCarryable(
              loaded.contentHash,
              loaded.modules.map((m) => m.id),
            )
          : null;
      const carriedSim = carriedRecord !== null ? restoreCarried(loaded, carriedRecord) : null;
      const base = saved ?? (carriedSim !== null ? carriedRecord : null);
      let seed = params.seed ?? randomSeed();
      const { sim, fresh } =
        booted !== null
          ? { sim: booted.sim, fresh: false }
          : carriedSim !== null
            ? { sim: carriedSim, fresh: false }
            : startSim(loaded, saved, seed);
      const probe = params.debug ? new EventProbe() : null;
      const settings: Settings = booted?.settings ?? base?.settings ?? { ...DEFAULT_SETTINGS };
      const wall = Date.now();
      const saveStore: SaveStore = activeSync ? serverSaveStore(activeSync) : store;

      if (services.joinPresence) {
        presence = new TownPresence({
          services,
          renderer: created,
          registry: loaded.registry,
        });
      }
      const townPresence = presence;

      game = createClassicGame({
        loaded,
        sim,
        renderer: created,
        save: saveStore,
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
        platform: services.platform ?? null,
        session: { accountId: services.session.accountId, name: services.session.name },
        ...(activeSync ? { server: activeSync, sync: activeSync.view } : {}),
        ...(townPresence
          ? { extraFrame: (s: Sim, nowMs: number) => townPresence.update(s, nowMs) }
          : {}),
      });

      if (activeSync) activeSync.attach(game);
      if (fellBack) game.notify("info", SYNC_TEXT.fallbackTitle, SYNC_TEXT.fallbackBody);

      if (carriedSim !== null) {
        // Write it back under the new content hash, then tell the player.
        game.save();
        game.notify("info", CARRY_TOAST.title, CARRY_TOAST.body, CARRY_TOAST.ms);
      }

      // Offline progress for a long absence, when the hero is in play and the controller drives it.
      // (Server mode: the server grants it from its own clock; the client never dispatches it.)
      if (!activeSync && !fresh && base && wall - base.savedAt > OFFLINE_MIN_MS) {
        const control = sim.world.getResource<ControlState>(RES.control);
        if (control && control.mode !== "manual" && game.api.hud.getSnapshot().phase === "play") {
          const elapsedMs = Math.min(wall - base.savedAt, OFFLINE_MAX_MS);
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
          // Server mode: the server picks the seeds (not known to the client).
          seed: () => (activeSync ? 0 : fresh || game?.currentSim() !== sim ? seed : 0),
          ...(activeSync ? { sync: () => activeSync.debugInfo() } : {}),
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

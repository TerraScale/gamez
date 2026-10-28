/**
 * React HUD of the classic mode — OWNER: HUD builder (T9).
 * docs/design/classic.md §13. Renders only from ClassicClientApi stores
 * (src/client/contract.ts) through useSelect selectors, so the 60 fps loop never
 * re-renders React.
 *
 * registerDefaultHud(slots) registers every default widget and panel (the §13
 * table; ids prefixed "classic.", moduleId "classic.hud"). ClassicHud renders
 * the slot regions and the panel host on top of the game canvas.
 */
import { useMemo, type CSSProperties, type Ref } from "react";
import { Slot, SlotProvider, type SlotComponent, type SlotRegistry } from "@gamez/ui-host";
import type { ClassicClientApi, PanelId } from "../contract.ts";
import { useMeasuredHeight, useSelect } from "./hooks.ts";
import { HudInsetsContext, type SlotProps } from "./common.tsx";
import { FONT, HUD_CSS, C } from "./styles.ts";
import {
  HUD_EDGE,
  HUD_MODULE_ID,
  LEFT_TOP,
  LEFT_WIDTH,
  PANEL_IDS,
  TARGET_TOP,
  leftColumnBottom,
  panelSlot,
  SLOT,
  topRightInset,
  type HudInsets,
  type HudLayout,
} from "./layout.ts";
import { useHudLayout } from "./common.tsx";
import { AreaBanner } from "./widgets/AreaBanner.tsx";
import { ControlBar } from "./widgets/ControlBar.tsx";
import { PerfOverlay } from "./widgets/PerfOverlay.tsx";
import { Minimap } from "./widgets/Minimap.tsx";
import { StatusBar } from "./widgets/StatusBar.tsx";
import { TargetBar } from "./widgets/TargetBar.tsx";
import { QuestTracker } from "./widgets/QuestTracker.tsx";
import { CombatLog } from "./widgets/CombatLog.tsx";
import { LifeOrb, ManaOrb } from "./widgets/Orbs.tsx";
import { SkillBar } from "./widgets/SkillBar.tsx";
import { Belt } from "./widgets/Belt.tsx";
import { XpBar } from "./widgets/XpBar.tsx";
import { PanelButtons } from "./widgets/PanelButtons.tsx";
import { NewHeroScreen } from "./widgets/NewHeroScreen.tsx";
import { DeathScreen } from "./widgets/DeathScreen.tsx";
import { Toasts } from "./widgets/Toasts.tsx";
import { Tooltip } from "./widgets/Tooltip.tsx";
import { ErrorFlash } from "./widgets/ErrorFlash.tsx";
import { PanelHost } from "./panels/PanelHost.tsx";
import { CharacterPanel } from "./panels/CharacterPanel.tsx";
import { InventoryPanel } from "./panels/InventoryPanel.tsx";
import { SkillsPanel } from "./panels/SkillsPanel.tsx";
import { QuestsPanel } from "./panels/QuestsPanel.tsx";
import { VendorPanel } from "./panels/VendorPanel.tsx";
import { StashPanel } from "./panels/StashPanel.tsx";
import { WaypointPanel } from "./panels/WaypointPanel.tsx";
import { SettingsPanel } from "./panels/SettingsPanel.tsx";
import { LogPanel } from "./panels/LogPanel.tsx";
import { MapPanel } from "./panels/MapPanel.tsx";

export interface ClassicHudProps {
  api: ClassicClientApi;
  /** Slot registry the default panels are registered into (createSlotRegistry()). */
  slots: SlotRegistry;
}

interface WidgetSpec {
  slot: string;
  id: string;
  order: number;
  component: SlotComponent;
}

/** The section 13 table: widgets per slot, in render order. */
export const DEFAULT_WIDGETS: readonly WidgetSpec[] = [
  { slot: SLOT.top, id: "classic.areaBanner", order: 10, component: AreaBanner },
  { slot: SLOT.top, id: "classic.controlBar", order: 20, component: ControlBar },
  { slot: SLOT.top, id: "classic.perfOverlay", order: 30, component: PerfOverlay },
  { slot: SLOT.topRight, id: "classic.minimap", order: 10, component: Minimap },
  { slot: SLOT.target, id: "classic.statusBar", order: 5, component: StatusBar },
  { slot: SLOT.target, id: "classic.targetBar", order: 10, component: TargetBar },
  { slot: SLOT.left, id: "classic.questTracker", order: 10, component: QuestTracker },
  { slot: SLOT.left, id: "classic.combatLog", order: 20, component: CombatLog },
  { slot: SLOT.bottom, id: "classic.xpBar", order: 10, component: XpBar },
  { slot: SLOT.bottom, id: "classic.lifeOrb", order: 20, component: LifeOrb },
  { slot: SLOT.bottom, id: "classic.skillBar", order: 30, component: SkillBar },
  { slot: SLOT.bottom, id: "classic.belt", order: 40, component: Belt },
  { slot: SLOT.bottom, id: "classic.manaOrb", order: 50, component: ManaOrb },
  { slot: SLOT.bottom, id: "classic.panelButtons", order: 60, component: PanelButtons },
  { slot: SLOT.overlay, id: "classic.newHeroScreen", order: 10, component: NewHeroScreen },
  { slot: SLOT.overlay, id: "classic.deathScreen", order: 20, component: DeathScreen },
  { slot: SLOT.overlay, id: "classic.toasts", order: 30, component: Toasts },
  { slot: SLOT.overlay, id: "classic.tooltip", order: 40, component: Tooltip },
  { slot: SLOT.overlay, id: "classic.errorFlash", order: 50, component: ErrorFlash },
];

/** One default component per panel id. */
export const PANEL_COMPONENTS: Record<PanelId, SlotComponent> = {
  character: CharacterPanel,
  inventory: InventoryPanel,
  skills: SkillsPanel,
  quests: QuestsPanel,
  vendor: VendorPanel,
  stash: StashPanel,
  waypoint: WaypointPanel,
  settings: SettingsPanel,
  log: LogPanel,
  map: MapPanel,
};

/** Registers the default HUD widgets and panels into `slots` (see §13 slot table). Call once per registry. */
export function registerDefaultHud(slots: SlotRegistry): void {
  for (const w of DEFAULT_WIDGETS) {
    slots.register(w.slot, {
      id: w.id,
      moduleId: HUD_MODULE_ID,
      component: w.component,
      order: w.order,
    });
  }
  for (const id of PANEL_IDS) {
    slots.register(panelSlot(id), {
      id: `classic.panel.${id}`,
      moduleId: HUD_MODULE_ID,
      component: PANEL_COMPONENTS[id],
      order: 0,
    });
  }
}

const ROOT: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  pointerEvents: "none",
  color: C.text,
  font: `13px/1.35 ${FONT}`,
};

function regionStyle(name: string, layout: HudLayout, insets: HudInsets): CSSProperties {
  const compact = layout !== "desktop";
  switch (name) {
    case SLOT.top:
      return {
        position: "absolute",
        top: HUD_EDGE,
        left: HUD_EDGE,
        right: topRightInset(layout),
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "flex-start",
        gap: 8,
        pointerEvents: "none",
      };
    case SLOT.topRight:
      return { position: "absolute", top: HUD_EDGE, right: HUD_EDGE, pointerEvents: "none" };
    case SLOT.target:
      return {
        position: "absolute",
        top: TARGET_TOP[layout],
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "calc(100% - 24px)",
        pointerEvents: "none",
      };
    case SLOT.left:
      return {
        position: "absolute",
        left: HUD_EDGE,
        width: LEFT_WIDTH[layout],
        display: "flex",
        flexDirection: "column",
        gap: 8,
        overflow: "hidden",
        pointerEvents: "none",
        // Phones stop above the measured bottom bar, so the Log row never meets the orbs and XP row.
        ...(layout === "desktop"
          ? { top: LEFT_TOP.desktop, maxHeight: "calc(100% - 300px)" }
          : {
              top: layout === "short" ? LEFT_TOP.short : undefined,
              bottom: leftColumnBottom(layout, insets),
            }),
      };
    case SLOT.bottom:
      return {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "flex-end",
        gap: compact ? 8 : 10,
        padding: compact ? "0 12px 12px" : "0 16px 14px",
        pointerEvents: "none",
      };
    default:
      return { position: "absolute", inset: 0, pointerEvents: "none" };
  }
}

function Region({
  name,
  api,
  layout,
  insets,
  regionRef,
}: {
  name: string;
  api: ClassicClientApi;
  layout: HudLayout;
  insets: HudInsets;
  regionRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={regionRef} data-slot={name} style={regionStyle(name, layout, insets)}>
      <Slot name={name} props={{ api } satisfies SlotProps} />
    </div>
  );
}

export function ClassicHud({ api, slots }: ClassicHudProps) {
  const compact = useSelect(api.ui, (u) => u.compact);
  const layout = useHudLayout(api);
  const choosing = useSelect(api.hud, (s) => s.phase === "choose");
  // The real top and bottom region heights: columns, toasts, the error flash and panels clear them.
  const [topRef, topHeight] = useMeasuredHeight();
  const [bottomRef, bottomHeight] = useMeasuredHeight();
  const insets = useMemo(
    () => ({ top: topHeight, bottom: bottomHeight }),
    [topHeight, bottomHeight],
  );
  if (choosing) {
    // Before the hero exists only the new-hero screen (an overlay) is shown.
    return (
      <SlotProvider registry={slots}>
        <HudInsetsContext.Provider value={insets}>
          <div className="cl-hud" data-compact={compact ? "true" : "false"} style={ROOT}>
            <style>{HUD_CSS}</style>
            <Region name={SLOT.overlay} api={api} layout={layout} insets={insets} />
          </div>
        </HudInsetsContext.Provider>
      </SlotProvider>
    );
  }
  return (
    <SlotProvider registry={slots}>
      <HudInsetsContext.Provider value={insets}>
        <div className="cl-hud" data-compact={compact ? "true" : "false"} style={ROOT}>
          <style>{HUD_CSS}</style>
          <Region name={SLOT.top} api={api} layout={layout} insets={insets} regionRef={topRef} />
          <Region name={SLOT.topRight} api={api} layout={layout} insets={insets} />
          <Region name={SLOT.target} api={api} layout={layout} insets={insets} />
          <Region name={SLOT.left} api={api} layout={layout} insets={insets} />
          <Region
            name={SLOT.bottom}
            api={api}
            layout={layout}
            insets={insets}
            regionRef={bottomRef}
          />
          <PanelHost api={api} />
          <Region name={SLOT.overlay} api={api} layout={layout} insets={insets} />
        </div>
      </HudInsetsContext.Provider>
    </SlotProvider>
  );
}

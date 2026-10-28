/**
 * Opens and closes panels from the bottom bar (classic.hud.bottom): Character, Inventory, Skills,
 * Talents, Quests, Automap on every layout; Achievements, Settings and Log in the desktop bar; on
 * phones those three and the Modes control collapse into a "More" menu (>= 44 px targets).
 * Keys C I S N L Tab Y are handled by the input layer (T-client).
 */
import { useState } from "react";
import type { PanelId } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useHudLayout, type SlotProps } from "../common.tsx";
import { bottomOrderFor, modesControlVisible } from "../layout.ts";
import { MoreMenu, type MoreItem } from "./MoreMenu.tsx";

interface PanelSpec {
  id: PanelId;
  label: string;
  title: string;
  /** Text of the row in the phone "More" menu. */
  text: string;
}

/** Shown on every layout, in this order. */
export const PRIMARY_BUTTONS: readonly PanelSpec[] = [
  { id: "character", label: "C", title: "Character (C)", text: "Character (C)" },
  { id: "inventory", label: "I", title: "Inventory (I)", text: "Inventory (I)" },
  { id: "skills", label: "S", title: "Skills (S)", text: "Skills (S)" },
  { id: "talents", label: "N", title: "Talents (N)", text: "Talents (N)" },
  { id: "quests", label: "L", title: "Quests (L)", text: "Quests (L)" },
  { id: "map", label: "Map", title: "Automap (Tab)", text: "Automap (Tab)" },
];

/** Desktop only: also on the phone "More" menu. */
export const SECONDARY_BUTTONS: readonly PanelSpec[] = [
  { id: "achievements", label: "Y", title: "Achievements (Y)", text: "Achievements (Y)" },
  { id: "settings", label: "⚙", title: "Settings", text: "Settings" },
];

/** Phone "More" menu only (the desktop bar has no room for it). */
const MORE_ONLY: readonly PanelSpec[] = [{ id: "log", label: "Log", title: "Log", text: "Log" }];

export function PanelButtons({ api }: SlotProps) {
  const open = useSelect(api.ui, (u) => u.panels);
  const layout = useHudLayout(api);
  const compact = layout !== "desktop";
  const [moreOpen, setMoreOpen] = useState(false);
  // The mode picker control. The shell has no back button for classic (ClientModeView.ownsExitControl).
  const showModes = modesControlVisible(layout, open.length > 0);
  const primary = compact ? PRIMARY_BUTTONS : [...PRIMARY_BUTTONS, ...SECONDARY_BUTTONS];
  const moreItems: MoreItem[] = [];
  if (compact) {
    for (const b of [...SECONDARY_BUTTONS, ...MORE_ONLY]) {
      moreItems.push({
        id: b.id,
        text: b.text,
        title: b.title,
        pressed: open.includes(b.id),
        onSelect: () => api.togglePanel(b.id),
      });
    }
    if (showModes) {
      moreItems.push({
        id: "modes",
        text: "Modes",
        title: "Modes: back to the mode picker",
        onSelect: () => api.exit(),
      });
    }
  }
  return (
    <div
      role="toolbar"
      aria-label="Panels"
      style={{
        order: bottomOrderFor(layout, "panel"),
        flexBasis: "100%",
        display: "flex",
        justifyContent: "center",
        flexWrap: "wrap",
        gap: compact ? 4 : 6,
        pointerEvents: "none",
      }}
    >
      {primary.map((b) => (
        <Btn
          key={b.id}
          label={b.title}
          title={b.title}
          pressed={open.includes(b.id)}
          minWidth={44}
          height={44}
          fontSize={b.label.length > 2 ? 12 : 13}
          style={b.label.length > 2 ? { padding: "0 8px" } : undefined}
          onClick={() => api.togglePanel(b.id)}
        >
          {b.label}
        </Btn>
      ))}
      {!compact && showModes ? (
        <Btn
          label="Modes: back to the mode picker"
          title="Modes"
          minWidth={44}
          height={44}
          fontSize={12}
          style={{ padding: "0 8px" }}
          onClick={() => api.exit()}
        >
          Modes
        </Btn>
      ) : null}
      {compact ? (
        <MoreMenu items={moreItems} open={moreOpen && moreItems.length > 0} setOpen={setMoreOpen} />
      ) : null}
    </div>
  );
}

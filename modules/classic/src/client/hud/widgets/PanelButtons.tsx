/** Opens and closes panels: C I S L, automap, settings, and the Modes control (classic.hud.bottom). */
import type { PanelId } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useHudLayout, type SlotProps } from "../common.tsx";
import { bottomOrderFor, modesControlVisible } from "../layout.ts";

const BUTTONS: { id: PanelId; label: string; title: string }[] = [
  { id: "character", label: "C", title: "Character (C)" },
  { id: "inventory", label: "I", title: "Inventory (I)" },
  { id: "skills", label: "S", title: "Skills (S)" },
  { id: "quests", label: "L", title: "Quests (L)" },
  { id: "map", label: "Map", title: "Automap (Tab)" },
  { id: "settings", label: "⚙", title: "Settings" },
];

export function PanelButtons({ api }: SlotProps) {
  const open = useSelect(api.ui, (u) => u.panels);
  const layout = useHudLayout(api);
  const compact = layout !== "desktop";
  // The mode picker control. The shell has no back button for classic (ClientModeView.ownsExitControl).
  const showModes = modesControlVisible(layout, open.length > 0);
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
      {BUTTONS.map((b) => (
        <Btn
          key={b.id}
          label={b.title}
          title={b.title}
          pressed={open.includes(b.id)}
          minWidth={44}
          height={44}
          onClick={() => api.togglePanel(b.id)}
        >
          {b.label}
        </Btn>
      ))}
      {showModes ? (
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
    </div>
  );
}

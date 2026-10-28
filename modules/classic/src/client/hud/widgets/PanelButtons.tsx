/** Opens and closes panels: C I S L, automap and settings (classic.hud.bottom). */
import type { PanelId } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useCompact, type SlotProps } from "../common.tsx";
import { bottomOrder } from "../layout.ts";

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
  const compact = useCompact(api);
  return (
    <div
      role="toolbar"
      aria-label="Panels"
      style={{
        order: bottomOrder(compact, "panel"),
        flexBasis: "100%",
        display: "flex",
        justifyContent: "center",
        flexWrap: "wrap",
        gap: 6,
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
    </div>
  );
}

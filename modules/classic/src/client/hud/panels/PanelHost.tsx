/**
 * Renders every open panel from its slot "classic.panel.<id>". Desktop: panels
 * sit side by side above the bottom bar. Compact: one full-screen sheet, the
 * most recently opened panel.
 */
import { useEffect } from "react";
import { Slot } from "@gamez/ui-host";
import { useSelect } from "../hooks.ts";
import { useCompact, type SlotProps } from "../common.tsx";
import { PANEL_IDS, panelSlot } from "../layout.ts";
import type { PanelId } from "../../contract.ts";

export function PanelHost({ api }: SlotProps) {
  const open = useSelect(api.ui, (u) => u.panels);
  const compact = useCompact(api);
  const known = open.filter((id): id is PanelId => PANEL_IDS.includes(id));
  const shown = compact ? known.slice(-1) : known;
  const anyOpen = known.length > 0;
  // Esc closes every panel (closeAll is idempotent, so it may coexist with the input layer's own Esc).
  useEffect(() => {
    if (!anyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") api.closeAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api, anyOpen]);
  if (shown.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Panels"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        display: "flex",
        alignItems: compact ? "stretch" : "flex-start",
        justifyContent: "center",
        gap: 12,
        padding: compact ? 0 : "64px 16px 170px",
      }}
    >
      {shown.map((id) => (
        <Slot key={id} name={panelSlot(id)} props={{ api }} />
      ))}
    </div>
  );
}

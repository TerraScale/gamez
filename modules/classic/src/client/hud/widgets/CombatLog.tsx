/** Last eight log lines, collapsible; full log button opens the log panel (classic.hud.left). */
import { useState } from "react";
import { hex } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useCompact, type SlotProps } from "../common.tsx";
import { labelStyle, panelStyle } from "../styles.ts";

export const COMBAT_LOG_LINES = 8;

export function CombatLog({ api }: SlotProps) {
  const compact = useCompact(api);
  const lines = useSelect(api.log, (l) => l.slice(-COMBAT_LOG_LINES));
  const [open, setOpen] = useState(!compact);
  return (
    <section
      aria-label="Combat log"
      // Fills its column (180 px compact, 250 px desktop) so the Full log button is never clipped.
      style={{ ...panelStyle, padding: 8, width: "100%", boxSizing: "border-box" }}
    >
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}
      >
        <Btn
          pressed={open}
          label="Toggle combat log"
          height={44}
          fontSize={12}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Log ▾" : "Log ▸"}
        </Btn>
        <Btn label="Open full log" height={44} fontSize={12} onClick={() => api.openPanel("log")}>
          Full log
        </Btn>
      </div>
      {open ? (
        <ol
          role="log"
          style={{
            listStyle: "none",
            margin: "6px 0 0",
            padding: 0,
            maxHeight: 190,
            overflow: "hidden",
          }}
        >
          {lines.map((l) => (
            <li key={l.id} style={{ color: hex(l.color), fontSize: 12, lineHeight: 1.4 }}>
              {l.text}
            </li>
          ))}
          {lines.length === 0 ? <li style={labelStyle}>Nothing has happened yet.</li> : null}
        </ol>
      ) : null}
    </section>
  );
}

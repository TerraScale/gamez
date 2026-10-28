/** Full combat and event log, newest first (panel "log"). */
import { hex } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { PanelFrame, type SlotProps } from "../common.tsx";
import { labelStyle } from "../styles.ts";

export const FULL_LOG_LINES = 300;

export function LogPanel({ api }: SlotProps) {
  const lines = useSelect(api.log, (l) => l);
  const shown = lines.slice(-FULL_LOG_LINES).reverse();
  return (
    <PanelFrame api={api} id="log" title="Log" width={460} subtitle={`${lines.length} entries`}>
      <ol
        role="log"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {shown.map((l) => (
          <li key={l.id} style={{ color: hex(l.color), lineHeight: 1.4 }}>
            <span style={{ ...labelStyle, marginRight: 6 }}>{`[${l.kind}]`}</span>
            {l.text}
          </li>
        ))}
        {shown.length === 0 ? <li style={labelStyle}>Nothing has been logged yet.</li> : null}
      </ol>
    </PanelFrame>
  );
}

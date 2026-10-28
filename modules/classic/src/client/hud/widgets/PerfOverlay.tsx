/** Developer overlay: fps, sim ms per tick, tick rate, entity counts (settings.showPerf). */
import { useSelect } from "../hooks.ts";
import type { SlotProps } from "../common.tsx";
import { fmtInt } from "../format.ts";
import { C, panelStyle } from "../styles.ts";

export function PerfOverlay({ api }: SlotProps) {
  const show = useSelect(api.ui, (u) => u.settings.showPerf);
  const perf = useSelect(api.ui, (u) => u.perf);
  if (!show) return null;
  return (
    <div
      aria-label="Performance"
      style={{
        ...panelStyle,
        padding: "4px 8px",
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: 11,
        color: C.muted,
        lineHeight: 1.45,
        pointerEvents: "none",
      }}
    >
      <div>{`${fmtInt(perf.fps)} fps · ${perf.tickMs.toFixed(2)} ms/tick · ${fmtInt(perf.ticksPerSecond)} tps`}</div>
      <div>{`${fmtInt(perf.entities)} entities · ${fmtInt(perf.monsters)} monsters`}</div>
    </div>
  );
}

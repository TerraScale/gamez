/** Large automap overlay (panel "map", Tab): explored tiles and dots, with a legend. */
import { DOT_COLOR, DOT_LABEL } from "../format.ts";
import { hex } from "../../contract.ts";
import { MinimapCanvas } from "../widgets/Minimap.tsx";
import { PanelFrame, type SlotProps } from "../common.tsx";
import { labelStyle } from "../styles.ts";
import { useSelect } from "../hooks.ts";

export function MapPanel({ api }: SlotProps) {
  const area = useSelect(api.hud, (s) =>
    s.area ? { name: s.area.name, depth: s.area.depth } : null,
  );
  return (
    <PanelFrame
      api={api}
      id="map"
      title="Automap"
      width={600}
      subtitle={area ? `${area.name} · explored tiles are shown` : undefined}
    >
      <MinimapCanvas api={api} size={512} cssWidth="100%" label="Automap" />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
        {(Object.keys(DOT_LABEL) as (keyof typeof DOT_LABEL)[]).map((kind) => (
          <span
            key={kind}
            style={{ ...labelStyle, display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              aria-hidden="true"
              style={{ width: 9, height: 9, borderRadius: 2, background: hex(DOT_COLOR[kind]) }}
            />
            {DOT_LABEL[kind]}
          </span>
        ))}
      </div>
    </PanelFrame>
  );
}

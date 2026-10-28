/** Large automap overlay (panel "map", Tab): explored tiles and dots, with a legend. */
import { DOT_LABEL, type MinimapDotKind } from "../format.ts";
import { HeroSwatch, MarkerSwatch, MinimapCanvas } from "../widgets/Minimap.tsx";
import { PanelFrame, type SlotProps } from "../common.tsx";
import { C, labelStyle } from "../styles.ts";
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
        <span style={{ ...labelStyle, width: "100%", marginBottom: -4 }}>Legend</span>
        <span
          style={{
            ...labelStyle,
            color: C.text,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minHeight: 28,
          }}
        >
          <HeroSwatch />
          Hero
        </span>
        {(Object.keys(DOT_LABEL) as MinimapDotKind[]).map((kind) => (
          <span
            key={kind}
            style={{
              ...labelStyle,
              color: C.text,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              minHeight: 28,
            }}
          >
            <MarkerSwatch kind={kind} />
            {DOT_LABEL[kind]}
          </span>
        ))}
      </div>
    </PanelFrame>
  );
}

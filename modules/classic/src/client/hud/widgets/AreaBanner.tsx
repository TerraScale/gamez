/** Area name, depth, explored share and kill counter (classic.hud.top). */
import { useSelect } from "../hooks.ts";
import { useHudLayout, type SlotProps } from "../common.tsx";
import { fmtInt, fmtPct } from "../format.ts";
import { C, labelStyle, panelStyle } from "../styles.ts";

export function AreaBanner({ api }: SlotProps) {
  const area = useSelect(api.hud, (s) => s.area);
  const compact = useHudLayout(api) !== "desktop";
  if (!area) return null;
  const where = area.isTown ? "Town" : `Depth ${fmtInt(area.depth)}`;
  return (
    <div
      aria-label="Area"
      style={{
        ...panelStyle,
        padding: compact ? "6px 10px" : "8px 14px",
        maxWidth: compact ? 260 : 420,
        pointerEvents: "none",
      }}
    >
      <div style={{ color: C.goldBright, fontWeight: 700, fontSize: compact ? 13 : 15 }}>
        {area.name}
      </div>
      <div style={labelStyle}>
        {`${where} · ${fmtPct(area.exploredPct)} explored · ${fmtInt(area.killed)}/${fmtInt(area.spawned)} slain`}
        {area.bossAlive ? " · boss alive" : ""}
      </div>
      {!compact ? <div style={labelStyle}>{`Deepest ${fmtInt(area.deepest)}`}</div> : null}
    </div>
  );
}

/** Waypoints: travel to any unlocked depth (panel "waypoint"). */
import { ACTION } from "../../../actions.ts";
import { useSelect } from "../hooks.ts";
import { Btn, PanelFrame, type SlotProps } from "../common.tsx";
import { fmtInt } from "../format.ts";
import { badgeStyle, C, labelStyle } from "../styles.ts";

export function WaypointPanel({ api }: SlotProps) {
  const area = useSelect(api.hud, (s) =>
    s.area
      ? {
          depth: s.area.depth,
          isTown: s.area.isTown,
          deepest: s.area.deepest,
          waypoints: s.area.waypoints,
        }
      : null,
  );
  if (!area)
    return (
      <PanelFrame api={api} id="waypoint" title="Waypoints" width={380}>
        <p style={labelStyle}>No area yet.</p>
      </PanelFrame>
    );
  const depths = [...new Set([0, ...area.waypoints])].sort((a, b) => a - b);
  return (
    <PanelFrame
      api={api}
      id="waypoint"
      title="Waypoints"
      width={380}
      subtitle={`Deepest reached: ${fmtInt(area.deepest)}`}
    >
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {depths.map((d) => {
          const here = d === area.depth;
          return (
            <li
              key={d}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: 10,
                borderRadius: 8,
                border: `1px solid ${here ? C.borderStrong : C.border}`,
                background: "rgba(255, 240, 210, 0.04)",
              }}
            >
              <span style={{ flex: 1, fontWeight: 700 }}>
                {d === 0 ? "Town" : `Depth ${fmtInt(d)}`}
              </span>
              {here ? <span style={badgeStyle}>You are here</span> : null}
              <Btn
                disabled={here}
                label={d === 0 ? "Travel to town" : `Travel to depth ${d}`}
                onClick={() => api.act(ACTION.useWaypoint, { depth: d })}
              >
                Travel
              </Btn>
            </li>
          );
        })}
      </ul>
      {area.waypoints.length === 0 ? <p style={labelStyle}>No waypoints unlocked yet.</p> : null}
    </PanelFrame>
  );
}

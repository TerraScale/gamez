/** React HUD for the steps mode: stats, event log, actions and the run-over banner. */
import { useSyncExternalStore, type CSSProperties } from "react";
import type { StepsController } from "./controller.ts";

const panel: CSSProperties = {
  pointerEvents: "auto",
  background: "rgba(16, 18, 24, 0.82)",
  color: "#f2f2f2",
  borderRadius: 10,
  padding: "10px 12px",
  font: "14px/1.4 system-ui, sans-serif",
  boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)",
};

const button: CSSProperties = {
  pointerEvents: "auto",
  font: "inherit",
  color: "#f2f2f2",
  background: "#2d3442",
  border: "1px solid #4b5566",
  borderRadius: 8,
  padding: "6px 12px",
  cursor: "pointer",
};

const disabledButton: CSSProperties = { ...button, opacity: 0.45, cursor: "default" };

export function Hud({ controller }: { controller: StepsController }) {
  const s = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot);
  const hero = s.board?.hero ?? null;
  const run = s.board?.run ?? null;
  const hpPct = hero && hero.max > 0 ? Math.round((hero.hp / hero.max) * 100) : 0;
  const over = run?.over === true;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div style={{ ...panel, position: "absolute", top: 12, left: 12, minWidth: 210 }}>
        <div style={{ fontWeight: 600 }}>Steps{run ? ` · depth ${run.depth}` : ""}</div>
        <div style={{ marginTop: 6 }}>HP {hero ? `${hero.hp} / ${hero.max}` : "–"}</div>
        <div style={{ height: 6, background: "#3a1f25", borderRadius: 3, marginTop: 4 }}>
          <div
            style={{
              width: `${hpPct}%`,
              height: "100%",
              background: hpPct > 35 ? "#5fbf6a" : "#d9534f",
              borderRadius: 3,
            }}
          />
        </div>
        <div style={{ marginTop: 6, opacity: 0.85 }}>
          Turn {s.turn}
          {run ? ` · Kills ${run.kills}` : ""}
          {s.status !== "online" ? ` · ${s.status}…` : ""}
        </div>
      </div>

      {over ? (
        <div
          style={{
            ...panel,
            position: "absolute",
            top: "40%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            textAlign: "center",
            fontSize: 18,
          }}
        >
          <div style={{ fontWeight: 600 }}>The run is over</div>
          <div style={{ marginTop: 8 }}>
            <button type="button" style={button} onClick={() => controller.restart()}>
              Start a new run
            </button>
          </div>
        </div>
      ) : null}

      <div
        style={{
          ...panel,
          position: "absolute",
          left: 12,
          right: 12,
          bottom: 12,
          maxWidth: 420,
          margin: "0 auto",
        }}
      >
        <div
          style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}
        >
          <div style={{ opacity: 0.8, fontSize: 12 }}>
            Arrows/WASD move · QEZC diagonal · . wait · &gt; descend · tap a neighbour
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              style={over ? disabledButton : button}
              disabled={over}
              onClick={() => controller.act({ kind: "wait" })}
            >
              Wait
            </button>
            <button
              type="button"
              style={over || !s.onStairs ? disabledButton : button}
              disabled={over || !s.onStairs}
              onClick={() => controller.act({ kind: "descend" })}
            >
              Descend
            </button>
            {/* Not top-right: the app shell's "Modes" button lives there. */}
            <button type="button" style={button} onClick={() => controller.restart()}>
              Restart
            </button>
          </div>
        </div>
        {s.error ? <div style={{ color: "#ffb4a8", marginTop: 6 }}>{s.error.message}</div> : null}
        <ol
          style={{
            listStyle: "none",
            margin: "8px 0 0",
            padding: 0,
            maxHeight: 120,
            overflowY: "auto",
          }}
        >
          {s.log.slice(-6).map((line) => (
            <li key={line.id} style={{ opacity: 0.9 }}>
              {line.text}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

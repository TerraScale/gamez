/** Manual / Auto / Idle segmented control, idle speeds x1-x8, plan label and overridden badge (classic.hud.top). */
import { ACTION } from "../../../actions.ts";
import type { ControlMode } from "../../../resources.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useCompact, type SlotProps } from "../common.tsx";
import { controlLabel, planLabel, SPEEDS } from "../format.ts";
import { badgeStyle, C, labelStyle, panelStyle } from "../styles.ts";

const MODES: { mode: ControlMode; hint: string }[] = [
  { mode: "manual", hint: "You steer the hero. Auto play pauses." },
  { mode: "auto", hint: "The hero plays itself at normal speed." },
  { mode: "idle", hint: "The hero plays itself and can fast-forward." },
];

export function ControlBar({ api }: SlotProps) {
  const phase = useSelect(api.hud, (s) => s.phase);
  const control = useSelect(api.hud, (s) => s.control);
  const compact = useCompact(api);
  if (phase !== "play") return null;
  const planText = control.mode === "manual" ? "Manual play" : planLabel(control.plan);
  return (
    <div
      aria-label="Control"
      style={{
        ...panelStyle,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: compact ? 6 : 10,
        padding: 6,
      }}
    >
      <div
        role="group"
        aria-label="Control mode"
        style={{
          display: "flex",
          gap: 4,
          padding: 2,
          borderRadius: 10,
          background: "rgba(0, 0, 0, 0.35)",
        }}
      >
        {MODES.map((m) => (
          <Btn
            key={m.mode}
            label={`${controlLabel(m.mode)} mode`}
            title={m.hint}
            pressed={control.mode === m.mode}
            minWidth={compact ? 70 : 84}
            height={44}
            onClick={() => api.act(ACTION.setControl, { mode: m.mode })}
          >
            {controlLabel(m.mode)}
          </Btn>
        ))}
      </div>
      {control.mode === "idle" ? (
        <div role="group" aria-label="Speed" style={{ display: "flex", gap: 4 }}>
          {SPEEDS.map((speed) => (
            <Btn
              key={speed}
              label={`Speed x${speed}`}
              pressed={control.speed === speed}
              minWidth={44}
              height={44}
              onClick={() => api.act(ACTION.setSpeed, { speed })}
            >
              {`×${speed}`}
            </Btn>
          ))}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ ...labelStyle, color: C.text }}>{planText}</span>
        {control.overridden ? <span style={badgeStyle}>Overridden</span> : null}
      </div>
    </div>
  );
}

/** Phase "choose": class cards and a name, then classic.newHero (classic.hud.overlay). */
import { useState } from "react";
import { ACTION } from "../../../actions.ts";
import { useSelect } from "../hooks.ts";
import { Btn, type SlotProps } from "../common.tsx";
import { C, FONT, panelStyle, titleStyle } from "../styles.ts";

export const HERO_NAME_MAX = 16;

export function NewHeroScreen({ api }: SlotProps) {
  const phase = useSelect(api.hud, (s) => s.phase);
  const classes = useSelect(api.hud, (s) => s.classes);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("Hero");
  if (phase !== "choose") return null;
  const classId = picked ?? classes[0]?.id ?? "";
  const trimmed = name.trim();
  const valid = classId !== "" && trimmed.length >= 1 && trimmed.length <= HERO_NAME_MAX;
  return (
    <div
      role="dialog"
      aria-label="Create your hero"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "auto",
        overflowY: "auto",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "24px 16px",
        background: `radial-gradient(ellipse at center, rgba(40, 30, 18, 0.92), rgba(4, 3, 2, 0.97))`,
        font: `14px/1.4 ${FONT}`,
        color: C.text,
      }}
    >
      <div style={{ ...panelStyle, width: "100%", maxWidth: 760, padding: 20 }}>
        <h1 style={{ ...titleStyle, fontSize: 24 }}>Create your hero</h1>
        <p style={{ color: C.muted, margin: "6px 0 14px" }}>
          Pick a class. Your hero then explores, fights and levels up on its own. You can take over
          at any time.
        </p>
        <div
          role="radiogroup"
          aria-label="Class"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 10,
          }}
        >
          {classes.map((c) => {
            const on = c.id === classId;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPicked(c.id)}
                style={{
                  pointerEvents: "auto",
                  textAlign: "left",
                  minHeight: 44,
                  padding: 12,
                  borderRadius: 10,
                  cursor: "pointer",
                  color: C.text,
                  font: "inherit",
                  background: on ? "rgba(90, 66, 32, 0.9)" : "rgba(255, 240, 210, 0.04)",
                  border: `2px solid ${on ? C.borderStrong : C.border}`,
                }}
              >
                <div style={{ color: C.goldBright, fontWeight: 700, fontSize: 16 }}>{c.name}</div>
                <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>{c.description}</div>
              </button>
            );
          })}
        </div>
        <label style={{ display: "block", marginTop: 16, color: C.muted }}>
          Hero name
          <input
            type="text"
            value={name}
            maxLength={HERO_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            aria-label="Hero name"
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              minHeight: 44,
              font: "inherit",
              color: C.text,
              background: "#120e0a",
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "6px 10px",
            }}
          />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <Btn
            disabled={!valid}
            pressed
            height={48}
            onClick={() => api.act(ACTION.newHero, { classId, name: trimmed })}
          >
            Begin the journey
          </Btn>
        </div>
      </div>
    </div>
  );
}

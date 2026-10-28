/** Level and experience between the current level start and the next level (classic.hud.bottom). */
import type { CSSProperties } from "react";
import { useSelect } from "../hooks.ts";
import { ProgressBar, useHudLayout, type SlotProps } from "../common.tsx";
import { bottomOrderFor } from "../layout.ts";
import { fmtInt, fmtPct, xpFraction } from "../format.ts";
import { C } from "../styles.ts";

/** Text sits on a dark chip so it reads over the world and never loses contrast. */
const CHIP: CSSProperties = {
  flex: "none",
  whiteSpace: "nowrap",
  padding: "1px 6px",
  borderRadius: 6,
  background: "rgba(0, 0, 0, 0.62)",
  border: `1px solid ${C.border}`,
  color: C.text,
  textShadow: "0 1px 2px #000",
  fontSize: 12,
  lineHeight: 1.4,
};

export function XpBar({ api }: SlotProps) {
  const xp = useSelect(api.hud, (s) =>
    s.hero
      ? { level: s.hero.level, xp: s.hero.xp, start: s.hero.xpLevelStart, next: s.hero.xpNextLevel }
      : null,
  );
  const layout = useHudLayout(api);
  if (!xp) return null;
  const pct = xpFraction(xp.xp, xp.start, xp.next) * 100;
  const compact = layout !== "desktop";
  return (
    <div
      aria-label="Experience"
      style={{
        order: bottomOrderFor(layout, "xp"),
        // The row always fills its own line (a max-width would let the life orb wrap up beside
        // it); the padding centres a bar of at most 900 px.
        flexBasis: "100%",
        width: "100%",
        boxSizing: "border-box",
        paddingInline: "max(0px, calc((100% - 900px) / 2))",
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 6,
        pointerEvents: "auto",
      }}
    >
      <span
        style={{ ...CHIP, color: C.goldBright, fontWeight: 700 }}
      >{`Lv ${fmtInt(xp.level)}`}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ProgressBar pct={pct} color={C.xp} height={6} label="Experience" />
      </div>
      <span style={{ ...CHIP, fontSize: compact ? 11 : 12 }}>
        {`${fmtInt(xp.xp)} / ${fmtInt(xp.next)} · ${fmtPct(pct)}`}
      </span>
    </div>
  );
}

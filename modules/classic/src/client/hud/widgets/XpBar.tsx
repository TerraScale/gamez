/** Level and experience between the current level start and the next level (classic.hud.bottom). */
import { useSelect } from "../hooks.ts";
import { ProgressBar, useCompact, type SlotProps } from "../common.tsx";
import { bottomOrder } from "../layout.ts";
import { fmtInt, fmtPct, xpFraction } from "../format.ts";
import { C, labelStyle } from "../styles.ts";

export function XpBar({ api }: SlotProps) {
  const xp = useSelect(api.hud, (s) =>
    s.hero
      ? { level: s.hero.level, xp: s.hero.xp, start: s.hero.xpLevelStart, next: s.hero.xpNextLevel }
      : null,
  );
  const compact = useCompact(api);
  if (!xp) return null;
  const pct = xpFraction(xp.xp, xp.start, xp.next) * 100;
  return (
    <div
      aria-label="Experience"
      style={{
        order: bottomOrder(compact, "xp"),
        flexBasis: "100%",
        maxWidth: 900,
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 8,
        pointerEvents: "auto",
      }}
    >
      <span
        style={{ color: C.goldBright, fontWeight: 700, minWidth: 52 }}
      >{`Lv ${fmtInt(xp.level)}`}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ProgressBar pct={pct} color={C.xp} height={6} label="Experience" />
      </div>
      <span style={{ ...labelStyle, whiteSpace: "nowrap" }}>
        {compact ? fmtPct(pct) : `${fmtInt(xp.xp)} / ${fmtInt(xp.next)} · ${fmtPct(pct)}`}
      </span>
    </div>
  );
}

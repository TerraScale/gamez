/** Shown while the hero is dead: respawn countdown and the respawn button (classic.hud.overlay). */
import { ACTION } from "../../../actions.ts";
import { useSelect } from "../hooks.ts";
import { Btn, type SlotProps } from "../common.tsx";
import { fmtDuration, fmtInt } from "../format.ts";
import { C, panelStyle, titleStyle } from "../styles.ts";

export function DeathScreen({ api }: SlotProps) {
  const hero = useSelect(api.hud, (s) =>
    s.hero
      ? { dead: s.hero.dead, respawnIn: s.hero.respawnIn, level: s.hero.level, gold: s.hero.gold }
      : null,
  );
  if (!hero || !hero.dead) return null;
  const ready = hero.respawnIn <= 0;
  return (
    <div
      role="alertdialog"
      aria-label="You died"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(40, 6, 4, 0.55)",
      }}
    >
      <div style={{ ...panelStyle, padding: 22, textAlign: "center", minWidth: 260 }}>
        <h2 style={{ ...titleStyle, color: C.danger, fontSize: 24 }}>You died</h2>
        <p style={{ color: C.muted, margin: "8px 0 14px" }}>
          {`Level ${fmtInt(hero.level)} · ${fmtInt(hero.gold)} gold`}
        </p>
        <p style={{ margin: "0 0 14px" }}>
          {ready ? "Ready to respawn in town." : `Respawn in ${fmtDuration(hero.respawnIn)}`}
        </p>
        <Btn disabled={!ready} height={48} onClick={() => api.act(ACTION.respawn, {})}>
          {ready ? "Respawn" : "Respawn (waiting)"}
        </Btn>
      </div>
    </div>
  );
}

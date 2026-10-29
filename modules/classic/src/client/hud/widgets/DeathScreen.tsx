/**
 * Shown while the controlled hero is dead (classic.hud.overlay). Party-aware (docs/design/party.md
 * §10.5): with another member standing, a slim banner ("<Name> is down, F2 takes control, click them
 * to revive, Respawn party in town") replaces the full overlay. When every member is down, the full
 * screen says "Your party has fallen". Solo, the screen is unchanged.
 */
import { ACTION } from "../../../actions.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useHudInsets, type SlotProps } from "../common.tsx";
import { deathBannerTop } from "../layout.ts";
import { fmtDuration, fmtInt } from "../format.ts";
import { C, panelStyle, titleStyle } from "../styles.ts";

/** What the death views need, as primitives (so unchanged snapshots do not re-render). */
export interface DeathInfo {
  dead: boolean;
  respawnIn: number;
  level: number;
  gold: number;
  name: string;
  /** Party size (1 = solo). */
  size: number;
  /** Every member is down. */
  wiped: boolean;
  /** Key of the first standing member ("F2"), or "" when none stands. */
  standingKey: string;
}

/** Death view state of the snapshot (null when the controlled hero is alive or there is none). */
export function deathInfoOf(s: {
  hero: { dead: boolean; respawnIn: number; level: number; gold: number; name: string } | null;
  party?: { members: { dead: boolean; controlled: boolean; key: string }[] } | null;
}): DeathInfo | null {
  const hero = s.hero;
  if (!hero || !hero.dead) return null;
  const members = s.party?.members ?? [];
  const size = Math.max(1, members.length);
  const standing = members.find((m) => !m.dead && !m.controlled);
  const wiped = size > 1 ? members.every((m) => m.dead) : true;
  return {
    dead: true,
    respawnIn: hero.respawnIn,
    level: hero.level,
    gold: hero.gold,
    name: hero.name,
    size,
    wiped,
    standingKey: size > 1 && !wiped && standing ? standing.key : "",
  };
}

export function DeathScreen({ api }: SlotProps) {
  const info = useSelect(api.hud, deathInfoOf);
  const insets = useHudInsets();
  if (!info) return null;
  const ready = info.respawnIn <= 0;
  const respawn = () => api.act(ACTION.respawn, {});
  if (info.standingKey !== "") {
    // A party is still standing: a slim banner, no full-screen block.
    return (
      <div
        role="status"
        aria-label={`${info.name} is down`}
        style={{
          ...panelStyle,
          position: "absolute",
          // Under the top region (control bar), so the mode buttons stay clickable.
          top: deathBannerTop(insets),
          left: "50%",
          transform: "translateX(-50%)",
          maxWidth: "calc(100% - 16px)",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "6px 10px",
          borderColor: C.danger,
          zIndex: 3,
        }}
      >
        <span style={{ color: C.danger, fontWeight: 700 }}>{`${info.name} is down`}</span>
        <span style={{ color: C.muted }}>
          {`${info.standingKey} takes control · click them to revive`}
        </span>
        <Btn
          label={
            ready
              ? "Respawn party in town"
              : `Respawn party in town (in ${fmtDuration(info.respawnIn)})`
          }
          disabled={!ready}
          height={44}
          fontSize={12}
          onClick={respawn}
        >
          {ready ? "Respawn party in town" : `Respawn in ${fmtDuration(info.respawnIn)}`}
        </Btn>
      </div>
    );
  }
  const title = info.wiped && info.size > 1 ? "Your party has fallen" : "You died";
  return (
    <div
      role="alertdialog"
      aria-label={title}
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
        <h2 style={{ ...titleStyle, color: C.danger, fontSize: 24 }}>{title}</h2>
        <p style={{ color: C.muted, margin: "8px 0 14px" }}>
          {info.size > 1
            ? `${info.name}, level ${fmtInt(info.level)} · ${fmtInt(info.gold)} gold`
            : `Level ${fmtInt(info.level)} · ${fmtInt(info.gold)} gold`}
        </p>
        <p style={{ margin: "0 0 14px" }}>
          {ready ? "Ready to respawn in town." : `Respawn in ${fmtDuration(info.respawnIn)}`}
        </p>
        <Btn disabled={!ready} height={48} onClick={respawn}>
          {ready ? "Respawn" : "Respawn (waiting)"}
        </Btn>
      </div>
    </div>
  );
}

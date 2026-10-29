/**
 * Party frames (classic.hud.left, order 5; docs/design/party.md §10.2): one frame per
 * member with portrait, name, level, life and mana bars, downed and revive state,
 * role, unspent-points badge and hotkey. Click or tap a frame to take control of
 * that hero. With one member and a free slot, a "+ Party" button opens the panel.
 * The header holds the "Party: Auto" toggle and the Party panel button.
 *
 * Desktop: a column of 200 x 48 px frames. Compact (phone): 44 px portraits with
 * thin bars in wrapping rows (the panel button first), so the bottom-anchored left
 * column stays short and never climbs into the control bar; every target is at
 * least 44 px.
 */
import type { CSSProperties } from "react";
import { ACTION } from "../../../actions.ts";
import type { ClassicClientApi, PartyMemberView, PartyView } from "../../contract.ts";
import { hex } from "../../contract.ts";
import { useSelect } from "../hooks.ts";
import { Btn, useHudLayout, type SlotProps } from "../common.tsx";
import { fillPercent, fmtInt } from "../format.ts";
import { C, FONT, badgeStyle } from "../styles.ts";

/** Gold border of the controlled frame (matches the "self" outline). */
export const CONTROL_GOLD = "#ffd24a";
/** Cyan border of the other party members (matches the "party" outline). */
export const PARTY_CYAN = "#4fd8ff";

/** Frame size on desktop (px) and the compact portrait size. */
export const FRAME_W = 200;
export const FRAME_H = 48;
export const PORTRAIT = 44;

/** Party-frame text for a member: "Brannoc, Warrior, level 9". */
export function frameLabel(m: PartyMemberView): string {
  const parts = [m.name, m.className, `level ${m.level}`];
  if (m.controlled) parts.push("controlled");
  if (m.dead) parts.push("downed");
  if (m.reviving) parts.push(`being revived ${m.reviving.pct}%`);
  return parts.join(", ");
}

/** The frame's border colour: gold when controlled, cyan otherwise. */
export function frameBorder(m: PartyMemberView): string {
  return m.controlled ? CONTROL_GOLD : PARTY_CYAN;
}

/** The action a frame click sends: take control of that member (null when it is already controlled). */
export function controlCall(
  m: PartyMemberView,
): { name: string; payload: { hero: number } } | null {
  return m.controlled ? null : { name: ACTION.partyControl, payload: { hero: m.entity } };
}

/** Hotkey-based text for the frame's button: "F2 takes control" or "" when controlled. */
export function takeControlHint(m: PartyMemberView): string {
  return m.controlled ? "" : `${m.key} takes control`;
}

/** Portrait: the class colour with its initial. Downed members turn grey. */
function Portrait({ m, size }: { m: PartyMemberView; size: number }) {
  const bg = m.dead ? "#3a3733" : hex(m.tint);
  const letter = (m.className || m.classId).charAt(0).toUpperCase();
  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        width: size,
        height: size,
        flex: "none",
        borderRadius: 6,
        background: `linear-gradient(160deg, ${bg}, #120e0a)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff7e0",
        fontWeight: 800,
        fontSize: Math.round(size * 0.46),
        textShadow: "0 1px 2px #000",
        opacity: m.dead ? 0.55 : 1,
        filter: m.dead ? "grayscale(0.9)" : undefined,
      }}
    >
      {letter}
      {m.reviving ? <ReviveRing pct={m.reviving.pct} size={size} /> : null}
      {m.dead ? <DownedMark size={size} /> : null}
    </div>
  );
}

/** Circular progress of a revive in progress (conic gradient, no SVG). */
export function ReviveRing({ pct, size }: { pct: number; size: number }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div
      role="progressbar"
      aria-label="Revive progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 6,
        background: `conic-gradient(${C.ok} ${p * 3.6}deg, rgba(0,0,0,0.5) 0deg)`,
        WebkitMask: "radial-gradient(circle, transparent 55%, #000 56%)",
        mask: "radial-gradient(circle, transparent 55%, #000 56%)",
        opacity: 0.9,
        width: size,
        height: size,
      }}
    />
  );
}

/** A small skull-like cross for downed members. */
function DownedMark({ size }: { size: number }) {
  const s = Math.round(size * 0.5);
  return (
    <svg
      aria-hidden="true"
      width={s}
      height={s}
      viewBox="0 0 16 16"
      style={{ position: "absolute", right: 1, bottom: 1 }}
    >
      <circle cx="8" cy="8" r="7" fill="#1a1613" stroke={C.danger} strokeWidth="1.5" />
      <path d="M5 5 L11 11 M11 5 L5 11" stroke={C.danger} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Thin bar (life or mana) used by both layouts. */
function Bar({ pct, color, height }: { pct: number; color: string; height: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        height,
        borderRadius: height,
        background: "rgba(0,0,0,0.55)",
        overflow: "hidden",
        width: "100%",
      }}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: "100%",
          background: color,
          transition: "width 150ms linear",
        }}
      />
    </div>
  );
}

function Badge({ children, title }: { children: string; title?: string }) {
  return (
    <span
      title={title}
      style={{ ...badgeStyle, padding: "0 5px", fontSize: 10, lineHeight: "16px" }}
    >
      {children}
    </span>
  );
}

const frameBase: CSSProperties = {
  position: "relative",
  pointerEvents: "auto",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: 4,
  textAlign: "left",
  color: C.text,
  font: `12px/1.2 ${FONT}`,
  borderRadius: 8,
  cursor: "pointer",
  background: "rgba(14, 12, 10, 0.9)",
  boxSizing: "border-box",
};

/** One desktop frame (200 x 48). */
function DesktopFrame({ m, onPick }: { m: PartyMemberView; onPick: (m: PartyMemberView) => void }) {
  const border = frameBorder(m);
  const hint = takeControlHint(m);
  return (
    <button
      type="button"
      aria-label={frameLabel(m)}
      aria-pressed={m.controlled}
      title={hint || "Controlled"}
      onClick={() => onPick(m)}
      data-party-frame={m.slot}
      style={{
        ...frameBase,
        width: FRAME_W,
        minHeight: FRAME_H,
        border: `2px solid ${border}`,
        boxShadow: m.controlled ? `0 0 0 1px ${CONTROL_GOLD}55` : "none",
      }}
    >
      <Portrait m={m} size={36} />
      <div style={{ minWidth: 0, flex: 1, display: "grid", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <span
            style={{
              fontWeight: 700,
              color: m.controlled ? C.goldBright : C.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {m.name}
          </span>
          <span style={{ color: C.muted, fontSize: 11, flex: "none" }}>Lv {fmtInt(m.level)}</span>
          {m.unspent > 0 ? <Badge title="Unspent points">{`+${m.unspent}`}</Badge> : null}
          <span style={{ marginLeft: "auto", color: C.faint, fontSize: 10, flex: "none" }}>
            {m.key}
          </span>
        </div>
        <Bar pct={fillPercent(m.life, m.lifeMax)} color={m.dead ? C.faint : C.life} height={5} />
        <Bar pct={fillPercent(m.mana, m.manaMax)} color={C.mana} height={3} />
      </div>
    </button>
  );
}

/** One compact frame: a 44 px portrait with thin bars under it (touch target 44 px). */
function CompactFrame({ m, onPick }: { m: PartyMemberView; onPick: (m: PartyMemberView) => void }) {
  return (
    <button
      type="button"
      aria-label={frameLabel(m)}
      aria-pressed={m.controlled}
      title={takeControlHint(m) || "Controlled"}
      onClick={() => onPick(m)}
      data-party-frame={m.slot}
      style={{
        ...frameBase,
        width: PORTRAIT + 8,
        minWidth: 44,
        minHeight: 44,
        padding: 4,
        flexDirection: "column",
        alignItems: "stretch",
        gap: 2,
        border: `2px solid ${frameBorder(m)}`,
      }}
    >
      <Portrait m={m} size={PORTRAIT} />
      <Bar pct={fillPercent(m.life, m.lifeMax)} color={m.dead ? C.faint : C.life} height={3} />
      <Bar pct={fillPercent(m.mana, m.manaMax)} color={C.mana} height={2} />
    </button>
  );
}

/** Header row: "Party: Auto" toggle and the panel button (phones: the panel button alone). */
function Header({
  party,
  api,
  compact,
}: {
  party: PartyView;
  api: ClassicClientApi;
  compact: boolean;
}) {
  const autoOn = party.partyAuto;
  const toggle = () => api.act(ACTION.setControl, { mode: autoOn ? "manual" : "auto" });
  const panel = () => api.togglePanel("party");
  if (compact) {
    // Phones: one 44 px button. "Party: Auto" lives in the control bar, so the column stays short.
    return (
      <Btn
        label="Open party panel"
        title="Party (P)"
        pressed={autoOn}
        minWidth={44}
        height={44}
        fontSize={11}
        style={{ padding: 0 }}
        onClick={panel}
      >
        Party
      </Btn>
    );
  }
  return (
    <div style={{ display: "flex", gap: 6, pointerEvents: "auto", width: FRAME_W }}>
      <Btn
        label={autoOn ? "Party auto on, switch to manual" : "Party auto off, switch to auto"}
        title="Party: Auto (run every member on the party AI)"
        pressed={autoOn}
        minWidth={0}
        height={44}
        fontSize={12}
        style={{ flex: 1, padding: "0 8px" }}
        onClick={toggle}
      >
        {autoOn ? "Party: Auto" : "Party: Manual"}
      </Btn>
      <Btn
        label="Open party panel"
        title="Party (P)"
        minWidth={44}
        height={44}
        fontSize={12}
        style={{ padding: "0 8px" }}
        onClick={panel}
      >
        Party
      </Btn>
    </div>
  );
}

/** Solo with a free slot: a single button that opens the panel (recruit). */
function AddButton({ api, compact }: { api: ClassicClientApi; compact: boolean }) {
  return (
    <Btn
      label="Add a party member"
      title="Party: recruit a hero (P)"
      minWidth={compact ? 44 : FRAME_W}
      height={44}
      fontSize={12}
      style={{ pointerEvents: "auto" }}
      onClick={() => api.togglePanel("party")}
    >
      {compact ? "+" : "+ Party"}
    </Btn>
  );
}

export function PartyFrames({ api }: SlotProps) {
  const party = useSelect(api.hud, (s) => s.party ?? null);
  const layout = useHudLayout(api);
  const compact = layout !== "desktop";
  if (!party) return null;
  if (party.members.length < 2) {
    if (party.slots < 2) return null;
    return <AddButton api={api} compact={compact} />;
  }
  const pick = (m: PartyMemberView) => {
    const call = controlCall(m);
    if (call) api.act(call.name, call.payload);
  };
  return (
    <div
      role="group"
      aria-label="Party"
      style={{
        display: "flex",
        flexDirection: compact ? "row" : "column",
        flexWrap: compact ? "wrap" : "nowrap",
        gap: compact ? 4 : 6,
        alignItems: "flex-start",
        pointerEvents: "none",
      }}
    >
      <Header party={party} api={api} compact={compact} />
      {party.members.map((m) =>
        compact ? (
          <CompactFrame key={m.entity} m={m} onPick={pick} />
        ) : (
          <DesktopFrame key={m.entity} m={m} onPick={pick} />
        ),
      )}
    </div>
  );
}

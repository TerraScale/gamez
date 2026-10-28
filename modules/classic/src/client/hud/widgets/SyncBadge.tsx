/**
 * Server sync badge of the classic HUD (wave B, docs/design/wave-B.md §2.5 and §8.4). OWNER:
 * T-classic-hud. Small status chip: "Saved", "Saving…", "Offline — playing locally" or "Local
 * game". A tap or click opens a detail popover (verified tick, pending ticks, last correction,
 * imported marker). ClassicHud renders it at the right end of the top row, inside the region
 * that already stops at topRightInset(), so it never covers the minimap column or the toasts.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { LOCAL_SYNC_VIEW, type Store, type SyncView } from "../../contract.ts";
import { clockNow, useSelect } from "../hooks.ts";
import type { SlotProps } from "../common.tsx";
import { buttonStyle, C, panelStyle } from "../styles.ts";

/**
 * Pending ticks below which a live server connection reads "Saved" at x1 (20 Hz: 60 ticks = 3 s
 * of play). The limit scales with the sim speed (savedPendingLimit), so it always means about 3 s
 * of wall time: at x8 the sim makes 160 ticks a second and a healthy segment holds up to 400.
 */
export const SAVED_PENDING_TICKS = 60;

/** The "Saved" limit in ticks at a sim speed (x1, x2, x4, x8; anything else counts as x1). */
export function savedPendingLimit(speed: number): number {
  return SAVED_PENDING_TICKS * (Number.isFinite(speed) && speed > 1 ? speed : 1);
}

export type SyncTone = "ok" | "busy" | "offline" | "local";

export interface SyncLabel {
  tone: SyncTone;
  text: string;
}

/** The badge text for a sync state at a sim speed (pure, tested for every state). */
export function syncLabel(v: SyncView, speed = 1): SyncLabel {
  if (v.mode === "local") return { tone: "local", text: "Local game" };
  if (v.status === "online") {
    return v.pendingTicks < savedPendingLimit(speed)
      ? { tone: "ok", text: "Saved" }
      : { tone: "busy", text: "Saving…" };
  }
  // "offline" and "connecting" both play locally until the socket answers.
  return { tone: "offline", text: "Offline — playing locally" };
}

const TONE_COLOR: Record<SyncTone, string> = {
  ok: C.ok,
  busy: C.gold,
  offline: C.danger,
  local: C.muted,
};

/**
 * Clock of a resync stamp. The stamp is epoch ms when it is larger than 1e11 (Date.now), otherwise
 * the page clock (clockNow). Both are accepted so the badge works with either convention.
 */
export function clockFor(at: number): number {
  return at > 1e11 ? Date.now() : clockNow();
}

/** "just now", "12 s ago", "3 min ago", "2 h ago" (pure). */
export function ageText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

function connectionText(v: SyncView): string {
  if (v.mode === "local") return "No server: progress is kept on this device";
  if (v.status === "online") return "Online: verified by the server";
  if (v.status === "connecting") return "Connecting to the server…";
  return "Offline: progress is kept here and sent when the connection returns";
}

/** The popover's rows (exported for the tests). */
export function SyncDetail({ view }: { view: SyncView }) {
  const row: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12 };
  const resync = view.lastResync;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontWeight: 700, color: C.goldBright }}>Save status</div>
      <div style={{ color: C.muted, fontSize: 12 }}>{connectionText(view)}</div>
      {view.mode === "server" ? (
        <>
          <div style={row}>
            <span style={{ color: C.muted }}>Verified tick</span>
            <span>{view.verifiedTick}</span>
          </div>
          <div style={row}>
            <span style={{ color: C.muted }}>Pending ticks</span>
            <span>{view.pendingTicks}</span>
          </div>
          {view.overflow ? (
            <div style={{ color: C.danger, fontSize: 12 }}>
              Over the limit: local progress past it is replaced by the server&apos;s.
            </div>
          ) : null}
        </>
      ) : null}
      <div style={row}>
        <span style={{ color: C.muted }}>Last correction</span>
        <span style={{ textAlign: "right" }}>
          {resync ? `${resync.code} (${ageText(resync.at, clockFor(resync.at))})` : "None"}
        </span>
      </div>
      {resync ? <div style={{ color: C.muted, fontSize: 12 }}>{resync.message}</div> : null}
      {view.imported ? (
        <div style={{ color: C.muted, fontSize: 12 }}>
          This hero was imported from a local save.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The badge button and its popover, controlled (the widget owns `open`). Pure: the tests and the
 * QA run render it with fixed props.
 */
export function SyncBadgeView({
  view,
  open,
  onToggle,
  speed = 1,
}: {
  view: SyncView;
  open: boolean;
  onToggle: () => void;
  /** Sim speed multiplier (the "Saved" limit is about 3 s of wall time at any speed). */
  speed?: number;
}) {
  const label = syncLabel(view, speed);
  const color = TONE_COLOR[label.tone];
  return (
    <div
      data-testid="sync-badge"
      style={{
        position: "relative",
        marginLeft: "auto",
        display: "inline-flex",
        pointerEvents: "auto",
      }}
    >
      <button
        type="button"
        aria-label={`Sync status: ${label.text}`}
        aria-expanded={open}
        onClick={onToggle}
        style={{
          ...buttonStyle({ minWidth: 44, height: 44, fontSize: 12 }),
          padding: "0 10px",
          gap: 6,
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: 999, background: color, flex: "none" }}
        />
        <span>{label.text}</span>
      </button>
      {open ? (
        <div
          role="status"
          aria-label="Save status details"
          style={{
            ...panelStyle,
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 6,
            width: 260,
            maxWidth: "calc(100vw - 24px)",
            padding: 10,
            zIndex: 3,
            fontSize: 13,
          }}
        >
          <SyncDetail view={view} />
        </div>
      ) : null}
    </div>
  );
}

/** Stands in for api.sync when the mode has no server store (CONTRACT: LOCAL_SYNC_VIEW forever). */
const LOCAL_SYNC_STORE: Store<SyncView> = {
  getSnapshot: () => LOCAL_SYNC_VIEW,
  subscribe: () => () => {},
};

/** The widget: reads api.sync and keeps the popover state. Re-renders once a second while open (ages). */
export function SyncBadge({ api }: SlotProps) {
  const store = api.sync ?? LOCAL_SYNC_STORE;
  const view = useSelect(store, (s) => s);
  const speed = useSelect(api.hud, (s) => s.control?.speed ?? 1);
  const [open, setOpen] = useState(false);
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setAgeTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [open]);
  return (
    <SyncBadgeView view={view} open={open} speed={speed} onToggle={() => setOpen((o) => !o)} />
  );
}

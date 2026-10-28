/** Level up, quest, area, loot and offline toasts. Each expires on its own (ui.toasts). */
import type { Toast } from "../../contract.ts";
import { useSelect, useVisibleUntil } from "../hooks.ts";
import { useCompact, type SlotProps } from "../common.tsx";
import { C, panelStyle } from "../styles.ts";

const KIND_COLOR: Record<Toast["kind"], string> = {
  levelUp: C.goldBright,
  quest: "#7fb4ff",
  loot: "#b388ff",
  area: "#9fe0a8",
  death: C.danger,
  info: C.text,
  offline: "#8fb0c8",
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const visible = useVisibleUntil(toast.until);
  if (!visible) return null;
  return (
    <div
      role="status"
      className="cl-toast"
      style={{
        ...panelStyle,
        padding: "8px 10px",
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        borderLeft: `3px solid ${KIND_COLOR[toast.kind]}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: KIND_COLOR[toast.kind], fontWeight: 700 }}>{toast.title}</div>
        {toast.body ? <div style={{ color: C.muted, fontSize: 12 }}>{toast.body}</div> : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        style={{
          pointerEvents: "auto",
          minWidth: 44,
          minHeight: 44,
          background: "none",
          border: "none",
          color: C.muted,
          font: "inherit",
          fontSize: 18,
          cursor: "pointer",
          marginTop: -8,
          marginRight: -6,
        }}
      >
        ×
      </button>
    </div>
  );
}

export function Toasts({ api }: SlotProps) {
  const toasts = useSelect(api.ui, (u) => u.toasts);
  const compact = useCompact(api);
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      style={{
        position: "absolute",
        right: 8,
        top: compact ? 112 : 190,
        width: compact ? 240 : 280,
        maxWidth: "calc(100% - 16px)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => api.dismissToast(t.id)} />
      ))}
    </div>
  );
}

/** Last rejected action, shown briefly above the bottom bar (ui.error). */
import { useSelect, useVisibleUntil } from "../hooks.ts";
import type { SlotProps } from "../common.tsx";
import { useCompact } from "../common.tsx";
import { C } from "../styles.ts";

export function ErrorFlash({ api }: SlotProps) {
  const error = useSelect(api.ui, (u) => u.error);
  const compact = useCompact(api);
  const visible = useVisibleUntil(error ? error.until : null);
  if (!error || !visible) return null;
  return (
    <div
      role="alert"
      className="cl-flash"
      style={{
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: compact ? 300 : 190,
        maxWidth: "calc(100% - 32px)",
        padding: "8px 14px",
        borderRadius: 8,
        background: "rgba(90, 20, 14, 0.94)",
        border: `1px solid ${C.danger}`,
        color: "#ffd9d0",
        fontWeight: 600,
        pointerEvents: "none",
        textAlign: "center",
      }}
    >
      {error.message}
    </div>
  );
}

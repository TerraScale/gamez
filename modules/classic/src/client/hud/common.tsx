/** Small shared React pieces of the HUD: buttons, progress bars, the panel frame and slot props. */
import type { CSSProperties, ReactNode } from "react";
import type { ClassicClientApi, PanelId } from "../contract.ts";
import { useSelect } from "./hooks.ts";
import { barTrack, buttonStyle, C, panelStyle, titleStyle } from "./styles.ts";

/** Props every HUD slot component receives. */
export interface SlotProps {
  api: ClassicClientApi;
}

export function useCompact(api: ClassicClientApi): boolean {
  return useSelect(api.ui, (u) => u.compact);
}

export interface BtnProps {
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  title?: string;
  label?: string;
  minWidth?: number;
  height?: number;
  fontSize?: number;
  style?: CSSProperties;
  children?: ReactNode;
}

/** A button with a 44 px touch target. */
export function Btn({
  onClick,
  disabled = false,
  pressed,
  title,
  label,
  minWidth,
  height,
  fontSize,
  style,
  children,
}: BtnProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...buttonStyle({ pressed: pressed === true, disabled, minWidth, height, fontSize }),
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function ProgressBar({
  pct,
  color,
  height = 10,
  label,
}: {
  pct: number;
  color: string;
  height?: number;
  label?: string;
}) {
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width)}
      style={{ ...barTrack, height }}
    >
      <div
        style={{
          width: `${width}%`,
          height: "100%",
          background: color,
          transition: "width 150ms linear",
        }}
      />
    </div>
  );
}

/** Frame of every panel: title, close button (44 px) and a scrolling body. Full-screen sheet when compact. */
export function PanelFrame({
  api,
  id,
  title,
  subtitle,
  width = 440,
  children,
}: SlotProps & {
  id: PanelId;
  title: string;
  subtitle?: string;
  width?: number;
  children?: ReactNode;
}) {
  const compact = useCompact(api);
  return (
    <section
      role="dialog"
      aria-label={title}
      style={{
        ...panelStyle,
        display: "flex",
        flexDirection: "column",
        width: compact ? "100%" : width,
        maxWidth: compact ? "100%" : "100%",
        height: compact ? "100%" : undefined,
        maxHeight: compact ? "100%" : "calc(100vh - 220px)",
        minHeight: 0,
        background: compact ? "rgba(14, 12, 10, 0.97)" : C.panel,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "6px 8px 6px 14px",
          borderBottom: `1px solid ${C.border}`,
          flex: "none",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 style={{ ...titleStyle, fontSize: 16 }}>{title}</h2>
          {subtitle ? <div style={{ color: C.muted, fontSize: 12 }}>{subtitle}</div> : null}
        </div>
        <Btn
          label="Close"
          title="Close"
          onClick={() => api.closePanel(id)}
          style={{ fontSize: 18 }}
        >
          ×
        </Btn>
      </header>
      <div style={{ overflowY: "auto", padding: 12, flex: "1 1 auto", minHeight: 0 }}>
        {children}
      </div>
    </section>
  );
}

export function Section({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          color: C.gold,
          fontSize: 12,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

export function Row({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 40,
        flexWrap: "wrap",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

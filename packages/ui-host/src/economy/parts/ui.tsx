/**
 * Presentational parts shared by the economy components. Inline styles from
 * the social palette; every interactive element is at least 44 px high and
 * the layout wraps instead of overflowing at 375 px.
 */
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import type { ItemSummary, VaultItem } from "@gamez/protocol";
import {
  SOCIAL_C,
  SOCIAL_TOUCH,
  errorTextStyle,
  mutedStyle,
  okTextStyle,
  socialButtonStyle,
  socialTabStyle,
} from "../../social/styles.ts";
import { categoryLabel, initials, rarityColor, rarityLabel } from "./text.ts";

export const rowBox: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  flexWrap: "wrap",
  minWidth: 0,
  padding: 8,
  border: `1px solid ${SOCIAL_C.border}`,
  borderRadius: 8,
  background: SOCIAL_C.inner,
  boxSizing: "border-box",
  width: "100%",
};

export const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 0,
  boxSizing: "border-box",
  width: "100%",
};

export const actionsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  minWidth: 0,
  alignItems: "center",
};

export const checkboxLabelStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  minHeight: SOCIAL_TOUCH,
  color: SOCIAL_C.text,
  cursor: "pointer",
};

/** Plain notice box: "ok" | "error" | "info". role=alert for errors. */
export function Banner({ tone, children }: { tone: "ok" | "error" | "info"; children: ReactNode }) {
  const color = tone === "error" ? SOCIAL_C.danger : tone === "ok" ? SOCIAL_C.ok : SOCIAL_C.gold;
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      style={{
        margin: 0,
        padding: "6px 8px",
        borderRadius: 6,
        border: `1px solid ${color}`,
        color,
        fontSize: 12,
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </p>
  );
}

/** Loading, empty and load-error lines for a list. */
export function StateNote({
  kind,
  message,
  onRetry,
}: {
  kind: "loading" | "empty" | "error";
  message: string;
  onRetry?: () => void;
}) {
  if (kind === "error") {
    return (
      <div style={actionsStyle}>
        <p role="alert" style={errorTextStyle}>
          {message}
        </p>
        {onRetry ? (
          <button type="button" onClick={onRetry} style={socialButtonStyle()}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <p role="status" style={mutedStyle}>
      {message}
    </p>
  );
}

/** Rarity-coloured initials badge (no art paths: the logical icon id is the tooltip). */
export function ItemBadge({ summary }: { summary: ItemSummary }) {
  return (
    <span
      aria-hidden="true"
      title={summary.icon}
      style={{
        flex: "0 0 auto",
        width: 36,
        height: 36,
        borderRadius: 6,
        border: `2px solid ${rarityColor(summary.rarity)}`,
        background: SOCIAL_C.field,
        color: rarityColor(summary.rarity),
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: 13,
      }}
    >
      {initials(summary.name)}
    </span>
  );
}

/** Name, rarity, level, category and the tooltip lines of an item. */
export function ItemText({ summary }: { summary: ItemSummary }) {
  return (
    <div
      style={{ minWidth: 0, flex: "1 1 160px", display: "flex", flexDirection: "column", gap: 2 }}
    >
      <strong
        style={{ color: rarityColor(summary.rarity), overflowWrap: "anywhere", fontSize: 14 }}
      >
        {summary.name}
      </strong>
      <span style={mutedStyle}>
        {rarityLabel(summary.rarity)}
        {summary.level > 0 ? ` · level ${summary.level}` : ""} · {categoryLabel(summary.category)}
      </span>
      {summary.lines.length > 0 ? (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", ...mutedStyle }}>
          {summary.lines.map((line, i) => (
            <li key={`${i}-${line}`} style={{ overflowWrap: "anywhere" }}>
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One vault or listing item: badge, text, and the row's actions on the right side. */
export function ItemRow({
  item,
  children,
  label,
}: {
  item: Pick<VaultItem, "summary" | "count">;
  children?: ReactNode;
  label: string;
}) {
  return (
    <li aria-label={label} style={rowBox}>
      <ItemBadge summary={item.summary} />
      <ItemText summary={item.summary} />
      {item.count > 1 ? <span style={mutedStyle}>×{item.count}</span> : null}
      {children ? <div style={actionsStyle}>{children}</div> : null}
    </li>
  );
}

/** Tab strip with arrow-key movement (WAI tabs pattern). */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) onChange(next.id);
  };
  return (
    <div role="tablist" aria-label={label} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => move(e, i)}
          style={socialTabStyle(tab.id === value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Previous/next paging with the offset shown. */
export function Pager({
  offset,
  pageSize,
  count,
  disabled,
  onPage,
}: {
  offset: number;
  pageSize: number;
  count: number;
  disabled: boolean;
  onPage: (offset: number) => void;
}) {
  const from = count === 0 ? 0 : offset + 1;
  const to = offset + count;
  return (
    <nav aria-label="Pages" style={actionsStyle}>
      <button
        type="button"
        disabled={disabled || offset === 0}
        onClick={() => onPage(Math.max(0, offset - pageSize))}
        style={socialButtonStyle({ disabled: disabled || offset === 0 })}
      >
        Previous
      </button>
      <span style={mutedStyle}>
        {from}–{to}
      </span>
      <button
        type="button"
        disabled={disabled || count < pageSize}
        onClick={() => onPage(offset + pageSize)}
        style={socialButtonStyle({ disabled: disabled || count < pageSize })}
      >
        Next
      </button>
    </nav>
  );
}

/** A confirm step shown in place of an action button (buy, shop buy). */
export function ConfirmRow({
  text,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="group" aria-label="Confirm" style={{ ...sectionStyle, gap: 6 }}>
      <p style={{ ...mutedStyle, color: SOCIAL_C.text }}>{text}</p>
      <div style={actionsStyle}>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          style={socialButtonStyle({ primary: true, disabled: busy })}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          style={socialButtonStyle({ disabled: busy })}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/** A labelled input, the label always visible and 44 px tall. */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, width: "100%" }}>
      <span style={{ color: SOCIAL_C.muted, fontSize: 12 }}>{label}</span>
      {children}
      {hint ? <span style={mutedStyle}>{hint}</span> : null}
    </label>
  );
}

export function Success({ children }: { children: ReactNode }) {
  return <p style={okTextStyle}>{children}</p>;
}

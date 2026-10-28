/**
 * Inline style objects for the shared social components. Palette values are
 * copied from the classic HUD look (dark translucent sheets, warm gold accent)
 * so both hosts read as one game. No global CSS is injected: everything here
 * is an inline style object, and focus rings come from the browser default.
 */
import type { CSSProperties } from "react";

export const SOCIAL_C = {
  sheet: "rgba(14, 12, 10, 0.97)",
  inner: "rgba(255, 240, 210, 0.05)",
  border: "rgba(201, 160, 80, 0.40)",
  borderStrong: "rgba(243, 210, 122, 0.85)",
  gold: "#d9ad52",
  goldBright: "#f3d27a",
  text: "#efe6d2",
  muted: "#a99c84",
  faint: "#6d6353",
  danger: "#e0664f",
  ok: "#7fbf6a",
  button: "#2b2219",
  buttonActive: "#5a4220",
  field: "#120e0a",
  own: "rgba(243, 210, 122, 0.14)",
} as const;

export const SOCIAL_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Minimum touch target edge (px), AGENTS.md §10. */
export const SOCIAL_TOUCH = 44;

export const sheetStyle: CSSProperties = {
  background: SOCIAL_C.sheet,
  border: `1px solid ${SOCIAL_C.border}`,
  borderRadius: 10,
  color: SOCIAL_C.text,
  font: `13px/1.35 ${SOCIAL_FONT}`,
  boxSizing: "border-box",
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  overflow: "hidden",
};

export const headingStyle: CSSProperties = {
  color: SOCIAL_C.goldBright,
  fontWeight: 700,
  fontSize: 15,
  margin: 0,
  overflowWrap: "anywhere",
};

export const subheadingStyle: CSSProperties = {
  color: SOCIAL_C.gold,
  fontWeight: 700,
  fontSize: 13,
  margin: "4px 0 0",
};

export const mutedStyle: CSSProperties = {
  color: SOCIAL_C.muted,
  fontSize: 12,
  margin: 0,
  overflowWrap: "anywhere",
};

export const errorTextStyle: CSSProperties = {
  color: SOCIAL_C.danger,
  fontSize: 12,
  margin: 0,
  overflowWrap: "anywhere",
};

export const okTextStyle: CSSProperties = {
  color: SOCIAL_C.ok,
  fontSize: 12,
  margin: 0,
  overflowWrap: "anywhere",
};

export const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  minWidth: 0,
};

export const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minWidth: 0,
};

export const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
  width: "100%",
};

export const fieldLabelStyle: CSSProperties = {
  color: SOCIAL_C.muted,
  fontSize: 12,
};

export const inputStyle: CSSProperties = {
  font: `inherit`,
  color: SOCIAL_C.text,
  background: SOCIAL_C.field,
  border: `1px solid ${SOCIAL_C.border}`,
  borderRadius: 6,
  minHeight: SOCIAL_TOUCH,
  padding: "6px 10px",
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
};

export const badgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  borderRadius: 999,
  background: "rgba(243, 210, 122, 0.16)",
  border: `1px solid ${SOCIAL_C.border}`,
  color: SOCIAL_C.goldBright,
  fontSize: 11,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

export interface SocialButtonLook {
  primary?: boolean;
  danger?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
}

/** Button look: at least 44 px high, gold outline when primary or pressed. */
export function socialButtonStyle({
  primary = false,
  danger = false,
  pressed = false,
  disabled = false,
  fullWidth = false,
}: SocialButtonLook = {}): CSSProperties {
  return {
    font: `600 13px/1 ${SOCIAL_FONT}`,
    color: disabled ? SOCIAL_C.faint : danger ? SOCIAL_C.danger : SOCIAL_C.text,
    background: primary || pressed ? SOCIAL_C.buttonActive : SOCIAL_C.button,
    border: `1px solid ${primary || pressed ? SOCIAL_C.borderStrong : SOCIAL_C.border}`,
    borderRadius: 8,
    minHeight: SOCIAL_TOUCH,
    minWidth: SOCIAL_TOUCH,
    padding: "0 12px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    whiteSpace: "nowrap",
    width: fullWidth ? "100%" : undefined,
    boxSizing: "border-box",
  };
}

/** Tab look for a tablist: selected tab gets the gold underline and bright text. */
export function socialTabStyle(selected: boolean): CSSProperties {
  return {
    font: `600 13px/1 ${SOCIAL_FONT}`,
    color: selected ? SOCIAL_C.goldBright : SOCIAL_C.muted,
    background: selected ? SOCIAL_C.buttonActive : "transparent",
    border: `1px solid ${selected ? SOCIAL_C.borderStrong : SOCIAL_C.border}`,
    borderRadius: 8,
    minHeight: SOCIAL_TOUCH,
    minWidth: SOCIAL_TOUCH,
    padding: "0 10px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
  };
}

/**
 * Look of the classic HUD: dark translucent panels with a warm gold accent
 * (original style). Colours are tokens in one object; widgets use inline style
 * objects, and HUD_CSS is the single injected <style> (keyframes, focus rings,
 * reduced motion, one media query). No CSS file imports.
 */
import type { CSSProperties } from "react";

export const C = {
  panel: "rgba(14, 12, 10, 0.90)",
  /** Panel sheets (PanelFrame): opaque enough that HUD text under them never shows through. */
  panelSolid: "rgba(14, 12, 10, 0.97)",
  panelInner: "rgba(255, 240, 210, 0.05)",
  border: "rgba(201, 160, 80, 0.40)",
  borderStrong: "rgba(243, 210, 122, 0.85)",
  gold: "#d9ad52",
  goldBright: "#f3d27a",
  text: "#efe6d2",
  muted: "#a99c84",
  faint: "#6d6353",
  life: "#c8372d",
  lifeDark: "#3d1210",
  mana: "#2f74d0",
  manaLight: "#8ec2ff",
  manaDark: "#0f2348",
  xp: "#c9a24a",
  danger: "#e0664f",
  ok: "#7fbf6a",
  button: "#2b2219",
  buttonHover: "#3b2e1f",
  buttonActive: "#5a4220",
  slot: "#1b1510",
  disabled: "#4a4337",
  scrim: "rgba(4, 3, 2, 0.66)",
} as const;

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Minimum touch target edge (px). */
export const TOUCH = 44;

export const panelStyle: CSSProperties = {
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  color: C.text,
  font: `13px/1.35 ${FONT}`,
  boxShadow: "0 4px 18px rgba(0, 0, 0, 0.45)",
  pointerEvents: "auto",
};

export const labelStyle: CSSProperties = {
  color: C.muted,
  fontSize: 12,
};

export const titleStyle: CSSProperties = {
  color: C.goldBright,
  fontWeight: 700,
  margin: 0,
};

export interface ButtonLook {
  pressed?: boolean;
  disabled?: boolean;
  minWidth?: number;
  height?: number;
  fontSize?: number;
}

/** Button look: 44 px touch target by default, gold ring when pressed. */
export function buttonStyle({
  pressed = false,
  disabled = false,
  minWidth = TOUCH,
  height = TOUCH,
  fontSize = 13,
}: ButtonLook = {}): CSSProperties {
  return {
    pointerEvents: "auto",
    font: `600 ${fontSize}px/1 ${FONT}`,
    color: disabled ? C.faint : C.text,
    background: pressed ? C.buttonActive : C.button,
    border: `1px solid ${pressed ? C.borderStrong : C.border}`,
    borderRadius: 8,
    minWidth,
    minHeight: height,
    padding: "0 12px",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    whiteSpace: "nowrap",
  };
}

export const badgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  background: "rgba(243, 210, 122, 0.16)",
  border: `1px solid ${C.border}`,
  color: C.goldBright,
  fontSize: 11,
  fontWeight: 700,
};

export const barTrack: CSSProperties = {
  position: "relative",
  height: 10,
  borderRadius: 5,
  background: "rgba(0, 0, 0, 0.55)",
  border: `1px solid ${C.border}`,
  overflow: "hidden",
};

/** Injected once by ClassicHud. Scoped under .cl-hud so it never leaks into the app shell. */
export const HUD_CSS = `
.cl-hud, .cl-hud * { box-sizing: border-box; }
.cl-hud button { font-family: inherit; }
.cl-hud button:not(:disabled):hover { filter: brightness(1.18); }
.cl-hud button:disabled { cursor: default; }
.cl-hud button:focus-visible, .cl-hud input:focus-visible, .cl-hud select:focus-visible {
  outline: 2px solid ${C.goldBright}; outline-offset: 2px;
}
.cl-hud input[type="number"], .cl-hud input[type="text"], .cl-hud select {
  font: inherit; color: ${C.text}; background: #120e0a; border: 1px solid ${C.border};
  border-radius: 6px; min-height: 44px; padding: 4px 8px;
}
.cl-hud ::-webkit-scrollbar { width: 8px; height: 8px; }
.cl-hud ::-webkit-scrollbar-thumb { background: rgba(201, 160, 80, 0.35); border-radius: 4px; }
@keyframes cl-flash { from { opacity: 0; transform: translate(-50%, -6px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes cl-toast { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes cl-glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(243, 210, 122, 0); } 50% { box-shadow: 0 0 0 4px rgba(243, 210, 122, 0.35); } }
@keyframes cl-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
.cl-hud .cl-glow { animation: cl-glow 1.4s ease-in-out infinite; }
.cl-hud .cl-toast { animation: cl-toast 220ms ease-out; }
.cl-hud .cl-flash { animation: cl-flash 180ms ease-out; }
.cl-hud .cl-rise { animation: cl-rise 260ms ease-out; }
@media (max-width: 699px) {
  .cl-hud .cl-hide-compact { display: none !important; }
}
@media (prefers-reduced-motion: reduce) {
  .cl-hud *, .cl-hud *::before, .cl-hud *::after { animation: none !important; transition: none !important; }
}
`;

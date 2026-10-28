/**
 * Onboarding tip card (overlay slot): the one due tip, a non-blocking card above the bottom bar
 * that is hidden while a panel is open, while toasts take its place on phones, and when Settings
 * turns tips off. "Got it" and × both remember the dismissal (tips/store.ts).
 */
import { useSyncExternalStore } from "react";
import { TIPS, pickTip, tipFacts, tipsStore } from "../../tips/index.ts";
import { useSelect, useVisibleUntil } from "../hooks.ts";
import { Btn, Row, useHudInsets, useHudLayout, type SlotProps } from "../common.tsx";
import { tipLayout } from "../layout.ts";
import { C, panelStyle } from "../styles.ts";

// Stable references (useSyncExternalStore re-subscribes when they change).
const subscribeTips = (onChange: () => void) => tipsStore.subscribe(onChange);
const readDismissed = () => tipsStore.dismissed();

export function Tips({ api }: SlotProps) {
  const facts = useSelect(api.hud, tipFacts);
  const enabled = useSelect(api.ui, (u) => u.settings.tips);
  const panels = useSelect(api.ui, (u) => u.panels);
  const latestToast = useSelect(api.ui, (u) => u.toasts.reduce((m, t) => Math.max(m, t.until), 0));
  const toastShown = useVisibleUntil(latestToast);
  const dismissed = useSyncExternalStore(subscribeTips, readDismissed, readDismissed);
  const layout = useHudLayout(api);
  const insets = useHudInsets();
  const id = pickTip(facts, { enabled, panels, dismissed });
  const placement = tipLayout(layout, insets.bottom, panels.length > 0, toastShown);
  if (id === null || placement === null) return null;
  const tip = TIPS[id];
  return (
    <div
      role="note"
      aria-label={`Tip: ${tip.title}`}
      className="cl-rise"
      style={{ ...placement, zIndex: 1, pointerEvents: "none" }}
    >
      <div
        style={{
          ...panelStyle,
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          padding: "6px 6px 8px 12px",
          borderLeft: `3px solid ${C.goldBright}`,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: C.goldBright, fontWeight: 700 }}>{tip.title}</div>
          <div style={{ color: C.text, fontSize: 12, marginTop: 2 }}>{tip.body}</div>
          <Row style={{ justifyContent: "flex-end", marginTop: 4, minHeight: 0 }}>
            <Btn
              label={`Got it: ${tip.title}`}
              minWidth={88}
              height={44}
              onClick={() => tipsStore.dismiss(id)}
            >
              Got it
            </Btn>
          </Row>
        </div>
        <Btn
          label="Dismiss tip"
          title="Dismiss tip"
          minWidth={44}
          height={44}
          fontSize={18}
          onClick={() => tipsStore.dismiss(id)}
        >
          ×
        </Btn>
      </div>
    </div>
  );
}

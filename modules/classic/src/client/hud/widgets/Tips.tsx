/**
 * Onboarding tip card (overlay slot): the one due tip, a non-blocking card that sits in a corner or
 * under the top region, never over the playfield centre. It is hidden while a panel is open, while
 * toasts take its place on phones, and when Settings turns tips off. It goes away after the action
 * that answers it (tipsSatisfied), after TIP_TIMEOUT_MS on screen, or on "Got it" / ×. Every
 * dismissal is remembered (tips/store.ts).
 */
import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import {
  TIP_TIMEOUT_MS,
  TIPS,
  pickTip,
  tipFacts,
  tipsSatisfied,
  tipsStore,
  type TipFacts,
} from "../../tips/index.ts";
import { useSelect, useVisibleUntil } from "../hooks.ts";
import { Btn, Row, useHudInsets, useHudLayout, type SlotProps } from "../common.tsx";
import { tipLayout } from "../layout.ts";
import { C, panelStyle } from "../styles.ts";
import { deathInfoOf } from "./DeathScreen.tsx";

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
  // The party's "<Name> is down" banner (DeathScreen) takes the top band on phones; the tip waits.
  const downed = useSelect(api.hud, deathInfoOf);
  const downedBannerShown = downed !== null && downed.standingKey !== "";
  const id = pickTip(facts, { enabled, panels, dismissed });
  const placement = tipLayout(layout, insets, panels.length > 0, toastShown, downedBannerShown);

  // Actions that answer a tip (a walk, a spent point, the panel it names) dismiss it for good.
  const prevFacts = useRef<TipFacts | null>(null);
  useEffect(() => {
    const prev = prevFacts.current;
    prevFacts.current = facts;
    for (const done of tipsSatisfied(prev, facts, panels)) tipsStore.dismiss(done);
  }, [facts, panels]);

  // A shown tip goes after TIP_TIMEOUT_MS on screen. Only visible time counts: a card hidden by a
  // panel or a phone toast is not timed, and the timer restarts when the card shows again.
  const shownId = placement === null ? null : id;
  useEffect(() => {
    if (shownId === null) return;
    const timer = setTimeout(() => tipsStore.dismiss(shownId), TIP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [shownId]);

  if (id === null || placement === null) return null;
  const tip = TIPS[id];
  const inline = layout === "compact";
  const gotIt = (style?: CSSProperties) => (
    <Btn
      label={`Got it: ${tip.title}`}
      minWidth={88}
      height={44}
      style={style}
      onClick={() => tipsStore.dismiss(id)}
    >
      Got it
    </Btn>
  );
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
          padding: "6px 6px 8px 12px",
          borderLeft: `3px solid ${C.goldBright}`,
        }}
      >
        {/* The × floats top-right, so the text wraps under it and the card stays short. On phone
            portrait (a full-width strip under the top region) "Got it" floats beside it too. */}
        <Btn
          label="Dismiss tip"
          title="Dismiss tip"
          minWidth={44}
          height={44}
          fontSize={18}
          style={{ float: "right", marginLeft: 8 }}
          onClick={() => tipsStore.dismiss(id)}
        >
          ×
        </Btn>
        {inline ? gotIt({ float: "right", marginLeft: 8 }) : null}
        <div style={{ color: C.goldBright, fontWeight: 700 }}>{tip.title}</div>
        <div style={{ color: C.text, fontSize: 12, marginTop: 2 }}>{tip.body}</div>
        {inline ? (
          <div style={{ clear: "both" }} />
        ) : (
          <Row style={{ clear: "both", justifyContent: "flex-end", marginTop: 4, minHeight: 0 }}>
            {gotIt()}
          </Row>
        )}
      </div>
    </div>
  );
}

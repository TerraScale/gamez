/**
 * "Trade with <name>" bubble over the bottom bar, opened by a tap on a remote hero
 * (wave C, docs/design/wave-C.md §10.4). OWNER: T-classic-ui. The state lives in
 * presence/bubble.ts; this widget only renders it and opens the trade screen.
 * Hidden without api.openScreen (offline) or without a bubble.
 */
import { useSyncExternalStore } from "react";
import type { PlatformScreen } from "@gamez/ui-host";
import type { ClassicClientApi } from "../../contract.ts";
import {
  clearTradeBubble,
  getTradeBubble,
  subscribeTradeBubble,
  type TradeBubble,
} from "../../presence/bubble.ts";
import { Btn } from "../common.tsx";
import { bottomBarInset, HUD_EDGE, type HudInsets, type HudLayout } from "../layout.ts";
import { C, panelStyle } from "../styles.ts";

/** Button text of the bubble. */
export function tradeLabel(displayName: string): string {
  return `Trade with ${displayName}`;
}

/** The shell screen the bubble opens (picker when the account id is unknown). */
export function tradeScreen(b: TradeBubble): PlatformScreen {
  return { id: "trade", with: { accountId: b.accountId, displayName: b.displayName } };
}

export function PresenceBubble({
  api,
  insets,
  layout,
}: {
  api: ClassicClientApi;
  insets: HudInsets;
  layout: HudLayout;
}) {
  const bubble = useSyncExternalStore(subscribeTradeBubble, getTradeBubble, getTradeBubble);
  if (!bubble || !api.openScreen) return null;
  return (
    <div
      role="status"
      aria-label="Player"
      style={{
        ...panelStyle,
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: bottomBarInset(layout, insets.bottom) + HUD_EDGE + 48,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: 6,
        maxWidth: "calc(100% - 24px)",
        pointerEvents: "auto",
        zIndex: 3,
        background: C.panelSolid,
      }}
    >
      <Btn
        label={tradeLabel(bubble.displayName)}
        title={tradeLabel(bubble.displayName)}
        minWidth={44}
        height={44}
        onClick={() => {
          clearTradeBubble();
          api.openScreen?.(tradeScreen(bubble));
        }}
      >
        {tradeLabel(bubble.displayName)}
      </Btn>
      <Btn
        label="Close player menu"
        title="Close"
        minWidth={44}
        height={44}
        onClick={clearTradeBubble}
      >
        ×
      </Btn>
    </div>
  );
}

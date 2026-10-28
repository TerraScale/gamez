/**
 * Shared economy React UI (wave C, docs/design/wave-C.md §10.2). OWNER:
 * T-econ-ui. Same rules as ../social: only PlatformServices interfaces,
 * inline styles in the classic HUD palette (reuse ../social/styles.ts), 375 px,
 * 44 px targets, keyboard accessible, states loading/empty/error/data.
 * The props below are the CONTRACT; the shell (T-shell) and the classic HUD
 * (T-classic-ui) render these components.
 */
import type { ItemCategory, Notice } from "@gamez/protocol";
import type { AccountApi, MarketApi, ShopsApi, TradeApi, VaultApi } from "../platform.ts";

export interface VaultViewProps {
  vault: VaultApi;
  account: AccountApi;
  /**
   * Optional bank actions of the running mode (classic: deposit from the hero /
   * withdraw to the hero). Absent = read-only vault (picker).
   */
  bank?: {
    /** Why the bank is unavailable right now ("Walk to town"), or null. */
    blocked: string | null;
    withdrawItem(uid: string): Promise<{ ok: boolean; message?: string }>;
    withdrawCoin(coin: number): Promise<{ ok: boolean; message?: string }>;
  };
  /** "Sell on market" from a vault row (opens MarketView's sell form). */
  onSell?: (uid: string) => void;
  compact?: boolean;
}

export interface MarketViewProps {
  market: MarketApi;
  vault: VaultApi;
  account: AccountApi;
  selfId: string;
  /** Guests browse only (writes need an account): shows a "create an account" hint. */
  canTrade: boolean;
  initialCategory?: ItemCategory;
  initialQuery?: string;
  /** Preselects a vault item in the sell tab. */
  sellUid?: string;
  compact?: boolean;
}

export interface TradeWindowProps {
  trade: TradeApi;
  vault: VaultApi;
  account: AccountApi;
  selfId: string;
  canTrade: boolean;
  /** Open (or resume) a trade with this player… */
  with?: { accountId: string; displayName: string };
  /** …or show this existing trade. */
  tradeId?: string;
  /** Poll interval while open (default 1000 ms). */
  pollMs?: number;
  onClose: () => void;
}

export interface PlotsViewProps {
  shops: ShopsApi;
  account: AccountApi;
  world: string;
  selfId: string;
  canTrade: boolean;
  onOpenShop: (plotId: string) => void;
}

export interface ShopViewProps {
  shops: ShopsApi;
  vault: VaultApi;
  account: AccountApi;
  world: string;
  plotId: string;
  selfId: string;
  canTrade: boolean;
  onClose: () => void;
}

export interface NoticesViewProps {
  vault: VaultApi;
  /** Notice link handler (trade invite -> trade screen, sale -> market…). */
  onOpen?: (notice: Notice) => void;
}

export { VaultView } from "./VaultView.tsx";
export { MarketView } from "./MarketView.tsx";
export { TradeWindow } from "./TradeWindow.tsx";
export { PlotsView } from "./PlotsView.tsx";
export { ShopView } from "./ShopView.tsx";
export { NoticesView } from "./NoticesView.tsx";

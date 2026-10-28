/**
 * Shared play/monetisation React UI (wave C, docs/design/wave-C.md §10.3).
 * BattlePassView: OWNER T-pass. StoreView: OWNER T-pay. Same rules as ../social.
 * (The arena screen lives in @gamez/mode-arena/client: it replays fights with the arena sim.)
 */
import type { AccountApi, PassApi, StoreApi } from "../platform.ts";

export interface BattlePassViewProps {
  pass: PassApi;
  account: AccountApi;
  /** "Get premium" -> the store screen. */
  onBuyPremium?: () => void;
  /** Registered accounts may unlock premium with gems (guests cannot spend). */
  canSpendGems?: boolean;
  compact?: boolean;
}

export interface StoreViewProps {
  store: StoreApi;
  account: AccountApi;
  /** ISO country for provider routing (from navigator.language region), optional. */
  country?: string;
  /** Called with the checkout URL; the shell navigates (location.assign). */
  onCheckout: (url: string) => void;
  canBuy: boolean;
}

export { BattlePassView } from "./BattlePassView.tsx";
export { StoreView } from "./StoreView.tsx";

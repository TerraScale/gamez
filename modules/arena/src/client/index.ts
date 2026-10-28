/**
 * Arena client (OWNER: T-arena-sim): the ArenaScreen the app shell shows for
 * the "arena" platform screen (status, ladder, fight button, recent matches)
 * and ArenaReplay (plays an ArenaMatch back by re-running fight() with
 * frames; falls back to the result text when contentHash differs).
 */
import type { ArenaMatch } from "@gamez/protocol";
import type { PlatformServices } from "@gamez/ui-host";

export interface ArenaScreenProps {
  platform: PlatformServices;
  /** Signed-in account id (to mark "you" in the ladder). */
  accountId: string;
  /** Source mode of the builds (default "classic"). */
  mode?: string;
  /** Logical art base for hero sprites (optional; the DOM avatars need none). */
  assetBaseUrl?: string;
  onClose: () => void;
  /** Inside a host sheet that already shows the title and Close: hide our own header. */
  embedded?: boolean;
}

export interface ArenaReplayProps {
  match: ArenaMatch;
  /** The viewer's account id: decides which fighter is "you". */
  viewerId: string;
  onDone?: () => void;
}

export { ArenaScreen } from "./ArenaScreen.tsx";
export { ArenaReplay } from "./ArenaReplay.tsx";
export {
  ArenaView,
  type ArenaViewProps,
  type Load,
  type FightState,
  type ArenaTab,
} from "./ArenaView.tsx";
export {
  planReplay,
  ticketStep,
  viewerOutcome,
  viewerSide,
  failureText,
  opponentOf,
  classLabel,
  classColour,
  isYou,
  resultLine,
  newArenaOpId,
  POLL_MS,
  MAX_POLLS,
  type ReplayPlan,
  type TicketStep,
  type ViewerSide,
} from "./model.ts";

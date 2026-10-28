/**
 * Client-side mode views, keyed by mode id. A mode in the catalog without an
 * entry here shows as "not available" in the picker.
 */
import { classicView } from "@gamez/mode-classic/client";
import { duelView } from "@gamez/mode-duel/client";
import { stepsView } from "@gamez/mode-steps/client";
import type { ClientModeView } from "@gamez/ui-host";
import { classicMode } from "./classic.ts";

export { classicInfo } from "./classic.ts";

export const CLIENT_MODE_VIEWS: readonly ClientModeView[] = [
  classicView,
  duelView,
  stepsView,
  classicMode,
];

const byId = new Map(CLIENT_MODE_VIEWS.map((view) => [view.modeId, view]));

export function findModeView(modeId: string): ClientModeView | undefined {
  return byId.get(modeId);
}

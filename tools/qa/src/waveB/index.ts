/**
 * Wave B browser QA scenarios (docs/design/wave-B.md §11). CONTRACT
 * (architect): one file per owner; this index only aggregates.
 *
 *   app.ts            account, social             T-app-shell
 *   classicServer.ts  classic-server, classic-legacy  T-classic-sync
 *   classicTown.ts    classic-town                T-classic-presence
 *   classicSocial.ts  classic-social              T-classic-hud
 *
 * Runners get the harness Run (../run.ts) and may use its exported helpers
 * (openPicker, pickMode, startClassic, classArg). Only call them inside the
 * runner (run.ts imports this file before it finishes evaluating).
 */
import type { Run } from "../run.ts";
import { APP_RUNNERS } from "./app.ts";
import { CLASSIC_SERVER_RUNNERS } from "./classicServer.ts";
import { CLASSIC_SOCIAL_RUNNERS } from "./classicSocial.ts";
import { CLASSIC_TOWN_RUNNERS } from "./classicTown.ts";

export type Runner = (run: Run) => Promise<void>;

export const WAVE_B_RUNNERS: Record<string, Runner> = {
  ...APP_RUNNERS,
  ...CLASSIC_SERVER_RUNNERS,
  ...CLASSIC_TOWN_RUNNERS,
  ...CLASSIC_SOCIAL_RUNNERS,
};

/**
 * Wave C browser QA scenarios (docs/design/wave-C.md §12). CONTRACT
 * (architect): one file per owner; this index only aggregates.
 *
 *   shell.ts    economy-shell …                       T-shell
 *   classic.ts  classic-bank, classic-market-street…  T-classic-ui
 *   arena.ts    arena                                 T-arena-sim
 *   admin.ts    admin                                 T-admin
 *   pwa.ts      pwa                                   T-ship
 */
import type { Run } from "../run.ts";
import { ADMIN_RUNNERS } from "./admin.ts";
import { ARENA_RUNNERS } from "./arena.ts";
import { CLASSIC_C_RUNNERS } from "./classic.ts";
import { PWA_RUNNERS } from "./pwa.ts";
import { SHELL_RUNNERS } from "./shell.ts";

export type Runner = (run: Run) => Promise<void>;

export const WAVE_C_RUNNERS: Record<string, Runner> = {
  ...SHELL_RUNNERS,
  ...CLASSIC_C_RUNNERS,
  ...ARENA_RUNNERS,
  ...ADMIN_RUNNERS,
  ...PWA_RUNNERS,
};

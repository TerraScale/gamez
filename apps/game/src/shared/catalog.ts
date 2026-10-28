/**
 * The game's module catalog and modes, shared by client and server so both
 * load identical modules (same kernel contentHash). A new mode package adds
 * its `modules` to MODULE_CATALOG and its `mode` to MODES.
 */
import type { ModeSpec, ModuleSpec } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";
import * as duel from "@gamez/mode-duel";
import * as steps from "@gamez/mode-steps";

export const MODULE_CATALOG: readonly ModuleSpec[] = [
  ...classic.modules,
  ...duel.modules,
  ...steps.modules,
];

export const MODES: readonly ModeSpec[] = [classic.mode, duel.mode, steps.mode];

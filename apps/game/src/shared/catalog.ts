/**
 * The game's module catalog and modes, shared by client and server so both
 * load identical modules (same kernel contentHash).
 *
 * TODO(phase1): add the "duel" and "steps" mode packages here once they exist:
 *   import * as duel from "@gamez/mode-duel";
 *   import * as steps from "@gamez/mode-steps";
 */
import type { ModeSpec, ModuleSpec } from "@gamez/kernel";

export const MODULE_CATALOG: readonly ModuleSpec[] = [];

export const MODES: readonly ModeSpec[] = [];

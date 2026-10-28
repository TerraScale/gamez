/**
 * Arena constants (OWNER: T-arena-sim). Kept in their own file so that core.ts
 * and mode.ts can both read them without an import cycle.
 */

/** Fixed tick rate of the arena sim (10 Hz). */
export const ARENA_HZ = 10;
/** 60 s cap. At the cap the higher remaining hp percent wins; equal => draw. */
export const ARENA_MAX_TICKS = 600;
/** Lane length in tenths of a tile (0..200 = 0..20 tiles). */
export const ARENA_LANE_MAX = 200;
/** Start positions in tenths of a tile. */
export const ARENA_START_ATTACKER = 40;
export const ARENA_START_DEFENDER = 160;
/** Basic attack reach in tenths of a tile (1 tile). */
export const BASIC_REACH = 10;
/** Crit damage multiplier in percent (150 = x1.5). */
export const CRIT_MULT_PCT = 150;
/** Shield decay: 5 % of the remaining shield per second, i.e. per 10 ticks. */
export const SHIELD_DECAY_PERMILLE_PER_TICK = 5;
/** Most skills an arena build keeps (ArenaBuild.skills is 0..4). */
export const ARENA_MAX_SKILLS = 4;
/** Basic attacks use 100 % of the weapon damage. */
export const BASIC_POWER = 100;

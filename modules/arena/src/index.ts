/**
 * The "arena" mode (wave C, docs/design/wave-C.md §6): deterministic
 * auto-battles between two ArenaBuilds (async PvP against ghost copies of
 * other players). OWNER: T-arena-sim. CONTRACT (architect): the exports below
 * and their semantics; the module internals are the owner's.
 *
 * The ArenaDO (server) calls fight() to resolve a match and stores
 * {seed, builds, winner, ticks, contentHash}; the client calls the very same
 * fight() to replay it (ArenaReplay in ./client). Same seed + builds => same
 * hash on every engine (AGENTS.md §6).
 *
 * Not listed in the mode picker (shared/catalog.ts MODES): it has no
 * player input. `mode.world` is null, fixed tick ARENA_HZ, no actions needed.
 */
export * from "./mode.ts";
export { fight, arenaLoaded, type ArenaFightResult, type ArenaFrame } from "./fight.ts";
export { clampBuild, clampInt, type ClampedBuild, type SkillInit } from "./model.ts";
export { strikeDamage, decayShield, basicInterval, hpPercent } from "./combat.ts";

/**
 * Pure integer combat math of the arena (wave-C.md §6.1). OWNER: T-arena-sim.
 * No rng, no world: the core system feeds the rolls in, tests check the maths.
 */
import { CRIT_MULT_PCT, SHIELD_DECAY_PERMILLE_PER_TICK } from "./constants.ts";

/** Ticks between basic attacks for an attack rate (attacks per 10 s = 100 ticks). */
export function basicInterval(attackRate: number): number {
  return Math.round(100 / Math.max(1, attackRate));
}

/**
 * Damage that lands on the target. `roll` is the weapon roll in
 * [dmgMin, dmgMax]; `power` is percent (100 for a basic attack).
 *   raw       = roll x power %, crit x1.5 when `crit`
 *   mitigated = raw x 100 / (100 + armor)
 *   after     = max(1, mitigated x (100 - resist) / 100)
 * All steps floor, so the result is a non-negative integer and at least 1.
 */
export function strikeDamage(
  roll: number,
  power: number,
  crit: boolean,
  armor: number,
  resist: number,
): number {
  let raw = Math.floor((roll * power) / 100);
  if (crit) raw = Math.floor((raw * CRIT_MULT_PCT) / 100);
  const mitigated = Math.floor((raw * 100) / (100 + armor));
  return Math.max(1, Math.floor((mitigated * (100 - resist)) / 100));
}

/** Percent of max hp as an integer (heal and shield amounts). */
export function percentOf(maxHp: number, pct: number): number {
  return Math.floor((maxHp * pct) / 100);
}

/**
 * Shield after one tick of decay: 5 % per second, i.e. 0.5 % per tick at
 * 10 Hz, rounded up so small shields still run out (at least 1 point a tick).
 */
export function decayShield(shield: number): number {
  if (shield <= 0) return 0;
  const drop = Math.max(1, Math.ceil((shield * SHIELD_DECAY_PERMILLE_PER_TICK) / 1000));
  return Math.max(0, shield - drop);
}

/** Integer hp percent (floor), used by the tick-cap rule. */
export function hpPercent(hp: number, maxHp: number): number {
  return Math.floor((Math.max(0, hp) * 100) / Math.max(1, maxHp));
}

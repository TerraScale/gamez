/**
 * Load-aware timing budgets for perf tests (docs/design/party.md §12).
 *
 * The dev box is shared and the full suite runs every core at once, so a
 * fixed millisecond bound either flakes or is too loose to catch anything.
 * loadScale() times a fixed CPU reference workload (object reads, copies, a
 * sort: the same kind of work as a sim tick) right now and divides it by
 * what the same workload takes on the idle dev box. A budget times that
 * factor (never below 1) follows the machine's current speed: on a quiet
 * box the bound is the plain budget, and under load it grows with the
 * measured slowdown instead of a guess.
 *
 * Measured on the dev box (46 cores): reference 5.0 ms idle, 12-16 ms with
 * 50 busy processes; the 4-hero party scenario went from 1.8 to 3.3 ms in the
 * same conditions, so the reference slows down at least as much as a tick.
 */

/** Best reference time (ms) on the idle dev box. */
export const REFERENCE_IDLE_MS = 5.0;

function workload(): number {
  const m = new Map<number, { x: number; y: number; tag: string }>();
  for (let i = 0; i < 4000; i++) m.set(i, { x: i, y: i * 2, tag: i % 3 === 0 ? "a" : "b" });
  let acc = 0;
  for (let r = 0; r < 40; r++) {
    const out: number[] = [];
    for (const [k, v] of m) {
      const c = { x: v.x, y: v.y, tag: v.tag };
      acc = (acc + (c.x ^ (c.y + r))) | 0;
      if (c.tag === "a") out.push(k);
    }
    out.sort((a, b) => b - a);
    acc = (acc + out.length) | 0;
  }
  return acc;
}

/** The machine's current slowdown versus the idle dev box (>= 1). */
export function loadScale(): number {
  workload();
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    workload();
    best = Math.min(best, performance.now() - t0);
  }
  return Math.max(1, best / REFERENCE_IDLE_MS);
}

/** `budgetMs` x `slack` x the current load scale; also returns the scale for logging. */
export function perfBudget(budgetMs: number, slack: number): { limit: number; scale: number } {
  const scale = loadScale();
  return { limit: budgetMs * slack * scale, scale };
}

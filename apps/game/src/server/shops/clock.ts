/**
 * Clock of the shop logic classes (wave-C.md §5). Real time in the DOs; tests
 * pass a fake. PlotBook adds its persisted dev offset on top (devAdvance).
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

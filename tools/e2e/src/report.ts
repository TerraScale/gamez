/** PASS/FAIL lines and measured timings shared by every e2e section. */

export const timings: Record<string, number> = {};

let failures = 0;

export function check(ok: boolean, what: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
}

/** Counts a failure that is not a check (an exception that ended the run). */
export function fail(what: string): void {
  failures++;
  console.log(`FAIL  ${what}`);
}

export function failureCount(): number {
  return failures;
}

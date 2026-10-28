/**
 * Wave B e2e features (docs/design/wave-B.md §10). CONTRACT (architect).
 * e2e.ts runs every feature's run() after the phase-0/1 checks (before the
 * dev-server restart) and afterRestart() after it. Each feature lives in its
 * own file, owned by the task that builds the feature; use check()/fail()
 * from report.ts and put shared state for afterRestart in ctx.state.
 *
 * A feature must never throw for a failed expectation (use check), only for
 * a broken harness; e2e.ts catches a throw and counts it as one failure.
 * Keep each feature under ~30 s.
 */
import type { Guest } from "./client.ts";
import type { LocalD1 } from "./local-d1.ts";
import { accountFeature } from "./account.ts";
import { authFeature } from "./auth.ts";
import { chatFeature } from "./chat.ts";
import { classicPresenceFeature } from "./classic-presence.ts";
import { classicVerifyFeature } from "./classic-verify.ts";
import { guildsFeature } from "./guilds.ts";
import { leaderboardsFeature } from "./leaderboards.ts";

export interface E2eContext {
  /** Dev server base URL (changes port never, but re-read after restart). */
  url: string;
  db: LocalD1;
  /** Two fresh guests created for wave B features. */
  guestA: Guest;
  guestB: Guest;
  /** Feature-private state carried from run() to afterRestart(); key by feature name. */
  state: Map<string, unknown>;
}

export interface E2eFeature {
  name: string;
  run(ctx: E2eContext): Promise<void>;
  afterRestart?(ctx: E2eContext): Promise<void>;
}

/** Order matters: auth first (others may register accounts), leaderboards after classic-verify. */
export const FEATURES: readonly E2eFeature[] = [
  authFeature,
  classicVerifyFeature,
  leaderboardsFeature,
  chatFeature,
  guildsFeature,
  accountFeature,
  classicPresenceFeature,
];

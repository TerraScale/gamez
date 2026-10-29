# ADR 0008: Offline/idle progress pays a share of the measured online rate

- Status: accepted (offline/idle workflow, integration pass)
- Date: 2026-10-28

The contract is [`docs/design/offline-idle.md`](../design/offline-idle.md). This ADR records the
decisions taken there and the ones changed when the work was integrated.

## 1. The measured online Idle rate is the reference

`classic.auto.rate` measures kills, kill XP, ground gold and upkeep (potions, scrolls, repairs) on
verified Auto/Idle ticks, in a decaying 30-minute window. An absence pays `xpPct` of that XP rate
(default 20 %), with gold and items at 100 % of the net rate. Kills (quest credit) are not scaled.
Deaths, wear and potion drinking are not modelled offline; their gold cost is in upkeep.

The second pass floored the rate's XP at the fallback model, because the window trails a hero that
is still levelling. **The integration pass dropped that floor.** The requirement tests showed the
floor winning almost everywhere and paying 1.9–3.75× the requirement (0.38–0.75 of online XP at
"20 %"). The model overpays at the depth-3 waypoint. Paying the trailing rate errs on the safe
side: an absence never pays more than the stated share of what the player saw online. The model is
used only as the fallback, for heroes with under 5 minutes of measured play, and as a × 3 sanity
cap. Calibration data is in design §4.3.

## 2. The admin factor travels in the payload

The XP share is the admin tunable `classic.offlineXpPct` (ConfigDO, 0..100, 10 s cache). The
verified host reads the live tunables right before a grant and passes the effective value in the
server-only action's payload (`{ elapsedMs, xpPct }`). The grant is compacted into the base at once
and is never replayed from a client, so replay stays deterministic. Local play uses the balance
default. The e2e test sets 50 through the admin API and checks that the server's grant is
byte-identical (same hash) to the bot's own `{ xpPct: 50 }` dispatch on its verified state.

## 3. The server measures every absence, including a frozen page

Time away is `now − lastActiveAt` on the server clock. `lastActiveAt` moves only on verified sim
progress, grants, new games and imports, and never on socket close. The integration pass adds one
rule (design §5.6). A segment that verifies after a silence of at least `minMs` on a live socket
counts that silence, minus the segment's own play time, as an absence. The deferred grant pays it
at once. This covers a page frozen in the background that resumes and sends a queued segment
before it rejoins; before this rule, the speed credit absorbed that absence. The silence is
measured from the later of the last progress and the last join, so a short absence followed by a
little play cannot add up to a grant.

## 4. The same-tick guard is local-only

The sim rejects a second offline grant on the same tick (`offline_twice`). That protects local
play against a double dispatch. The server's actor (`"server"`) is exempt. After a grant the
server's tick does not move until the client plays, so a player who adopted a grant and left at
once had the next absence refused after the host had consumed it, and those hours were lost. The
host never needs the guard: it pays measured absences only and resets `lastActiveAt` with every
grant.

## 5. Analytics

Every grant goes through one host helper, which also reports `sim.offline` to the admin dashboard
(ADR 0007). Verified segments feed `sim.tally` through the classic `ModeAnalytics` hooks.

## Unverified

- The frozen-page path (§3) is covered by host tests and the QA probe's frame capture. It has not
  been reproduced on a real phone.
- Early-game rate-path gold underpays (0–0.7× the next 10 minutes' net gold). This is
  conservative and documented in design §4.3.

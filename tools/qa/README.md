# @gamez/qa: browser QA harness

A dependency-free Chrome DevTools Protocol driver plus ready-made scenarios
for checking gamez in a real (headless) browser. It runs with plain `node`
(Node 24 strips the TypeScript types) against a running dev server (default
`http://127.0.0.1:5173`).

- Browser: `~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`
  (override it with `GAMEZ_QA_CHROME`). Nothing is downloaded.
- Graphics: software GL (SwiftShader). Frame rates are slow and noisy. Compare
  them between runs and never read them as absolute numbers.
- The harness never starts, stops or restarts the dev server. If the server is
  briefly down, `run.ts` waits up to 90 s for it to come back.

## Scenarios

```sh
node tools/qa/src/run.ts picker                       # mode list, layout, touch targets
node tools/qa/src/run.ts classic-start warrior         # autostarted hero in town: art, labels, sim ticking
node tools/qa/src/run.ts classic-create rogue          # new-hero screen through the real UI
node tools/qa/src/run.ts classic-idle warrior 1 8      # Idle mode x8 for 1 minute: samples + screenshots, data.descents
node tools/qa/src/run.ts classic-features warrior      # wave A systems with cheats: talents, smith, gambler, stash, filter, sets, rift
node tools/qa/src/run.ts classic-boss warrior          # cheats: a boss beside the hero, each telegraph shape, both phases, the shake
node tools/qa/src/run.ts panels [class]                # every HUD panel, every NPC/station panel
node tools/qa/src/run.ts gallery [--all-facings]       # ?qa=gallery: every appearance/item/effect/tile/prop
node tools/qa/src/run.ts steps | duel | plaza          # the other modes: load, a few inputs, screenshots
```

Options: `--viewport desktop|phone` (1366x768, or 390x844 with mobile and touch
emulation at dpr 2; every scenario accepts it, for example `classic-features warrior --viewport phone`), `--out <dir>` (default `/tmp/gamez-qa/<scenario>-<args>[-phone]`, whose old PNGs are cleared at the start of a run),
`--url <base>` (or `GAMEZ_QA_URL`), `--seed <n>` (classic seed, default 4242),
`--strict` (console errors fail the run), `--verbose` (page console to stderr).

`--out` does not clear old screenshots (only the default directory is cleared),
so pass a fresh directory when you compare runs: the numbering moves when a
section gains a page.

### classic-features (cheats)

`classic-features <class>` opens `?debug=1&cheats=1` (the QA module `classic.debug`,
with its own local save slot) and grants late-game content through
`controls.cheat` (gold, 10 levels, 5 talent points, rare items, gems). It then
walks the wave A systems and screenshots each:

| Shot                                                                         | What                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `talents`, `talents-learned`                                                 | N opens the talent tree; the first learnable node is learned (`classic.learnTalent`)                                                                                             |
| `smith-vendor`, `smith-craft`, `smith-after`                                 | the smith (vendor), the craft panel, repair everything, upgrade and socket the first bag item                                                                                    |
| `gambler`                                                                    | the gambler (`gamble` panel)                                                                                                                                                     |
| `stash-tabs`, `loot-filter`, `settings`, `character`                         | stash, loot filter, settings, character                                                                                                                                          |
| `achievements`                                                               | Y opens achievements                                                                                                                                                             |
| `set-bonus`                                                                  | the class's early set (cheat `set`), two pieces worn: `classic.set.bonus` must count up                                                                                          |
| `rift-locked`, `rift-unlocked`, `rift-level-1`, `rift-guardian`, `rift-left` | the obelisk locked, unlocked (`unlockRift`), level 1 opened (`classic.openRift`), the guardian reached on auto (8 s, then the `riftProgress` cheat), leave (`classic.leaveRift`) |

Action checks pass when the action is accepted or refused by a game rule (for
example `no_repair_needed`); an unknown action, `internal` or `client` error fails.
`data.features` records the outcome of each action. The guardian check is a warning:
a cheat hero (12 more levels for the rift, but no rift gear) rarely clears it, so after 8 s the run fills the bar with
the `riftProgress` cheat and checks that the guardian appears (a hard check, unless the
run already ended in a death, `not_in_rift`).
Use `--viewport phone` for the phone layout of the same run.

### classic-boss (cheats)

A deterministic route to a boss fight: 25 levels, the town stairs to depth 1 in manual
mode, then `spawnBoss: "classic.monster.boss_warden"` puts Morrow awake on the first walkable tile at least 3 tiles
from the hero and at most 12 steps away (never behind a wall), at the depth's level, so the fight lasts long enough to watch (a rift-level boss
kills a cheat hero in seconds). The run polls `sim.lastEvents` for `classic.telegraph` and takes a
`telegraph-<shape>` shot as soon as a new shape (circle, cone, line) starts to fill.
`woundBosses: 60` then `woundBosses: 30` drive both phases (`boss-phase-1`, `boss-phase-2`).
Hard checks: the boss spawns, phase 1 starts, its toast names Morrow, and
`render.shakes` counts up. Each telegraph shape is a warning (the line only comes
with the phase 2 rush). `data.boss` holds the shapes seen and the shake counts.

### party

The party UI without the party cheat (`src/party.ts`). `party <class> [--viewport phone]`:

1. Manual mode, a gold cheat, then the Party panel (key P): buys slots 2 and 3 with the panel button,
   picks the Rogue and Sorcerer class cards, types the names Wren and Ilsa and presses Recruit
   (`party-panel`, `party-panel-recruited`).
2. Checks three members in `window.__gamez.sim.party`, three `[data-party-frame]` HUD frames and the
   outline census (one gold `self`, cyan `party` for the others) (`party-frames`).
3. Takes control by clicking portrait 2, then F3, F1 and Tab. After each switch the controlled member
   and the HUD hero must be the expected one, the camera target (`window.__gamez.render.camera`, tiles)
   must be on that hero and the centre within 2.5 tiles, and there must still be exactly one `self`
   outline (`control-portrait`, `control-f3`, `control-f1`, `control-tab`).
4. Party: Auto (Idle x8) for 30 s. The party must stay within the leash (24 tiles; 12 is a warning),
   and the camera target must stay on the controlled hero in 80 % of the samples (`party-idle`).

### classic-party (cheats)

A party of four in the real browser (`src/party.ts`, owner T-party-render). `classic-party <class>`
opens `?debug=1&cheats=1` (`--url` picks the server; `--viewport phone` works too) and:

1. Grants the party with `controls.cheat {party: ["classic.rogue", "classic.sorcerer", "classic.warrior"]}`.
   When the cheat is not there yet, the run falls back to `{bossesKilled: [4, 8, 12], gold: 100000}` and
   recruits the same three through `controls.act("classic.party.recruit")`. `data.party.grant` says which path ran
   (`party-cheat` or `fallback`). The cheat names its recruits `<Class> <n>` (Rogue 1, Sorcerer 2,
   Warrior 3); only the fallback recruits as Brannoc, Celene and Oren. The frame-name check accepts both.
2. Takes `town-party` (outlines, name plates, party frames). The HUD's `window.__gamez.render.outlines`
   census must show one gold `self` and cyan `party` outlines. Frame names are read from the page text.
   The `ally` count is informational only: in town it includes the presence avatars (and their
   companions) of every other live session on the shared dev server. Downed party members keep a
   dimmed `self` / `party` outline, so they stay in the census.
3. Presses F2, then Tab (`control-f2`, `control-tab`). The controlled hero's name (`sim.hero.name`) must change each time.
4. Idles at x8 for 60 s, sampling every 2 s. Takes `downed` and `revived` shots the first time each happens, and
   `idle-party` at the end.

`data.party` holds the grant path, the outline census, the frame names, the control names, one sample per
2 s (depth, controlled hero, downs, revives, heroDeaths and, when exposed, every member), the largest
follower distance (`maxFollowerDistance`, tiles), `depthMax`, `downs`, `revives` and `final`.
Member positions are read from `window.__gamez.sim.party.members` (`{name, x, y, dead, level}`, tiles)
when the debug summary publishes it. Without it, the together check is a warning and only the controlled
hero is sampled.

Hard checks: three recruits joined, one self outline and party outlines, F2 and Tab switch control.
Warnings: the frame names, the outline after the switch, the together check when positions are missing,
and the descent (depth 1 or deeper).

Gallery: the `party` section (`?qa=gallery`) lists the controlled hero (`self`), a follower (`party`), a
downed follower (the dead pose, `party`), another player (`ally`, green) and a summon of a party member (the
Spark Sentry in the party ink), every action, on the town grass.

### Auto mode and manual steps

- The hero starts in auto. With the rift unlocked (cheat `unlockRift`), auto's rift loop
  takes the town stairs into the rift, so call `controls.setMode('manual')` before a
  manual descent or `interact('stairsDown')`.
- `interact(target)` sets a walk-to intent and returns `ok` at once; the NPC's panel opens
  when the hero arrives (up to ~20 s). Wait for the panel, for example
  `waitFor("window.__gamez.ui.panels.includes('vendor')")`.

### Totals (`classic-idle`)

`classic-idle` reads `window.__gamez.counters` at the start and at the end.
`data.counters` holds `{start, end, totals}`; `totals` is
`{ticks, slain, heroDeaths, descents, events}` for the run, where `events` lists only the
types that changed (for example `classic.loot.picked`). Totals are `null` when
the page reloaded during the run (the probe restarts with the page). The warn
check `cumulative counters advanced with the sim` compares `totals.ticks` with
the sim's own tick progress.

`data.descents` is the number of stairs-down descents in the run (counted from
`classic.area.changed` with `via: "stairsDown"`, never ring-dropped). The warn
check `descended at least once` reads it. Use these totals rather than counting `lastEvents`,
which is a 60-entry ring.

### Perf signal (`classic-start`, `classic-idle`)

Both scenarios install a page probe before the game loads, so the boot is
measured too. The probe records every frame gap over 100 ms (rAF timestamps)
and every longtask (`PerformanceObserver`, not buffered, so entries start
at document start). Results are split at 5 s after navigation:

- `data.perf.longFrames.{boot,steady}`: `{count, max}` in ms.
- `data.perf.longtasks.{boot,steady}`: `{count, max}` in ms, by the longtask's start.
- `data.perf.excludedFrames` / `harnessPauses`: a screenshot freezes the page,
  so gaps that overlap one are the harness's, not the game's, and are not counted.
- `data.perf.documentMs`: age of the measured document. A dev-server reload
  restarts the probe, so a value below the run length means a reload happened.

The warn-only check `no frame over 100 ms after the first 5 s` is in
`checks`. Software GL stalls the frame without blocking JavaScript, so a long
steady frame with no steady longtask points at rendering, not at game code.

Under SwiftShader, `classic-idle <class> <min> 8` routinely warns here (steady
frames of 2-3 s, a few fps). Wave B QA measured the same stalls with server sync
on and off, while the sim tick stayed around 16 ms, so the warning at x8 is the
software render path. Do not chase it in the sim or the sync code; re-measure on
a GPU machine before calling it a regression.

### Wave B scenarios (account, social, server sync, town presence)

```sh
node tools/qa/src/run.ts account                       # register, sign out, sign in again, wrong password
node tools/qa/src/run.ts social                        # leaderboards, guild create/leave, chat send/report
node tools/qa/src/run.ts classic-server [class]        # server-verified hero: reload, new game, Idle x8
node tools/qa/src/run.ts classic-legacy [class]        # offline play writes the old local save; import it once
node tools/qa/src/run.ts classic-town [class]          # a bot walks in the classic town; the page draws it
node tools/qa/src/run.ts classic-social [class]        # the classic HUD's social panels and sync badge
```

Simulating a network drop: Chrome's `Network.emulateNetworkConditions`
(offline) and `Network.setBlockedURLs` do **not** sever or block WebSockets.
To play offline, install a pre-document script with
`Page.addScriptToEvaluateOnNewDocument` that replaces `window.WebSocket`
behind a localStorage flag (`classic-legacy` does this with `qa.offline`). To
drop one live socket, wrap `WebSocket` the same way and close only the socket
whose URL matches (for example `world=classic-town`): closing every socket
also closes Vite's HMR socket, which reloads the page.

Expected console noise: a wrong-password sign-in logs the browser's own
"Failed to load resource ... 401" for `/api/auth/login`. That is the correct
`bad_credentials` reply, not an app error.

`classic-town` judges movement only on the bot's own avatar: other sessions on
the same dev server can be drawn too, and are listed in
`data.presence.otherSessions`.

Every run prints one JSON report to stdout:

```jsonc
{
  "scenario": "classic-idle",
  "args": ["warrior", "1", "8"],
  "viewport": "desktop",
  "ok": true, // no exception and every hard check passed
  "error": "...", // only when the scenario threw (an error.png is saved)
  "outDir": "/tmp/gamez-qa/classic-idle-warrior-1-8",
  "screenshots": [{ "name": "start", "path": ".../01-start.png" }],
  "checks": [
    { "name": "sim advanced", "ok": true, "detail": {} },
    { "name": "no missing art ids", "ok": true, "warn": true },
  ], // warn = never fails the run
  "samples": [{ "t": 6, "tick": 465, "depth": 1, "level": 1, "fps": 15.5, "ticksPerSec": 70 }],
  "data": { "render": {}, "artProblems": {}, "final": {} }, // scenario specifics
  "consoleErrors": [{ "level": "error", "source": "exception", "text": "..." }],
  "consoleWarnings": [],
}
```

The exit code is 0 when `ok`, 1 otherwise, and 2 for bad usage. A useful
pattern: `node tools/qa/src/run.ts gallery > /tmp/g.json; node -e 'console.log(require("/tmp/g.json").data.summary)'`.

### Offline and away (`classic-offline`, permanent)

```sh
node tools/qa/src/run.ts classic-offline warrior --out /tmp/gamez-qa/classic-offline-warrior
```

Proves that classic Idle keeps farming while the player is away, in server-synced play
(docs/design/offline-idle.md §2, §5, §6, §7). Source: `src/offline.ts`. About 13 minutes:
Idle 150 s, absence 75 s, and the same again in each phase. It uses the live dev server (default
`http://127.0.0.1:5173`); the scenario never starts, stops or restarts it.

| Phase | What the player does                                                    | Hard checks                                                                                                                                            |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | Idle 150 s, close the tab, wait 75 s, reopen                            | card "While you were away"; away at least 1 min; XP since close at least the card's XP; card says "% offline rate"; Idle preserved; sync server online |
| B     | Close the card, reload at once                                          | no second card; no `classic.offline.summary`; Idle preserved. Warn: XP jump within 2x the measured Idle rate                                           |
| C     | HUD "Modes" to the picker, wait 75 s, return via the Classic card       | the same checks as A                                                                                                                                   |
| D     | Hidden tab (see below), 70 s, visible again                             | the same checks as A                                                                                                                                   |
| E     | Optional, warn only: local play (`?cheats=1`), close, wait 75 s, reopen | the same checks, as warnings                                                                                                                           |

What counts as a pass: every hard check of a phase. A phase that throws is a hard failure of that
phase only; the later phases still run. Timing-sensitive values (the exact XP, the XP jump, whether
the summary is still in the event ring, the rate source) are warnings.

- **Absence waits.** The wait ends at `leaveWall + 75 s` on the page clock, where `leaveWall` is the
  moment the tab navigated to about:blank (or the picker was entered). The server measures its own
  clock from the last verified progress, which is never later than the close, so the absence it
  credits is at least 75 s (the grant floor is 60 s).
- **Hidden tab (phase D).** Headless Chrome does not hide a tab on its own. The scenario redefines
  `document.visibilityState` and `document.hidden` (the getters return `'hidden'`), holds
  `requestAnimationFrame` callbacks (a background tab runs no frames; Pixi's Ticker looks the
  global up every frame, so the game loop stands still while timers keep running) and dispatches
  `visibilitychange`. After 70 s (over `HIDDEN_RECONNECT_MS` = 60 s and the 60 s grant floor) it
  removes the override, dispatches `visibilitychange` and only then releases the held frames,
  the order a real browser uses. The client rejoins and the card shows the grant. A warn-only
  check confirms that the sim tick stood still while hidden. Rejected stand-ins:
  - The override alone: the loop keeps playing, so the client plays the absence live and the
    server rightly grants nothing (granting would pay twice).
  - `Debugger.pause`: on resume the queued frames and the 2 s segment timer run before the
    visible event, so a non-empty segment reaches the server on the old socket first, and the
    absence is spent (it moves `lastActiveAt` to now).
  - `Page.setWebLifecycleState` "frozen": in chrome-headless-shell rAF does not restart after
    "active".
- **Stale cards.** A card still open from an earlier return is closed before phases C and D
  leave. Phase D stays on the same page, so it only accepts a card that came with a new
  `classic.offline.summary` (the event counter rose; a hard check). Sync is read as online
  after up to 15 s of settling, because the card can show before the rejoin's status flips.
- **Rate source.** The measured rate replaces the fallback model only after 5 min of online Idle
  (`AUTO_RATE_MIN_TICKS` = 6000 ticks at x1). The scenario has about 3 min, so every card is
  expected to say "Estimated: not enough Idle history yet" (`source: "model"`). The warn-only
  check compares the card with the online Idle the run accumulated (`data.onlineIdleMs`).
- **Reopens never use autostart.** Only the first open of a run creates the hero, because autostart
  replaces the saved one. A reopen uses the same URL without autostart. A dev-server reload during
  the run (HMR) is recovered the same way, counted in `data.reloads`.
- **Output.** `data.phases.{A,B,C,D,E}` holds each verdict and its numbers (card, pre and post XP,
  sync, quests); `data.idleXpPerMs` is the Idle rate measured in phase A. Screenshots are numbered
  in order (`01-A-idle-before-close.png`, `03-A-reopen-card.png`, ...), and `error.png` is written
  when the run throws.
- **Parsing.** `parseCard(text, quests)` reads the card (away span, credited span, kills, XP and
  rate, gold and rate, items, levels, quest rows, the upkeep note, the measured or estimated hint).
  It is pure, so a unit test can cover it without a browser.

## Harness rules: toasts, reloads, the dev server

These rules hold for every scenario (round-1 QA fixes):

- **Toast checks are read right after the action.** A toast lasts 4 s, and a
  loaded machine can be slower than that between a click and a read. So the
  `quests` scenario polls the toasts for up to 3.5 s from the press
  (`expectToast` in `quests.ts`; `pollToastTexts` for the classic-boss phase toast).
  The first read is immediate.
- **Toast fallback.** A dev-server reload wipes the toasts (the page reloads and
  the UI state is gone). When a reload happened between the action and the check
  (`data.reloads` changed), or the page could not be read, the quest log line
  decides instead: `Accepted: <name>`, `Complete: <name>`, `Reward: <gold> gold,
  <xp> XP`. Such a check is **warn-only** and its detail says why (`via: "log"`,
  `reason`). On an unreloaded page, a toast that was not seen while its log line
  is there is also warn-only (`reason: toast not observed ...`): an HMR update or
  a stalled frame can drop a 4 s toast, and the event itself is confirmed. Only
  when **neither** the toast nor the log line is seen does the check fail
  (warn-only where Idle made the turn-in, which has no press to time from). The
  quest state, tracker and gold/XP checks next to it stay hard checks, so a real
  quest bug still fails the run.
- **Dialog presses are timed by their effect.** A phone tap's click is synthesised
  by Chrome after `touchend`, on the renderer's time: on a loaded machine with a
  busy game (right after an Idle x8 run) it was measured landing 3.5 s after the
  tap. The `... responds to the tap/click` check therefore watches the quest row
  for up to 6 s (`RESPOND_MS`, `detail.waitedMs`), and the toast is polled from the
  moment the row changed. Only a row unchanged after 6 s fails (then a DOM click
  carries the run on).
- **Reloads in `panels`.** The game returns to the picker after a reload.
  `panels` runs every step through `recoverFromReload`: it starts the same class
  again (same seed) and redoes the failed step, up to 4 attempts. `data.reloads` counts them.
- **The dev server restarting.** `openPicker` (every reacquire) waits for the
  server (`waitForServer`, 90 s) before it opens the page. A navigation that fails
  with a connection error is retried by the caller, not reported as a game error.
  `recoverFromReload` retries a failed recovery up to 3 times, waiting for the
  server (120 s) in between, instead of giving up on the first refused connection.
- **Reloads in `classic-boss`.** A boss fight cannot be resumed after a reload
  (the page returns to the picker and the boss is gone), so the whole attempt is
  restarted (up to 3 attempts, after `waitForServer`). The interrupted attempt's
  checks are dropped and listed in `data.bossRestarts` (`attempt`, `error`,
  `droppedChecks`); `data.reloads` counts the restarts. The phase-2 window is
  100 s (`PHASE2_WATCH_MS`) so Morrow's rush (the line telegraph) can come round.
- **`progress.log`.** Every check (`ok`/`WARN`/`FAIL`), screenshot, reload and
  recovery attempt is appended with a timestamp to `<out>/progress.log` while the
  run goes (the JSON report is only printed at the end). Read it to see how far a
  long or stalled run got.
  Connection errors (`ERR_CONNECTION_REFUSED`, `ERR_CONNECTION_RESET`,
  `ERR_EMPTY_RESPONSE`) are kept out of the `no console errors` check and listed
  in a separate warn check, `dev-server connection errors during the run (not the game)`.
- **Console error details** are objects: `{ text, url, source }`, so a failure
  names the URL it came from (`url` is null when the browser gave none).
- **`quests <class> phone`.** The word `phone` may come before or after the class:
  `quests phone` runs the warrior on the phone layout (before this fix the word
  became the class name).
- **classic-boss phase 2** waits up to 100 s for the cone, circle and line
  telegraphs (the line rush follows the other skills' cooldowns).
- **Chat (`social`).** The chat dock is only usable once its status reads `Live`
  (ChatWindow sends only when online). `openChat` waits for that before typing.

## Quests (`quests` scenario and the quest sim suite)

Quest coverage has two halves: a sim suite (fast, no browser, runs on every
change) and a browser scenario (the whole loop as a player sees it).

### The sim suite

```sh
node_modules/.bin/vp test run modules/classic/tests/quests.all.test.ts
```

Data-driven over `registry.all(KIND.quest)`, so a new quest is covered without
editing the file. On the real catalog and every classic module, it drives real
actions (`classic.acceptQuest`, `classic.completeQuest`, `classic.interact` to
Captain Hale, placed in reach) and sets up level, depth and bosses through the
real transitions and resources. Kills are pushed as death records, the way combat
reports them. It checks, per quest: offered by level and chain (HUD and
actions agree), refused far from Hale (`too_far`, hash unchanged), accepted near
Hale once, progress counted for the right things (wrong monster and a normal-rarity
namesake ignored for a boss kill, `reachDepth` follows the deepest depth,
`clearLevel` stays open while a monster lives), finished, turned in for exactly
the reward gold and XP and an item of the reward rarity, second turn-in and
re-accept refused, the chain unlocks the next quest. Also: the whole chain to
ten completed quests, a retroactive boss kill (accepted after its depth is in
`bossesKilled`), the stash fallback for a full bag, Idle and Auto per class
(warrior, rogue, sorcerer), and determinism (same script, same hash).

Round 2 added, all data-driven over the registry:

- **Turn-in location.** Every quest, finished and then turned in from depth 1
  (`classic.completeQuest` in the dungeon): `not_in_town`, hash unchanged, the
  quest still done and not completed. Every `classic.quest.completed` event the
  Idle and Auto tests see is recorded with the depth the hero stood on at that
  tick (`Driver.completions`); each one must be depth 0. This is the check for the
  QA question "turn-in location not observed".
- **Pinned rewards.** A table of the gold, XP and minimum reward rarity of all ten
  quests (`REWARDS`). Each quest's data must equal it, and its turn-in grants
  exactly that gold and XP; the item (or no item) follows the rarity. Into the
  Ninth is pinned as `reachDepth` 12, after Deeper Still, level 16, and is done
  once the deepest depth is 12.
- **Auto and Idle play a quest on their own, per class.** From a fresh hero with
  no accept or turn-in dispatched by the test, Auto and Idle (at speed 4, set with
  `classic.setSpeed`) each accept Rats in the Cellar, progress it
  (`classic.quest.progress`), turn it in in town and are paid its gold and XP.
  `setSpeed` is refused outside Idle. The sim has no speed effect (the host steps
  `speed` ticks per 50 ms), so speed 4 plays the same ticks as speed 1 here.
- **One town visit accepts every eligible quest.** A level 10 hero starts in the
  dungeon. Auto and Idle go to town for the quests (the trip reason, design §15.2
  step 8) and accept all six quests with no chain and reqLevel ≤ 10 (Rats, Deeper
  Still, The Warden's Rest, Ash and Ember, Clear the Crypt, Cull the Flames), with
  no trip to the dungeon between the first and the last accept.

Round 2 guards (name, then the code it covers):

- `not_in_town` turn-in from the dungeon (per quest): `progression/ops.ts`
  execCompleteQuest, the town check before the reward.
- `pinned reward is granted exactly` (per quest): `content/quests.ts` values and
  the reward grants in execCompleteQuest.
- `Auto and Idle play a quest on their own` (per class): the controller's accept,
  progress and turn-in (`auto/`), with Idle at speed 4.
- `one town visit accepts every eligible quest` (per class and mode):
  `auto/town.ts` questOps and the quest trip reason in `auto/think.ts`.

The suite is the target behaviour of the quest fix and is never skipped or
weakened to pass. Tests that guard a quest fix (name, then the code it covers):

- `retroactive: ...` (the four boss quests, and Tunnel Mother turned in): a
  killBoss quest accepted after its boss depth is already in `bossesKilled` is
  done within one tick of the accept (`progression/quests.ts` advanceLevelQuests),
- `clearLevel completes on an uncredited last death`: any monster death that
  empties the live depth 3 completes Clear the Crypt,
- `reward item falls back to the stash when the bag is full`,
- `Auto completes Clear the Crypt` (per class): level 18, 6 rare items,
  `deepest` 4 and waypoints 1 and 3 (what a hero who reached depth 4 has);
  turned in within 13 000 ticks (about 30 % over the slowest class, warrior),
- `Auto accepts a chained quest in the same visit` (per class): Tunnel Mother is
  accepted before Auto leaves town after turning in The Warden's Rest,
- `the whole chain`: ten quests completed and `Trusted by the Town` unlocked
  (achievements are checked every 20 ticks, so the test steps one interval).

On the current tree all 119 tests pass in 96 s on a quiet machine and 136 s with
other suites running (round 1's 85 took 55 s on their own). The per-class Auto and
Idle tests take 2 to 15 s each (the sorcerer Idle run is the slowest), and the
one-visit tests about 2 to 3 s each.

### `quests` (browser)

```sh
node tools/qa/src/run.ts quests <class> [phone]   # warrior | rogue | sorcerer; `phone` = 390x844 touch layout
```

A fresh classic hero (`?debug=1&cheats=1&class=…&autostart=1`, manual control) in town. No
`seed`: a seeded run neither reads nor writes the local save, and the reloads need it.

1. Captain Hale offers `Rats in the Cellar` (the `!` state; the marker label
   count at the spawn is a warn check).
2. The quest log (L) at the spawn, away from Hale: the run records what it shows
   (a `Go to Captain Hale` button is the expected HUD fix; the actual state is
   recorded as a warn check, not assumed).
3. Hale's dialog (`controls.interact("quest")`; on phone a tap on his sprite via
   `controls.npcScreenPos`), the `!` marker drawn with Hale on screen, the real
   Accept button, the `Quest accepted` toast,
   the tracker (`0 / 20`), the log (L) progress text.
4. Idle x8 until 20/20. Manual again as soon as it is ready, so Idle does not
   turn it in by itself. Checks: the `Quest complete` toast or log line, the
   tracker `Ready` row.
5. Reload with the quest done: the state and the tracker must survive.
6. Turn in from the dialog: the `?` marker drawn with Hale on screen, then the
   `Reward` toast (`+60 gold, +120 XP`), gold and
   XP up. Reload: the completed list survives.
7. Deeper Still: accepted from the dialog (level 4 by cheat if the run is short;
   when Idle x8 already reached level 4 and accepted it on its own, the manual
   accept is skipped and `data.deeperAcceptedBy` is `idle`), `deepest` 6 by
   cheat, done, turned in. Into the Ninth stays locked below level 16 and becomes
   available at it (by cheat).
8. Into the Ninth (round 2), at level 16: accepted from Hale's dialog (the real
   Accept button), the `Quest accepted` toast, the tracker with `/ 12`. Deepest 12
   by cheat: the tracker row says `Ready` and the log (L) says `Ready to turn in`.
   Turned in from the dialog (a town portal, or Auto back to town, when the hero
   is deep): `Reward` toast `+1200 gold, +1400 XP` (read from the quest data),
   gold and XP up. Reload: completed survives.
9. Ash and Ember (round 2, a killMonsters reward): accepted from the dialog
   unless Idle already took it (`data.ashAcceptedBy`), Idle x8 until 15 ash seers
   are killed (budget 420 s; a failed finish is a hard check), turned in from the
   dialog (`data.ashTurnedInBy` when Idle turned it in itself), and the `Reward`
   toast reads `+300 gold, +500 XP`.

For every Reward toast the run records the depth at the toast in
`data.rewardToasts` (`{quest, label, toast, depth, isTown}`), and a turn-in out
of town is a warn check (`Reward toast raised in town`).

Final reload.

Screenshots (in the run's output directory, `/tmp/gamez-qa/quests-<class>[-phone]`
by default, numbered in order): `01-hale-marker`, `02-log-far-from-hale`,
`03-dialog-open`, `04-accepted-tracker`, `05-log-progress`, `06-quest-ready`,
`07-turned-in`, `08-deeper-done`, `09-into-the-ninth`, `10-into-the-ninth-accepted`,
`11-into-the-ninth-turned-in`, `12-killmonsters-reward`. Failures get `error.png`.

Every dialog button press also records what `document.elementFromPoint` hits at
the button's centre (`hit`: `button`, or the covering element) and checks that
the press changed the quest row (`<label> (<quest>) responds to the tap|click`).
A press that does nothing is a failed check; a DOM click then carries the run
on, so one dead button does not hide the rest of the loop.

Known limits:

- Auto runs only at x1. Use Idle x8 for unattended QA (the scenario does).
- Long runs (Idle x8 takes about 40 s to a few minutes for the first 20 kills)
  can be interrupted by Vite full reloads while other work edits files. Every wait,
  controls call, log read and screenshot re-opens the saved cheats hero after a
  reload (no autostart, which would replace it; up to 4 tries while the dev
  server answers 500 for a module mid-edit), puts Idle x8 or Auto back, issues the
  walk to Hale again, and carries on; `data.reloads` counts them. A screenshot
  that times out becomes a `screenshot <name>` warn check.
- Turning in from the dungeon needs a town portal scroll. Without one the run
  switches to Auto until the hero is in town (`data.toTown` says which path).
- Accept and Turn in are disabled out of reach of Hale. A dialog opened before
  the hero has walked to him (a town portal arrival did this in round 2) shows
  `Go to Captain Hale`; the scenario presses that button (the player's own way) and
  waits up to 30 s for `questGiver.inReach` before pressing the disabled button.
  `data["walkedTo <label> <quest>"]` records each time this happened.
- The quest list scrolls inside the dialog. A row below the fold (Into the Ninth
  on the 1366x768 desktop) is scrolled into view before its button is pressed.
  Before this, the press hit nothing (`hit: none`), and the DOM click carried on.
- The renderer exposes a count of visible marker labels
  (`render.labelsVisible.marker`), not the glyph. The `!` and `?` checks are
  therefore made with the hero next to Hale (his sprite on screen, via
  `controls.npcScreenPos`) and the quest state known: `!` at the accept, `?`
  right before the turn-in. The count at the spawn is a warn check, because
  Hale can be off screen there (always on phone).
- Idle at speed 1 duplicates Auto in the sim: only `ControlState.mode` differs.
  Idle-only QA must run Idle at speed 2, 4 or 8 (the sim keeps the setting; the
  browser host applies it), or be done in the browser (the scenario uses Idle x8).
- Idle and Auto accept every eligible quest in one town visit, at once. This is
  by design (§15.2 step 8: the quest step accepts every quest the hero may take).
  A check that expects one accept per visit is wrong.
- Hale's `!` label is off screen at the spawn on phone. The count of visible `!`
  labels there is a warn check, and that result is expected, not a bug.
- Chain QA beyond The Tunnel Mother needs about a 2-hour sim run. Its reqLevel
  is 14, which a 30-minute Auto run does not reach. The sim suite covers the chain
  by setting the level and the chain state, so only the browser run is affected.
- Offline progress for killMonsters quests (§15.4, §16 rule d): `*` (Cull the
  Flames) gets every offline kill. A named target gets `floor(kills / n)` when it
  is one of the `n` monsters of the offline depth's tier, and 0 otherwise.
  Progress is capped at the count. Depth, boss and clear quests never progress
  offline. Covered by `modules/classic/tests/auto.offline.quests.test.ts`.
- The boss kill regression (`modules/classic/tests/auto.bosses.test.ts`) belongs
  to another task. It was added to the tree while round 2 ran (untracked then).
  The quest suites do not depend on it.

## The driver (`src/cdp.ts`)

```ts
import { launch, VIEWPORTS } from "./cdp.ts";

const page = await launch(VIEWPORTS.phone); // or { width, height, mobile?, touch?, dpr? }
await page.open("http://127.0.0.1:5173/?debug=1&seed=7&class=rogue&autostart=1");
await page.clickText("Classic"); // smallest visible element with that text, aria-label or title; taps on touch viewports
await page.waitFor("window.__gamez?.sim?.hero != null", 30_000);
await page.press("i"); // keys: single chars, Escape, Tab, Enter, Space, Arrow*, F1-F12, + - =
await page.click(200, 300); // also tap(x, y, holdMs), hover(x, y), type(text)
const sim = await page.evaluate("window.__gamez.sim"); // also evaluate(fn, ...jsonArgs)
await page.screenshot("/tmp/gamez-qa/mine/inventory.png");
console.log(page.consoleErrors()); // console.error, uncaught exceptions, failed requests, crashes
await page.close();
```

`page.send(method, params)` reaches any raw CDP command, for example
`Performance.getMetrics` or `Emulation.setCPUThrottlingRate`.

## Debug hooks in the game (`?debug=1`)

The client installs `window.__gamez` only with `?debug=1`. Without it, nothing
is installed and the game pays nothing for the hooks.

| Field                | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`               | `"classic"`, or `"classic.gallery"` in the gallery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sim` (classic)      | live getter: `tick, phase, depth, area{…}, hero{class, level, xp, life, mana, gold, potions, belt, skillBar, statuses, x, y}, counts{monstersAlive, bossesAlive, summons, corpses, slain, lootOnGround, projectiles, heroDeaths}, runStats, control{mode, speed}, autoState{plan, todo, focus, frontier}, eventCounts, casts, effects, lastEvents[]`                                                                                                                                                                                                                                                                                                                 |
| `counters` (classic) | cumulative totals that the ring buffer of `sim` cannot drop: `tick` (current sim), `ticksTotal` (ticks of every sim on this page, carried across newHero/newGame), `events{type: n}` (every event since the last new hero), `slain`, `heroDeaths`, `ringDropped` (events the 60-entry ring has pushed out), `descents` (stairs-down area changes). Read with `ticksTotal`, not `sim.tick`, for a run's tick count                                                                                                                                                                                                                                                    |
| `hud`, `ui`, `log`   | the client stores: the full HUD snapshot, UI state (panels, toasts, error, settings, perf), and the last 40 log lines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `controls` (classic) | `setMode(m)`, `setSpeed(x)`, `newHero(class, name?)`, `setClass(class)`, `seed`, `act(name, payload)`, `interact("smith"\|"alchemist"\|"junk"\|"healer"\|"quest"\|"gambler"\|"stash"\|"waypoint"\|"stairsDown"\|"stairsUp"\|"portal"\|"obelisk"\|"riftExit")`, `openPanel/closePanel/togglePanel/closeAll`, `castSlot(n)`, `drink(n)`, `respawn()`, `updateSettings(patch)`, `cheat(payload)` (only with `cheats=1`: `classic.debug.grant`, see below)                                                                                                                                                                                                               |
| `render` (any mode)  | renderer getter: `fps, frameMs{avg,p95,max}` (wall clock), `tickMs, zoom, entities, entitiesDrawn, primitivesDrawn, chunks, chunksBuilt, props, missingIds[] (art and icon.* ids; the report also splits them into missingArtIds and missingIconIds), animationsSeen{"appearance\|action\|facing": "key (kind)"}, labelsVisible{nameplate,npc,loot,sign,damage,healthbar, and marker/subtitle when the renderer exposes them}, effectsSeen{"kind\|sprite": "sprite"\|"procedural"}, effectsPlayed, floatsShown, shakes` (camera shake requests, counted even when the quality turns shake off; the generic `hit\|` and `levelup\|` effects are procedural by design) |
| `gallery`            | see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Every control goes through `api.act`, so all changes are kernel actions and
the sim stays deterministic. Resolution kinds: `exact` (own art for that
action), `action-fallback` (own art from another action, usually idle),
`generic` (a shorter prefix id), `fallback` (the fallbackAppearance chain),
`primitive`/`missing` (no art).

URL parameters (classic, independent of `?debug`):

- `?seed=<n>` starts a fresh sim with that seed. The local save is neither
  read nor written.
- `?class=<warrior|rogue|sorcerer>&autostart=1[&name=…]` skips the new-hero
  screen.
- `?debug=1&cheats=1` loads the QA module `classic.debug` (action
  `classic.debug.grant`). Its mode has another content hash and its own save
  slot (`gamez.classic.save.v1.cheats`), so cheat saves never mix with real ones.
  `controls.cheat(payload)` takes `gold`, `levels`, `items: {count, rarity, ilvl, category?}`,
  `gems`, `unlockRift`, `bossesKilled: [depth]`, `deepest`, `talentPoints`, and the QA
  routes `set: "<set id>"` (every piece of the set into the bag), `riftProgress: 1..100`
  (fills the open run; 100 calls the guardian; `not_in_rift` without a run),
  `spawnBoss: "<boss or guardian id>"` (awake beside the hero; `in_town` in town) and
  `woundBosses: 1..99` (every living boss of the area to that % of its life, so phases
  start on demand; `bad_target` with no boss; it may be sent in the same grant as
  `spawnBoss`, and then applies right after the boss spawns). Unknown or out-of-range fields are
  rejected (`bad_payload`) and change nothing.
- `?fresh=1` skips the save carry-over. A save of another content version whose
  modules all still exist is restored under the new hash, stepped 20 ticks as a
  check, and kept with the notice "Save carried over"; a save that fails starts a
  new game.

## Gallery (`?qa=gallery`)

Coverage counts (`data.summary`, see below): `byWorstKind` counts each cell by
its worst resolution, with `n/a` for an action the game never plays on that
kind (NPCs only play idle: attack, cast, hit, death and walk are `n/a`).
`attackFallbacks` counts cast or hit that play the attack clip (accepted).
`actionFallbacks` counts only real gaps (a fallback that lands on idle or another clip).
`icons` (`ids`, `missing`) is informational: HUD icons are inline SVG, so a
missing `icon.*` sprite is not an art gap and is kept out of `missingArtIds`.
The `every action has its own animation` check uses `actionFallbacks` only.

**Glyph icons (planned):** the gallery report may gain a separate `glyph` list for
icon ids that are drawn as glyphs (not sprites). Another agent is changing
`modules/classic/src/client/gallery.ts` so glyph-backed `icon.*` ids are not counted
as missing. Until that lands, `icons.missing` can still list them; read it with that in mind.

Area effects are drawn at most one tile wide in their cell (the game uses the
real radius), so every effect stays inside its fixed-size cell and its caption
sits below the cell, not on the effect.

Captions follow the camera zoom (font 8 to 12 px, width of one column), so
neighbouring captions never run together when the page is zoomed out. Every
caption sits on a dark plate with light text (the kind colours stay readable on
beige floors), wraps inside its column and stops at 3 lines. Unit rows and loot
rows reserve room for their renderer nameplate above the head, so a row never
runs into the row above, and the camera keeps the two-row toolbar clear.

Gallery steps retry: if the dev server reloads the page mid-run, the step waits
for the gallery to be ready and redoes itself. `data.galleryRetries` counts them.

Dev server note: the dev server can keep serving an older copy of a module
whose watcher event it missed (`modules/classic/src/client/gallery.ts` has done
this: the served copy predates later edits, and a `touch` does not refresh it).
Check a suspicious result with `curl -s "http://127.0.0.1:5173/@fs/<abs path>"`
and grep for a string you know is in the file. To test the current code, build
and serve it on another port: `node_modules/.bin/vp -C apps/game build` (the
`--outDir` flag is ignored by the Cloudflare build, so the output is
`apps/game/.cloudflare/output/v0/workers/default`), then
`node_modules/.bin/vp -C apps/game preview --port 4180 --strictPort`, and point the harness at it with
`--url http://127.0.0.1:4180`. The preview serves `POST /api/guest` (the app's
guest login), which the gallery needs to mount.

A CDP command that gets no answer within 90 s rejects (`CDP timeout after …`),
so a stalled page fails its step, and gallery steps retry, instead of hanging
the run. Set `GAMEZ_QA_CDP_TIMEOUT_MS` to change the limit.

Summary fields: `cells`, `byWorstKind`, `problems` (gaps: generic, fallback, primitive or missing),
`actionFallbacks`, `unusedArt`, `attackFallbacks`, `notPlayed`, `icons{ids,missing}`.

`/?qa=gallery&debug=1` opens a static scene on the real Pixi renderer. It is
not reachable from the normal UI. Its sections:

- heroes, monsters, bosses (with the rift guardians, two tall rows a page) and NPCs,
  in idle, walk, attack, cast, hit and death, cycling all 8 facings
- an effects section: every `EFFECT_TABLE` row (captions show kind and particle
  style) and the three telegraph shapes (circle, cone, line), played through the planner
- monster mod tints, rarity label colours, status tints and the hover ring
- every loot sprite with its rarity label, the uniques, the gems (tinted by kind)
  and a set-rarity sample
- every skill effect and projectile, plus weapon projectiles
- the `party` page: self, party, downed, ally and a party summon, every action
- float texts and event effects, played through the real `effects.ts` planner
- every tile and prop that the generated maps, themes and manifest use, and
  the station signs

Captions show what each id resolved to, colour-coded by kind.

`window.__gamez.gallery` has these members:

- `sections`, `current`
- `show(id, page)`, `next()`, `prev()` (re-showing the same page keeps its built chunks)
- `setFacing(f | null)` (null resumes the cycle)
- `replay()`
- `shown()`
- `report()`, which returns `{ sections, summary{cells, byWorstKind, problems, actionFallbacks, unusedArt}, cells[] }`
- `summary`

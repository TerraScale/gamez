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
node tools/qa/src/run.ts classic-idle warrior 1 8      # Idle mode x8 for 1 minute: samples + screenshots
node tools/qa/src/run.ts panels [class]                # every HUD panel, every NPC/station panel
node tools/qa/src/run.ts gallery [--all-facings]       # ?qa=gallery: every appearance/item/effect/tile/prop
node tools/qa/src/run.ts steps | duel | plaza          # the other modes: load, a few inputs, screenshots
```

Options: `--viewport desktop|phone` (1366x768, or 390x844 with mobile and touch
emulation at dpr 2), `--out <dir>` (default `/tmp/gamez-qa/<scenario>-<args>[-phone]`, whose old PNGs are cleared at the start of a run),
`--url <base>` (or `GAMEZ_QA_URL`), `--seed <n>` (classic seed, default 4242),
`--strict` (console errors fail the run), `--verbose` (page console to stderr).

`--out` does not clear old screenshots (only the default directory is cleared),
so pass a fresh directory when you compare runs: the numbering moves when a
section gains a page.

### Totals (`classic-idle`)

`classic-idle` reads `window.__gamez.counters` at the start and at the end.
`data.counters` holds `{start, end, totals}`; `totals` is
`{ticks, slain, heroDeaths, events}` for the run, where `events` lists only the
types that changed (for example `classic.loot.picked`). Totals are `null` when
the page reloaded during the run (the probe restarts with the page). The warn
check `cumulative counters advanced with the sim` compares `totals.ticks` with
the sim's own tick progress. Use these totals rather than counting `lastEvents`,
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

| Field                | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`               | `"classic"`, or `"classic.gallery"` in the gallery                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sim` (classic)      | live getter: `tick, phase, depth, area{…}, hero{class, level, xp, life, mana, gold, potions, belt, skillBar, statuses, x, y}, counts{monstersAlive, bossesAlive, summons, corpses, slain, lootOnGround, projectiles, heroDeaths}, runStats, control{mode, speed}, autoState{plan, todo, focus, frontier}, eventCounts, casts, effects, lastEvents[]`                                                                                                                                                            |
| `counters` (classic) | cumulative totals that the ring buffer of `sim` cannot drop: `tick` (current sim), `ticksTotal` (ticks of every sim on this page, carried across newHero/newGame), `events{type: n}` (every event since the last new hero), `slain`, `heroDeaths`, `ringDropped` (events the 60-entry ring has pushed out). Read with `ticksTotal`, not `sim.tick`, for a run's tick count                                                                                                                                      |
| `hud`, `ui`, `log`   | the client stores: the full HUD snapshot, UI state (panels, toasts, error, settings, perf), and the last 40 log lines                                                                                                                                                                                                                                                                                                                                                                                           |
| `controls` (classic) | `setMode(m)`, `setSpeed(x)`, `newHero(class, name?)`, `setClass(class)`, `seed`, `act(name, payload)`, `interact("smith"\|"alchemist"\|"junk"\|"healer"\|"quest"\|"stash"\|"waypoint"\|"stairsDown"\|"stairsUp"\|"portal")`, `openPanel/closePanel/togglePanel/closeAll`, `castSlot(n)`, `drink(n)`, `respawn()`, `updateSettings(patch)`                                                                                                                                                                       |
| `render` (any mode)  | renderer getter: `fps, frameMs{avg,p95,max}` (wall clock), `tickMs, zoom, entities, entitiesDrawn, primitivesDrawn, chunks, chunksBuilt, props, missingIds[] (art and icon.* ids; the report also splits them into missingArtIds and missingIconIds), animationsSeen{"appearance\|action\|facing": "key (kind)"}, labelsVisible{nameplate,npc,loot,sign,damage,healthbar, and marker/subtitle when the renderer exposes them}, effectsSeen{"kind\|sprite": "sprite"\|"procedural"}, effectsPlayed, floatsShown` |
| `gallery`            | see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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

## Gallery (`?qa=gallery`)

Coverage counts (`data.summary`, see below): `byWorstKind` counts each cell by
its worst resolution, with `n/a` for an action the game never plays on that
kind (NPCs only play idle: attack, cast, hit, death and walk are `n/a`).
`attackFallbacks` counts cast or hit that play the attack clip (accepted).
`actionFallbacks` counts only real gaps (a fallback that lands on idle or another clip).
`icons` (`ids`, `missing`) is informational: HUD icons are inline SVG, so a
missing `icon.*` sprite is not an art gap and is kept out of `missingArtIds`.
The `every action has its own animation` check uses `actionFallbacks` only.

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

- heroes, monsters (bosses included) and NPCs, in idle, walk, attack, cast,
  hit and death, cycling all 8 facings
- monster mod tints, rarity label colours, status tints and the hover ring
- every loot sprite with its rarity label, and the uniques
- every skill effect and projectile, plus weapon projectiles
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

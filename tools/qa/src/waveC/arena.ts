/**
 * Wave C QA scenario: arena (wave-C.md §6, §15). OWNER: T-arena-sim.
 *
 *   arena   1. the arena client on its dev page (modules/arena/dev, port 5186):
 *              ?view=screen with a fake platform.arena: fight (queue, poll, match),
 *              the replay mid-fight and the result, the ladder tab (your row)
 *              and the non-happy states (unavailable, error, empty)
 *           2. ?view=replay: a sample fight played, scrubbed and skipped to the result
 *           3. the real app shell, when it is reachable: picker -> Arena -> the screen
 *              (a soft check: skipped with a warning when the picker is not there)
 *
 * Run it with the dev page up (node_modules/.bin/vp dev --config modules/arena/dev/vite.config.ts)
 * and GAMEZ_ARENA_DEV_URL to point elsewhere. Screenshots: --out or the default
 * /tmp/gamez-qa/arena[-phone]/ (the wave-C report names /tmp/gamez-qa/waveC-arena-sim-*).
 */
import type { Run } from "../run.ts";
import { openPicker, pickMode } from "../run.ts";
import type { Runner } from "./index.ts";

const DEV_URL = process.env.GAMEZ_ARENA_DEV_URL ?? "http://localhost:5186";

interface Target {
  x: number;
  y: number;
  text: string;
}

interface ArenaReadout {
  tick: number | null;
  total: number | null;
  banner: string | null;
  bodyText: string;
  scrollW: number;
  innerW: number;
  smallTargets: string[];
  rows: number;
  youRows: number;
}

/** Visible button (optionally by exact text, optionally with a class) and its centre. */
function findArenaButton(cls: string | null, text: string | null): Target | null {
  const sel = cls ? `button.${cls}` : "button";
  for (const el of document.querySelectorAll<HTMLButtonElement>(sel)) {
    const r = el.getBoundingClientRect();
    const t = (el.innerText || "").trim();
    if (r.width > 0 && r.height > 0 && !el.disabled && (text === null || t === text)) {
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: t };
    }
  }
  return null;
}

/** Everything the scenario checks, read from the page in one call. */
function readArena(): ArenaReadout {
  const note = document.querySelector<HTMLElement>(".arena-note")?.innerText ?? "";
  const m = /Tick (\d+) of (\d+)/.exec(note);
  const banner = document.querySelector<HTMLElement>(".arena-banner")?.innerText ?? null;
  const small = [...document.querySelectorAll<HTMLElement>(".arena-root button")]
    .filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && (r.height < 44 || r.width < 44);
    })
    .map((b) => (b.innerText || b.getAttribute("aria-label") || "").slice(0, 40));
  return {
    tick: m ? Number(m[1]) : null,
    total: m ? Number(m[2]) : null,
    banner,
    bodyText: document.body.innerText,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    smallTargets: small,
    rows: document.querySelectorAll(".arena-row").length,
    youRows: document.querySelectorAll(".arena-row.arena-you").length,
  };
}

async function clickArenaButton(
  run: Run,
  cls: string | null,
  text: string | null,
): Promise<string> {
  const end = Date.now() + 8_000;
  for (;;) {
    const t = await run.page.evaluate<Target | null>(findArenaButton, cls, text);
    if (t) {
      if (run.page.viewport.touch) await run.page.tap(t.x, t.y);
      else await run.page.click(t.x, t.y);
      return t.text;
    }
    if (Date.now() > end) throw new Error(`no button ${cls ?? ""} "${text ?? ""}"`);
    await run.page.wait(150);
  }
}

async function readout(run: Run): Promise<ArenaReadout> {
  return run.page.evaluate<ArenaReadout>(readArena);
}

/** Layout checks shared by every arena view. */
function layoutChecks(run: Run, r: ArenaReadout, label: string): void {
  run.check(
    `${label}: no horizontal page scroll`,
    r.scrollW <= r.innerW,
    { scrollW: r.scrollW, innerW: r.innerW },
    true,
  );
  run.check(`${label}: buttons at least 44px`, r.smallTargets.length === 0, r.smallTargets, true);
}

async function screenFlow(run: Run): Promise<void> {
  await run.page.open(`${DEV_URL}/?view=screen`);
  await run.page.waitFor("document.querySelector('.arena-root') !== null", 20_000);
  await run.page.waitFor("!document.body.innerText.includes('Loading the arena')", 10_000);
  const ready = await readout(run);
  run.check(
    "screen: status loaded (rating shown)",
    /left today/i.test(ready.bodyText),
    ready.bodyText.slice(0, 120),
  );
  layoutChecks(run, ready, "screen");
  await run.shot("screen-ready");

  await clickArenaButton(run, "arena-primary", "Fight");
  await run.page.waitFor("document.body.innerText.includes('Searching')", 5_000);
  await run.shot("screen-searching");
  await run.page.waitFor("document.querySelector('.arena-lane') !== null", 15_000);
  await run.page.wait(1_500);
  const mid = await readout(run);
  run.check(
    "replay mid-fight: tick advances",
    mid.tick !== null && mid.tick > 0 && mid.banner === null,
    { tick: mid.tick, total: mid.total },
  );
  await run.shot("replay-mid");

  await clickArenaButton(run, null, "Skip to result");
  await run.page.wait(300);
  const end = await readout(run);
  run.check(
    "replay result: banner names the winner side",
    end.banner !== null && /You win|You lose|Draw|wins/.test(end.banner),
    end.banner,
  );
  run.check("replay result: tick reaches the end", end.tick !== null && end.tick === end.total, {
    tick: end.tick,
    total: end.total,
  });
  layoutChecks(run, end, "replay");
  await run.shot("replay-result");

  await clickArenaButton(run, null, "Back");
  await run.page.waitFor("document.querySelector('.arena-tabs') !== null", 5_000);
  await clickArenaButton(run, null, "Ladder");
  await run.page.waitFor("document.querySelectorAll('.arena-row').length > 0", 5_000);
  const ladder = await readout(run);
  run.check("ladder: your row is highlighted once", ladder.youRows === 1, {
    rows: ladder.rows,
    youRows: ladder.youRows,
  });
  layoutChecks(run, ladder, "ladder");
  await run.shot("screen-ladder");
}

async function stateFlows(run: Run): Promise<void> {
  const cases: { state: string; expect: string }[] = [
    { state: "unavailable", expect: "not open yet" },
    { state: "error", expect: "Try again" },
    { state: "empty", expect: "No fights yet" },
  ];
  for (const c of cases) {
    await run.page.open(`${DEV_URL}/?view=screen&state=${c.state}`);
    await run.page.waitFor("document.querySelector('.arena-root') !== null", 20_000);
    await run.page.waitFor("!document.body.innerText.includes('Loading the arena')", 10_000);
    const r = await readout(run);
    run.check(
      `state ${c.state}: shows "${c.expect}"`,
      r.bodyText.includes(c.expect),
      r.bodyText.slice(0, 160),
    );
    layoutChecks(run, r, `state ${c.state}`);
    await run.shot(`state-${c.state}`);
  }
}

async function replayPage(run: Run): Promise<void> {
  await run.page.open(`${DEV_URL}/?view=replay`);
  await run.page.waitFor("document.querySelector('.arena-lane') !== null", 20_000);
  await run.page.wait(1_200);
  const mid = await readout(run);
  run.check("dev replay plays: tick advances", mid.tick !== null && mid.tick > 0, mid.tick);
  await run.shot("dev-replay-mid");
  await clickArenaButton(run, null, "Skip to result");
  await run.page.wait(300);
  const end = await readout(run);
  run.check("dev replay result banner", end.banner !== null, end.banner);
  layoutChecks(run, end, "dev replay");
  await run.shot("dev-replay-result");
}

/** The real app shell: picker -> Arena. A soft check, skipped when the picker is not reachable. */
async function appFlow(run: Run): Promise<void> {
  try {
    await openPicker(run);
  } catch {
    run.check("app shell reachable (skipped: not the game server)", true, run.args.url, true);
    return;
  }
  try {
    await pickMode(run, "Arena");
  } catch {
    run.check("picker lists Arena (soft)", false, "no Arena entry in the picker bar", true);
    return;
  }
  // The sheet lazy-loads ArenaScreen: wait for its status, not the "Loading..." placeholder.
  const rendered = await run.page
    .waitFor(
      "document.querySelector('.arena-root') !== null && !document.body.innerText.includes('Loading the arena')",
      20_000,
    )
    .then(() => true)
    .catch(() => false);
  run.check(
    "app arena: screen rendered (not the lazy placeholder)",
    rendered,
    "waited 20 s for .arena-root",
    true,
  );
  await run.shot("app-arena");
  const r = await readout(run);
  layoutChecks(run, r, "app arena");
}

export const ARENA_RUNNERS: Record<string, Runner> = {
  arena: async (run) => {
    await screenFlow(run);
    await stateFlows(run);
    await replayPage(run);
    await appFlow(run);
  },
};

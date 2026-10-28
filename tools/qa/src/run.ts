/**
 * Ready-made browser QA scenarios against the dev server (default
 * http://127.0.0.1:5173). Prints one JSON report to stdout; screenshots go to
 * --out (default /tmp/gamez-qa/<scenario>[-args]). Exit code 0 when every
 * hard check passed, 1 otherwise, 2 for bad usage.
 *
 *   node tools/qa/src/run.ts picker
 *   node tools/qa/src/run.ts classic-start warrior
 *   node tools/qa/src/run.ts classic-idle warrior 1 8
 *   node tools/qa/src/run.ts classic-features warrior
 *   node tools/qa/src/run.ts gallery [--all-facings]
 *   node tools/qa/src/run.ts panels [class]
 *   node tools/qa/src/run.ts classic-create [class]
 *   node tools/qa/src/run.ts steps | duel | plaza
 *
 * Options: --out <dir>  --viewport desktop|phone  --url <base>  --seed <n>
 *          --strict (console errors fail the run)  --verbose (page console to stderr)
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  launch,
  VIEWPORTS,
  waitForServer,
  type ConsoleEntry,
  type Page,
  type ViewportName,
} from "./cdp.ts";
import {
  PERF_PROBE_SOURCE,
  splitMissingIds,
  summarisePerf,
  type PerfProbe,
  type PerfSummary,
} from "./analysis.ts";

interface Args {
  scenario: string;
  positional: string[];
  out: string | null;
  viewport: ViewportName;
  url: string;
  seed: number;
  strict: boolean;
  verbose: boolean;
  allFacings: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  /** Warnings are reported but never fail the run. */
  warn?: boolean;
  detail?: unknown;
}

export interface QaReport {
  scenario: string;
  args: string[];
  viewport: ViewportName;
  url: string;
  ok: boolean;
  error?: string;
  startedAt: string;
  durationMs: number;
  outDir: string;
  screenshots: { name: string; path: string }[];
  checks: Check[];
  samples: unknown[];
  data: Record<string, unknown>;
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
}

const SCENARIOS = [
  "picker",
  "classic-start",
  "classic-create",
  "classic-idle",
  "classic-features",
  "classic-boss",
  "gallery",
  "panels",
  "steps",
  "duel",
  "plaza",
] as const;

function usage(msg?: string): never {
  if (msg) process.stderr.write(`${msg}\n\n`);
  process.stderr.write(
    "usage: node tools/qa/src/run.ts <scenario> [args] [--out dir] [--viewport desktop|phone] [--url base] [--seed n] [--strict] [--verbose]\n" +
      `scenarios: ${SCENARIOS.join(", ")}\n` +
      "  classic-start <class>                 class: warrior | rogue | sorcerer\n" +
      "  classic-idle <class> <minutes> <speed> speed: 1 | 2 | 4 | 8\n" +
      "  classic-features <class>              cheats (?debug=1&cheats=1): talents, smith, gambler, sets, rift\n" +
      "  classic-boss <class>                  cheats: a boss beside the hero, its telegraphs, phases and shake\n" +
      "  gallery [--all-facings]\n" +
      "  panels [class], classic-create [class]\n",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const a: Omit<Args, "scenario" | "positional"> = {
    out: null,
    viewport: "desktop",
    url: process.env.GAMEZ_QA_URL ?? "http://127.0.0.1:5173",
    seed: 4242,
    strict: false,
    verbose: false,
    allFacings: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] ?? "";
    const next = (): string => {
      const n = argv[++i];
      if (n === undefined) usage(`missing value for ${v}`);
      return n;
    };
    switch (v) {
      case "--out":
        a.out = next();
        break;
      case "--viewport": {
        const n = next();
        if (n !== "desktop" && n !== "phone") usage(`unknown viewport ${n}`);
        a.viewport = n;
        break;
      }
      case "--url":
        a.url = next().replace(/\/+$/, "");
        break;
      case "--seed":
        a.seed = Number(next());
        break;
      case "--strict":
        a.strict = true;
        break;
      case "--verbose":
        a.verbose = true;
        break;
      case "--all-facings":
        a.allFacings = true;
        break;
      case "-h":
      case "--help":
        usage();
        break;
      default:
        if (v.startsWith("--")) usage(`unknown option ${v}`);
        positional.push(v);
    }
  }
  const scenario = positional.shift();
  if (!scenario) usage();
  if (!(SCENARIOS as readonly string[]).includes(scenario)) usage(`unknown scenario ${scenario}`);
  return { scenario, positional, ...a };
}

/** Collects screenshots, checks and samples for one run. */
class Run {
  readonly page: Page;
  readonly report: QaReport;
  readonly args: Args;
  private shotIndex = 0;
  /** Page-time stretches the harness froze the page for (screenshots), for the perf split. */
  readonly pauses: [number, number][] = [];

  constructor(page: Page, report: QaReport, args: Args) {
    this.page = page;
    this.report = report;
    this.args = args;
  }

  async shot(name: string): Promise<string> {
    const file = `${String(++this.shotIndex).padStart(2, "0")}-${name.replace(/[^a-z0-9_.-]+/gi, "_")}.png`;
    // The page freezes while a screenshot is taken: its frame gap is the harness's, not the game's.
    const from = await this.page.evaluate<number>("performance.now()");
    const path = await this.page.screenshot(join(this.report.outDir, file));
    const to = await this.page.evaluate<number>("performance.now()");
    this.pauses.push([from, to]);
    this.report.screenshots.push({ name, path });
    return path;
  }

  check(name: string, ok: boolean, detail?: unknown, warn = false): boolean {
    const c: Check = { name, ok };
    if (warn) c.warn = true;
    if (detail !== undefined) c.detail = detail;
    this.report.checks.push(c);
    return ok;
  }

  sample(value: unknown): void {
    this.report.samples.push(value);
  }

  url(query: string): string {
    return `${this.args.url}/${query ? `?${query}` : ""}`;
  }
}

// ---- shared steps -------------------------------------------------------------------

async function openPicker(run: Run, query = "debug=1"): Promise<void> {
  await run.page.open(run.url(query));
  await run.page.waitFor("document.querySelectorAll('.mode-card').length > 0", 30_000);
}

async function pickMode(run: Run, name: string): Promise<void> {
  await run.page.clickText(name, { exact: true, timeoutMs: 10_000 });
}

function classArg(run: Run, i = 0): string {
  const c = run.args.positional[i] ?? "warrior";
  if (!/^[a-z_.]+$/i.test(c)) usage(`bad class ${c}`);
  return c;
}

/**
 * Opens classic with ?debug, ?seed, ?class, ?autostart and waits for the hero.
 * `cheats` adds ?cheats=1 (the QA grant action, classic.debug).
 */
async function startClassic(run: Run, cls: string, opts: { cheats?: boolean } = {}): Promise<void> {
  const cheats = opts.cheats === true ? "&cheats=1" : "";
  const q = `debug=1&seed=${run.args.seed}&class=${encodeURIComponent(cls)}&autostart=1${cheats}`;
  await openPicker(run, q);
  await pickMode(run, "Classic");
  await run.page.waitFor(
    "window.__gamez?.mode === 'classic' && window.__gamez.sim?.hero != null",
    45_000,
  );
  // Let the first chunks build and the camera settle.
  await run.page.waitFor("(window.__gamez.render?.chunks ?? 0) > 0", 15_000);
  await run.page.wait(800);
}

interface SimView {
  tick: number;
  phase: string;
  depth: number;
  area: { name: string; isTown: boolean; exploredPct: number; killed: number } | null;
  hero: {
    class: string;
    level: number;
    xp: number;
    life: number;
    lifeMax: number;
    mana: number;
    gold: number;
    potions: number;
    dead: boolean;
  } | null;
  counts: Record<string, number>;
  control: { mode: string; speed: number; overridden: boolean } | null;
  autoState: { plan: string; todo: string[] } | null;
  eventCounts: Record<string, number>;
  casts: Record<string, number>;
  effects: Record<string, number>;
  runStats: Record<string, number> | null;
}

interface RenderView {
  fps: number;
  frameMs: { avg: number; p95: number; max: number };
  tickMs: { avg: number; p95: number };
  entities: number;
  entitiesDrawn: number;
  primitivesDrawn: number;
  chunks: number;
  chunksBuilt: number;
  missingIds: string[];
  labelsVisible: Record<string, number>;
  animationsSeen: Record<string, string>;
  effectsSeen: Record<string, string>;
  effectsPlayed: number;
  floatsShown: number;
  shakes?: number;
}

const simOf = (run: Run): Promise<SimView> => run.page.evaluate<SimView>("window.__gamez.sim");
const renderOf = (run: Run): Promise<RenderView | null> =>
  run.page.evaluate<RenderView | null>("window.__gamez.render ?? null");
const uiOf = (
  run: Run,
): Promise<{ panels: string[]; error: { code: string; message: string } | null }> =>
  run.page.evaluate(
    "(() => { const u = window.__gamez.ui; return { panels: u.panels, error: u.error }; })()",
  );

function compactSample(t: number, s: SimView, r: RenderView | null): Record<string, unknown> {
  return {
    t,
    tick: s.tick,
    depth: s.depth,
    area: s.area?.name ?? null,
    explored: s.area?.exploredPct ?? null,
    level: s.hero?.level ?? null,
    xp: s.hero?.xp ?? null,
    life: s.hero ? `${s.hero.life}/${s.hero.lifeMax}` : null,
    gold: s.hero?.gold ?? null,
    potions: s.hero?.potions ?? null,
    dead: s.hero?.dead ?? null,
    plan: s.autoState?.plan ?? null,
    mode: s.control ? `${s.control.mode} x${s.control.speed}` : null,
    monstersAlive: s.counts.monstersAlive,
    slain: s.counts.slain,
    loot: s.counts.lootOnGround,
    projectiles: s.counts.projectiles,
    fps: r?.fps ?? null,
    frameP95: r?.frameMs.p95 ?? null,
    drawn: r?.entitiesDrawn ?? null,
    labels: r?.labelsVisible ?? null,
    // Absent until the renderer exposes the marker label kind; never required.
    labelMarker: r?.labelsVisible?.marker ?? null,
  };
}

function renderSummary(r: RenderView | null): Record<string, unknown> | null {
  if (!r) return null;
  const split = splitMissingIds(r.missingIds);
  return {
    fps: r.fps,
    frameMs: r.frameMs,
    tickMs: r.tickMs,
    entities: r.entities,
    entitiesDrawn: r.entitiesDrawn,
    primitivesDrawn: r.primitivesDrawn,
    chunks: r.chunks,
    chunksBuilt: r.chunksBuilt,
    missingIds: r.missingIds,
    missingArtIds: split.art,
    missingIconIds: split.icons,
    labelsVisible: r.labelsVisible,
    effectsPlayed: r.effectsPlayed,
    floatsShown: r.floatsShown,
    shakes: r.shakes ?? null,
  };
}

/**
 * Installs the perf probe before the page loads (boot included). Long frames and
 * longtasks are then split into boot (first 5 s) and steady state.
 */
async function installPerfProbe(run: Run): Promise<void> {
  await run.page.send("Page.addScriptToEvaluateOnNewDocument", { source: PERF_PROBE_SOURCE });
}

async function readPerf(run: Run): Promise<PerfSummary> {
  const probe = await run.page.evaluate<PerfProbe | null>(
    "(() => { const p = window.__qaPerf ?? null; return p ? { frames: p.frames, longtasks: p.longtasks, nowMs: performance.now() } : null; })()",
  );
  return summarisePerf(probe, run.pauses);
}

/** Records the perf split in data.perf and adds the warn-only frame check. */
function reportPerf(run: Run, perf: PerfSummary): void {
  run.report.data.perf = perf;
  run.check(
    "no frame over 100 ms after the first 5 s",
    perf.installed && perf.longFrames.steady.count === 0,
    {
      installed: perf.installed,
      documentMs: perf.documentMs,
      boot: perf.longFrames.boot,
      steady: perf.longFrames.steady,
    },
    true,
  );
}

/** Animations and effects that did not resolve to their own art. */
function artProblems(r: RenderView | null): { animations: string[]; effects: string[] } {
  if (!r) return { animations: [], effects: [] };
  const animations = Object.entries(r.animationsSeen)
    .filter(([, v]) => !v.endsWith("(exact)"))
    .map(([k, v]) => `${k} -> ${v}`);
  const effects = Object.entries(r.effectsSeen)
    .filter(([, v]) => v !== "sprite")
    .map(([k, v]) => `${k} -> ${v}`);
  return { animations, effects };
}

// ---- scenarios ----------------------------------------------------------------------

async function picker(run: Run): Promise<void> {
  await openPicker(run, "");
  await run.page.wait(300);
  await run.shot("picker");
  const modes = await run.page.evaluate<{ name: string; description: string; disabled: boolean }[]>(
    `[...document.querySelectorAll('.mode-card')].map((b) => ({
      name: b.querySelector('.mode-name')?.textContent ?? '',
      description: b.querySelector('.mode-desc')?.textContent ?? '',
      disabled: b.disabled,
    }))`,
  );
  run.report.data.modes = modes;
  for (const want of ["Classic", "Duel", "Steps", "Town Plaza"]) {
    const m = modes.find((x) => x.name === want);
    run.check(`mode "${want}" listed and available`, !!m && !m.disabled, m);
  }
  const layout = await run.page.evaluate<{
    scrollW: number;
    innerW: number;
    smallTargets: string[];
  }>(
    `(() => {
      const small = [...document.querySelectorAll('button')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && (r.height < 44 || r.width < 44);
      }).map((b) => (b.innerText || b.getAttribute('aria-label') || '').slice(0, 40));
      return { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, smallTargets: small };
    })()`,
  );
  run.check("no horizontal page scroll", layout.scrollW <= layout.innerW, layout, true);
  run.check("touch targets >= 44px", layout.smallTargets.length === 0, layout.smallTargets, true);
}

async function classicStart(run: Run): Promise<void> {
  const cls = classArg(run);
  await installPerfProbe(run);
  await startClassic(run, cls);
  await run.shot(`town-${cls}`);
  const s = await simOf(run);
  const r = await renderOf(run);
  run.sample(compactSample(0, s, r));
  run.check(
    "hero created with the requested class",
    s.hero?.class === `classic.${cls}`,
    s.hero?.class,
  );
  run.check("in town", s.area?.isTown === true, s.area);
  run.check(
    "world drawn (chunks and entities)",
    (r?.chunks ?? 0) > 0 && (r?.entitiesDrawn ?? 0) > 0,
    renderSummary(r),
  );
  const art = splitMissingIds(r?.missingIds ?? []);
  run.check(
    "no missing art ids",
    art.art.length === 0,
    { art: art.art, iconsInfo: art.icons.length },
    true,
  );
  run.check(
    "no primitive placeholders drawn",
    (r?.primitivesDrawn ?? 0) === 0,
    r?.primitivesDrawn,
    true,
  );
  run.check("NPC nameplates visible", (r?.labelsVisible.npc ?? 0) > 0, r?.labelsVisible, true);
  await run.page.wait(3_000);
  await run.shot(`town-${cls}-3s`);
  const s2 = await simOf(run);
  const r2 = await renderOf(run);
  run.sample(compactSample(3, s2, r2));
  run.check("sim advancing", s2.tick > s.tick, { before: s.tick, after: s2.tick });
  run.report.data.render = renderSummary(r2);
  run.report.data.artProblems = artProblems(r2);
  run.report.data.sim = s2;
  reportPerf(run, await readPerf(run));
}

async function classicCreate(run: Run): Promise<void> {
  const cls = classArg(run);
  // A seeded run ignores any save, so the new-hero screen always shows.
  await openPicker(run, `debug=1&seed=${run.args.seed}`);
  await pickMode(run, "Classic");
  await run.page.waitFor("window.__gamez?.mode === 'classic'", 45_000);
  await run.page.waitFor("window.__gamez.hud.phase === 'choose'", 10_000);
  await run.page.wait(500);
  await run.shot("new-hero-screen");
  const name = cls.charAt(0).toUpperCase() + cls.slice(1);
  await run.page.clickText(name, { exact: true });
  await run.page.wait(200);
  const nameBox = await run.page.evaluate<{ x: number; y: number } | null>(
    `(() => { const el = document.querySelector('input[aria-label="Hero name"]');
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  run.check("hero name input present", nameBox !== null);
  if (nameBox) {
    if (run.page.viewport.touch) await run.page.tap(nameBox.x, nameBox.y);
    else await run.page.click(nameBox.x, nameBox.y);
    await run.page.evaluate(
      "(() => { const el = document.querySelector('input[aria-label=\"Hero name\"]'); el.select(); })()",
    );
    await run.page.type("Tester");
  }
  await run.shot("new-hero-filled");
  await run.page.clickText("Begin the journey", { exact: true });
  await run.page.waitFor("window.__gamez.sim?.hero != null", 10_000);
  await run.page.wait(1_000);
  await run.shot("after-create");
  const s = await simOf(run);
  run.check("hero created via the UI", s.hero?.class === `classic.${cls}`, s.hero);
  run.report.data.sim = s;
}

/**
 * Runs one sampling step of a long scenario. A dev-server reload (live edits)
 * drops the game and the page goes back to the mode picker, so `recover` starts
 * the scenario again (the same seed) and redoes the step. Reloads are counted
 * in data.reloads.
 */
async function recoverFromReload<T>(
  run: Run,
  step: () => Promise<T>,
  recover: () => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      if (attempt >= 4) throw err;
      run.report.data.reloads = ((run.report.data.reloads as number) ?? 0) + 1;
      await recover();
    }
  }
}

/** Cumulative counters of window.__gamez.counters (debug.ts): see tools/qa/README.md. */
interface QaCounters {
  tick: number;
  ticksTotal: number;
  events: Record<string, number>;
  slain: number;
  heroDeaths: number;
  /** Stairs-down descents (wave A debug counters). */
  descents?: number;
}

const countersOf = (run: Run): Promise<QaCounters | null> =>
  run.page.evaluate<QaCounters | null>("window.__gamez?.counters ?? null");

/**
 * Totals of one run from two counter reads. Null when the page reloaded in
 * between (the probe restarts with the page, so the deltas would be wrong).
 */
function countersTotals(
  start: QaCounters | null,
  end: QaCounters | null,
  reloadsAtStart: number,
  run: Run,
): {
  ticks: number;
  slain: number;
  heroDeaths: number;
  descents: number;
  events: Record<string, number>;
} | null {
  const reloads = (run.report.data.reloads as number) ?? 0;
  if (!start || !end || reloads !== reloadsAtStart) return null;
  const events: Record<string, number> = {};
  for (const [type, n] of Object.entries(end.events)) {
    const d = n - (start.events[type] ?? 0);
    if (d !== 0) events[type] = d;
  }
  return {
    ticks: end.ticksTotal - start.ticksTotal,
    slain: end.slain - start.slain,
    heroDeaths: end.heroDeaths - start.heroDeaths,
    descents: (end.descents ?? 0) - (start.descents ?? 0),
    events,
  };
}

async function classicIdle(run: Run): Promise<void> {
  const cls = classArg(run);
  const minutes = Number(run.args.positional[1] ?? "1");
  const speed = Number(run.args.positional[2] ?? "8");
  if (!(minutes > 0 && minutes <= 120)) usage(`bad minutes ${String(run.args.positional[1])}`);
  if (![1, 2, 4, 8].includes(speed)) usage(`bad speed ${String(run.args.positional[2])}`);
  await installPerfProbe(run);
  await startClassic(run, cls);
  await run.shot("start");
  const restoreIdle = async (): Promise<void> => {
    await startClassic(run, cls);
    await run.page.evaluate(
      `(() => { const c = window.__gamez.controls; c.setMode('idle'); c.setSpeed(${speed}); })()`,
    );
  };
  const modeRes = await run.page.evaluate<{ ok: boolean; error?: unknown }>(
    "window.__gamez.controls.setMode('idle')",
  );
  run.check("setMode(idle) accepted", modeRes.ok, modeRes.error);
  const speedRes = await run.page.evaluate<{ ok: boolean; error?: unknown }>(
    `window.__gamez.controls.setSpeed(${speed})`,
  );
  run.check(`setSpeed(${speed}) accepted`, speedRes.ok, speedRes.error);

  const totalMs = minutes * 60_000;
  const sampleEvery = Math.max(5_000, Math.min(30_000, totalMs / 12));
  const shotEvery = Math.max(10_000, totalMs / 6);
  const first = await simOf(run);
  // Cumulative counters (debug.ts `counters`): ticks and event totals that a ring buffer cannot drop.
  const countersStart = await countersOf(run);
  const reloadsAtStart = (run.report.data.reloads as number) ?? 0;
  const t0 = performance.now();
  let lastShot = t0;
  let lastTick = first.tick;
  let lastT = t0;
  /** The sample the "sim advanced" check counts from (moves after a reload: a new sim starts low). */
  let base = first;
  const tickRates: number[] = [];
  const uiErrors = new Map<string, number>();
  const depths = new Set<number>();
  let maxDepth = first.depth;
  run.sample(compactSample(0, first, await renderOf(run)));
  for (;;) {
    const now = performance.now();
    const left = t0 + totalMs - now;
    if (left <= 0) break;
    await run.page.wait(Math.min(sampleEvery, left));
    const reloadsBefore = (run.report.data.reloads as number) ?? 0;
    const { s, r, ui } = await recoverFromReload(
      run,
      async () => ({ s: await simOf(run), r: await renderOf(run), ui: await uiOf(run) }),
      restoreIdle,
    );
    const tNow = performance.now();
    const reloaded = ((run.report.data.reloads as number) ?? 0) !== reloadsBefore;
    const rate = ((s.tick - lastTick) * 1000) / Math.max(1, tNow - lastT);
    if (reloaded) {
      base = s;
    } else {
      tickRates.push(Math.round(rate));
    }
    lastTick = s.tick;
    lastT = tNow;
    depths.add(s.depth);
    maxDepth = Math.max(maxDepth, s.depth);
    if (ui.error) {
      const k = `${ui.error.code}: ${ui.error.message}`;
      uiErrors.set(k, (uiErrors.get(k) ?? 0) + 1);
    }
    run.sample({
      ...compactSample(Math.round((tNow - t0) / 1000), s, r),
      ticksPerSec: reloaded ? null : Math.round(rate),
    });
    if (tNow - lastShot >= shotEvery - 500) {
      lastShot = tNow;
      await run.shot(`t${Math.round((tNow - t0) / 1000)}s-d${s.depth}`);
    }
  }
  await run.shot("end");
  const fin = await recoverFromReload(
    run,
    async () => ({
      s: await simOf(run),
      r: await renderOf(run),
      c: await countersOf(run),
    }),
    restoreIdle,
  );
  const last = fin.s;
  const r = fin.r;
  const target = 20 * speed;
  const avgRate = tickRates.length ? tickRates.reduce((a, b) => a + b, 0) / tickRates.length : 0;
  const totals = countersTotals(countersStart, fin.c, reloadsAtStart, run);
  run.report.data.counters = { start: countersStart, end: fin.c, totals };
  run.report.data.final = last;
  run.report.data.render = renderSummary(r);
  run.report.data.artProblems = artProblems(r);
  run.report.data.animationsSeen = r?.animationsSeen ?? {};
  run.report.data.effectsSeen = r?.effectsSeen ?? {};
  run.report.data.tickRates = tickRates;
  run.report.data.depthsVisited = [...depths].sort((a, b) => a - b);
  run.report.data.uiErrors = Object.fromEntries(uiErrors);
  run.check("still in idle mode", last.control?.mode === "idle", last.control);
  run.check(
    "cumulative counters advanced with the sim",
    // Count from the later of the two start reads: the sim keeps ticking between
    // the first sample and the counters' start read.
    totals === null ||
      (totals.ticks > 0 &&
        totals.ticks >= last.tick - Math.max(base.tick, countersStart?.tick ?? base.tick)),
    totals ?? "counters unavailable (reload during run)",
    true,
  );
  run.check("sim advanced", last.tick > base.tick, {
    from: base.tick,
    to: last.tick,
    reloads: (run.report.data.reloads as number) ?? 0,
  });
  run.check(
    `sim rate near ${target} ticks/s (software GL: relative only)`,
    avgRate >= target * 0.5,
    { avg: Math.round(avgRate), target },
    true,
  );
  run.check(
    "hero progressed (xp, kills or depth)",
    (last.hero?.xp ?? 0) > (first.hero?.xp ?? 0) ||
      (last.counts.slain ?? 0) > 0 ||
      maxDepth > first.depth ||
      (last.hero?.level ?? 0) > (first.hero?.level ?? 0),
    {
      level: [first.hero?.level, last.hero?.level],
      xp: [first.hero?.xp, last.hero?.xp],
      slain: last.counts.slain,
      maxDepth,
    },
  );
  run.check("left town at least once", maxDepth > 0, { maxDepth }, true);
  // Descents are the stairs-down area changes (classic.area.changed via stairsDown), counted by the probe.
  const descents = totals?.descents ?? null;
  run.report.data.descents = descents;
  run.check("descended at least once", (descents ?? 0) > 0, { descents }, true);
  const art = splitMissingIds(r?.missingIds ?? []);
  run.check(
    "no missing art ids",
    art.art.length === 0,
    { art: art.art, iconsInfo: art.icons.length },
    true,
  );
  run.check("no client errors shown", uiErrors.size === 0, Object.fromEntries(uiErrors), true);
  reportPerf(run, await readPerf(run));
}

/**
 * Runs one gallery step. The dev server reloads the page on live edits, which
 * drops the gallery mid-run. A failed step waits for the gallery to be ready
 * again and redoes itself (every step re-shows its page first). Retries are
 * counted in data.galleryRetries.
 */
async function galleryStep<T>(run: Run, step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      if (attempt >= 3) throw err;
      run.report.data.galleryRetries = ((run.report.data.galleryRetries as number) ?? 0) + 1;
      await run.page.waitFor("window.__gamez?.gallery?.ready === true", 45_000);
    }
  }
}

async function gallery(run: Run): Promise<void> {
  await run.page.open(run.url("qa=gallery&debug=1"));
  await galleryStep(run, () => run.page.waitFor("window.__gamez?.gallery?.ready === true", 45_000));
  await run.page.wait(800);
  const sections = await galleryStep(run, () =>
    run.page.evaluate<{ id: string; title: string; pages: number; cells: number }[]>(
      "window.__gamez.gallery.sections",
    ),
  );
  run.report.data.sections = sections;
  const unitSections = new Set(["heroes", "monsters", "bosses", "npcs"]);
  for (const s of sections) {
    for (let p = 0; p < s.pages; p++) {
      const facings =
        run.args.allFacings && unitSections.has(s.id)
          ? ["s", "sw", "w", "nw", "n", "ne", "e", "se"]
          : ["se"];
      for (const f of facings) {
        const suffix = facings.length > 1 ? `-${f}` : "";
        await galleryStep(run, async () => {
          await run.page.evaluate(
            `(() => { const g = window.__gamez.gallery; g.show(${JSON.stringify(s.id)}, ${p}); g.setFacing(${JSON.stringify(f)}); })()`,
          );
          await run.page.wait(450);
          await run.page.evaluate("window.__gamez.gallery.replay()");
          await run.page.wait(250);
          await run.shot(`${s.id}-p${p + 1}${suffix}`);
        });
      }
    }
  }
  const report = await galleryStep(run, () =>
    run.page.evaluate<{
      summary: {
        cells: number;
        byWorstKind: Record<string, number>;
        problems: string[];
        actionFallbacks: string[];
        unusedArt: string[];
      };
      cells: unknown[];
    }>("window.__gamez.gallery.report()"),
  );
  run.report.data.summary = report.summary;
  run.report.data.cells = report.cells;
  run.report.data.render = renderSummary(await renderOf(run));
  run.check("gallery lists cells", report.summary.cells > 0, report.summary.cells);
  run.check(
    "every id resolves to real art",
    report.summary.problems.length === 0,
    report.summary.problems,
    true,
  );
  run.check(
    "every action has its own animation",
    report.summary.actionFallbacks.length === 0,
    report.summary.actionFallbacks.length,
    true,
  );
}

const PANEL_KEYS: [string, string][] = [
  ["c", "character"],
  ["i", "inventory"],
  ["s", "skills"],
  ["l", "quests"],
  ["Tab", "map"],
];

async function panels(run: Run): Promise<void> {
  const cls = classArg(run);
  await startClassic(run, cls);
  await run.page.evaluate("window.__gamez.controls.setMode('manual')");
  await run.page.wait(300);
  const results: Record<string, unknown> = {};
  for (const [key, panel] of PANEL_KEYS) {
    await run.page.press(key);
    await run.page.wait(450);
    const ui = await uiOf(run);
    results[panel] = ui.panels;
    run.check(`key ${key} opens ${panel}`, ui.panels.includes(panel), ui.panels);
    await run.shot(`panel-${panel}`);
    await run.page.press("Escape");
    await run.page.wait(200);
  }
  for (const panel of ["settings", "log"]) {
    await run.page.evaluate(`window.__gamez.controls.openPanel(${JSON.stringify(panel)})`);
    await run.page.wait(400);
    const ui = await uiOf(run);
    run.check(`${panel} panel opens`, ui.panels.includes(panel), ui.panels);
    await run.shot(`panel-${panel}`);
    await run.page.evaluate("window.__gamez.controls.closeAll()");
    await run.page.wait(200);
  }
  // NPCs and stations: the hero walks there (kernel action) and the panel opens.
  // panel null = no panel by design (the healer heals on contact): wait for its npc.opened event.
  const targets: [string, string | null][] = [
    ["smith", "vendor"],
    ["alchemist", "vendor"],
    ["junk", "vendor"],
    ["healer", null],
    ["quest", "quests"],
    ["stash", "stash"],
    ["waypoint", "waypoint"],
  ];
  for (const [target, panel] of targets) {
    const res = await run.page.evaluate<{ ok: boolean; error?: unknown }>(
      `window.__gamez.controls.interact(${JSON.stringify(target)})`,
    );
    if (!res.ok) {
      run.check(`interact ${target}`, false, res.error);
      continue;
    }
    const done =
      panel === null
        ? `window.__gamez.sim.lastEvents.some((e) => e.type === 'classic.npc.opened' && e.role === ${JSON.stringify(target)})`
        : "window.__gamez.ui.panels.length > 0";
    let reached = true;
    try {
      await run.page.waitFor(done, 25_000);
    } catch {
      reached = false;
    }
    await run.page.wait(400);
    const ui = await uiOf(run);
    results[target] = ui.panels;
    if (panel === null) {
      const hero = (await simOf(run)).hero;
      run.check(`${target} reached (no panel by design)`, reached, {
        panels: ui.panels,
        life: hero ? `${hero.life}/${hero.lifeMax}` : null,
      });
    } else {
      run.check(`${target} opens ${panel}`, reached && ui.panels.includes(panel), ui.panels);
    }
    await run.shot(`npc-${target}`);
    await run.page.evaluate("window.__gamez.controls.closeAll()");
    await run.page.wait(250);
  }
  run.report.data.panels = results;
  run.report.data.render = renderSummary(await renderOf(run));
}

/** Ticks a queued cheat grant needs to land (manual x1 runs 20 ticks per second). */
const GRANT_WAIT_MS = 1500;

/**
 * classic-features <class>: the wave A systems in one run (cheats on). Late-game
 * grants, then talents (N), the smith (vendor, craft, repair, upgrade, socket),
 * the gambler, stash tabs, the loot filter, settings, character, achievements
 * (Y), the rift (locked, unlocked, a level opened, its guardian reached on
 * auto). Every panel gets a screenshot (use --viewport phone for the phone layout).
 * Actions are checked for "accepted or refused by a rule", never for a crash.
 */
async function classicFeatures(run: Run): Promise<void> {
  const cls = classArg(run);
  await startClassic(run, cls, { cheats: true });
  await run.page.evaluate("window.__gamez.controls.setMode('manual')");
  await run.page.wait(300);
  const data: Record<string, unknown> = {};
  run.report.data.features = data;

  const actRes = (
    name: string,
    payload: unknown,
  ): Promise<{ ok: boolean; error?: { code: string; message: string } }> =>
    run.page.evaluate(
      `window.__gamez.controls.act(${JSON.stringify(name)}, ${JSON.stringify(payload)})`,
    );
  /** Accepted, or refused by a game rule (not an unknown action or a client crash). */
  const ruleOk = (r: { ok: boolean; error?: { code: string } }): boolean =>
    r.ok || !["unknown_action", "internal", "client"].includes(r.error?.code ?? "");
  const hud = <T>(expr: string): Promise<T> => run.page.evaluate<T>(`window.__gamez.hud.${expr}`);
  const hasPanel = async (p: string): Promise<boolean> => (await uiOf(run)).panels.includes(p);

  /** Walks to a station or NPC through the kernel and waits for its panel. */
  const interactPanel = async (target: string, panel: string): Promise<void> => {
    const res = await run.page.evaluate<{ ok: boolean; error?: unknown }>(
      `window.__gamez.controls.interact(${JSON.stringify(target)})`,
    );
    if (!res.ok) {
      run.check(`interact ${target}`, false, res.error);
      return;
    }
    let reached = true;
    try {
      await run.page.waitFor(`window.__gamez.ui.panels.includes(${JSON.stringify(panel)})`, 25_000);
    } catch {
      reached = false;
    }
    await run.page.wait(400);
    run.check(`${target} opens ${panel}`, reached, (await uiOf(run)).panels);
  };

  // 1. Late-game grants: gold, ten levels, talent points, rare items, gems.
  const grant = await run.page.evaluate<{ ok: boolean; error?: unknown }>(
    `window.__gamez.controls.cheat(${JSON.stringify({
      gold: 5000,
      levels: 10,
      talentPoints: 5,
      items: { count: 6, rarity: "rare", ilvl: 12 },
      gems: 4,
    })})`,
  );
  run.check("cheat grant accepted", grant.ok, grant.error);
  await run.page.wait(GRANT_WAIT_MS);
  const after = await simOf(run);
  run.check("grant raised the level", (after.hero?.level ?? 0) >= 11, { level: after.hero?.level });

  // 2. Talents (N).
  await run.page.press("n");
  await run.page.wait(400);
  run.check("N opens talents", await hasPanel("talents"), (await uiOf(run)).panels);
  await run.shot("talents");
  const learnable = await hud<string | null>("talents?.nodes.find((n) => n.learnable)?.id ?? null");
  if (learnable === null) {
    run.check("a talent node is learnable after the grant", false, await hud("talents"), true);
  } else {
    const r = await actRes("classic.learnTalent", { node: learnable });
    data.learnTalent = { node: learnable, ok: r.ok, code: r.error?.code ?? null };
    run.check("learnTalent accepted or refused by a rule", ruleOk(r), r.error);
    await run.page.wait(300);
    await run.shot("talents-learned");
  }
  await run.page.press("Escape");
  await run.page.wait(200);

  // 3. Smith: vendor, craft panel, repair everything, upgrade and socket the first bag item.
  await interactPanel("smith", "vendor");
  await run.shot("smith-vendor");
  await run.page.evaluate("window.__gamez.controls.openPanel('craft')");
  await run.page.wait(400);
  run.check("craft panel opens by the smith", await hasPanel("craft"), (await uiOf(run)).panels);
  await run.shot("smith-craft");
  const smithNpc = await hud<number | null>("vendor?.npc ?? null");
  const bagUid = await hud<number | null>("inventory.items[0]?.item.uid ?? null");
  if (smithNpc !== null) {
    const repair = await actRes("classic.repair", { npc: smithNpc, uid: 0 });
    data.repair = { ok: repair.ok, code: repair.error?.code ?? null };
    run.check("repair accepted or refused by a rule", ruleOk(repair), repair.error);
    if (bagUid !== null) {
      const up = await actRes("classic.upgradeItem", { npc: smithNpc, uid: bagUid });
      data.upgrade = { ok: up.ok, code: up.error?.code ?? null };
      run.check("upgrade accepted or refused by a rule", ruleOk(up), up.error);
      const sock = await actRes("classic.addSocket", { npc: smithNpc, uid: bagUid });
      data.addSocket = { ok: sock.ok, code: sock.error?.code ?? null };
      run.check("addSocket accepted or refused by a rule", ruleOk(sock), sock.error);
    }
  }
  await run.page.wait(300);
  await run.shot("smith-after");
  await run.page.evaluate("window.__gamez.controls.closeAll()");
  await run.page.wait(250);

  // 4. Gambler, stash tabs, loot filter, settings, character, achievements.
  await interactPanel("gambler", "gamble");
  await run.shot("gambler");
  await run.page.evaluate("window.__gamez.controls.closeAll()");
  await run.page.wait(250);
  await interactPanel("stash", "stash");
  await run.shot("stash-tabs");
  await run.page.evaluate("window.__gamez.controls.openPanel('lootFilter')");
  await run.page.wait(400);
  run.check("loot filter panel opens", await hasPanel("lootFilter"), (await uiOf(run)).panels);
  await run.shot("loot-filter");
  await run.page.evaluate("window.__gamez.controls.openPanel('settings')");
  await run.page.wait(400);
  await run.shot("settings");
  await run.page.evaluate("window.__gamez.controls.openPanel('character')");
  await run.page.wait(400);
  await run.shot("character");
  await run.page.press("y");
  await run.page.wait(400);
  run.check("Y opens achievements", await hasPanel("achievements"), (await uiOf(run)).panels);
  await run.shot("achievements");
  await run.page.press("Escape");
  await run.page.wait(200);

  // 4b. Sets: every piece of the class's early set (cheat `set`), two worn -> the 2-piece bonus.
  const setId = EARLY_SET[cls] ?? "classic.set.ashen_choir";
  const setGrant = await run.page.evaluate<{ ok: boolean; error?: unknown }>(
    `window.__gamez.controls.cheat(${JSON.stringify({ set: setId })})`,
  );
  run.check("cheat set accepted", setGrant.ok, setGrant.error);
  await run.page.wait(GRANT_WAIT_MS);
  const bonusBefore = await run.page.evaluate<number>(
    "window.__gamez.counters?.events?.['classic.set.bonus'] ?? 0",
  );
  const pieces = await hud<number[]>(
    `inventory.items.filter((p) => p.item.rarity === "set").map((p) => p.item.uid)`,
  );
  const worn: number[] = [];
  for (const uid of pieces) {
    if (worn.length >= 2) break;
    const r = await actRes("classic.equip", { uid, slot: null });
    if (r.ok) worn.push(uid);
    await run.page.wait(150);
  }
  await run.page.wait(400);
  const bonusAfter = await run.page.evaluate<number>(
    "window.__gamez.counters?.events?.['classic.set.bonus'] ?? 0",
  );
  data.sets = { set: setId, pieces: pieces.length, worn: worn.length, bonusBefore, bonusAfter };
  run.check("the set grant gives every piece", pieces.length >= 4, data.sets);
  run.check("two worn set pieces activate the set bonus", bonusAfter > bonusBefore, data.sets);
  await run.page.evaluate("window.__gamez.controls.openPanel('inventory')");
  await run.page.wait(400);
  await run.shot("set-bonus");
  await run.page.evaluate("window.__gamez.controls.closeAll()");
  await run.page.wait(250);

  // 5. Rift: obelisk locked, then unlocked, a level opened, the guardian reached on auto.
  await interactPanel("obelisk", "rift");
  await run.shot("rift-locked");
  data.riftLocked = await hud("rift ?? null");
  await run.page.evaluate("window.__gamez.controls.closeAll()");
  await run.page.wait(250);
  // Rift level 1 monsters are level 20: twelve more levels give the cheat hero a chance.
  const unlock = await run.page.evaluate<{ ok: boolean; error?: unknown }>(
    `window.__gamez.controls.cheat({ unlockRift: true, levels: 12 })`,
  );
  run.check("cheat unlockRift accepted", unlock.ok, unlock.error);
  await run.page.wait(GRANT_WAIT_MS);
  await run.page.evaluate("window.__gamez.controls.openPanel('rift')");
  await run.page.wait(400);
  await run.shot("rift-unlocked");
  const obelisk = await hud<number | null>("rift?.obelisk ?? null");
  if (obelisk !== null && obelisk !== 0) {
    const open = await actRes("classic.openRift", { target: obelisk, level: 1 });
    data.openRift = { ok: open.ok, code: open.error?.code ?? null };
    run.check("openRift accepted or refused by a rule", ruleOk(open), open.error);
    await run.page.wait(800);
    await run.shot("rift-level-1");
    await run.page.evaluate("window.__gamez.controls.setMode('auto')");
    let guardian = true;
    try {
      await run.page.waitFor("window.__gamez.hud.rift?.active?.guardianAlive === true", 8_000);
    } catch {
      guardian = false;
    }
    data.guardianReached = guardian;
    // A cheat hero is rarely geared for the rift: warn only, then fill the bar to check the guardian path.
    run.check("a rift run reaches its guardian (auto)", guardian, await hud("rift ?? null"), true);
    if (!guardian) {
      const fill = await run.page.evaluate<{ ok: boolean; error?: { code: string } }>(
        "window.__gamez.controls.cheat({ riftProgress: 100 })",
      );
      let called = fill.ok;
      if (fill.ok) {
        try {
          await run.page.waitFor("window.__gamez.hud.rift?.active?.guardianAlive === true", 15_000);
        } catch {
          called = false;
        }
      }
      data.guardianByCheat = { fill: fill.ok, code: fill.error?.code ?? null, called };
      // not_in_rift: the run already ended (the hero died first); that is a rule refusal, not a bug.
      run.check(
        "a full progress bar calls the guardian (cheat riftProgress)",
        called || fill.error?.code === "not_in_rift",
        data.guardianByCheat,
      );
    }
    await run.shot("rift-guardian");
    await run.page.evaluate("window.__gamez.controls.setMode('manual')");
    const left = await actRes("classic.leaveRift", {});
    data.leaveRift = { ok: left.ok, code: left.error?.code ?? null };
    run.check("leaveRift accepted or refused by a rule", ruleOk(left), left.error);
    await run.page.wait(500);
    await run.shot("rift-left");
  } else {
    run.check("the obelisk is in reach for the rift run", false, obelisk, true);
  }
  run.report.data.render = renderSummary(await renderOf(run));
  run.report.data.final = await simOf(run);
}

/** The early set of each class (classic-features grants it with the `set` cheat). */
const EARLY_SET: Record<string, string> = {
  warrior: "classic.set.ashen_choir",
  rogue: "classic.set.quicksilver_veil",
  sorcerer: "classic.set.ember_codex",
};

interface TelegraphSeen {
  tick: number;
  shape: string;
  skill: string;
}

/**
 * classic-boss <class>: a deterministic route to a boss fight (cheats). The
 * hero gets 25 levels and takes the town stairs to depth 1, then `spawnBoss`
 * puts Morrow, the Grave Warden (depth-1 level) awake beside it. The run screenshots each telegraph shape as
 * it fills (circle, cone, and the line Morrow learns in phase 2), then uses
 * `woundBosses` to drive both phases and checks the phase toast and the camera
 * shake (render.shakes). Shapes not seen in time are warnings.
 */
async function classicBoss(run: Run): Promise<void> {
  const cls = classArg(run);
  await startClassic(run, cls, { cheats: true });
  await run.page.evaluate("window.__gamez.controls.setMode('manual')");
  const data: Record<string, unknown> = {};
  run.report.data.boss = data;
  const cheat = (payload: unknown): Promise<{ ok: boolean; error?: { code: string } }> =>
    run.page.evaluate(`window.__gamez.controls.cheat(${JSON.stringify(payload)})`);

  // A strong hero against a depth-1 boss: the fight lasts long enough to watch every
  // telegraph and both phases (a rift-level boss kills a cheat hero in seconds).
  const grant = await cheat({ levels: 25 });
  run.check("cheat grant accepted", grant.ok, grant.error);
  await run.page.wait(GRANT_WAIT_MS);

  // Down the town stairs to depth 1 (manual mode, so auto never takes over).
  const walk = await run.page.evaluate<{ ok: boolean }>(
    "window.__gamez.controls.interact('stairsDown')",
  );
  run.check("interact stairsDown", walk.ok);
  await run.page.waitFor("window.__gamez.sim.depth === 1", 45_000);
  await run.page.evaluate("window.__gamez.controls.closeAll()");
  await run.page.wait(800);

  const shakesAt = async (): Promise<number> => (await renderOf(run))?.shakes ?? 0;
  const shakes0 = await shakesAt();
  const spawn = await cheat({ spawnBoss: "classic.monster.boss_warden" });
  run.check("cheat spawnBoss accepted", spawn.ok, spawn.error);
  await run.page.wait(800);
  const s0 = await simOf(run);
  run.check("the boss is alive beside the hero", (s0.counts.bossesAlive ?? 0) >= 1, s0.counts);
  await run.shot("boss-spawned");

  /** Telegraphs in the event ring newer than `since`. */
  const telegraphs = (since: number): Promise<TelegraphSeen[]> =>
    run.page.evaluate<TelegraphSeen[]>(
      `window.__gamez.sim.lastEvents.filter((e) => e.type === "classic.telegraph" && e.tick > ${since}).map((e) => ({ tick: e.tick, shape: e.shape, skill: e.skill }))`,
    );
  const shapes: Record<string, TelegraphSeen> = {};
  let last = 0;
  /** Polls for telegraphs until every wanted shape was seen; screenshots each new shape as it fills. */
  const watch = async (want: string[], ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until && want.some((w) => !shapes[w])) {
      for (const t of await telegraphs(last)) {
        last = Math.max(last, t.tick);
        if (shapes[t.shape]) continue;
        shapes[t.shape] = t;
        await run.shot(`telegraph-${t.shape}`);
      }
      const hero = (await simOf(run)).hero;
      if (hero?.dead) break;
      await run.page.wait(120);
    }
  };

  // Phase 0: Morrow cleaves (cone) and quakes (circle).
  await watch(["cone", "circle"], 40_000);

  // Phase 1 at 70 % life: the phase toast and the shake.
  const phase1 = await cheat({ woundBosses: 60 });
  run.check("cheat woundBosses accepted", phase1.ok, phase1.error);
  let phaseSeen = true;
  try {
    await run.page.waitFor(
      "(window.__gamez.counters?.events?.['classic.boss.phase'] ?? 0) >= 1",
      10_000,
    );
  } catch {
    phaseSeen = false;
  }
  await run.page.wait(250);
  await run.shot("boss-phase-1");
  const toasts = await run.page.evaluate<string[]>(
    "window.__gamez.ui.toasts.map((t) => `${t.title} | ${t.body ?? ''}`)",
  );
  data.phaseToasts = toasts;
  run.check("the boss enters phase 1", phaseSeen);
  run.check(
    "the phase shows a toast",
    toasts.some((t) => /Morrow/.test(t)),
    toasts,
  );

  // Phase 2 at 35 %: enrage and the rush (line telegraph).
  const phase2 = await cheat({ woundBosses: 30 });
  run.check("cheat woundBosses (phase 2) accepted", phase2.ok, phase2.error);
  await run.page.wait(400);
  await run.shot("boss-phase-2");
  await watch(["line", "cone", "circle"], 40_000);
  const shakes1 = await shakesAt();
  data.shakes = { before: shakes0, after: shakes1 };
  data.shapes = shapes;
  run.check("the phase change shakes the camera", shakes1 > shakes0, data.shakes);
  for (const shape of ["circle", "cone", "line"]) {
    run.check(`a ${shape} telegraph was seen and captured`, !!shapes[shape], shapes, true);
  }
  run.report.data.render = renderSummary(await renderOf(run));
  run.report.data.final = await simOf(run);
}

async function steps(run: Run): Promise<void> {
  await openPicker(run);
  await pickMode(run, "Steps");
  await run.page.waitFor("document.querySelector('.mode-host canvas, .mode-host button')", 30_000);
  await run.page.wait(2_000);
  await run.shot("steps-start");
  for (const key of [
    "ArrowRight",
    "ArrowRight",
    "ArrowDown",
    "ArrowLeft",
    "ArrowUp",
    "ArrowDown",
  ]) {
    await run.page.press(key);
    await run.page.wait(250);
  }
  await run.page.wait(800);
  await run.shot("steps-after-moves");
  const r = await renderOf(run);
  run.report.data.render = renderSummary(r);
  run.check(
    "steps renders a canvas",
    await run.page.evaluate<boolean>("!!document.querySelector('.mode-host canvas')"),
  );
  run.report.data.errorBanner = await run.page.evaluate<string | null>(
    "document.querySelector('.mode-error')?.textContent ?? null",
  );
  run.check(
    "no mode error banner",
    run.report.data.errorBanner === null,
    run.report.data.errorBanner,
  );
}

async function duel(run: Run): Promise<void> {
  await openPicker(run);
  await pickMode(run, "Duel");
  await run.page.waitFor("document.querySelector('.mode-host button')", 30_000);
  await run.page.wait(1_500);
  await run.shot("duel-start");
  const clicked: string[] = [];
  for (let i = 0; i < 6; i++) {
    const target = await run.page.evaluate<{ x: number; y: number; text: string } | null>(
      `(() => {
        const b = [...document.querySelectorAll('.mode-host section[aria-label="Moves"] button, .mode-host button')]
          .find((el) => !el.disabled && el.getBoundingClientRect().width > 0);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (b.innerText || '').slice(0, 40) };
      })()`,
    );
    if (!target) break;
    clicked.push(target.text);
    if (run.page.viewport.touch) await run.page.tap(target.x, target.y);
    else await run.page.click(target.x, target.y);
    await run.page.wait(700);
  }
  await run.shot("duel-after-turns");
  run.report.data.clicked = clicked;
  run.check("duel has clickable buttons", clicked.length > 0, clicked);
  run.report.data.errorBanner = await run.page.evaluate<string | null>(
    "document.querySelector('.mode-error')?.textContent ?? null",
  );
  run.check(
    "no mode error banner",
    run.report.data.errorBanner === null,
    run.report.data.errorBanner,
  );
}

async function plaza(run: Run): Promise<void> {
  await openPicker(run);
  await pickMode(run, "Town Plaza");
  await run.page.waitFor("document.querySelector('.mode-host canvas')", 30_000);
  await run.page.wait(2_500);
  await run.shot("plaza-start");
  const vp = run.page.viewport;
  const x = Math.round(vp.width * 0.62);
  const y = Math.round(vp.height * 0.6);
  if (vp.touch) await run.page.tap(x, y);
  else await run.page.click(x, y);
  await run.page.wait(2_500);
  await run.shot("plaza-after-walk");
  const r = await renderOf(run);
  run.report.data.render = renderSummary(r);
  run.report.data.artProblems = artProblems(r);
  run.check("plaza draws entities", (r?.entitiesDrawn ?? 0) > 0, renderSummary(r));
  run.report.data.errorBanner = await run.page.evaluate<string | null>(
    "document.querySelector('.mode-error')?.textContent ?? null",
  );
  run.check(
    "no mode error banner",
    run.report.data.errorBanner === null,
    run.report.data.errorBanner,
  );
}

const RUNNERS: Record<(typeof SCENARIOS)[number], (run: Run) => Promise<void>> = {
  picker,
  "classic-start": classicStart,
  "classic-create": classicCreate,
  "classic-idle": classicIdle,
  "classic-features": classicFeatures,
  "classic-boss": classicBoss,
  gallery,
  panels,
  steps,
  duel,
  plaza,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const label = [args.scenario, ...args.positional].join("-").replace(/[^a-z0-9_.-]+/gi, "_");
  const outDir =
    args.out ?? join("/tmp/gamez-qa", `${label}${args.viewport === "phone" ? "-phone" : ""}`);
  mkdirSync(outDir, { recursive: true });
  // Screenshots of an earlier run in the default directory would mix with this run's.
  if (args.out === null) {
    for (const f of readdirSync(outDir)) {
      if (f.endsWith(".png")) rmSync(join(outDir, f), { force: true });
    }
  }
  const started = performance.now();
  const report: QaReport = {
    scenario: args.scenario,
    args: args.positional,
    viewport: args.viewport,
    url: args.url,
    ok: false,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    outDir,
    screenshots: [],
    checks: [],
    samples: [],
    data: {},
    consoleErrors: [],
    consoleWarnings: [],
  };
  let page: Page | null = null;
  try {
    await waitForServer(args.url);
    page = await launch(VIEWPORTS[args.viewport], { verbose: args.verbose });
    const run = new Run(page, report, args);
    await RUNNERS[args.scenario as (typeof SCENARIOS)[number]](run);
  } catch (err) {
    report.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (page) {
      try {
        const path = await page.screenshot(join(outDir, "error.png"));
        report.screenshots.push({ name: "error", path });
      } catch {
        // The page may be gone.
      }
    }
  } finally {
    if (page) {
      report.consoleErrors = page.consoleErrors();
      report.consoleWarnings = page.consoleWarnings();
      await page.close();
    }
  }
  const consoleOk = report.consoleErrors.length === 0;
  report.checks.push({
    name: "no console errors",
    ok: consoleOk,
    ...(args.strict ? {} : { warn: true }),
    ...(consoleOk ? {} : { detail: report.consoleErrors.slice(0, 20).map((e) => e.text) }),
  });
  report.ok = report.error === undefined && report.checks.every((c) => c.ok || c.warn === true);
  report.durationMs = Math.round(performance.now() - started);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

await main();

/**
 * QA scenario: classic-offline [class] (docs/design/offline-idle.md §2, §5, §6, §7).
 * OWNER: T2-qa. A permanent lens: "classic Idle keeps farming while the player is away".
 *
 * `node tools/qa/src/run.ts classic-offline warrior --out /tmp/gamez-qa/classic-offline-warrior`
 *
 * Server-synced play (no ?seed, no ?cheats: the hero lives on the InstanceDO). A fresh hero
 * (autostart) runs Idle, then the player leaves in four ways. Each return must show the
 * "While you were away" card (role=dialog, aria-label "While you were away"), keep Idle, and
 * add XP since the player left at least as much as the card's XP.
 *
 *   A  Idle 150 s, close the tab (Page.navigate to about:blank), absence 75 s, reopen.
 *      Hard: card; away >= 1 min; XP delta since close >= card XP; card XP says
 *      "% offline rate"; Idle preserved; sync server online again.
 *   B  Close the card, then reload at once (no play in between). Hard: no second card,
 *      no classic.offline.summary, Idle preserved. Warn: XP jump <= 2x the measured Idle
 *      rate over the reload window.
 *   C  Leave to the mode picker with the HUD "Modes" button, absence 75 s, return with the
 *      Classic card. Same checks as A.
 *   D  Hidden tab (see HIDE_JS / SHOW_JS). Hidden 70 s (over the 60 s HIDDEN_RECONNECT_MS
 *      and the grant floor), then visible again. Same checks as A, plus "a new summary on
 *      the same page". Headless Chrome never hides a tab by itself, so the scenario stands
 *      in for a background tab: document.visibilityState and document.hidden are redefined,
 *      visibilitychange is dispatched, and requestAnimationFrame callbacks are held (no
 *      frames, so the game loop stands still; timers keep running). On return the event
 *      fires first and the frames resume after it, as in a real browser.
 *      Rejected stand-ins: the override alone (the loop keeps playing, so the absence is
 *      played live and correctly never granted); Debugger.pause (the queued frames and the
 *      2 s segment timer run before the visible event, so a non-empty segment reaches the
 *      server first and consumes the absence); Page.setWebLifecycleState "frozen" (in
 *      chrome-headless-shell rAF does not restart after "active").
 *   E  Optional, warn only: local play (?cheats=1 forces local mode, the save is read and
 *      written in the browser). Idle 60 s, close, absence 75 s, reopen. Same checks, warn.
 *
 * Duration: about 13 minutes (A 150 + 75 s, B ~20 s, C 75 s + ~30 s, D 65 s + ~30 s,
 * E 60 + 75 s + ~30 s, plus page opens and the samples). Sampling is every 15 s.
 *
 * Absence waits: the absence is measured on the page clock from the moment the tab (or the
 * page) leaves, so each wait ends at leaveWall + ABSENCE_MS. The server measures its own
 * clock, which only ever sees more time than this, so a 75 s wait always yields >= 60 s.
 *
 * Timing-sensitive checks (exact XP, the XP jump, whether the summary sits in the event
 * ring, the rate source) are warn-only. Every structural check is hard.
 *
 * Stale cards: a card left open from an earlier return is closed before C and D leave, and D
 * (same page, no reload) only accepts a card that came with a new classic.offline.summary
 * (the counter rose). Sync "online" is read after up to 15 s of settling, since the card can
 * show before the rejoin's status flips.
 *
 * Rate source: the measured rate needs 5 min of online Idle (AUTO_RATE_MIN_TICKS = 6000 at
 * x1). The scenario has about 3 min, so the card is expected to say "Estimated" (the model
 * path); the warn-only check compares against the online Idle the run accumulated.
 *
 * Reopens never use autostart (autostart would replace the saved hero); only the first
 * open of the run does. A dev-server reload (HMR) is recovered by reopening the same
 * URL without autostart, and counted in data.reloads.
 *
 * Output: data.phases.{A,B,C,D,E} = { verdict, ... numbers }, data.idleXpPerMs (the measured
 * Idle rate, from phase A's samples), data.reloads. Screenshots: 01-... in order.
 */
import { waitForServer } from "./cdp.ts";
// Type-only: run.ts imports this file, so a value import would be a cycle, and parseCard
// could not be imported on its own (a unit test, a one-off node script).
import type { Run } from "./run.ts";

type Runner = (run: Run) => Promise<void>;

/** The class argument (run.ts classArg, copied to keep the import type-only). */
function classArg(run: Run): string {
  const c = run.args.positional[0] ?? "warrior";
  if (!/^[a-z_.]+$/i.test(c)) throw new Error(`bad class ${c}`);
  return c;
}

/** Clicks a mode card by its name (run.ts pickMode). */
async function pickMode(run: Run, name: string): Promise<void> {
  await run.page.clickText(name, { exact: true, timeoutMs: 10_000 });
}

const ALIVE = "window.__gamez?.mode === 'classic' && window.__gamez.sim?.hero != null";
const PICKER = "document.querySelectorAll('.mode-card').length > 0";
const CARD = 'section[role="dialog"][aria-label="While you were away"]';

/** The absence the scenario creates (over the 60 s floor of the grant). */
const ABSENCE_MS = 75_000;
/** Idle time before the first leave (2.5 min). */
const IDLE_MS = 150_000;
/** Hidden-tab time (over HIDDEN_RECONNECT_MS = 60 s and the 60 s grant floor). */
const HIDDEN_MS = 70_000;
const LOCAL_IDLE_MS = 60_000;
const SAMPLE_MS = 15_000;
/** How long the card may take to appear after a return. */
const CARD_WAIT_MS = 25_000;
/** The card's away time must reach the grant floor (OFFLINE_MIN_MS). */
const MIN_AWAY_MS = 60_000;
/** Online Idle before the measured rate replaces the model (AUTO_RATE_MIN_TICKS = 6000 at x1). */
const RATE_MIN_IDLE_MS = 300_000;
/** How long a server return may take to read sync status online after the card shows. */
const ONLINE_WAIT_MS = 15_000;

/**
 * Hides the tab the way a background tab looks to the client (headless Chrome never does):
 * visibilityState/hidden read 'hidden', visibilitychange fires, and requestAnimationFrame
 * callbacks are held (a background tab runs no frames, so the game loop stands still; timers
 * keep running, as they do throttled in a real background tab). Pixi's Ticker looks up the
 * global requestAnimationFrame every frame, so the hold catches the loop.
 */
const HIDE_JS = `(() => {
  const raf = window.requestAnimationFrame;
  const held = [];
  window.__qaHidden = { raf, held };
  window.requestAnimationFrame = (cb) => { held.push(cb); return 0; };
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  return document.visibilityState;
})()`;

/**
 * Shows the tab again in a real browser's order: visibilitychange first (the override is
 * removed, so the prototype getter reads 'visible'), then the frames resume (the held
 * callbacks run on the real requestAnimationFrame).
 */
const SHOW_JS = `(() => {
  delete document.visibilityState;
  delete document.hidden;
  document.dispatchEvent(new Event('visibilitychange'));
  const h = window.__qaHidden;
  if (h) {
    window.requestAnimationFrame = h.raf;
    delete window.__qaHidden;
    for (const cb of h.held) window.requestAnimationFrame(cb);
  }
  return document.visibilityState;
})()`;

/** One read of the page: alive flag, hero, control, sync, the summary events and the card. */
const SNAP_JS = `(() => {
  const g = window.__gamez;
  if (!g || g.mode !== 'classic' || !g.sim || !g.sim.hero) return { alive: false };
  const s = g.sim;
  const h = s.hero;
  const sync = g.sync || null;
  const counts = g.counters && g.counters.events ? g.counters.events : null;
  const dlg = document.querySelector('${CARD}');
  return {
    alive: true,
    wall: Date.now(),
    tick: s.tick,
    control: s.control ? { mode: s.control.mode, speed: s.control.speed } : null,
    hero: { level: h.level, xp: h.xp, gold: h.gold, life: h.life, lifeMax: h.lifeMax, dead: !!h.dead, potions: h.potions, depth: s.depth, area: s.area ? s.area.name : null },
    sync: sync ? { mode: sync.mode, status: sync.status, verifiedTick: sync.verifiedTick, pendingTicks: sync.pendingTicks, localTick: sync.localTick ?? null, epoch: sync.epoch ?? null, lastResync: sync.lastResync ? sync.lastResync.code : null } : null,
    summaries: (s.lastEvents || []).filter(e => e.type === 'classic.offline.summary').map(e => ({ awayMs: e.awayMs, ms: e.ms, xp: e.xp, gold: e.gold, kills: e.kills, xpPct: e.xpPct, goldPct: e.goldPct, upkeep: e.upkeep ?? null, source: e.source })),
    summaryCount: counts ? (counts['classic.offline.summary'] || 0) : null,
    card: dlg ? {
      count: document.querySelectorAll('${CARD}').length,
      text: dlg.innerText,
      quests: [...dlg.querySelectorAll('ul[aria-label="Quest progress"] li')].map(li => li.innerText),
    } : null,
  };
})()`;

interface SummaryEvent {
  awayMs: number;
  ms: number;
  xp: number;
  gold: number;
  kills: number;
  xpPct: number;
  goldPct: number;
  upkeep: number | null;
  source: string;
}

interface CardInfo {
  count: number;
  text: string;
  quests: string[];
}

interface Snap {
  alive: boolean;
  wall: number;
  tick: number | null;
  control: { mode: string; speed: number } | null;
  hero: {
    level: number;
    xp: number;
    gold: number;
    life: number;
    lifeMax: number;
    dead: boolean;
    potions: number;
    depth: number;
    area: string | null;
  } | null;
  sync: {
    mode: string;
    status: string;
    verifiedTick: number;
    pendingTicks: number;
    localTick: number | null;
    epoch: number | null;
    lastResync: string | null;
  } | null;
  summaries: SummaryEvent[];
  summaryCount: number | null;
  card: CardInfo | null;
}

/** What the card says, read from its text (pure: unit-testable without a browser). */
export interface CardRead {
  time: string | null;
  awayMs: number | null;
  creditedMs: number | null;
  cappedMs: number | null;
  kills: number | null;
  xp: number | null;
  xpPct: number | null;
  gold: number | null;
  goldPct: number | null;
  items: number | null;
  levels: number | null;
  upkeep: number | null;
  source: "measured" | "estimated" | null;
  quests: string[];
  /** A quest that became done offline reads "turn in at the quest giver". */
  turnIn: boolean;
}

/** "8 h", "2 h 5 min", "42 min" to milliseconds (the awaySpan format); null when unparsable. */
export function spanMs(span: string): number | null {
  const m = /^(?:(\d+) h)?(?: ?(\d+) min)?$/.exec(span.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
}

/** A number as shown on the card ("1,234" or "1 234"). */
const num = (s: string): number => Number(s.replace(/[^\d]/g, ""));
const NUM = "[\\d\\s,.\\u00a0\\u202f]+";

/** Parses the card text (its lines, one per row) and its quest rows. Missing rows read null. */
export function parseCard(text: string, quests: string[]): CardRead {
  const out: CardRead = {
    time: null,
    awayMs: null,
    creditedMs: null,
    cappedMs: null,
    kills: null,
    xp: null,
    xpPct: null,
    gold: null,
    goldPct: null,
    items: null,
    levels: null,
    upkeep: null,
    source: null,
    quests,
    turnIn: quests.some((q) => /turn in/.test(q)),
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^Away (.+?) · credited (.+?)(?: \\(capped at (.+?)\\))?$`).exec(line))) {
      out.time = line;
      out.awayMs = spanMs(m[1] ?? "");
      out.creditedMs = spanMs(m[2] ?? "");
      out.cappedMs = m[3] !== undefined ? spanMs(m[3]) : null;
    } else if ((m = new RegExp(`^(${NUM}) kills?$`).exec(line))) {
      out.kills = num(m[1] ?? "");
    } else if ((m = new RegExp(`^\\+(${NUM}) XP \\((\\d+)% offline rate\\)$`).exec(line))) {
      out.xp = num(m[1] ?? "");
      out.xpPct = Number(m[2]);
    } else if ((m = new RegExp(`^\\+(${NUM}) gold(?: \\((\\d+)%\\))?`).exec(line))) {
      out.gold = num(m[1] ?? "");
      out.goldPct = m[2] !== undefined ? Number(m[2]) : 100;
    } else if ((m = new RegExp(`(${NUM}) items? → stash`).exec(line))) {
      out.items = num(m[1] ?? "");
    } else if ((m = new RegExp(`^\\+(${NUM}) levels?$`).exec(line))) {
      out.levels = num(m[1] ?? "");
    }
    if (/Measured from your Idle rate/.test(line)) out.source = "measured";
    else if (line.startsWith("Estimated")) out.source = "estimated";
    const up = new RegExp(`net of (${NUM}) upkeep`).exec(line);
    if (up) out.upkeep = num(up[1] ?? "");
    if (/turn in/.test(line)) out.turnIn = true;
  }
  return out;
}

/** The scenario's state: the run, the resume URL the reopens use, and the Idle samples. */
interface Ctx {
  run: Run;
  cls: string;
  /** Reopen query (no autostart). Local runs add cheats=1 here. */
  base: string;
  /** Phase A's Idle samples: the measured online XP rate comes from them. */
  idle: Snap[];
  /** Phase A's card, for B. */
  aCard: boolean;
  serverOnline: boolean;
  /** Online Idle time so far (page clock): decides whether the card should say measured. */
  onlineIdleMs: number;
  /** Wall time the current online Idle stretch began (null while away). */
  onSince: number | null;
}

/** Ends an online Idle stretch at a leave. */
function markLeave(ctx: Ctx, wall: number): void {
  if (ctx.onSince !== null) ctx.onlineIdleMs += Math.max(0, wall - ctx.onSince);
  ctx.onSince = null;
}

const emptySnap = (): Snap => ({
  alive: false,
  wall: Date.now(),
  tick: null,
  control: null,
  hero: null,
  sync: null,
  summaries: [],
  summaryCount: null,
  card: null,
});

async function snap(run: Run): Promise<Snap> {
  try {
    return await run.page.evaluate<Snap>(SNAP_JS);
  } catch {
    return emptySnap();
  }
}

async function isAlive(run: Run): Promise<boolean> {
  try {
    return await run.page.evaluate<boolean>(`!!(${ALIVE})`);
  } catch {
    return false;
  }
}

/** Picks Classic on the mode picker, retried (the first click can land before the picker takes input). */
async function enterClassic(run: Run): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pickMode(run, "Classic");
      await run.page.waitFor(ALIVE, 15_000);
      return;
    } catch {
      // Not in yet: click again.
    }
  }
  throw new Error("Classic did not start from the mode picker");
}

/** Opens the page with a query and waits until the Classic hero is on screen. */
async function openClassic(run: Run, query: string): Promise<void> {
  await waitForServer(run.args.url);
  await run.page.open(run.url(query));
  await run.page.waitFor(`${PICKER} || (${ALIVE})`, 60_000);
  if (!(await isAlive(run))) await enterClassic(run);
  await run.page.waitFor("(window.__gamez.render?.chunks ?? 0) > 0", 30_000).catch(() => undefined);
  await run.page.wait(800);
}

/** Reopens the same save when a dev-server reload dropped the page (no autostart). */
async function ensure(ctx: Ctx): Promise<void> {
  if (await isAlive(ctx.run)) return;
  ctx.run.report.data.reloads = ((ctx.run.report.data.reloads as number) ?? 0) + 1;
  ctx.run.progress(`re-opened ${ctx.base} after a dev-server reload`);
  await openClassic(ctx.run, ctx.base);
}

/** One sample: recorded in the report, returned. */
async function sample(ctx: Ctx, label: string): Promise<Snap> {
  await ensure(ctx);
  const s = await snap(ctx.run);
  ctx.run.sample({ label, ...s });
  return s;
}

/**
 * Polls for the card after a return. Null when it did not show in time. On the same page
 * (`sameSince` = the summary counter before leaving) the card only counts once a new
 * classic.offline.summary arrived, so a card left over from an earlier grant never passes.
 */
async function awaitCard(
  run: Run,
  timeoutMs: number,
  sameSince: number | null = null,
): Promise<Snap | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await snap(run);
    const fresh = sameSince === null || (s.summaryCount ?? 0) > sameSince;
    if (s.card && fresh) return s;
    if (Date.now() > end) return null;
    await run.page.wait(500);
  }
}

/** After a server return: waits (bounded) until sync reads online, then reads the page again. */
async function settleOnline(run: Run, s: Snap): Promise<Snap> {
  if (s.sync?.mode !== "server" || s.sync.status === "online") return s;
  await run.page
    .waitFor(
      "window.__gamez?.sync?.mode === 'server' && window.__gamez.sync?.status === 'online'",
      ONLINE_WAIT_MS,
    )
    .catch(() => undefined);
  const again = await snap(run);
  return again.alive ? { ...again, card: s.card } : s;
}

/** Closes a card still open from an earlier return, so the next phase reads only its own. */
async function clearCard(ctx: Ctx, label: string): Promise<void> {
  if (!(await ctx.run.page.evaluate<boolean>(`!!document.querySelector('${CARD}')`))) return;
  const closed = await closeCard(ctx.run);
  ctx.run.progress(`${label}: closed the previous card first (${closed ? "gone" : "still open"})`);
}

/** Closes the tab: the same unload a player's close produces (pagehide, save and flush). */
async function closeTab(run: Run): Promise<number> {
  const wall = Date.now();
  await run.page.send("Page.navigate", { url: "about:blank" });
  await run.page.wait(1500);
  return wall;
}

/** Clicks the card's Close button. True when the card is gone afterwards. */
async function closeCard(run: Run): Promise<boolean> {
  const at = await run.page.evaluate<{ x: number; y: number } | null>(
    `(() => { const d = document.querySelector('${CARD}'); if (!d) return null; const b = [...d.querySelectorAll('button')].find(x => x.innerText.trim() === 'Close'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!at) return false;
  if (run.args.viewport === "phone") await run.page.tap(at.x, at.y);
  else await run.page.click(at.x, at.y);
  await run.page.wait(500);
  return !(await run.page.evaluate<boolean>(`!!document.querySelector('${CARD}')`));
}

/** HUD "Modes" to the picker. True when the picker shows. */
async function leaveToPicker(run: Run): Promise<boolean> {
  try {
    await run.page.clickText("Modes", { exact: true, timeoutMs: 10_000 });
    await run.page.waitFor(PICKER, 15_000);
    return true;
  } catch {
    return false;
  }
}

/** The shared checks of a return. Warn-only for the timing-sensitive ones and for local play. */
function checkReturn(
  run: Run,
  p: string,
  pre: Snap,
  post: Snap,
  expectMode: "server" | "local",
  warn: boolean,
  onlineIdleMs: number,
): CardRead | null {
  const text = post.card?.text ?? null;
  const cr = text !== null ? parseCard(text, post.card?.quests ?? []) : null;
  run.check(
    `${p}: "While you were away" card on return`,
    cr !== null,
    cr
      ? { time: cr.time, xp: cr.xp, gold: cr.gold, kills: cr.kills }
      : { summaries: post.summaries },
    warn,
  );
  run.check(
    `${p}: away at least 1 min`,
    cr !== null && cr.awayMs !== null && cr.awayMs >= MIN_AWAY_MS,
    { awayMs: cr?.awayMs ?? null, time: cr?.time ?? null },
    warn,
  );
  const dXp = pre.hero && post.hero ? post.hero.xp - pre.hero.xp : null;
  run.check(
    `${p}: XP since leaving is at least the card's XP`,
    cr !== null && cr.xp !== null && dXp !== null && dXp >= cr.xp,
    { dXp, cardXp: cr?.xp ?? null, preXp: pre.hero?.xp ?? null, postXp: post.hero?.xp ?? null },
    warn,
  );
  run.check(
    `${p}: card XP line says "% offline rate"`,
    text !== null && /% offline rate/.test(text),
    { line: text?.split("\n").find((l) => /XP/.test(l)) ?? null },
    warn,
  );
  run.check(
    `${p}: Idle preserved (control mode idle)`,
    post.control?.mode === "idle",
    { before: pre.control, after: post.control },
    warn,
  );
  run.check(
    `${p}: sync ${expectMode}${expectMode === "server" ? " online again" : ""}`,
    post.sync?.mode === expectMode && (expectMode === "local" || post.sync.status === "online"),
    post.sync,
    warn,
  );
  run.check(
    `${p}: classic.offline.summary arrived (event ring or counter)`,
    post.summaries.length > 0 || (post.summaryCount ?? 0) > 0,
    { ring: post.summaries.length, counter: post.summaryCount },
    true,
  );
  // The measured rate needs 5 min of online Idle (AUTO_RATE_MIN_TICKS); before that the
  // grant uses the fallback model and the card says "Estimated". Warn-only: page-clock estimate.
  const want = onlineIdleMs >= RATE_MIN_IDLE_MS ? "measured" : "estimated";
  run.check(
    `${p}: the card's rate source matches the Idle history (${want})`,
    cr?.source === want,
    { source: cr?.source ?? null, want, onlineIdleMs: Math.round(onlineIdleMs) },
    true,
  );
  return cr;
}

/** Verdict of the checks recorded since `mark`: pass when no hard check failed. */
function verdictSince(run: Run, mark: number): "pass" | "fail" {
  return run.report.checks.slice(mark).every((c) => c.ok || c.warn === true) ? "pass" : "fail";
}

/** Records a phase's verdict and numbers in data.phases. */
function recordPhase(run: Run, name: string, mark: number, detail: Record<string, unknown>): void {
  const phases = run.report.data.phases as Record<string, unknown>;
  phases[name] = { verdict: verdictSince(run, mark), ...detail };
}

/** Measured online XP per ms of Idle, from phase A's samples (null when there are too few). */
function idleRate(samples: Snap[]): number | null {
  const first = samples.find((s) => s.alive && s.hero);
  const last = [...samples].reverse().find((s) => s.alive && s.hero);
  if (!first?.hero || !last?.hero) return null;
  const dt = last.wall - first.wall;
  if (dt < 30_000) return null;
  return (last.hero.xp - first.hero.xp) / dt;
}

/** Phase A: Idle, close, absence, reopen. */
async function phaseA(ctx: Ctx, fresh: string): Promise<void> {
  const { run } = ctx;
  const mark = run.report.checks.length;
  await openClassic(run, fresh);
  const online = await run.page
    .waitFor(
      "window.__gamez?.sync?.mode === 'server' && window.__gamez.sync?.status === 'online'",
      25_000,
    )
    .then(() => true)
    .catch(() => false);
  ctx.serverOnline = online;
  const first = await snap(run);
  run.check("A: server-synced play (sync server, online)", online, first.sync, false);
  if (!online) {
    recordPhase(run, "A", mark, { note: "no server sync: phases B-D skipped" });
    return;
  }
  await run.page.evaluate("window.__gamez.controls.setMode('idle')");
  ctx.onSince = Date.now();
  run.progress("A: Idle on, sampling");
  const end = Date.now() + IDLE_MS;
  while (Date.now() < end) {
    await run.page.wait(SAMPLE_MS);
    ctx.idle.push(await sample(ctx, "A-idle"));
  }
  await run.shot("A-idle-before-close");
  const pre = await sample(ctx, "A-pre-close");
  run.check("A: Idle on before leaving", pre.control?.mode === "idle", pre.control, false);
  const closedAt = await closeTab(run);
  markLeave(ctx, closedAt);
  run.progress("A: tab closed (about:blank), absence running");
  await run.page.wait(Math.max(0, closedAt + ABSENCE_MS - Date.now()));
  run.progress("A: reopen");
  await openClassic(run, ctx.base);
  const back = await awaitCard(run, CARD_WAIT_MS);
  ctx.onSince = Date.now();
  const post = await settleOnline(run, back ?? (await snap(run)));
  ctx.aCard = back !== null;
  await run.shot(back ? "A-reopen-card" : "A-reopen-no-card");
  const cr = checkReturn(run, "A close tab", pre, post, "server", false, ctx.onlineIdleMs);
  const rate = idleRate(ctx.idle);
  recordPhase(run, "A", mark, {
    absentWallMs: Date.now() - closedAt,
    preXp: pre.hero?.xp ?? null,
    postXp: post.hero?.xp ?? null,
    level: { pre: pre.hero?.level ?? null, post: post.hero?.level ?? null },
    card: cr,
    idleXpPerMs: rate,
    summaries: post.summaries,
    quests: post.card?.quests ?? [],
    sync: post.sync,
  });
}

/** Phase B: close the card, reload at once, no second card. */
async function phaseB(ctx: Ctx): Promise<void> {
  const { run } = ctx;
  const mark = run.report.checks.length;
  const closed = await closeCard(run);
  run.check("B: card closed with its Close button", closed, null, false);
  const pre = await sample(ctx, "B-pre-reload");
  run.progress("B: reload at once");
  await openClassic(run, ctx.base);
  await run.page.wait(4_000);
  const post = await snap(run);
  run.sample({ label: "B-post-reload", ...post });
  await run.shot("B-after-reload");
  run.check("B: no second card after an immediate reload", post.card === null, post.card, false);
  run.check(
    "B: no classic.offline.summary on the reload",
    post.summaries.length === 0,
    { ring: post.summaries.length },
    false,
  );
  run.check(
    "B: Idle preserved (control mode idle)",
    post.control?.mode === "idle",
    post.control,
    false,
  );
  const rate = idleRate(ctx.idle);
  const elapsed = pre.hero && post.hero ? post.wall - pre.wall : null;
  const dXp = pre.hero && post.hero ? post.hero.xp - pre.hero.xp : null;
  const maxJump = rate !== null && elapsed !== null ? rate * elapsed * 2 + 50 : null;
  run.check(
    "B: XP jump across the reload within 2x normal Idle play",
    dXp !== null && maxJump !== null && dXp <= maxJump,
    { dXp, maxJump, elapsedMs: elapsed, idleXpPerMs: rate },
    true,
  );
  recordPhase(run, "B", mark, { dXp, elapsedMs: elapsed, maxJump, sync: post.sync });
}

/** Phase C: HUD Modes to the picker, absence, return with the Classic card. */
async function phaseC(ctx: Ctx): Promise<void> {
  const { run } = ctx;
  const mark = run.report.checks.length;
  await clearCard(ctx, "C");
  const pre = await sample(ctx, "C-pre-leave");
  const left = await leaveToPicker(run);
  run.check("C: HUD Modes leaves Classic for the picker", left, null, false);
  if (!left) {
    recordPhase(run, "C", mark, { note: "could not leave to the picker" });
    return;
  }
  const leftAt = Date.now();
  markLeave(ctx, leftAt);
  await run.shot("C-picker");
  await run.page.wait(Math.max(0, leftAt + ABSENCE_MS - Date.now()));
  run.progress("C: return via the Classic card");
  await enterClassic(run);
  await run.page.waitFor("(window.__gamez.render?.chunks ?? 0) > 0", 30_000).catch(() => undefined);
  const back = await awaitCard(run, CARD_WAIT_MS);
  ctx.onSince = Date.now();
  const post = await settleOnline(run, back ?? (await snap(run)));
  run.sample({ label: "C-return", ...post });
  await run.shot(back ? "C-return-card" : "C-return-no-card");
  const cr = checkReturn(run, "C modes picker", pre, post, "server", false, ctx.onlineIdleMs);
  recordPhase(run, "C", mark, {
    absentWallMs: Date.now() - leftAt,
    preXp: pre.hero?.xp ?? null,
    postXp: post.hero?.xp ?? null,
    card: cr,
  });
}

/** Phase D: hidden tab (visibility override), 65 s, visible again. */
async function phaseD(ctx: Ctx): Promise<void> {
  const { run } = ctx;
  const mark = run.report.checks.length;
  // The card of C is still open on this page: close it, so D only passes on its own grant.
  await clearCard(ctx, "D");
  const pre = await sample(ctx, "D-pre-hide");
  const hiddenState = await run.page.evaluate<string>(HIDE_JS);
  const hiddenAt = Date.now();
  markLeave(ctx, hiddenAt);
  run.check(
    "D: visibility override reads hidden",
    hiddenState === "hidden",
    { hiddenState },
    false,
  );
  // HIDE_JS holds the frames, so the game loop stands still while hidden. (A visibility
  // override alone leaves the loop running: the client plays the absence live and rightly
  // gets no grant. Debugger.pause stops the loop too, but on resume the queued frames and
  // the segment timer run before the visible event, which a real browser does not do.)
  const pausedTick = (await snap(run)).tick;
  await run.page.wait(HIDDEN_MS);
  const heldTick = await run.page.evaluate<number | null>("window.__gamez?.sim?.tick ?? null");
  const shownState = await run.page.evaluate<string>(SHOW_JS);
  run.check(
    "D: override removed (reads visible again)",
    shownState === "visible",
    { shownState },
    false,
  );
  run.check(
    "D: the game loop stood still while hidden (frames held)",
    heldTick !== null && pausedTick !== null && heldTick - pausedTick < 40,
    { pausedTick, heldTick },
    true,
  );
  run.progress(`D: visible again after ${Date.now() - hiddenAt} ms hidden`);
  // Same page: only a card that came with a new classic.offline.summary counts.
  const back = await awaitCard(run, CARD_WAIT_MS, pre.summaryCount ?? 0);
  ctx.onSince = Date.now();
  const post = await settleOnline(run, back ?? (await snap(run)));
  run.sample({ label: "D-return", ...post });
  await run.shot(back ? "D-return-card" : "D-return-no-card");
  run.check(
    "D hidden tab: a new grant on the same page (summary counter rose)",
    (post.summaryCount ?? 0) > (pre.summaryCount ?? 0),
    { before: pre.summaryCount, after: post.summaryCount },
    false,
  );
  const cr = checkReturn(run, "D hidden tab", pre, post, "server", false, ctx.onlineIdleMs);
  recordPhase(run, "D", mark, {
    hiddenMs: Date.now() - hiddenAt,
    summaryCount: { before: pre.summaryCount, after: post.summaryCount },
    preXp: pre.hero?.xp ?? null,
    postXp: post.hero?.xp ?? null,
    card: cr,
    sync: post.sync,
  });
}

/** Phase E (optional, warn-only): local play with ?cheats=1, the save is read in the browser. */
async function phaseE(ctx: Ctx): Promise<void> {
  const { run, cls } = ctx;
  const mark = run.report.checks.length;
  ctx.base = `debug=1&cheats=1&class=${encodeURIComponent(cls)}`;
  await openClassic(run, `${ctx.base}&autostart=1`);
  const mode = await run.page.evaluate<string | null>("window.__gamez.sync?.mode ?? null");
  run.check("E local: no server (sync mode local)", mode === "local", { mode }, true);
  await run.page.evaluate("window.__gamez.controls.setMode('idle')");
  const localStart = Date.now();
  const end = localStart + LOCAL_IDLE_MS;
  while (Date.now() < end) {
    await run.page.wait(SAMPLE_MS);
    await sample(ctx, "E-idle");
  }
  const pre = await sample(ctx, "E-pre-close");
  const closedAt = await closeTab(run);
  await run.page.wait(Math.max(0, closedAt + ABSENCE_MS - Date.now()));
  await openClassic(run, ctx.base);
  const back = await awaitCard(run, CARD_WAIT_MS);
  const post = back ?? (await snap(run));
  run.sample({ label: "E-return", ...post });
  await run.shot(back ? "E-return-card" : "E-return-no-card");
  // A new local hero: its own Idle history (about 60 s, so the card is estimated).
  const cr = checkReturn(run, "E local", pre, post, "local", true, closedAt - localStart);
  recordPhase(run, "E", mark, {
    absentWallMs: Date.now() - closedAt,
    preXp: pre.hero?.xp ?? null,
    postXp: post.hero?.xp ?? null,
    card: cr,
  });
}

/** Runs one phase. A throw is a hard failure of that phase only; the next phases still run. */
async function runPhase(run: Run, name: string, fn: () => Promise<void>): Promise<void> {
  const mark = run.report.checks.length;
  try {
    await fn();
  } catch (err) {
    run.check(
      `${name}: phase ran to completion`,
      false,
      String(err instanceof Error ? err.message : err).slice(0, 400),
    );
    recordPhase(run, name, mark, { note: "phase threw; see the failed check" });
  }
}

async function classicOffline(run: Run): Promise<void> {
  const cls = classArg(run);
  run.report.data.class = cls;
  run.report.data.reloads = 0;
  run.report.data.phases = {};
  const ctx: Ctx = {
    run,
    cls,
    base: `debug=1&class=${encodeURIComponent(cls)}`,
    idle: [],
    aCard: false,
    serverOnline: false,
    onlineIdleMs: 0,
    onSince: null,
  };
  const fresh = `${ctx.base}&autostart=1`;
  await runPhase(run, "A", () => phaseA(ctx, fresh));
  if (ctx.serverOnline) {
    await runPhase(run, "B", () => phaseB(ctx));
    await runPhase(run, "C", () => phaseC(ctx));
    await runPhase(run, "D", () => phaseD(ctx));
  } else {
    run.check("B-D: skipped (no server-synced hero in phase A)", false, null, true);
  }
  await runPhase(run, "E", () => phaseE(ctx));
  run.report.data.idleXpPerMs = idleRate(ctx.idle);
  run.report.data.onlineIdleMs = Math.round(ctx.onlineIdleMs);
}

export const OFFLINE_RUNNERS: Record<string, Runner> = {
  "classic-offline": classicOffline,
};

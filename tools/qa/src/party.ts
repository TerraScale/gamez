/**
 * QA scenarios: classic-party and party (docs/design/party.md §10, §15).
 *
 * `party <class>` (integrator) drives the real party UI without the party cheat: buys
 * slots and recruits through the Party panel, switches control by portrait, F3, F1 and
 * Tab, checks the HUD hero, the camera (window.__gamez.render.camera) and the outlines
 * after each switch, then runs Party: Auto (Idle x8) for 30 s. See uiRecruit below.
 *
 * classic-party (T-party-render):
 *
 * `node tools/qa/src/run.ts classic-party <class> [--viewport phone] [--url base]`
 *
 * A cheat hero (?debug=1&cheats=1) grows a party of four in the real browser:
 *   1. Grant: `controls.cheat {party: [...]}` (the party cheat, classic.debug). If that
 *      cheat is not there, the fallback grants `{bossesKilled: [4, 8, 12], gold: 100000}`
 *      and recruits the three heroes through `controls.act("classic.party.recruit")`.
 *   2. Town: `town-party` (outlines, name plates, party frames), then F2 and Tab each
 *      switch control (`control-f2`, `control-tab`); the controlled name must change.
 *   3. Idle x8 for 60 s: samples the controlled hero and, when the sim exposes it, every
 *      member (max distance from the controlled hero, depth, downs, revives). Takes a
 *      `downed` and a `revived` shot the first time each happens.
 *
 * A Vite hot reload drops window.__gamez mid-run. Each phase after the grant then starts
 * the scenario again (same class, the cheats save slot) and redoes itself; the reloads
 * are counted in data.reloads.
 *
 * data.party holds the grant path, the outline census, the frame names, the control names,
 * the samples and the totals. Member positions come from `window.__gamez.sim.party.members`
 * (tiles, `{name, x, y, dead, level}`) when the debug summary publishes them; without them
 * the distance checks are warnings and only the controlled hero is sampled.
 */
import { classArg, startClassic, type Run } from "./run.ts";

type Runner = (run: Run) => Promise<void>;

/** Heroes recruited (in this order) on top of the scenario's own class. */
const RECRUITS: readonly string[] = ["classic.rogue", "classic.sorcerer", "classic.warrior"];
const NAMES: Readonly<Record<string, string>> = {
  "classic.rogue": "Brannoc",
  "classic.sorcerer": "Celene",
  "classic.warrior": "Oren",
};
const IDLE_MS = 60_000;
const SAMPLE_MS = 2_000;
/** Follower distance (tiles) from the controlled hero that counts as "together". */
const TOGETHER_TILES = 12;
/** PartyProto.leashTeleport in tiles: followers farther than this are regrouped. */
const LEASH_TILES = 24;
const PHASE_ATTEMPTS = 6;
/** Samples lost to reloads the idle minute tolerates before it gives up. */
const IDLE_RECOVERIES = 12;

interface SimMember {
  name: string;
  x: number;
  y: number;
  dead: boolean;
  level: number;
}

interface SimHero {
  name: string;
  level: number;
  x: number;
  y: number;
  dead: boolean;
}

interface SimView {
  tick: number;
  depth: number;
  hero: SimHero | null;
  counts: Record<string, number>;
  control: { mode: string; speed: number } | null;
  party?: { members: SimMember[] } | null;
}

interface Outlines {
  self: number;
  party: number;
  ally: number;
}

type Result = { ok: boolean; error?: { code: string; message?: string } };

const simOf = (run: Run): Promise<SimView> => run.page.evaluate<SimView>("window.__gamez.sim");
const outlinesOf = (run: Run): Promise<Outlines | null> =>
  run.page.evaluate<Outlines | null>("window.__gamez.render?.outlines ?? null");
const eventsOf = (run: Run): Promise<Record<string, number>> =>
  run.page.evaluate<Record<string, number>>("window.__gamez.counters?.events ?? {}");
const cheat = (run: Run, payload: unknown): Promise<Result> =>
  run.page.evaluate<Result>(`window.__gamez.controls.cheat(${JSON.stringify(payload)})`);
const act = (run: Run, name: string, payload: unknown): Promise<Result> =>
  run.page.evaluate<Result>(
    `window.__gamez.controls.act(${JSON.stringify(name)}, ${JSON.stringify(payload)})`,
  );

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Runs one phase; after a page reload (the step throws) it starts the scenario again and retries. */
async function phase<T>(run: Run, cls: string, step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      if (attempt >= PHASE_ATTEMPTS) throw err;
      run.report.data.reloads = ((run.report.data.reloads as number) ?? 0) + 1;
      await startClassic(run, cls, { cheats: true });
    }
  }
}

/**
 * Waits for the page to come back after a reload; starts the scenario again when it does not.
 * Mode and speed are per page session, so the caller re-applies them.
 */
async function settle(run: Run, cls: string): Promise<void> {
  try {
    await run.page.waitFor(
      "window.__gamez?.controls != null && window.__gamez.sim != null",
      15_000,
    );
  } catch {
    await startClassic(run, cls, { cheats: true });
  }
}

/** Grants the party: the party cheat, or the boss slots and gold plus recruits. */
async function grant(run: Run, data: Record<string, unknown>): Promise<void> {
  const g = await cheat(run, { party: [...RECRUITS] });
  data.grant = g.ok ? "party-cheat" : "fallback";
  if (g.ok) {
    run.check("cheat party accepted", true);
  } else {
    run.check("party cheat not available (fallback grant)", true, g.error, true);
    const gold = await cheat(run, { bossesKilled: [4, 8, 12], gold: 100_000 });
    run.check("cheat bossesKilled + gold accepted", gold.ok, gold.error);
    for (const c of RECRUITS) {
      const r = await act(run, "classic.party.recruit", { classId: c, name: NAMES[c] });
      run.check(`recruit ${NAMES[c]} (${c})`, r.ok, r.error);
      await run.page.wait(200);
    }
  }
  try {
    await run.page.waitFor(
      "(window.__gamez?.counters?.events?.['classic.party.recruited'] ?? 0) >= 3",
      15_000,
    );
  } catch {
    // Checked below.
  }
  const recruited = (await eventsOf(run))["classic.party.recruited"] ?? 0;
  run.check("three heroes joined the party", recruited >= 3, { recruited });
}

/** Town: outlines, name plates and party frames. */
async function town(run: Run, data: Record<string, unknown>): Promise<void> {
  await run.page.evaluate("window.__gamez.controls.closeAll()");
  await run.page.wait(1200);
  await run.shot("town-party");
  const outlines = await outlinesOf(run);
  data.outlines = outlines;
  run.check(
    "one gold self outline and cyan party outlines",
    outlines !== null && outlines.self === 1 && outlines.party >= 1,
    outlines,
  );
  // Names of the party: the fallback's own names, or the cheat's "<Class> <n>" names.
  const names = await run.page.evaluate<string[]>(
    `(() => {
      const t = document.body.innerText;
      const own = ${JSON.stringify(Object.values(NAMES))}.filter((n) => t.includes(n));
      const generated = [...new Set(t.match(/(Rogue|Sorcerer|Warrior) \\d/g) ?? [])];
      return [...own, ...generated];
    })()`,
  );
  data.frameNames = names;
  run.check("party frames show the members' names", names.length >= 2, names, true);
}

/** Control switches: F2 then Tab; the controlled hero's name must change each time. */
async function switches(run: Run, data: Record<string, unknown>): Promise<void> {
  const heroName = async (): Promise<string | null> => (await simOf(run)).hero?.name ?? null;
  const first = await heroName();
  await run.page.press("F2");
  await run.page.wait(600);
  const afterF2 = await heroName();
  await run.shot("control-f2");
  await run.page.press("Tab");
  await run.page.wait(600);
  const afterTab = await heroName();
  await run.shot("control-tab");
  data.control = { first, afterF2, afterTab };
  run.check("F2 switches control to another hero", afterF2 !== null && afterF2 !== first, {
    first,
    afterF2,
  });
  run.check("Tab switches control again", afterTab !== null && afterTab !== afterF2, {
    afterF2,
    afterTab,
  });
  const after = await outlinesOf(run);
  run.check(
    "the outline follows the controlled hero (still one self)",
    after?.self === 1,
    after,
    true,
  );
}

/** Idle x8 for a minute: sample the party, shoot the first down and the first revive. */
async function idle(run: Run, cls: string, data: Record<string, unknown>): Promise<void> {
  const runIdle = (): Promise<void> =>
    run.page
      .evaluate("window.__gamez.controls.setMode('idle')")
      .then(() => run.page.evaluate("window.__gamez.controls.setSpeed(8)"))
      .then(() => undefined);
  await runIdle();
  let recoveries = 0;
  const samples: Record<string, unknown>[] = [];
  let maxDistance = 0;
  let depthMax = 0;
  let sawPositions = false;
  let shotDowned = false;
  let shotRevived = false;
  let downs = 0;
  let revives = 0;
  const until = Date.now() + IDLE_MS;
  while (Date.now() < until) {
    await run.page.wait(SAMPLE_MS);
    let s: SimView;
    let ev: Record<string, number>;
    try {
      s = await simOf(run);
      ev = await eventsOf(run);
    } catch {
      // A hot reload dropped the page: wait for it, re-arm Idle and keep sampling.
      recoveries++;
      run.report.data.reloads = ((run.report.data.reloads as number) ?? 0) + 1;
      if (recoveries > IDLE_RECOVERIES) throw new Error("the page kept reloading during Idle");
      await settle(run, cls);
      await runIdle();
      continue;
    }
    depthMax = Math.max(depthMax, s.depth);
    const hero = s.hero;
    const members = s.party?.members ?? null;
    if (members !== null) sawPositions = true;
    let farthest = 0;
    if (hero !== null && members !== null) {
      for (const m of members) {
        if (m.name === hero.name) continue;
        farthest = Math.max(farthest, distance(m, hero));
      }
      maxDistance = Math.max(maxDistance, farthest);
    }
    downs = ev["classic.party.downed"] ?? 0;
    revives = ev["classic.party.revived"] ?? 0;
    if (downs > 0 && !shotDowned) {
      await run.shot("downed");
      shotDowned = true;
    }
    if (revives > 0 && !shotRevived) {
      await run.shot("revived");
      shotRevived = true;
    }
    samples.push({
      t: samples.length * (SAMPLE_MS / 1000),
      tick: s.tick,
      depth: s.depth,
      hero: hero
        ? { name: hero.name, level: hero.level, dead: hero.dead, x: hero.x, y: hero.y }
        : null,
      members: members ?? undefined,
      farthest: Math.round(farthest * 10) / 10,
      downs,
      revives,
      heroDeaths: s.counts.heroDeaths ?? 0,
    });
  }
  await run.shot("idle-party");
  await run.page.evaluate("window.__gamez.controls.setMode('manual')");
  data.samples = samples;
  data.maxFollowerDistance = sawPositions ? Math.round(maxDistance * 10) / 10 : null;
  data.depthMax = depthMax;
  data.downs = downs;
  data.revives = revives;
  // Hard bound: the leash teleport (24 tiles). Fights and the walk-back leash (12 tiles)
  // can stretch the party for a moment, so 12 tiles is a warning.
  run.check(
    "the party stays within the leash (followers within 24 tiles)",
    !sawPositions || maxDistance <= LEASH_TILES,
    { maxDistance: data.maxFollowerDistance },
    !sawPositions,
  );
  run.check(
    "the party stays close (followers within 12 tiles)",
    !sawPositions || maxDistance <= TOGETHER_TILES,
    { maxDistance: data.maxFollowerDistance },
    true,
  );
  run.check(
    "member positions are visible to QA (sim.party.members)",
    sawPositions,
    undefined,
    true,
  );
  run.check("the party descends during the minute", depthMax >= 1, { depthMax }, true);
}

const partyRunner: Runner = async (run) => {
  const cls = classArg(run);
  await startClassic(run, cls, { cheats: true });
  const data: Record<string, unknown> = {};
  run.report.data.party = data;
  await phase(run, cls, () => grant(run, data));
  await phase(run, cls, () => town(run, data));
  await phase(run, cls, () => switches(run, data));
  await phase(run, cls, () => idle(run, cls, data));
  const final = await simOf(run);
  data.final = {
    depth: final.depth,
    hero: final.hero?.name ?? null,
    deaths: final.counts.heroDeaths ?? 0,
  };
  run.report.data.render = await run.page.evaluate("window.__gamez.render ?? null");
};

// ---------------------------------------------------------------------------
// party: the real party UI (docs/design/party.md §10, §15)
// ---------------------------------------------------------------------------

interface PartySim {
  leader: number;
  members: (SimMember & { entity: number; class: string; controlled: boolean })[];
}
interface Camera {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
}
const UI_RECRUITS: readonly { cls: string; label: string; name: string }[] = [
  { cls: "classic.rogue", label: "Rogue", name: "Wren" },
  { cls: "classic.sorcerer", label: "Sorcerer", name: "Ilsa" },
];
/** Camera centre within this many tiles of the controlled hero once it has panned. */
const CAMERA_TILES = 2.5;

const partyOf = (run: Run): Promise<PartySim | null> =>
  run.page.evaluate<PartySim | null>("window.__gamez.sim.party ?? null");

/** Clicks (taps on phone) the centre of the first element matching `selector`. */
async function clickSelector(run: Run, selector: string): Promise<boolean> {
  const at = await run.page.evaluate<{ x: number; y: number } | null>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    })()`,
  );
  if (at === null) return false;
  if (run.page.viewport.touch) await run.page.tap(at.x, at.y);
  else await run.page.click(at.x, at.y);
  return true;
}

/**
 * The controlled member and how far the camera (centre and target) is from it, in tiles.
 * Both are read in one evaluate, so the sim and the camera come from the same moment.
 */
async function controlState(
  run: Run,
): Promise<{ name: string | null; camera: number | null; target: number | null }> {
  const both = await run.page.evaluate<{ party: PartySim | null; cam: Camera | null }>(
    "({ party: window.__gamez.sim.party ?? null, cam: window.__gamez.render?.camera ?? null })",
  );
  const party = both.party;
  const me = party?.members.find((m) => m.controlled) ?? null;
  const cam = both.cam;
  if (me === null || cam === null) return { name: me?.name ?? null, camera: null, target: null };
  const r = (v: number): number => Math.round(v * 10) / 10;
  return {
    name: me.name,
    camera: r(distance({ x: cam.x, y: cam.y }, me)),
    target: r(distance({ x: cam.targetX, y: cam.targetY }, me)),
  };
}

/** Recruits through the party panel: buy two slots, then a Rogue and a Sorcerer. */
async function uiRecruit(run: Run, data: Record<string, unknown>): Promise<void> {
  // Manual: the hero stays in town (recruiting and buying slots are town-only).
  await run.page.evaluate("window.__gamez.controls.setMode('manual')");
  const g = await cheat(run, { gold: 20_000 });
  run.check("cheat gold for two slots and two fees", g.ok, g.error);
  await run.page.evaluate("window.__gamez.controls.closeAll()");
  await run.page.press("p");
  await run.page.waitFor("document.querySelector('[aria-label=\"Party roster\"]') !== null", 5000);
  await run.shot("party-panel");
  for (let i = 0; i < 2; i++) {
    const ok = await clickSelector(run, 'button[aria-label="Buy the next party slot"]');
    run.check(`buy party slot ${i + 2} (panel button)`, ok);
    await run.page.wait(500);
  }
  for (const r of UI_RECRUITS) {
    const card = `(() => {
      const b = [...document.querySelectorAll('[role="radiogroup"][aria-label="Class"] button')]
        .findIndex((el) => (el.textContent ?? "").startsWith(${JSON.stringify(r.label)}));
      return b;
    })()`;
    const idx = await run.page.evaluate<number>(card);
    const picked =
      idx >= 0 &&
      (await clickSelector(
        run,
        `[role="radiogroup"][aria-label="Class"] button:nth-of-type(${idx + 1})`,
      ));
    run.check(`pick the ${r.label} class card`, picked, { idx });
    await clickSelector(run, 'input[aria-label="New hero name"]');
    await run.page.evaluate(
      "(() => { const i = document.querySelector('input[aria-label=\"New hero name\"]'); i.focus(); i.select(); })()",
    );
    await run.page.type(r.name);
    await run.page.wait(150);
    const before = (await eventsOf(run))["classic.party.recruited"] ?? 0;
    const ok = await clickSelector(run, 'button[aria-label="Recruit"]');
    try {
      await run.page.waitFor(
        `(window.__gamez?.counters?.events?.['classic.party.recruited'] ?? 0) > ${before}`,
        5000,
      );
    } catch {
      // Checked below.
    }
    const after = (await eventsOf(run))["classic.party.recruited"] ?? 0;
    run.check(`recruit ${r.name} the ${r.label} (panel)`, ok && after > before, { before, after });
  }
  await run.shot("party-panel-recruited");
  await run.page.evaluate("window.__gamez.controls.closeAll()");
  await run.page.wait(1200);
  const party = await partyOf(run);
  data.members = party?.members.map((m) => ({ name: m.name, class: m.class, level: m.level }));
  run.check("the party has three members", party?.members.length === 3, data.members);
  const frames = await run.page.evaluate<number>(
    "document.querySelectorAll('[data-party-frame]').length",
  );
  run.check("three party frames on the HUD", frames === 3, { frames });
  const outlines = await outlinesOf(run);
  data.outlines = outlines;
  run.check(
    "outlines: one gold self, cyan party for the other two",
    outlines !== null && outlines.self === 1 && outlines.party >= 2,
    outlines,
  );
  await run.shot("party-frames");
}

/** Control switches by portrait, F-keys and Tab; the HUD and the camera follow each time. */
async function uiControl(run: Run, data: Record<string, unknown>): Promise<void> {
  const party = await partyOf(run);
  const names = party?.members.map((m) => m.name) ?? [];
  const steps: { how: string; want: string | undefined; shot: string }[] = [
    { how: "portrait 2", want: names[1], shot: "control-portrait" },
    { how: "F3", want: names[2], shot: "control-f3" },
    { how: "F1", want: names[0], shot: "control-f1" },
    { how: "Tab", want: names[1], shot: "control-tab" },
  ];
  const log: Record<string, unknown>[] = [];
  for (const st of steps) {
    if (st.how.startsWith("portrait")) await clickSelector(run, '[data-party-frame="1"]');
    else await run.page.press(st.how);
    await run.page.wait(1500);
    const c = await controlState(run);
    const hud = (await simOf(run)).hero?.name ?? null;
    log.push({ how: st.how, want: st.want, ...c, hud });
    run.check(`${st.how} takes control of ${st.want}`, c.name === st.want && hud === st.want, {
      controlled: c.name,
      hud,
    });
    run.check(
      `${st.how}: the camera follows ${st.want}`,
      c.target !== null && c.target <= 1 && c.camera !== null && c.camera <= CAMERA_TILES,
      { target: c.target, camera: c.camera },
    );
    const o = await outlinesOf(run);
    run.check(`${st.how}: still exactly one gold self outline`, o?.self === 1, o);
    await run.shot(st.shot);
  }
  data.control = log;
}

/** Party: Auto (Idle x8) for 30 s: the party stays together and the camera follows the leader. */
async function uiIdle(run: Run, data: Record<string, unknown>): Promise<void> {
  await run.page.evaluate("window.__gamez.controls.setMode('idle')");
  await run.page.evaluate("window.__gamez.controls.setSpeed(8)");
  let worst = 0;
  const camGaps: number[] = [];
  let depthMax = 0;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    await run.page.wait(2000);
    const party = await partyOf(run);
    const s = await simOf(run);
    depthMax = Math.max(depthMax, s.depth);
    const me = party?.members.find((m) => m.controlled);
    if (!party || !me) continue;
    for (const m of party.members) if (!m.dead) worst = Math.max(worst, distance(m, me));
    const c = await controlState(run);
    if (c.target !== null) camGaps.push(c.target);
  }
  await run.shot("party-idle");
  await run.page.evaluate("window.__gamez.controls.setMode('manual')");
  // At x8 the renderer's last frame can trail the sim by a few ticks (and a level change
  // moves the hero before the next frame), so most samples, not all, must be on the hero.
  const onHero = camGaps.filter((g) => g <= 2).length;
  data.idle = { worstSpread: Math.round(worst * 10) / 10, camGaps, depthMax };
  // Hard bound: the leash teleport (PartyProto.leashTeleport, 24 tiles). Fights and the
  // walk-back leash (12 tiles) can stretch the party for a moment, so 12 is a warning.
  run.check("Idle: the party stays within the leash (24 tiles)", worst <= LEASH_TILES, { worst });
  run.check(
    "Idle: the party stays close (within 12 tiles)",
    worst <= TOGETHER_TILES,
    { worst },
    true,
  );
  run.check(
    "Idle: the camera target stays on the controlled hero (80 % of samples within 2 tiles)",
    camGaps.length > 0 && onHero >= Math.ceil(camGaps.length * 0.8),
    { camGaps },
  );
}

/** `party <class>`: the party UI end to end (no party cheat; gold only). */
const partyUiRunner: Runner = async (run) => {
  const cls = classArg(run);
  await startClassic(run, cls, { cheats: true });
  const data: Record<string, unknown> = {};
  run.report.data.party = data;
  await uiRecruit(run, data);
  await uiControl(run, data);
  await uiIdle(run, data);
  run.report.data.render = await run.page.evaluate("window.__gamez.render ?? null");
};

export const PARTY_RUNNERS: Record<string, Runner> = {
  "classic-party": partyRunner,
  party: partyUiRunner,
};

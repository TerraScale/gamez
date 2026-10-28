/**
 * QA scenario: quests (docs/design/classic.md §16). OWNER: quest fix round 1.
 *
 * `node tools/qa/src/run.ts quests <class> [phone]`
 *
 * A fresh classic hero (cheats=1, manual control) in town walks through the
 * first quest chain in the real browser, the way a player does:
 *   1. Captain Hale shows "!" (the Rats in the Cellar quest is available).
 *   2. The quest log (L) at the spawn, away from Hale: records what it shows
 *      (the expected HUD fix is a "Go to Captain Hale" button; the actual state
 *      is recorded, not assumed).
 *   3. Hale's dialog (interact "quest"; on phone a tap on his sprite through
 *      npcScreenPos, falling back to interact), the real Accept button, the
 *      "Quest accepted" toast, the tracker, the log (L) with its progress text.
 *   4. Idle x8 until 20/20 ("Quest complete" toast, the Ready tracker row, the
 *      log line), manual again so Idle does not turn it in by itself.
 *   5. Reload with the tracker active and done: it must survive (local save).
 *   6. Turn in from the dialog: the reward toast, gold and XP up.
 *   7. Reload: QuestState (the completed list) survived.
 *   8. Deeper Still: accept (level 4 by cheat if needed), deepest 6, done,
 *      turn in; Into the Ninth shows up as available at level 16.
 *
 * Known limits: Auto runs only at x1 (use Idle x8 for unattended QA, which this
 * scenario does). Long runs can be interrupted by Vite full reloads when other
 * work edits files: every wait re-acquires the page (same class, save slot
 * cheats) and carries on, and the reload count is in data.reloads. Turning in
 * from deep in the dungeon uses a town portal (needs a scroll); without one the
 * run switches to Auto until the hero is in town (data.toTown says which path).
 */
import { classArg, openPicker, type Run } from "./run.ts";

type Runner = (run: Run) => Promise<void>;

const HALE = "classic.npc.captain_hale";
const RATS = "classic.quest.rats_in_the_cellar";
const DEEPER = "classic.quest.deeper_still";
const NINTH = "classic.quest.into_the_ninth";
const RATS_NAME = "Rats in the Cellar";
const DEEPER_NAME = "Deeper Still";
const RATS_COUNT = 20;
const DEEPER_LEVEL = 4;
const NINTH_LEVEL = 16;
const DEEPER_DEEPEST = 6;
const DIALOG = 'section[role="dialog"][aria-label="Quests"]';
const TRACKER = 'section[aria-label="Quest tracker"]';

interface QuestRow {
  id: string;
  name: string;
  state: "available" | "active" | "done" | "completed" | null;
  progress: number;
  count: number;
  reward: string;
}
interface HudLite {
  quests: QuestRow[];
  questGiver: { name: string; inReach: boolean } | null;
  area: { isTown: boolean } | null;
  hero: { level: number; xp: number; gold: number } | null;
}
interface UiLite {
  panels: string[];
  toasts: { kind: string; title: string; body: string }[];
  error: { code: string; message: string } | null;
}
interface ClickTarget {
  found: boolean;
  disabled?: boolean;
  x?: number;
  y?: number;
  text?: string;
  /** What document.elementFromPoint hits at the button's centre: "button" or the covering element. */
  hit?: string;
  /** "dom-click" when the tap/click did nothing and a DOM click was used to carry on. */
  fallback?: string;
}

const isPhone = (run: Run): boolean =>
  run.args.viewport === "phone" || run.args.positional.includes("phone");

/** Phone layout on a desktop launch: device metrics and touch emulation (the page reloads with it). */
async function applyPhone(run: Run): Promise<void> {
  await run.page.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await run.page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}

const hudOf = (run: Run): Promise<HudLite> =>
  run.page.evaluate<HudLite>(
    "(() => { const h = window.__gamez.hud; return { quests: (h.quests ?? []).map(q => ({ id: q.id, name: q.name, state: q.state, progress: q.progress, count: q.count, reward: q.reward })), questGiver: h.questGiver ? { name: h.questGiver.name, inReach: h.questGiver.inReach } : null, area: h.area ? { isTown: h.area.isTown } : null, hero: h.hero ? { level: h.hero.level, xp: h.hero.xp, gold: h.hero.gold } : null }; })()",
  );

const uiOf = (run: Run): Promise<UiLite> =>
  run.page.evaluate<UiLite>(
    "(() => { const u = window.__gamez.ui; return { panels: u.panels, toasts: u.toasts.map(t => ({ kind: t.kind, title: t.title, body: t.body })), error: u.error ?? null }; })()",
  );

/** hudOf that re-acquires the page when a dev-server reload has interrupted it, then retries once. */
async function hudSafe(run: Run, cls: string): Promise<HudLite> {
  try {
    return await hudOf(run);
  } catch {
    await reacquire(run, cls);
    return hudOf(run);
  }
}

/** uiOf with the same re-acquire. */
async function uiSafe(run: Run, cls: string): Promise<UiLite> {
  try {
    return await uiOf(run);
  } catch {
    await reacquire(run, cls);
    return uiOf(run);
  }
}

const stateOf = (hud: HudLite, id: string): QuestRow["state"] =>
  hud.quests.find((q) => q.id === id)?.state ?? null;

/** Is the classic hero on the page right now (false after a reload, or with no page)? */
async function alive(run: Run): Promise<boolean> {
  try {
    return await run.page.evaluate<boolean>(
      "window.__gamez?.mode === 'classic' && window.__gamez.sim?.hero != null",
    );
  } catch {
    return false;
  }
}

/**
 * Enters Classic from the mode picker. A DOM click on the Classic card, once the
 * list is full (the phone layout can still be drawing it): retried, since the
 * first click can land before the picker takes input.
 */
async function enterClassic(run: Run): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await run.page
      .waitFor("document.querySelectorAll('.mode-card').length >= 3", 30_000)
      .catch(() => undefined);
    await run.page.evaluate(
      "[...document.querySelectorAll('.mode-card')].find(c => c.textContent.includes('Classic'))?.click()",
    );
    try {
      await run.page.waitFor(
        "window.__gamez?.mode === 'classic' && window.__gamez.sim?.hero != null",
        20_000,
      );
      return;
    } catch {
      // Not in yet: click again.
    }
  }
  throw new Error("Classic did not start from the mode picker");
}

/** Opens the same classic save again (no seed, no autostart: the local save is read). */
async function reacquire(run: Run, cls: string): Promise<void> {
  run.report.data.reloads = ((run.report.data.reloads as number) ?? 0) + 1;
  // No autostart: it would create a new hero and replace the saved one. The class only matters for a new hero.
  // Other work can leave the dev server briefly broken (a 500 on a module mid-edit): retry.
  for (let attempt = 1; ; attempt++) {
    try {
      await openPicker(run, `debug=1&cheats=1&class=${encodeURIComponent(cls)}`);
      await enterClassic(run);
      await run.page.waitFor("(window.__gamez.render?.chunks ?? 0) > 0", 30_000);
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      await run.page.wait(10_000);
    }
  }
  await run.page.wait(600);
  await dismissTips(run);
}

/**
 * Waits until the page expression is true, re-acquiring the page after a
 * dev-server reload. Returns false on timeout.
 */
async function waitUntil(
  run: Run,
  cls: string,
  expr: string,
  timeoutMs: number,
  chunkMs = 15_000,
  onReacquire?: () => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await run.page.waitFor(expr, Math.min(chunkMs, Math.max(1_000, deadline - Date.now())));
      return true;
    } catch {
      if (!(await alive(run))) {
        await reacquire(run, cls);
        // A reload drops runtime settings (control mode, speed): the caller puts them back.
        if (onReacquire) await onReacquire().catch(() => undefined);
      }
    }
  }
  return false;
}

/** A controls call that survives a dev-server reload (re-acquires the page and tries again once). */
async function ctl<T = unknown>(run: Run, cls: string, expr: string): Promise<T> {
  try {
    if (!(await alive(run))) await reacquire(run, cls);
    return await run.page.evaluate<T>(expr);
  } catch {
    if (!(await alive(run))) await reacquire(run, cls);
    return run.page.evaluate<T>(expr);
  }
}

const questDone = (id: string, states: string[]): string =>
  `(window.__gamez.hud?.quests ?? []).some(q => q.id === '${id}' && [${states
    .map((s) => `'${s}'`)
    .join(",")}].includes(q.state))`;

const toastSeen = (ui: UiLite, title: string): boolean => ui.toasts.some((t) => t.title === title);

/** Button in the quest dialog, found by its label inside the row of one quest (or anywhere when quest is null). */
async function dialogButton(run: Run, label: string, quest: string | null): Promise<ClickTarget> {
  return run.page.evaluate<ClickTarget>(
    `(() => {
      const d = document.querySelector('${DIALOG}');
      if (!d) return { found: false };
      const rows = ${quest === null ? "[d]" : `[...d.querySelectorAll('li')].filter(l => l.textContent.includes(${JSON.stringify(quest)}))`};
      for (const row of rows) {
        const b = [...row.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
        if (b) {
          const r = b.getBoundingClientRect();
          return { found: true, disabled: b.disabled, x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.textContent.trim() };
        }
      }
      return { found: false };
    })()`,
  );
}

async function press(run: Run, phone: boolean, x: number, y: number): Promise<void> {
  if (phone) await run.page.tap(x, y);
  else await run.page.click(x, y);
}

/**
 * Hale's marker as the renderer draws it: whether his sprite is on screen and
 * how many marker labels are visible. The renderer exposes a count, not the
 * glyph; the glyph follows scene.ts questMarker ("?" when a quest of his is
 * done, else "!" when one can be accepted), so a visible marker with Hale on
 * screen and the quest state known is the evidence for the glyph.
 */
async function haleMarker(run: Run): Promise<{ haleOnScreen: boolean; marker: number | null }> {
  return run.page.evaluate<{ haleOnScreen: boolean; marker: number | null }>(
    `(() => {
      const p = window.__gamez.controls.npcScreenPos?.('${HALE}') ?? null;
      const haleOnScreen = p !== null && p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight;
      return { haleOnScreen, marker: window.__gamez.render?.labelsVisible?.marker ?? null };
    })()`,
  );
}

/**
 * Opens the quest dialog by talking to Hale; returns how it opened ("tap" or
 * "interact"), or null. On phone a tap on his sprite comes first, but only
 * when the sprite is on screen (a tap on empty ground does nothing). Then
 * controls.interact('quest') walks there; it is issued again after every
 * dev-server reload, since a reload drops the walk and closes the panel.
 */
async function talkToHale(run: Run, cls: string, phone: boolean): Promise<string | null> {
  const panelOpen = "(window.__gamez.ui?.panels ?? []).includes('quests')";
  if (phone) {
    try {
      const pos = await run.page.evaluate<{ x: number; y: number } | null>(
        `(() => { const p = window.__gamez.controls.npcScreenPos('${HALE}'); return p !== null && p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight ? p : null; })()`,
      );
      if (pos !== null) {
        await press(run, true, pos.x, pos.y);
        await run.page.waitFor(panelOpen, 25_000);
        return "tap";
      }
    } catch {
      if (!(await alive(run))) await reacquire(run, cls);
    }
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if (await run.page.evaluate<boolean>(panelOpen)) return "interact";
      await run.page.evaluate("window.__gamez.controls.interact('quest')");
      await run.page.waitFor(panelOpen, 20_000);
      return "interact";
    } catch {
      if (!(await alive(run))) await reacquire(run, cls);
    }
  }
  return null;
}

/**
 * A screenshot that never aborts the scenario: a CDP timeout (the page stuck
 * in a dev-server reload) becomes a warn check, and the page is re-acquired
 * when the game is gone.
 */
async function safeShot(run: Run, cls: string, name: string): Promise<void> {
  try {
    await run.shot(name);
  } catch (e) {
    run.check(`screenshot ${name}`, false, { error: String(e).slice(0, 200) }, true);
    if (!(await alive(run))) await reacquire(run, cls);
  }
}

/**
 * Clicks (or taps) a dialog button; false when it is missing or disabled.
 * Records what sits at the button's centre (elementFromPoint). When the
 * press does nothing (the quest row is unchanged after 1.5 s), that is a
 * failed check (a covered or dead button is a real UI bug, or a harness
 * input problem; `hit` tells which), and a DOM click carries the run on.
 */
async function clickDialog(
  run: Run,
  phone: boolean,
  label: string,
  quest: string | null,
): Promise<{ clicked: boolean; target: ClickTarget }> {
  const target = await dialogButton(run, label, quest);
  if (!target.found || target.disabled || target.x === undefined || target.y === undefined) {
    return { clicked: false, target };
  }
  const rowExpr = `(() => {
    const d = document.querySelector('${DIALOG}');
    const row = d && [...d.querySelectorAll('li')].find(l => l.textContent.includes(${JSON.stringify(quest ?? "")}));
    return row ? row.textContent : null;
  })()`;
  target.hit = await run.page.evaluate<string>(
    `(() => {
      const el = document.elementFromPoint(${target.x}, ${target.y});
      if (!el) return 'none';
      const b = el.closest('button');
      if (b && b.textContent.trim() === ${JSON.stringify(label)}) return 'button';
      return (el.tagName + '.' + String(el.className)).slice(0, 120);
    })()`,
  );
  const before = await run.page.evaluate<string | null>(rowExpr);
  await press(run, phone, target.x, target.y);
  let changed = false;
  for (let i = 0; i < 6 && !changed; i++) {
    await run.page.wait(250);
    changed = (await run.page.evaluate<string | null>(rowExpr)) !== before;
  }
  run.check(`${label} (${quest ?? "dialog"}) responds to the ${phone ? "tap" : "click"}`, changed, {
    hit: target.hit,
    x: target.x,
    y: target.y,
  });
  if (!changed) {
    target.fallback = "dom-click";
    await run.page.evaluate(
      `(() => {
        const d = document.querySelector('${DIALOG}');
        const rows = d ? [...d.querySelectorAll('li')].filter(l => l.textContent.includes(${JSON.stringify(quest ?? "")})) : [];
        for (const row of rows) {
          const b = [...row.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)});
          if (b) { b.click(); return; }
        }
      })()`,
    );
  }
  return { clicked: true, target };
}

/** Tries to get to town: a town portal when the hero has a scroll, else Auto until it is there. */
async function goToTown(run: Run, cls: string): Promise<string> {
  const tp = await ctl<{ ok: boolean; error?: { code: string } }>(
    run,
    cls,
    "window.__gamez.controls.act('classic.townPortal', {})",
  );
  if (tp.ok) {
    await waitUntil(run, cls, "window.__gamez.sim?.area?.isTown === true", 30_000);
    return "town portal";
  }
  const auto = (): Promise<void> =>
    ctl<void>(run, cls, "window.__gamez.controls.setMode('auto')").then(() => undefined);
  await auto();
  await waitUntil(run, cls, "window.__gamez.sim?.area?.isTown === true", 240_000, 15_000, auto);
  await ctl(run, cls, "window.__gamez.controls.setMode('manual')");
  return `auto (town portal refused: ${tp.error?.code ?? "unknown"})`;
}

async function questTracker(run: Run): Promise<string | null> {
  return run.page.evaluate<string | null>(
    `document.querySelector('${TRACKER}')?.textContent ?? null`,
  );
}

async function dialogText(run: Run): Promise<string | null> {
  return run.page.evaluate<string | null>(
    `document.querySelector('${DIALOG}')?.textContent ?? null`,
  );
}

/** Opens the quest log with the real L key (re-acquiring the page first after a reload). */
async function openLog(run: Run, cls: string): Promise<void> {
  if (!(await alive(run))) await reacquire(run, cls);
  await run.page.press("l");
  await run.page.wait(400);
}

async function closeLog(run: Run, cls: string): Promise<void> {
  await ctl(run, cls, "window.__gamez.controls.closePanel('quests')");
  await run.page.wait(300);
}

/**
 * The quest log's text, opened with L. Up to three tries: a dev-server reload
 * between the key press and the read leaves no panel (empty text).
 */
async function readLog(run: Run, cls: string): Promise<string> {
  let text = "";
  for (let i = 0; i < 3 && text === ""; i++) {
    await closeLog(run, cls);
    await openLog(run, cls);
    text = (await dialogText(run).catch(() => null)) ?? "";
  }
  return text;
}

/** Closes the first-time tip ("Got it"), which would otherwise cover the map and the dialogs. */
async function dismissTips(run: Run): Promise<void> {
  await run.page.evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Got it')?.click()",
  );
  await run.page.wait(300);
}

/**
 * A fresh hero (autostart replaces any saved one). No seed: a seeded run neither
 * reads nor writes the local save, and the reloads below need the save.
 */
async function startFresh(run: Run, cls: string): Promise<void> {
  await openPicker(run, `debug=1&cheats=1&class=${encodeURIComponent(cls)}&autostart=1`);
  await enterClassic(run);
  await run.page.waitFor("(window.__gamez.render?.chunks ?? 0) > 0", 15_000);
  await run.page.wait(800);
  await dismissTips(run);
}

async function quests(run: Run): Promise<void> {
  const cls = classArg(run, 0);
  const phone = isPhone(run);
  if (phone && run.args.viewport !== "phone") await applyPhone(run);
  await startFresh(run, cls);
  run.report.data.class = cls;
  run.report.data.phone = phone;
  run.report.data.reloads = 0;
  await ctl(run, cls, "window.__gamez.controls.setMode('manual')");
  await run.page.wait(800);

  // 1. Hale's "!" marker: the quest is available to a level 1 hero with an empty chain.
  let hud = await hudSafe(run, cls);
  const rats0 = stateOf(hud, RATS);
  const marker0 = await run.page.evaluate<number | null>(
    "window.__gamez.render?.labelsVisible?.marker ?? null",
  );
  run.check("Hale offers Rats in the Cellar (the '!' marker state)", rats0 === "available", {
    state: rats0,
    markerLabelsVisible: marker0,
  });
  run.check(
    "marker label drawn for Hale",
    typeof marker0 === "number" && marker0 > 0,
    { markerLabelsVisible: marker0 },
    true,
  );
  await safeShot(run, cls, "hale-marker");

  // 2. The log away from Hale: what does it show? (expected after the HUD fix: "Go to Captain Hale").
  const farText = await readLog(run, cls);
  const farGo = await dialogButton(run, `Go to ${hud.questGiver?.name ?? "Captain Hale"}`, null);
  const farAccept = await dialogButton(run, "Accept", RATS_NAME);
  const farInReach = hud.questGiver?.inReach ?? null;
  run.report.data.farLog = {
    inReach: farInReach,
    hasGoButton: farGo.found,
    acceptFound: farAccept.found,
    acceptDisabled: farAccept.disabled ?? null,
    text: farText.slice(0, 300),
  };
  run.check(
    "log far from Hale offers 'Go to Captain Hale' (warn until the HUD fix)",
    farInReach === true || farGo.found,
    { inReach: farInReach, hasGoButton: farGo.found, acceptDisabled: farAccept.disabled ?? null },
    true,
  );
  await safeShot(run, cls, "log-far-from-hale");
  await closeLog(run, cls);

  // 3. Talk to Hale, accept Rats in the Cellar with the real button.
  const talked = await talkToHale(run, cls, phone);
  run.check("Hale's dialog opens (talk to Captain Hale)", talked !== null, { phone, via: talked });
  const near0 = await haleMarker(run);
  run.check(
    "Hale shows the '!' marker next to the hero (Rats available, Hale on screen)",
    near0.haleOnScreen && (near0.marker ?? 0) > 0,
    { state: rats0, ...near0 },
  );
  await safeShot(run, cls, "dialog-open");
  const accept = await clickDialog(run, phone, "Accept", RATS_NAME);
  run.check(
    "Accept button for Rats in the Cellar is enabled in reach",
    accept.clicked,
    accept.target,
  );
  await run.page.wait(500);
  hud = await hudSafe(run, cls);
  let ui = await uiSafe(run, cls);
  run.check("Rats in the Cellar is active after Accept", stateOf(hud, RATS) === "active", {
    state: stateOf(hud, RATS),
  });
  run.check(
    "'Quest accepted' toast",
    toastSeen(ui, "Quest accepted"),
    ui.toasts.map((t) => t.title),
  );
  const tracker0 = await questTracker(run);
  run.check(
    "quest tracker lists Rats with 0 / 20",
    (tracker0 ?? "").includes(RATS_NAME) && (tracker0 ?? "").includes(`0 / ${RATS_COUNT}`),
    {
      tracker: tracker0,
    },
  );
  await safeShot(run, cls, "accepted-tracker");

  // The log (L) with the progress text.
  const logText = await readLog(run, cls);
  run.check(
    "log (L) shows Rats in the Cellar with its progress",
    logText.includes(RATS_NAME) && logText.includes(`/ ${RATS_COUNT}`),
    {
      head: logText.slice(0, 160),
    },
  );
  await safeShot(run, cls, "log-progress");
  await closeLog(run, cls);

  // 4. Idle x8 until the quest is finished. Manual again as soon as it is ready, so Idle
  //    does not turn it in on its own (the turn-in is tested through the dialog).
  const idle8 = async (): Promise<void> => {
    await ctl(run, cls, "window.__gamez.controls.setMode('idle')");
    await ctl(run, cls, "window.__gamez.controls.setSpeed(8)");
  };
  await idle8();
  const finishedAt = Date.now();
  const finished = await waitUntil(
    run,
    cls,
    questDone(RATS, ["done", "completed"]),
    480_000,
    15_000,
    idle8,
  );
  await ctl(run, cls, "window.__gamez.controls.setMode('manual')");
  run.report.data.progressSeconds = Math.round((Date.now() - finishedAt) / 1000);
  hud = await hudSafe(run, cls);
  ui = await uiSafe(run, cls);
  const rowState = stateOf(hud, RATS);
  run.check(
    "Idle x8 finishes Rats in the Cellar (20/20)",
    finished && rowState !== null && rowState !== "active" && rowState !== "available",
    {
      state: rowState,
      seconds: run.report.data.progressSeconds,
    },
  );
  run.check(
    "'Quest complete' toast or log line on finish",
    toastSeen(ui, "Quest complete") || (await logHas(run, "Complete: Rats in the Cellar")),
    {
      toasts: ui.toasts.map((t) => t.title),
    },
    true,
  );
  const tracker1 = await questTracker(run);
  run.check(
    "tracker shows Ready (return to Captain Hale)",
    rowState !== "done" || (tracker1 ?? "").includes("Ready"),
    {
      state: rowState,
      tracker: tracker1,
    },
    rowState !== "done",
  );
  // The '?' marker is judged at the turn-in (step 6), where Hale is on screen.
  await safeShot(run, cls, "quest-ready");

  // 5. Reload with the quest done: the tracker and the state must survive.
  if (rowState === "done") {
    await run.page.wait(3_000);
    await reacquire(run, cls);
    hud = await hudSafe(run, cls);
    run.check("Rats in the Cellar survives a reload as done", stateOf(hud, RATS) === "done", {
      state: stateOf(hud, RATS),
    });
    const after = await questTracker(run);
    run.check("tracker survives the reload (Ready)", (after ?? "").includes(RATS_NAME), {
      tracker: after,
    });
  }

  // 6. Turn in from the dialog: the reward toast, gold and XP up.
  const toTown = await goToTown(run, cls);
  run.report.data.toTown = toTown;
  await ctl(run, cls, "window.__gamez.controls.setMode('manual')");
  hud = await hudSafe(run, cls);
  const gold0 = hud.hero?.gold ?? 0;
  const xp0 = hud.hero?.xp ?? 0;
  const talked2 = await talkToHale(run, cls, phone);
  run.check("Hale's dialog opens for the turn-in", talked2 !== null, {
    phone,
    toTown,
    via: talked2,
  });
  const near1 = await haleMarker(run);
  const ratsReady = stateOf(hud, RATS);
  run.check(
    "Hale shows the '?' marker before the turn-in (Rats done, Hale on screen)",
    ratsReady === "done" && near1.haleOnScreen && (near1.marker ?? 0) > 0,
    { state: ratsReady, ...near1 },
  );
  const turn = await clickDialog(run, phone, "Turn in", RATS_NAME);
  run.check("Turn in button for Rats in the Cellar is enabled", turn.clicked, turn.target);
  await run.page.wait(800);
  hud = await hudSafe(run, cls);
  ui = await uiSafe(run, cls);
  run.check(
    "Rats in the Cellar is completed after the turn-in",
    stateOf(hud, RATS) === "completed",
    {
      state: stateOf(hud, RATS),
    },
  );
  const rewardToast = ui.toasts.find((t) => t.title === "Reward");
  run.check("reward toast shows +60 gold, +120 XP", rewardToast?.body === "+60 gold, +120 XP", {
    toast: rewardToast?.body ?? null,
  });
  run.check(
    "gold and XP went up by the reward",
    (hud.hero?.gold ?? 0) - gold0 >= 60 && (hud.hero?.xp ?? 0) - xp0 >= 120,
    { gold: [gold0, hud.hero?.gold], xp: [xp0, hud.hero?.xp] },
  );
  await safeShot(run, cls, "turned-in");

  // 7. Reload: the completed list survived.
  await run.page.wait(3_000);
  await reacquire(run, cls);
  hud = await hudSafe(run, cls);
  run.check(
    "reload keeps Rats in the Cellar completed (QuestState)",
    stateOf(hud, RATS) === "completed",
    {
      state: stateOf(hud, RATS),
    },
  );

  // 8. Deeper Still: accept (level 4 by cheat when the run is short), deepest 6, done, turn in.
  if ((hud.hero?.level ?? 0) < DEEPER_LEVEL) {
    const levels = DEEPER_LEVEL - (hud.hero?.level ?? 1);
    await ctl(run, cls, `window.__gamez.controls.cheat({ levels: ${levels} })`);
    await run.page.wait(800);
  }
  // Idle accepts quests on its own: when the Idle x8 run above reached level 4 in
  // town, Deeper Still is already active. That is the expected Idle behaviour, so
  // the manual accept is then skipped (data.deeperAcceptedBy says which path ran).
  const deeper0 = await stateOf2(run, cls, DEEPER);
  const byIdle = deeper0 === "active" || deeper0 === "done";
  run.report.data.deeperAcceptedBy = byIdle ? "idle" : "dialog";
  run.check(
    "Deeper Still is offered at level 4 (or already accepted by Idle)",
    deeper0 === "available" || byIdle,
    {
      state: deeper0,
    },
  );
  if (!byIdle) {
    const talked3 = await talkToHale(run, cls, phone);
    run.check("Hale's dialog opens for Deeper Still", talked3 !== null, { phone, via: talked3 });
    const acceptDeeper = await clickDialog(run, phone, "Accept", DEEPER_NAME);
    run.check(
      "Accept for Deeper Still is enabled in reach",
      acceptDeeper.clicked,
      acceptDeeper.target,
    );
    await run.page.wait(500);
  }
  const deeper1 = await stateOf2(run, cls, DEEPER);
  run.check("Deeper Still is active", deeper1 === "active" || deeper1 === "done", {
    state: deeper1,
  });
  await ctl(run, cls, `window.__gamez.controls.cheat({ deepest: ${DEEPER_DEEPEST} })`);
  await run.page.wait(800);
  hud = await hudSafe(run, cls);
  run.check("Deeper Still is done once depth 6 is reached", stateOf(hud, DEEPER) === "done", {
    state: stateOf(hud, DEEPER),
  });
  await safeShot(run, cls, "deeper-done");
  const talked4 = await talkToHale(run, cls, phone);
  run.check("Hale's dialog opens for the Deeper Still turn-in", talked4 !== null, {
    phone,
    via: talked4,
  });
  const turnDeeper = await clickDialog(run, phone, "Turn in", DEEPER_NAME);
  run.check("Turn in for Deeper Still is enabled", turnDeeper.clicked, turnDeeper.target);
  await run.page.wait(800);
  hud = await hudSafe(run, cls);
  run.check("Deeper Still is completed", stateOf(hud, DEEPER) === "completed", {
    state: stateOf(hud, DEEPER),
  });

  // Into the Ninth: locked below level 16, available at it.
  const ninthLocked = stateOf(hud, NINTH);
  run.check(
    "Into the Ninth stays locked below level 16 (Deeper Still done)",
    ninthLocked === null || (hud.hero?.level ?? 0) >= NINTH_LEVEL,
    { level: hud.hero?.level, state: ninthLocked },
  );
  if ((hud.hero?.level ?? 0) < NINTH_LEVEL) {
    const levels = NINTH_LEVEL - (hud.hero?.level ?? 1);
    await ctl(run, cls, `window.__gamez.controls.cheat({ levels: ${levels} })`);
    await run.page.wait(800);
    hud = await hudSafe(run, cls);
  }
  run.check("Into the Ninth becomes available at level 16", stateOf(hud, NINTH) === "available", {
    level: hud.hero?.level,
    state: stateOf(hud, NINTH),
  });
  await safeShot(run, cls, "into-the-ninth");

  // Final reload: both completions are in the save.
  await run.page.wait(3_000);
  await reacquire(run, cls);
  hud = await hudSafe(run, cls);
  run.check(
    "reload keeps both Rats and Deeper Still completed",
    stateOf(hud, RATS) === "completed" && stateOf(hud, DEEPER) === "completed",
    {
      rats: stateOf(hud, RATS),
      deeper: stateOf(hud, DEEPER),
    },
  );
  run.report.data.final = { level: hud.hero?.level, gold: hud.hero?.gold, quests: hud.quests };
}

async function stateOf2(run: Run, cls: string, id: string): Promise<QuestRow["state"]> {
  return stateOf(await hudSafe(run, cls), id);
}

async function logHas(run: Run, text: string): Promise<boolean> {
  const lines = await run.page.evaluate<{ text?: string; message?: string }[]>(
    "window.__gamez.log ?? []",
  );
  return lines.some((l) => JSON.stringify(l).includes(text));
}

export const QUESTS_RUNNERS: Record<string, Runner> = {
  quests,
};

/**
 * QA scenario admin (docs/design/admin-dashboard.md §10, §13; wave C §12).
 *
 *   admin  #admin -> (not an admin yet: "Make me admin (dev)") -> seed the local
 *          analytics stub (POST /api/dev/admin/seed-metrics?days=7&reset=1, dev
 *          hosts only; replaces earlier seeds, never real dev points) -> every
 *          sidebar section by deep link (#admin/<section>), each with a top and a
 *          scrolled screenshot, checks: no horizontal page scroll, no "NaN", no
 *          section error, charts rendered as inline SVG -> lookup of the QA account
 *          (#admin/lookup/<id>) -> dark theme shots of overview and tech -> in
 *          Flags & config, toggle the `arena` flag off with confirmation and back on.
 *          A fetch wrapper logs every /api/ request: a range change must refetch the
 *          overview with 200, and no request of the session may answer 5xx.
 *          Run once per viewport: `admin` (desktop 1366x768) and `admin --viewport phone`.
 *
 * The `arena` flag is restored in a finally block, and the theme is put back to
 * "system", so the live dev server and the browser profile are left as found.
 */
import type { Run } from "../run.ts";
import type { Runner } from "./index.ts";

const SCREEN = '[data-testid="admin-screen"]';
const BODY = ".adm-body";
const FLAG_TOGGLE = "arena";
const SESSION_KEY = "gamez.guest.v1";

/** Sidebar order (apps/game/src/client/admin/sections/index.ts). */
const SECTIONS = [
  "overview",
  "players",
  "lookup",
  "social",
  "gameplay",
  "economy",
  "monetization",
  "tech",
  "config",
] as const;

const DENIED_BUTTON = `[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Make me admin (dev)')`;
const LAYER = `(document.querySelector('.admin-layer') ?? document.scrollingElement)`;

/** Same-origin fetch with the page's guest token (the dashboard's own session). */
function authedFetch(path: string, method = "GET"): string {
  return `(async () => {
    const s = JSON.parse(localStorage.getItem('${SESSION_KEY}') ?? '{}');
    const r = await fetch(${JSON.stringify(path)}, {
      method: '${method}',
      headers: { authorization: 'Bearer ' + (s.token ?? '') },
    });
    let body = null;
    try { body = await r.json(); } catch {}
    return { status: r.status, body };
  })()`;
}

/**
 * Wraps window.fetch to record every /api/ request (url, status, start time).
 * Resource timings land only after a response finishes, so request checks use
 * this log instead. Hash navigation keeps the page, so it lasts the session.
 */
const FETCH_LOG = `(() => {
  if (window.__admFetchLog) return true;
  const log = [];
  window.__admFetchLog = log;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const entry = { url, at: Date.now(), status: 0 };
    if (url.includes('/api/')) log.push(entry);
    try {
      const r = await orig(input, init);
      entry.status = r.status;
      return r;
    } catch (err) {
      entry.status = -1;
      throw err;
    }
  };
  return true;
})()`;

/** Clicks a range preset button ("24 h", "7 d"…) in the toolbar. */
function clickRange(label: string): string {
  return `(() => {
    const b = [...document.querySelectorAll('[aria-label="Time range"] button')].find(
      (x) => x.innerText.trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`;
}

/** Sets a React-controlled <select> and fires the change React listens to. */
function setSelect(label: string, value: string): string {
  return `(() => {
    const el = document.querySelector('select[aria-label="${label}"]');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

/** Waits until the section in the hash has rendered and finished loading. */
async function waitForSection(run: Run, id: string, timeoutMs = 30_000): Promise<void> {
  await run.page.waitFor(
    `location.hash.startsWith('#admin/${id}') &&
     document.querySelector('select[aria-label="Section"]')?.value === '${id}' &&
     !!document.querySelector('${BODY}') &&
     !document.querySelector('${BODY}[aria-busy="true"]') &&
     !(document.querySelector('.adm-meta')?.innerText ?? '').includes('Loading')`,
    timeoutMs,
  );
  // Charts measure their width with a ResizeObserver: give them a frame or two.
  await run.page.evaluate(`new Promise((r) => setTimeout(r, 400))`);
}

async function goTo(run: Run, hash: string): Promise<void> {
  // A hash change fires no load event, so navigate in-page rather than page.open.
  await run.page.evaluate(`(() => { location.hash = ${JSON.stringify(hash)}; return true; })()`);
}

async function sectionFacts(run: Run): Promise<{
  scrollW: number;
  innerW: number;
  svg: number;
  tiles: number;
  nan: boolean;
  errors: number;
  clipped: number;
  empty: number;
}> {
  return run.page.evaluate(`(() => {
    const root = document.querySelector('${SCREEN}');
    const txt = root?.innerText ?? '';
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      svg: document.querySelectorAll('${BODY} svg').length,
      tiles: document.querySelectorAll('${BODY} .adm-tile').length,
      // Numbers only: tiles and chart labels. (Client error messages may say "undefined".)
      nan: /\\bNaN\\b|\\bInfinity\\b/.test(txt) ||
        [...document.querySelectorAll('${BODY} .adm-tile, ${BODY} svg text')].some((el) =>
          /\\bundefined\\b/.test(el.textContent ?? '')),
      errors: document.querySelectorAll('.adm-error').length,
      // Panels clipped past the viewport (the admin layer hides page-level overflow).
      clipped: [...document.querySelectorAll('${BODY} .adm-panel')].filter(
        (el) => el.getBoundingClientRect().right > window.innerWidth + 1,
      ).length,
      empty: (txt.match(/No data|no samples|Nothing in this range/gi) ?? []).length,
    };
  })()`);
}

async function scrollShot(run: Run, name: string): Promise<void> {
  await run.page.evaluate(
    `(() => { const el = ${LAYER}; el.scrollTop = Math.round(el.scrollHeight / 2); return true; })()`,
  );
  await run.page.evaluate(`new Promise((r) => setTimeout(r, 250))`);
  await run.shot(name);
  await run.page.evaluate(`(() => { const el = ${LAYER}; el.scrollTop = 0; return true; })()`);
}

async function adminFlow(run: Run): Promise<void> {
  const page = run.page;
  await page.open(`${run.args.url}/#admin`);
  await page.waitFor(`!!document.querySelector('${SCREEN}')`, 30_000);

  // Either the dashboard or the "not an admin" state, then decide.
  await page.waitFor(`!!document.querySelector('${BODY}') || (${DENIED_BUTTON})`, 30_000);
  const denied = await page.evaluate<boolean>(
    `!document.querySelector('${BODY}') && (${DENIED_BUTTON})`,
  );
  if (denied) {
    // A fresh guest is not on the admin list: grant the dev admin, as the dev host allows.
    await run.shot("not-admin");
    await page.clickText("Make me admin (dev)", { timeoutMs: 15_000 });
  }
  await page.waitFor(`!!document.querySelector('${BODY}')`, 30_000);
  run.check("dev admin reaches the dashboard", true);
  await page.evaluate(FETCH_LOG);

  // Seed the local analytics stub so every AE chart has shape (dev hosts only).
  const seed = await page.evaluate<{ status: number; body: { points?: number } | null }>(
    authedFetch("/api/dev/admin/seed-metrics?days=7&reset=1", "POST"),
  );
  run.sample({ seed });
  run.check(
    "seeded the local analytics stub",
    seed.status === 200 && (seed.body?.points ?? 0) > 0,
    seed,
  );

  const perSection: Record<string, unknown> = {};
  for (const id of SECTIONS) {
    try {
      await goTo(run, `#admin/${id}`);
      await waitForSection(run, id);
      const f = await sectionFacts(run);
      perSection[id] = f;
      run.check(`${id}: renders without a section error`, f.errors === 0, f);
      run.check(`${id}: no NaN/undefined/Infinity in the text`, !f.nan);
      run.check(
        `${id}: no horizontal page scroll`,
        f.scrollW <= f.innerW,
        `${f.scrollW} > ${f.innerW}`,
      );
      run.check(`${id}: no panel wider than the viewport`, f.clipped === 0, f.clipped);
      if (id !== "lookup" && id !== "config") {
        run.check(`${id}: charts render as inline SVG`, f.svg > 0, f.svg);
      }
      await run.shot(`section-${id}`);
      await scrollShot(run, `section-${id}-scrolled`);
    } catch (err) {
      run.check(`${id}: section loads`, false, String(err));
    }
  }
  run.sample({ sections: perSection });

  // Range change: a new overview request starts and answers 200 (fetch log, not timings).
  try {
    await goTo(run, "#admin/overview");
    await waitForSection(run, "overview");
    const pressed = await page.evaluate<string>(
      `document.querySelector('[aria-label="Time range"] button[aria-pressed="true"]')?.innerText.trim() ?? ''`,
    );
    const target = pressed === "24 h" ? "7 d" : "24 h";
    const since = await page.evaluate<number>("Date.now()");
    run.check(`range: ${target} button found`, await page.evaluate<boolean>(clickRange(target)));
    await page.waitFor(
      `window.__admFetchLog.some((e) => e.at >= ${since} && e.url.includes('/api/admin/overview') && e.status > 0)`,
      15_000,
    );
    const req = await page.evaluate<{ url: string; status: number } | null>(
      `window.__admFetchLog.find((e) => e.at >= ${since} && e.url.includes('/api/admin/overview')) ?? null`,
    );
    run.check("range change refetches the overview with 200", req?.status === 200, req);
    if (pressed) await page.evaluate(clickRange(pressed));
    await waitForSection(run, "overview");
  } catch (err) {
    run.check("range change refetches the overview with 200", false, String(err));
  }

  // Lookup by deep link: the QA account itself.
  try {
    const me = await page.evaluate<string>(
      `JSON.parse(localStorage.getItem('${SESSION_KEY}') ?? '{}').accountId ?? ''`,
    );
    await goTo(run, `#admin/lookup/${encodeURIComponent(me)}`);
    await page.waitFor(
      // Loaded, not "Loading player…": the support actions only render with the detail.
      `(document.querySelector('${SCREEN}')?.innerText ?? '').includes('Support actions') &&
       (document.querySelector('${SCREEN}')?.innerText ?? '').includes(${JSON.stringify(me)})`,
      30_000,
    );
    run.check("lookup deep link opens the QA account", true);
    const lf = await sectionFacts(run);
    run.check("lookup detail: no panel wider than the viewport", lf.clipped === 0, lf.clipped);
    await run.shot("lookup-detail");
    await scrollShot(run, "lookup-detail-scrolled");
  } catch (err) {
    run.check("lookup deep link opens the QA account", false, String(err));
  }

  // Dark theme on two dense sections, then back to the system theme.
  try {
    await goTo(run, "#admin/overview");
    await waitForSection(run, "overview");
    run.check("theme picker found", await page.evaluate<boolean>(setSelect("Theme", "dark")));
    await page.waitFor(
      `document.querySelector('.adm')?.getAttribute('data-theme') === 'dark'`,
      5_000,
    );
    await run.shot("dark-overview");
    await goTo(run, "#admin/tech");
    await waitForSection(run, "tech");
    await run.shot("dark-tech");
    run.check("dark theme applies data-theme=dark", true);
  } catch (err) {
    run.check("dark theme applies data-theme=dark", false, String(err));
  } finally {
    await page.evaluate(setSelect("Theme", "system"));
  }

  // Kill switch round trip in Flags & config on a flag whose feature is not live yet.
  await goTo(run, "#admin/config");
  await waitForSection(run, "config");
  // The config section loads /api/config and the tunables itself after it mounts.
  await page
    .waitFor(
      `document.querySelectorAll('[aria-labelledby="adm-flags-title"] .adm-flag').length > 0 &&
       (document.querySelector('${SCREEN}')?.innerText ?? '').includes('classic.offlineXpPct')`,
      20_000,
    )
    .catch(() => undefined);
  const flags = await page.evaluate<number>(
    `document.querySelectorAll('[aria-labelledby="adm-flags-title"] .adm-flag').length`,
  );
  run.check("config: seven feature flags listed", flags === 7, flags);
  const tunable = await page.evaluate<boolean>(
    `(document.querySelector('${SCREEN}')?.innerText ?? '').includes('classic.offlineXpPct')`,
  );
  run.check("config: the offline XP tunable is listed", tunable);

  /** Scrolls a control into view first: clickText only sees elements in the viewport. */
  const reveal = (sel: string) =>
    page.evaluate<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ block: 'center' }); return !!el; })()`,
    );
  const flagOn = () =>
    page.evaluate<boolean>(
      `fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).then((c) => c.flags['${FLAG_TOGGLE}'] !== false)`,
    );
  try {
    await reveal(`[aria-label="Turn off ${FLAG_TOGGLE}"]`);
    await page.clickText(`Turn off ${FLAG_TOGGLE}`, { timeoutMs: 10_000 });
    await reveal(".adm-confirm");
    await run.shot("flag-confirm");
    await page.clickText("Confirm: turn off", { timeoutMs: 5_000 });
    await page.waitFor(
      `(document.querySelector('.adm-status')?.innerText ?? '').includes('${FLAG_TOGGLE} turned off')`,
      15_000,
    );
    run.check(`flag ${FLAG_TOGGLE} switched off with confirmation`, true);
    await run.shot("flag-off");
  } catch (err) {
    run.check(`flag ${FLAG_TOGGLE} switched off with confirmation`, false, String(err));
  } finally {
    try {
      if (!(await flagOn())) {
        await reveal(`[aria-label="Turn on ${FLAG_TOGGLE}"]`);
        await page.clickText(`Turn on ${FLAG_TOGGLE}`, { timeoutMs: 10_000 });
        await reveal(".adm-confirm");
        await page.clickText("Confirm: turn on", { timeoutMs: 5_000 });
        await page.waitFor(
          `(document.querySelector('.adm-status')?.innerText ?? '').includes('${FLAG_TOGGLE} turned on')`,
          15_000,
        );
      }
      run.check(`flag ${FLAG_TOGGLE} is on again`, await flagOn());
    } catch (err) {
      run.check(`flag ${FLAG_TOGGLE} is on again`, false, String(err));
    }
  }

  // Every /api/ answer of the session, with the URL of any server error.
  const failed = await page.evaluate<{ url: string; status: number }[]>(
    `(window.__admFetchLog ?? []).filter((e) => e.status >= 500 || e.status === -1)`,
  );
  const total = await page.evaluate<number>(`(window.__admFetchLog ?? []).length`);
  run.sample({ apiRequests: total, apiFailures: failed });
  run.check("no /api/ request failed with 5xx or a network error", failed.length === 0, failed);
}

export const ADMIN_RUNNERS: Record<string, Runner> = {
  admin: adminFlow,
};

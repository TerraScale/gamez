/**
 * QA scenario admin (docs/design/wave-C.md §12). OWNER: T-admin.
 *
 *   admin  #admin -> (not an admin yet: "Make me admin (dev)") -> dashboard tiles,
 *          faucets vs sinks chart, price index, flags, moderation queue; no horizontal
 *          scroll; toggle the `arena` flag off with confirmation and back on.
 *          Run once per viewport: `admin` (desktop 1366x768) and `admin --viewport phone` (390x844).
 *
 * The `arena` flag is used because its feature is not live yet; it is restored in a
 * finally block, so the live dev server is left with every flag on.
 */
import type { Run } from "../run.ts";
import type { Runner } from "./index.ts";

const SCREEN = '[data-testid="admin-screen"]';
const TILES = ".adm-tiles";
const FLAG_TOGGLE = "arena";

/** Waits until the dashboard (not the loading or denied state) is on screen. */
async function waitForDashboard(run: Run, timeoutMs = 20_000): Promise<void> {
  await run.page.waitFor(`!!document.querySelector('${TILES}')`, timeoutMs);
}

async function adminFlow(run: Run): Promise<void> {
  const page = run.page;
  await page.open(`${run.args.url}/#admin`);
  await page.waitFor(`!!document.querySelector('${SCREEN}')`, 30_000);

  // Wait for either the dashboard or the "not an admin" state, then decide.
  const DENIED_BUTTON = `[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Make me admin (dev)')`;
  await page.waitFor(`!!document.querySelector('${TILES}') || (${DENIED_BUTTON})`, 20_000);
  const denied = await page.evaluate<boolean>(
    `!document.querySelector('${TILES}') && (${DENIED_BUTTON})`,
  );
  if (denied) {
    // A fresh guest is not on the admin list: grant the dev admin, as the dev host allows.
    await run.shot("not-admin");
    await page.clickText("Make me admin (dev)", { timeoutMs: 15_000 });
  }
  await waitForDashboard(run);
  await page.waitFor(`document.querySelectorAll('.adm-section svg[role=img]').length >= 2`, 20_000);

  const facts = await page.evaluate<{
    tiles: number;
    charts: number;
    flags: number;
    scrollW: number;
    innerW: number;
    moderation: boolean;
    priceNote: boolean;
  }>(`(() => {
    const txt = document.querySelector('${SCREEN}')?.innerText ?? '';
    return {
      tiles: document.querySelectorAll('.adm-tile').length,
      charts: document.querySelectorAll('.adm-section svg[role=img]').length,
      flags: document.querySelectorAll('.adm-flag').length,
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      moderation: txt.includes('Moderation queue'),
      priceNote: txt.includes('Price index'),
    };
  })()`);
  run.sample(facts);
  run.check("dashboard: at least 8 stat tiles", facts.tiles >= 8, facts.tiles);
  run.check(
    "dashboard: faucets chart and price chart are inline SVG",
    facts.charts >= 2,
    facts.charts,
  );
  run.check("dashboard: seven feature flags listed", facts.flags === 7, facts.flags);
  run.check(
    "dashboard: moderation queue and price index sections",
    facts.moderation && facts.priceNote,
  );
  run.check(
    "dashboard: no horizontal page scroll",
    facts.scrollW <= facts.innerW,
    `${facts.scrollW} > ${facts.innerW}`,
  );
  await run.shot("dashboard");

  // Kill switch round trip on a flag whose feature is not live yet. The finally block
  // reads the server's flag and restores it through the same UI whenever it is off.
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
      `(document.querySelector('.adm-status')?.innerText ?? '').includes('${FLAG_TOGGLE} is now off')`,
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
          `(document.querySelector('.adm-status')?.innerText ?? '').includes('${FLAG_TOGGLE} is now on')`,
          15_000,
        );
      }
      run.check(`flag ${FLAG_TOGGLE} is on again`, await flagOn());
    } catch (err) {
      run.check(`flag ${FLAG_TOGGLE} is on again`, false, String(err));
    }
  }
}

export const ADMIN_RUNNERS: Record<string, Runner> = {
  admin: adminFlow,
};

/**
 * QA scenario classic-social (docs/design/wave-B.md §11). OWNER: T-classic-hud.
 *
 * Opens the four social panels (chat, guild, leaderboards, account) through the real entry
 * points (the desktop bar, or the phone "More" menu), screenshots each, then the sync badge and
 * its detail popover. Checks that the entry points exist, that each panel opens and renders,
 * that the badge sits clear of the minimap column (layout helpers) and that its hit area is at
 * least 44 px. A seeded run is a local game, so the badge reads "Local game" and the panels show
 * their offline notes unless a platform is wired in.
 *
 *   node tools/qa/src/run.ts classic-social warrior
 *   node tools/qa/src/run.ts classic-social warrior --viewport phone
 */
import { classArg, startClassic, type Run } from "../run.ts";
import type { Runner } from "./index.ts";
// The layout helpers are pure TypeScript (type-only imports), so the node runner can load them.
import { hudLayoutFor, topRightInset } from "../../../../modules/classic/src/client/hud/layout.ts";

interface SocialPanel {
  id: "chat" | "guild" | "leaderboard" | "account";
  title: string;
}

const SOCIAL: readonly SocialPanel[] = [
  { id: "chat", title: "Chat" },
  { id: "guild", title: "Guild" },
  { id: "leaderboard", title: "Leaderboards" },
  { id: "account", title: "Account" },
];

interface BadgeRect {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
}

const badgeRect = `(() => {
  const b = document.querySelector('[data-testid="sync-badge"] button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, right: r.right, label: b.getAttribute('aria-label') };
})()`;

const dialogText = (title: string): string =>
  `(document.querySelector('[role=dialog][aria-label=${JSON.stringify(title)}]')?.innerText ?? '').slice(0, 400)`;

export const CLASSIC_SOCIAL_RUNNERS: Record<string, Runner> = {
  "classic-social": async (run: Run) => {
    const cls = classArg(run);
    await startClassic(run, cls);
    await run.page.evaluate("window.__gamez.controls.setMode('manual')");
    await run.page.wait(300);
    const phone = run.args.viewport === "phone";
    const data: Record<string, unknown> = { viewport: run.args.viewport, panels: {} };
    run.report.data.social = data;

    // ---- entry points -------------------------------------------------------------------
    if (phone) {
      await run.page.clickText("More panels", { exact: true, timeoutMs: 10_000 });
      await run.page.wait(300);
      const rows = await run.page.evaluate<string[]>(
        "[...document.querySelectorAll('[role=menu][aria-label=\"More panels\"] button')].map((b) => b.getAttribute('title') ?? '')",
      );
      data.menuRows = rows;
      for (const p of SOCIAL) {
        run.check(`More menu lists ${p.title}`, rows.includes(p.title), rows);
      }
      await run.shot("more-menu");
      await run.page.clickText("More panels", { exact: true, timeoutMs: 5_000 });
      await run.page.wait(200);
    } else {
      const bar = await run.page.evaluate<string[]>(
        "[...document.querySelectorAll('[role=toolbar][aria-label=Panels] button')].map((b) => b.getAttribute('title') ?? '')",
      );
      data.barTitles = bar;
      for (const p of SOCIAL) {
        run.check(`desktop bar has ${p.title}`, bar.includes(p.title), bar);
      }
    }

    // ---- the four panels ----------------------------------------------------------------
    for (const p of SOCIAL) {
      await run.page.evaluate("window.__gamez.controls.closeAll()");
      await run.page.wait(200);
      if (phone) {
        await run.page.clickText("More panels", { exact: true, timeoutMs: 5_000 });
        await run.page.wait(200);
        await run.page.clickText(p.title, { exact: true, timeoutMs: 5_000 });
      } else {
        await run.page.clickText(p.title, { exact: true, timeoutMs: 5_000 });
      }
      await run.page.wait(500);
      const opened = await run.page.evaluate<string[]>("window.__gamez.ui.panels");
      run.check(`${p.title} panel opens`, opened.includes(p.id), opened);
      const text = await run.page.evaluate<string>(dialogText(p.title));
      const panels = data.panels as Record<string, unknown>;
      panels[p.id] = { text: text.slice(0, 160) };
      run.check(`${p.title} panel renders text`, text.trim().length > 0, text.slice(0, 80));
      await run.shot(`panel-${p.id}`);
    }

    // ---- the sync badge -----------------------------------------------------------------
    await run.page.evaluate("window.__gamez.controls.closeAll()");
    await run.page.wait(200);
    const before = await run.page.evaluate<(BadgeRect & { label: string }) | null>(badgeRect);
    run.check("sync badge is rendered", before !== null, before);
    if (before) {
      data.badgeLabel = before.label;
      run.check("sync badge hit area is at least 44 px", before.height >= 44, before);
      const { innerWidth, innerHeight } = await run.page.evaluate<{
        innerWidth: number;
        innerHeight: number;
      }>("({ innerWidth, innerHeight })");
      const layout = hudLayoutFor(innerWidth < 700, innerHeight);
      const inset = topRightInset(layout);
      run.check(
        `sync badge clears the minimap column (${layout})`,
        innerWidth - before.right >= inset - 1,
        { right: before.right, innerWidth, inset },
      );
      await run.page.click(before.x, before.y);
      await run.page.wait(300);
      const popover = await run.page.evaluate<string>(
        "(document.querySelector('[role=status][aria-label=\"Save status details\"]')?.innerText ?? '')",
      );
      data.popover = popover.slice(0, 300);
      run.check(
        "sync badge popover opens",
        popover.includes("Verified tick") || popover.includes("No server"),
        popover.slice(0, 80),
      );
      await run.shot("sync-detail");
      await run.page.click(before.x, before.y);
      await run.page.wait(200);
    }
    await run.shot("after-close");
  },
};

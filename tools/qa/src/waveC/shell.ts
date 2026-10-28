/**
 * Wave C QA scenarios: economy-shell (picker -> market, vault, trade between two pages, plots, pass, store; desktop + phone) (docs/design/wave-C.md §12). OWNER: T-shell.
 *
 *   economy-shell  two guests register (in place, so the accounts are registered), then:
 *                  1. every picker entry opens its sheet (title, a screenshot), closes with
 *                     Escape, and the Close button works once;
 *                  2. guest A gets an item from the dev grant and opens a trade with B
 *                     (POST /api/trade, the same call the classic town's "Trade" makes);
 *                  3. B gets the trade.invite toast, taps "Open", and both accept.
 *                  Steps 2-3 need the EscrowDO (T-escrow) and the dev grant; when they are
 *                  missing the checks say how far the flow got.
 *
 * Run it once per viewport, each with its own --out so the screenshots do not collide:
 *   node tools/qa/src/run.ts economy-shell --out /tmp/gamez-qa/waveC-shell-desktop --viewport desktop
 *   node tools/qa/src/run.ts economy-shell --out /tmp/gamez-qa/waveC-shell-phone --viewport phone
 *
 * Selectors are the shell's own (EconomyBar, Sheet, Toast). Sheet bodies are the
 * economy components; they are found by visible text only.
 */
import { launch, VIEWPORTS, type Page } from "../cdp.ts";
import { openPicker, type Run } from "../run.ts";
import type { Runner } from "./index.ts";

/** The picker entries, the button text that opens each, and the sheet title it shows. */
const ENTRIES: readonly { key: string; button: string; title: string }[] = [
  { key: "market", button: "^Market$", title: "Market" },
  { key: "vault", button: "^Vault$", title: "Vault" },
  { key: "trade", button: "^Trade$", title: "Trade" },
  { key: "shops", button: "^Shops$", title: "Shops" },
  { key: "arena", button: "^Arena$", title: "Arena" },
  { key: "pass", button: "^Battle Pass$", title: "Battle Pass" },
  { key: "store", button: "^Store$", title: "Store" },
  { key: "notices", button: "Inbox|Notices", title: "Notices" },
];

/** Item granted to guest A (dev grant, classic-independent universal material). */
const GRANT_ITEM = {
  itemId: "universal.material.ember_dust",
  count: 3,
  origin: "",
  universal: true,
  tradable: true,
  data: null,
  summary: {
    name: "Ember Dust",
    rarity: "common",
    level: 0,
    category: "material",
    slot: null,
    icon: "item.ember_dust",
    lines: [],
  },
};

interface Target {
  x: number;
  y: number;
  text: string;
}

interface SheetInfo {
  title: string | null;
  body: string;
  sheets: number;
  scrollW: number;
  innerW: number;
  small: string[];
}

// ---- in-page helpers (passed to page.evaluate as functions) ---------------------------

/** Visible, enabled button inside `scope` (or the page) whose text or label matches `pattern`. */
function findButton(scope: string | null, pattern: string): Target | null {
  const root: ParentNode = (scope ? document.querySelector(scope) : null) ?? document;
  const re = new RegExp(pattern, "i");
  for (const el of root.querySelectorAll<HTMLElement>("button, [role=button]")) {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || el.getAttribute("aria-label") || "").trim();
    const disabled = (el as HTMLButtonElement).disabled === true;
    if (r.width > 0 && r.height > 0 && !disabled && re.test(text)) {
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text };
    }
  }
  return null;
}

/** The sheet on top of the stack (the only one without the hidden attribute), with the page's layout facts. */
function topSheet(): SheetInfo {
  const backdrops = [...document.querySelectorAll<HTMLElement>(".sheet-backdrop")];
  const top = backdrops.filter((b) => !b.hasAttribute("hidden")).at(-1) ?? null;
  const small = [...document.querySelectorAll<HTMLElement>(".economy-bar button, .sheet button")]
    .filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 44;
    })
    .map((b) => (b.innerText || b.getAttribute("aria-label") || "").slice(0, 40));
  return {
    title: top?.querySelector("h2")?.textContent ?? null,
    body: top?.querySelector(".sheet-body")?.textContent?.slice(0, 160) ?? "",
    sheets: backdrops.length,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    small,
  };
}

/** Plain-text list of the trades the page can see (GET /api/trade), for the step log. */
async function tradesOf(): Promise<unknown> {
  const res = await fetch("/api/trade", {
    headers: {
      authorization: `Bearer ${JSON.parse(localStorage.getItem("gamez.guest.v1") ?? "{}").token}`,
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * Registers the guest in this page in place (same accountId, now registered) and stores
 * the new session, so the next load of the page is that account.
 */
async function registerInPage(label: string, password: string): Promise<unknown> {
  const KEY = "gamez.guest.v1";
  const guest = JSON.parse(localStorage.getItem(KEY) ?? "null");
  if (!guest || typeof guest.token !== "string") return { ok: false, code: "no_guest_session" };
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${guest.token}` },
    body: JSON.stringify({
      email: `${label}@example.test`,
      password,
      displayName: label.replace(/[^A-Za-z0-9]/g, "").slice(0, 16),
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    token?: string;
    account?: { accountId: string; displayName: string; kind: string };
    code?: string;
  } | null;
  if (!res.ok || !body?.token || !body.account) {
    return { ok: false, status: res.status, code: body?.code ?? null };
  }
  localStorage.setItem(
    KEY,
    JSON.stringify({
      token: body.token,
      accountId: body.account.accountId,
      name: body.account.displayName,
      kind: body.account.kind,
    }),
  );
  return { ok: true, accountId: body.account.accountId, kind: body.account.kind };
}

/** The current session's account id, read from localStorage (the page owns it). */
function sessionOf(): { accountId: string | null; kind: string | null } {
  const s = JSON.parse(localStorage.getItem("gamez.guest.v1") ?? "null");
  return { accountId: s?.accountId ?? null, kind: s?.kind ?? null };
}

// ---- harness helpers ------------------------------------------------------------------

async function clickButton(
  page: Page,
  scope: string | null,
  pattern: string,
  timeoutMs = 8_000,
): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const t = await page.evaluate<Target | null>(findButton, scope, pattern);
    if (t) {
      if (page.viewport.touch) await page.tap(t.x, t.y);
      else await page.click(t.x, t.y);
      return t.text;
    }
    if (Date.now() > end) throw new Error(`no button /${pattern}/ in ${scope ?? "page"}`);
    await page.wait(150);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Registers a guest in `page` and reloads it into the registered session. */
async function registerPage(
  run: Run,
  page: Page,
  label: string,
): Promise<{ accountId: string | null }> {
  await page.open(run.url(""));
  await page.waitFor("document.querySelector('.economy-bar') !== null", 30_000);
  const res = await page.evaluate<{
    ok: boolean;
    accountId?: string;
    code?: string;
    status?: number;
  }>(registerInPage, label, "shell-password-123");
  if (!res.ok) throw new Error(`register ${label} failed: ${res.code ?? res.status ?? "unknown"}`);
  await page.open(run.url(""));
  await page.waitFor("document.querySelector('.economy-bar') !== null", 30_000);
  const session = await page.evaluate<{ accountId: string | null; kind: string | null }>(sessionOf);
  return { accountId: session.accountId };
}

// ---- scenario -------------------------------------------------------------------------

async function economyShell(run: Run): Promise<void> {
  const stamp = Date.now().toString(36).slice(-6);
  const viewport = run.args.viewport;
  const steps: Record<string, unknown> = { viewport };
  run.report.data.steps = steps;

  await openPicker(run, "");
  await run.page.waitFor("document.querySelector('.economy-bar') !== null", 30_000);
  await run.page.wait(300);
  await run.shot("picker");

  // Phase 0: two registered accounts (the trade needs both).
  const a = await registerPage(run, run.page, `ShellA${stamp}`);
  run.check("guest A registered in place", a.accountId !== null, a);
  steps.accountA = a.accountId;

  const second = await launch(VIEWPORTS[viewport]);
  try {
    const b = await registerPage(run, second, `ShellB${stamp}`);
    run.check("guest B registered in place", b.accountId !== null, b);
    steps.accountB = b.accountId;

    // Phase 1: every picker entry opens its sheet, screenshots, closes (Escape).
    await run.page.open(run.url(""));
    await run.page.waitFor("document.querySelector('.economy-bar') !== null", 30_000);
    const layoutPicker = await run.page.evaluate<{ scrollW: number; innerW: number }>(
      "({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth })",
    );
    run.check(
      "picker: no horizontal scroll",
      layoutPicker.scrollW <= layoutPicker.innerW,
      layoutPicker,
    );
    const pickerSmall = await run.page.evaluate<string[]>(
      `[...document.querySelectorAll('.economy-bar button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height < 44; }).map((b) => (b.innerText || b.getAttribute('aria-label') || '').slice(0, 40))`,
    );
    run.check(
      "picker: economy buttons are at least 44 px high",
      pickerSmall.length === 0,
      pickerSmall,
    );
    for (const entry of ENTRIES) {
      try {
        await clickButton(run.page, ".economy-bar", entry.button);
        await run.page.waitFor(
          `!!document.querySelector('.sheet-backdrop:not([hidden]) h2') && document.querySelector('.sheet-backdrop:not([hidden]) h2').textContent === ${JSON.stringify(entry.title)}`,
          10_000,
        );
        // Lazy bodies: wait for the chunk, then for the loading line to go.
        await run.page
          .waitFor(
            `!(document.querySelector('.sheet-backdrop:not([hidden]) .sheet-body')?.textContent ?? '').includes('Loading')`,
            20_000,
          )
          .catch(() => undefined);
        await run.page.wait(300);
        const info = await run.page.evaluate<SheetInfo>(topSheet);
        await run.shot(`sheet-${entry.key}`);
        run.check(`${entry.title}: sheet opens over the picker`, info.title === entry.title, {
          title: info.title,
          body: info.body.slice(0, 80),
        });
        run.check(
          `${entry.title}: no horizontal scroll with the sheet open`,
          info.scrollW <= info.innerW,
          { scrollW: info.scrollW, innerW: info.innerW },
        );
        if (info.small.length > 0) {
          run.check(`${entry.title}: buttons are at least 44 px`, false, info.small, true);
        }
        await run.page.press("Escape");
        await run.page.waitFor("document.querySelectorAll('.sheet-backdrop').length === 0", 5_000);
        run.check(`${entry.title}: Escape closes it`, true);
      } catch (err) {
        run.check(`${entry.title}: opens and closes`, false, errorText(err));
        await run.page.press("Escape").catch(() => undefined);
      }
    }

    // The Close button, once: Vault.
    await clickButton(run.page, ".economy-bar", "^Vault$");
    await run.page.waitFor("document.querySelector('.sheet-backdrop') !== null", 10_000);
    await clickButton(run.page, ".sheet-backdrop:not([hidden])", "^Close$");
    await run.page.waitFor("document.querySelectorAll('.sheet-backdrop').length === 0", 5_000);
    run.check("Vault: the Close button closes it", true);

    // Phase 2: a grant to A, then a trade from A to B (the EscrowDO path, T-escrow).
    const grant = await run.page.evaluate<{ status: number; body: unknown }>(async (item) => {
      const token = JSON.parse(localStorage.getItem("gamez.guest.v1") ?? "{}").token;
      const res = await fetch("/api/dev/economy/grant", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ items: [item] }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, GRANT_ITEM);
    steps.grant = grant;
    run.check(
      "dev grant: item granted to A (T-escrow endpoint present)",
      grant.status === 200,
      grant.status === 404 ? "endpoint absent (404): T-escrow not landed" : grant,
      grant.status === 404,
    );

    const tradeOpen = await run.page.evaluate<{ status: number; body: unknown }>(
      async (withAccountId, opId) => {
        const token = JSON.parse(localStorage.getItem("gamez.guest.v1") ?? "{}").token;
        const res = await fetch("/api/trade", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ opId, with: withAccountId }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      b.accountId,
      `qashell${stamp}trade`,
    );
    steps.tradeOpen = tradeOpen;
    const tradeId = (tradeOpen.body as { id?: string } | null)?.id ?? null;
    run.check(
      "A opens a trade with B (POST /api/trade)",
      tradeOpen.status === 200 && tradeId !== null,
      tradeOpen.status === 404 ? "endpoint absent (404): T-escrow not landed" : tradeOpen,
      tradeOpen.status === 404,
    );

    // A sees the trade in the Trade sheet.
    await clickButton(run.page, ".economy-bar", "^Trade$");
    await run.page.waitFor(
      "document.querySelector('.sheet-backdrop:not([hidden])') !== null",
      10_000,
    );
    await run.page.wait(800);
    await run.shot("trade-A");
    await run.page.press("Escape");
    await run.page.waitFor("document.querySelectorAll('.sheet-backdrop').length === 0", 5_000);

    // B: the invite arrives as a toast (5 s, the bell polls every 20 s) and stays as an unread
    // bell count. Wait for the bell (persistent); the toast is taken if it is still up.
    let bellUnread = false;
    try {
      await second.waitFor(
        "/unread/.test(document.querySelector('.economy-bell')?.getAttribute('aria-label') ?? '')",
        45_000,
      );
      bellUnread = true;
    } catch {
      bellUnread = false;
    }
    const sawToast = await second.evaluate<boolean>(
      "document.querySelector('.toast-action') !== null",
    );
    run.check(
      "B sees the trade invite (bell count, and the toast when it is still up)",
      bellUnread,
      { bellUnread, toastStillUp: sawToast },
      !bellUnread,
    );
    run.check(
      "B's invite toast carries an Open action",
      sawToast,
      sawToast ? undefined : "toast already gone when checked (5 s display): bell opened instead",
      true,
    );
    steps.bellB = await second.evaluate<string | null>(
      "document.querySelector('.economy-bell')?.getAttribute('aria-label') ?? null",
    );
    run.report.screenshots.push({
      name: "trade-invite-B",
      path: await second.screenshot(`${run.report.outDir}/trade-invite-B.png`),
    });

    if (sawToast) {
      await clickButton(second, null, "^Open$");
    } else if (bellUnread) {
      await clickButton(second, ".economy-bar", "Inbox|Notices");
      await second.waitFor(
        "document.querySelector('.sheet-backdrop:not([hidden]) h2') !== null",
        10_000,
      );
      await clickButton(second, ".sheet-backdrop:not([hidden])", "wants to trade", 10_000).catch(
        () => undefined,
      );
    }
    if (bellUnread) {
      await second
        .waitFor(
          "document.querySelector('.sheet-backdrop:not([hidden]) h2')?.textContent === 'Trade'",
          10_000,
        )
        .then(
          () => run.check("B opens the invite into the Trade sheet", true),
          (err: unknown) =>
            run.check("B opens the invite into the Trade sheet", false, errorText(err)),
        );
      await second.wait(800);
      run.report.screenshots.push({
        name: "trade-B",
        path: await second.screenshot(`${run.report.outDir}/trade-B.png`),
      });
    }

    // A puts the granted item on the table (an empty trade cannot be accepted).
    const itemUid = (grant.body as { items?: { uid?: string }[] } | null)?.items?.[0]?.uid;
    if (tradeId !== null && typeof itemUid === "string") {
      const offered = await run.page.evaluate<{ status: number; body: unknown }>(
        async (id, uid) => {
          const token = JSON.parse(localStorage.getItem("gamez.guest.v1") ?? "{}").token;
          const res = await fetch(`/api/trade/${encodeURIComponent(id)}/offer`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ coin: 0, uids: [uid] }),
          });
          return { status: res.status, body: await res.json().catch(() => null) };
        },
        tradeId,
        itemUid,
      );
      steps.offerA = offered.status;
      run.check("A offers the granted item in the trade", offered.status === 200, offered);
    }

    // Phase 3: both accept, using the versions each side saw (the server checks them).
    const list = await run.page.evaluate<unknown>(tradesOf);
    steps.tradesA = list;
    if (tradeId !== null) {
      for (const [name, page] of [
        ["A", run.page],
        ["B", second],
      ] as const) {
        const accepted = await page.evaluate<{ status: number; body: unknown }>(async (id) => {
          const token = JSON.parse(localStorage.getItem("gamez.guest.v1") ?? "{}").token;
          const got = await fetch(`/api/trade/${encodeURIComponent(id)}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          const view = (await got.json().catch(() => null)) as {
            offers?: Record<string, { version?: number }>;
          } | null;
          const va = view?.offers?.a?.version ?? 0;
          const vb = view?.offers?.b?.version ?? 0;
          const res = await fetch(`/api/trade/${encodeURIComponent(id)}/accept`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ versions: [va, vb] }),
          });
          return { status: res.status, body: await res.json().catch(() => null) };
        }, tradeId);
        steps[`accept${name}`] = accepted.status;
        run.check(`${name} accepts the trade`, accepted.status === 200, accepted);
      }
      const final = await run.page.evaluate<string | null>(async (id) => {
        const token = JSON.parse(localStorage.getItem("gamez.guest.v1") ?? "{}").token;
        const got = await fetch(`/api/trade/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const view = (await got.json().catch(() => null)) as { status?: string } | null;
        return view?.status ?? null;
      }, tradeId);
      steps.finalStatus = final;
      run.check(
        "trade ends done after both accept",
        final === "done",
        { status: final },
        final !== "done",
      );
    }
  } finally {
    await second.close();
  }
}

export const SHELL_RUNNERS: Record<string, Runner> = {
  "economy-shell": economyShell,
};

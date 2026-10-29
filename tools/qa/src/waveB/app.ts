/**
 * QA scenarios: account, social (docs/design/wave-B.md §11). OWNER: T-app-shell.
 *
 *   account  picker -> account chip -> register a unique email -> chip shows the
 *            name -> sign out -> sign in again (desktop and --viewport phone)
 *   social   leaderboards (all three boards, class filters) -> register -> guild
 *            create (+ leave) -> chat dock: send, and a second guest page receives
 *
 * Selectors are the app shell's own (ModePicker, AccountChip, SocialBar, ChatDock,
 * Sheet). The sheet bodies (AccountPanel, LeaderboardView, GuildView, ChatWindow)
 * are found by visible text and input types, so the scenario survives markup
 * changes in packages/ui-host/src/social.
 */
import { join } from "node:path";
import { launch, VIEWPORTS, type Page } from "../cdp.ts";
import { openPicker, type Run } from "../run.ts";
import type { Runner } from "./index.ts";

interface Target {
  x: number;
  y: number;
  text: string;
}

const SHEET = "[role=dialog]";
const EMAIL_INPUT = "input[type=email], input[name=email], input[autocomplete=email]";
const PASSWORD_INPUT = "input[type=password]";
/** Text-like inputs that are neither email, password nor checkbox. */
const TEXT_INPUT =
  "input:not([type=email]):not([type=password]):not([type=checkbox]):not([type=hidden])";

export const APP_RUNNERS: Record<string, Runner> = {
  account: async (run) => accountFlow(run),
  social: async (run) => socialFlow(run),
};

// ---- in-page helpers (passed to page.evaluate as functions) ---------------------------

/** Visible, enabled button (or role=button) inside `scope` whose text matches `pattern`. */
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

/** True when a visible element matching `selector` exists inside `scope`. */
function hasVisible(scope: string | null, selector: string): boolean {
  const root: ParentNode = (scope ? document.querySelector(scope) : null) ?? document;
  return [...root.querySelectorAll<HTMLElement>(selector)].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

/** Focuses the nth visible element matching `selector` inside `scope`. */
function focusNth(scope: string | null, selector: string, index: number): boolean {
  const root: ParentNode = (scope ? document.querySelector(scope) : null) ?? document;
  const els = [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const el = els[index];
  if (!el) return false;
  el.focus();
  return true;
}

function textOf(scope: string): string {
  const el = document.querySelector<HTMLElement>(scope);
  return el ? el.innerText : "";
}

function layoutOf(): { scrollW: number; innerW: number; small: string[] } {
  const small = [...document.querySelectorAll<HTMLElement>(".picker button, .chat-dock button")]
    .filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && (r.height < 44 || r.width < 44);
    })
    .map((b) => (b.innerText || b.getAttribute("aria-label") || "").slice(0, 40));
  return {
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    small,
  };
}

// ---- harness helpers ------------------------------------------------------------------

/** Clicks a button matching `pattern` in `scope` (or the page), waiting for it to appear. */
async function clickButton(
  run: Run,
  scope: string | null,
  pattern: string,
  timeoutMs = 8_000,
): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const t = await run.page.evaluate<Target | null>(findButton, scope, pattern);
    if (t) {
      if (run.page.viewport.touch) await run.page.tap(t.x, t.y);
      else await run.page.click(t.x, t.y);
      return t.text;
    }
    if (Date.now() > end) throw new Error(`no button /${pattern}/ in ${scope ?? "page"}`);
    await run.page.wait(150);
  }
}

async function buttonExists(run: Run, scope: string | null, pattern: string): Promise<boolean> {
  return (await run.page.evaluate<Target | null>(findButton, scope, pattern)) !== null;
}

/** Focuses the nth visible input matching `selector` and types into it. */
async function typeInto(
  run: Run,
  scope: string | null,
  selector: string,
  index: number,
  text: string,
): Promise<boolean> {
  const ok = await run.page.evaluate<boolean>(focusNth, scope, selector, index);
  if (ok) await run.page.type(text);
  return ok;
}

/** Waits until a header chip contains `text`. */
async function waitForChip(run: Run, text: string, timeoutMs = 15_000): Promise<void> {
  await run.page.waitFor(
    `[...document.querySelectorAll('.chip')].some((c) => c.textContent.includes(${JSON.stringify(text)}))`,
    timeoutMs,
  );
}

async function chipTexts(run: Run): Promise<string> {
  return run.page.evaluate<string>(
    `[...document.querySelectorAll('.chip')].map((c) => c.textContent).join(' | ')`,
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Phone layout: no page scroll, 44 px targets in the picker and the chat dock. */
async function layoutChecks(run: Run, label: string): Promise<void> {
  const layout = await run.page.evaluate<{ scrollW: number; innerW: number; small: string[] }>(
    layoutOf,
  );
  run.check(`${label}: no horizontal page scroll`, layout.scrollW <= layout.innerW, layout, true);
  run.check(
    `${label}: picker and chat buttons >= 44px`,
    layout.small.length === 0,
    layout.small,
    true,
  );
}

/** Closes an open sheet (Escape, then its Close button) and waits until it is gone. */
async function closeOpenSheet(run: Run): Promise<void> {
  const open = () => run.page.evaluate<boolean>(`!!document.querySelector('${SHEET}')`);
  if (!(await open())) return;
  await run.page.evaluate<boolean>(
    `(() => { const d = document.querySelector('${SHEET}'); if (!d) return false;
      d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true; })()`,
  );
  await run.page.wait(200);
  if (await open()) await clickButton(run, SHEET, "^close").catch(() => "");
  await run.page.waitFor(`!document.querySelector('${SHEET}')`, 5_000).catch(() => undefined);
}

/** Opens the account sheet from the header chip (guest prompt or display name). */
async function openAccountSheet(run: Run, chip: string): Promise<void> {
  await clickButton(run, ".picker-top", chip);
  await run.page.waitFor(`!!document.querySelector('${SHEET}')`, 10_000);
  await run.page.wait(200);
}

/**
 * Fills the registration form in the open sheet (switching to it first when the
 * sheet opens on a choice) and submits it.
 */
async function registerInSheet(
  run: Run,
  name: string,
  email: string,
  password: string,
): Promise<void> {
  if (!(await run.page.evaluate<boolean>(hasVisible, SHEET, EMAIL_INPUT))) {
    await clickButton(run, SHEET, "create account|register|sign up");
  }
  await typeInto(run, SHEET, EMAIL_INPUT, 0, email);
  await typeInto(run, SHEET, PASSWORD_INPUT, 0, password);
  await typeInto(run, SHEET, TEXT_INPUT, 0, name);
  // Anchored: the "Create account" tab precedes the submit button in the DOM.
  await clickButton(run, SHEET, "^(save progress|register|sign up)$");
  await waitForChip(run, name);
}

// ---- scenarios -------------------------------------------------------------------------

/** picker -> chip -> register -> sign out -> sign in (used by `account`; `social` registers too). */
async function accountFlow(run: Run): Promise<void> {
  const suffix = String(Date.now()).slice(-6);
  const name = `QA${suffix}`;
  const email = `qa-${suffix}@example.com`;
  const password = `qa-password-${suffix}`;

  await openPicker(run, "");
  await run.page.wait(300);
  await run.shot("picker-guest");
  const guestChips = await chipTexts(run);
  run.check(
    "guest chip says 'Save your progress'",
    /Save your progress/.test(guestChips),
    guestChips,
  );
  await layoutChecks(run, "picker");

  await openAccountSheet(run, "Save your progress");
  await run.shot("account-sheet-guest");

  try {
    await registerInSheet(run, name, email, password);
  } catch (err) {
    run.check("register from the account sheet", false, {
      error: errorText(err),
      toast: await run.page.evaluate<string>(textOf, ".toast"),
    });
    return;
  }
  run.check(`registered: chip shows "${name}"`, true, { email });
  await run.page.wait(300);
  await run.shot("after-register");
  const registeredChips = await chipTexts(run);
  run.check(
    "registered: no 'Save your progress' prompt left",
    !/Save your progress/.test(registeredChips),
    registeredChips,
  );

  // Sign out from the sheet (open it from the name chip when the sheet closed).
  if (!(await run.page.evaluate<boolean>(`!!document.querySelector('${SHEET}')`))) {
    await openAccountSheet(run, name);
  }
  try {
    await clickButton(run, SHEET, "sign out|log out|logout");
    await waitForChip(run, "Save your progress");
    run.check("sign out: chip back to 'Save your progress'", true);
  } catch (err) {
    run.check("sign out: chip back to 'Save your progress'", false, errorText(err));
    return;
  }
  await run.page.wait(300);
  await run.shot("after-sign-out");
  const toastAfterSignOut = await run.page.evaluate<string>(textOf, ".toast");
  run.check(
    "sign out: the notice says 'Signed out.' (not 'Account updated.')",
    /Signed out/.test(toastAfterSignOut ?? ""),
    { toast: toastAfterSignOut },
    true,
  );
  // The app closes the sheet after sign out; close it here too if it stayed open, because on
  // a phone the sheet covers the header chip.
  await closeOpenSheet(run);
  run.check(
    "sign out: the account sheet closed",
    !(await run.page.evaluate<boolean>(`!!document.querySelector('${SHEET}')`)),
    undefined,
    true,
  );

  // Sign in again with the same email and password.
  await openAccountSheet(run, "Save your progress");
  // The guest sheet opens on "Create account" (email field already visible):
  // switch to the sign-in tab first.
  await clickButton(run, SHEET, "^(i have an account|sign in|log in)$", 4_000).catch(() => "");
  await typeInto(run, SHEET, EMAIL_INPUT, 0, email);
  await typeInto(run, SHEET, PASSWORD_INPUT, 0, password);
  await clickButton(run, SHEET, "^(sign in|log in)$");
  try {
    await waitForChip(run, name);
    run.check(`signed in again: chip shows "${name}"`, true);
  } catch (err) {
    run.check(`signed in again: chip shows "${name}"`, false, {
      error: errorText(err),
      toast: await run.page.evaluate<string>(textOf, ".toast"),
    });
  }
  await run.page.wait(300);
  await run.shot("after-sign-in");
  run.report.data.accountName = name;
}

/** Opens the chat dock (the toggle) and waits for the expanded dock. */
async function openChat(page: Page): Promise<void> {
  await page.waitFor("!!document.querySelector('.chat-toggle')", 15_000);
  await page.evaluate<boolean>(
    `(() => { const b = document.querySelector('.chat-toggle'); if (!b) return false; b.click(); return true; })()`,
  );
  await page.waitFor("!!document.querySelector('.chat-dock-open')", 10_000);
  // ChatWindow only sends while its status (the first role=status in the dock header) reads
  // "Live"; the socket takes about 1 s to get there, so a message typed earlier is dropped.
  await page.waitFor(
    "document.querySelector('.chat-dock-open [role=status]')?.textContent?.trim() === 'Live'",
    15_000,
  );
}

async function socialFlow(run: Run): Promise<void> {
  const suffix = String(Date.now()).slice(-6);

  // ---- leaderboards (open to guests)
  await openPicker(run, "");
  await run.page.wait(300);
  await run.shot("picker-social-guest");
  await clickButton(run, ".social-bar", "^Leaderboards$");
  await run.page.waitFor(`!!document.querySelector('${SHEET}')`, 10_000);
  await run.page.wait(400);
  await run.shot("leaderboards-level");
  const lb = await run.page.evaluate<string>(textOf, SHEET);
  for (const board of ["Level", "Depth", "Rift"]) {
    run.check(
      `leaderboards: "${board}" board offered`,
      new RegExp(board, "i").test(lb),
      undefined,
      true,
    );
  }
  for (const cls of ["Warrior", "Rogue", "Sorcerer"]) {
    run.check(
      `leaderboards: "${cls}" class filter offered`,
      new RegExp(cls, "i").test(lb),
      undefined,
      true,
    );
  }
  for (const [label, pattern] of [
    ["depth", "^(Deepest depth|Depth)$"],
    ["rift", "^Rift$"],
  ] as const) {
    if (await buttonExists(run, SHEET, pattern)) {
      await clickButton(run, SHEET, pattern);
      await run.page.wait(400);
      await run.shot(`leaderboards-${label}`);
    }
  }
  run.report.data.leaderboardText = lb.slice(0, 600);
  await run.page.press("Escape");
  await run.page.waitFor(`!document.querySelector('${SHEET}')`, 5_000);
  run.check("Escape closes the leaderboards sheet", true);

  // ---- register, then guild (guests may browse but not create or join)
  // A failed registration is reported, and the guild and chat steps still run as a guest.
  const name = `QA${suffix}`;
  await openAccountSheet(run, "Save your progress");
  let registered = true;
  try {
    await registerInSheet(run, name, `qa-soc-${suffix}@example.com`, `qa-password-${suffix}`);
    run.check("registered for the social flow", true, { name });
  } catch (err) {
    registered = false;
    run.check("registered for the social flow", false, {
      error: errorText(err),
      toast: await run.page.evaluate<string>(textOf, ".toast"),
    });
  }
  await run.page.press("Escape");
  await run.page.waitFor(`!document.querySelector('${SHEET}')`, 5_000).catch(() => {});

  await clickButton(run, ".social-bar", "^Guild");
  await run.page.waitFor(`!!document.querySelector('${SHEET}')`, 10_000);
  await run.page.wait(300);
  await run.shot("guild-before-create");
  const guildName = `QA Guild ${suffix}`;
  const tag = `Q${suffix.slice(-3)}`;
  // The sheet also has a search box: scope to the create form (GuildView).
  const createForm = `${SHEET} form[aria-label="Create a guild"]`;
  const hasForm = await typeInto(run, createForm, TEXT_INPUT, 0, guildName);
  if (hasForm) await typeInto(run, createForm, TEXT_INPUT, 1, tag);
  run.check("guild form has name and tag fields", hasForm, undefined, true);
  if (hasForm && (await buttonExists(run, createForm, "^(create|found)"))) {
    await clickButton(run, createForm, "^(create|found)");
    try {
      await run.page.waitFor(
        `(document.querySelector('${SHEET}')?.innerText || '').includes(${JSON.stringify(guildName)}) || (document.querySelector('${SHEET}')?.innerText || '').includes(${JSON.stringify(tag)})`,
        15_000,
      );
      if (registered) run.check("guild created: the sheet shows it", true, { guildName, tag });
      else
        run.check("guest guild create refused with a plain-words notice", false, {
          guildName,
          tag,
        });
    } catch (err) {
      run.check(
        registered
          ? "guild created: the sheet shows it"
          : "guest guild create refused with a plain-words notice",
        !registered,
        { error: errorText(err), toast: await run.page.evaluate<string>(textOf, ".toast") },
      );
    }
    await run.shot("guild-created");
    if (await buttonExists(run, SHEET, "^leave")) {
      await clickButton(run, SHEET, "^leave");
      // GuildView asks for a confirmation first.
      await clickButton(run, SHEET, "^confirm leave$", 4_000).catch(() => "");
      let left = true;
      await run.page
        .waitFor(
          `!(document.querySelector('${SHEET}')?.innerText || '').includes(${JSON.stringify(tag)})`,
          10_000,
        )
        .catch(() => (left = false));
      run.check("guild left again", left, undefined, true);
      await run.shot("guild-left");
    }
  } else {
    run.check("guild create form available", false, undefined, true);
  }
  await run.page.press("Escape");
  await run.page.waitFor(`!document.querySelector('${SHEET}')`, 5_000).catch(() => {});

  // ---- chat dock: send, and a second guest receives
  await openChat(run.page);
  await run.shot("chat-open");
  const dock = await run.page.evaluate<string>(textOf, ".chat-dock-open");
  run.check("chat dock shows the global channel", /Global/i.test(dock), dock.slice(0, 120));
  const message = `hello from qa ${suffix}`;
  const focused = await typeInto(
    run,
    ".chat-dock-open",
    "textarea, input:not([type=checkbox])",
    0,
    message,
  );
  run.check("chat input focused", focused);
  await run.page.press("Enter");
  try {
    await run.page.waitFor(
      `(document.querySelector('.chat-dock-open')?.innerText || '').includes(${JSON.stringify(message)})`,
      10_000,
    );
    run.check("chat: own message echoed in the dock", true);
  } catch (err) {
    run.check("chat: own message echoed in the dock", false, errorText(err));
  }
  await run.shot("chat-sent");

  // Receive side: a second guest (its own Chrome profile) opens the dock.
  const second = await launch(VIEWPORTS.desktop);
  try {
    await second.open(run.url(""));
    await second.waitFor("document.querySelectorAll('.mode-card').length > 0", 30_000);
    await openChat(second);
    try {
      await second.waitFor(
        `(document.querySelector('.chat-dock-open')?.innerText || '').includes(${JSON.stringify(message)})`,
        15_000,
      );
      run.check("chat: second guest receives the message live", true);
    } catch (err) {
      run.check("chat: second guest receives the message live", false, errorText(err));
    }
    const path = await second.screenshot(join(run.report.outDir, "99-chat-receiver.png"));
    run.report.screenshots.push({ name: "chat-receiver", path });
  } finally {
    await second.close();
  }
  await run.shot("chat-end");
}

/**
 * Wave C browser QA for the classic HUD (docs/design/wave-C.md §10.4, §15).
 * OWNER: T-classic-ui.
 *
 *   node tools/qa/src/run.ts classic-bank [class] [--viewport phone]
 *   node tools/qa/src/run.ts classic-market-street [class] [--viewport phone]
 *   node tools/qa/src/run.ts classic-trade [class] [--viewport phone]
 *
 * All three open classic WITHOUT ?seed (the hero lives on the server, so the
 * bank, the shop plots and the trade sheet can work). Checks that depend on
 * another wave C owner (api.bank from T-bridge, the shop fixtures from
 * T-shops/T-scale, the trade sheet from T-shell) are warnings: when the piece
 * is missing the run says so and captures the blocked state.
 *
 * Screen positions come from the camera rule of the ARPG renderer: the camera
 * follows the hero, and an entity at X is drawn at tileToScreen(X + 0.5), so a
 * point X is at
 *   client = canvas centre + zoom * (tileToScreen(X + 0.5) - tileToScreen(hero + 0.5))
 * with tileToScreen(x, y) = ((x - y) * 32, (x + y) * 16) and zoom = settings.zoom.
 * Pointer taps report the same X system (PixiWorldRenderer.tileAtClient).
 */
import { classArg, openPicker, pickMode, type Run } from "../run.ts";
import type { Runner } from "./index.ts";

interface HeroState {
  gold: number;
  bag: number;
  bagNames: string[];
  stash: number;
  town: boolean;
  depth: number;
  x: number;
  y: number;
}

interface SyncState {
  mode: string;
  status: string;
}

/** Client (CSS px) point of an entity position (cx, cy) in the renderer's X system. Self-contained (runs in the page). */
function clientPointOf(cx: number, cy: number): { x: number; y: number } | null {
  const g = (window as unknown as { __gamez?: Record<string, any> }).__gamez;
  const canvas = document.querySelector("canvas");
  const hero = g?.hud?.hero;
  if (!g || !canvas || !hero) return null;
  const r = canvas.getBoundingClientRect();
  const z = Number(g.ui?.settings?.zoom ?? 1);
  const iso = (x: number, y: number) => ({ sx: (x - y) * 32, sy: (x + y) * 16 });
  const h = iso(hero.x + 0.5, hero.y + 0.5);
  const t = iso(cx + 0.5, cy + 0.5);
  return {
    x: r.left + r.width / 2 + (t.sx - h.sx) * z,
    y: r.top + r.height / 2 + (t.sy - h.sy) * z,
  };
}

/** The hero's state from the HUD snapshot (window.__gamez.hud). */
function heroState(): HeroState | null {
  const h = (window as unknown as { __gamez?: Record<string, any> }).__gamez?.hud;
  if (!h?.hero) return null;
  const bagItems = (h.inventory?.items ?? []) as { item: { name: string } }[];
  return {
    gold: Number(h.hero.gold ?? 0),
    bag: bagItems.length,
    bagNames: bagItems.map((p) => p.item.name),
    stash: Array.isArray(h.stash) ? h.stash.length : 0,
    town: Boolean(h.area?.isTown),
    depth: Number(h.area?.depth ?? -1),
    x: Number(h.hero.x),
    y: Number(h.hero.y),
  };
}

const hero = (run: Run): Promise<HeroState | null> =>
  run.page.evaluate<HeroState | null>(heroState);
const syncOf = (run: Run): Promise<SyncState | null> =>
  run.page.evaluate<SyncState | null>("window.__gamez?.sync ?? null");
const bodyText = (run: Run): Promise<string> =>
  run.page.evaluate<string>("document.body?.innerText ?? ''");
const dialogCount = (run: Run): Promise<number> =>
  run.page.evaluate<number>("document.querySelectorAll('[role=dialog]').length");

/** Polls a predicate for up to `ms`; true when it held. Never throws. */
async function waitOk(run: Run, predicate: string, ms: number): Promise<boolean> {
  try {
    await run.page.waitFor(predicate, ms, 200);
    return true;
  } catch {
    return false;
  }
}

/** Taps (phone) or clicks (desktop) a client point. */
async function pressAt(run: Run, p: { x: number; y: number }): Promise<void> {
  if (run.args.viewport === "phone") await run.page.tap(p.x, p.y);
  else await run.page.click(p.x, p.y);
}

/** Opens classic online (no ?seed, no cheats) and waits for the hero and the server. Returns whether the server answered. */
async function openOnline(run: Run, cls: string): Promise<boolean> {
  await openPicker(run, `debug=1&class=${encodeURIComponent(cls)}&autostart=1`);
  await pickMode(run, "Classic");
  await run.page.waitFor(
    "window.__gamez?.mode === 'classic' && window.__gamez.sim?.hero != null",
    60_000,
  );
  await run.page.waitFor("(window.__gamez.render?.chunks ?? 0) > 0", 15_000);
  await run.page.wait(600);
  // The onboarding tip box covers the middle of the town and would take the taps.
  await run.page.evaluate<void>("void window.__gamez.controls.updateSettings({ tips: false })");
  return waitOk(
    run,
    "window.__gamez.sync?.mode === 'server' && window.__gamez.sync?.status === 'online'",
    30_000,
  );
}

/**
 * Reopens classic when the page left it (a dev-server reload while the tree changes, or an
 * exit to the picker). The run records each reopen, so the report shows it.
 */
async function ensureClassic(run: Run, cls: string): Promise<void> {
  const running = await run.page
    .evaluate<boolean>("window.__gamez?.mode === 'classic' && window.__gamez.sim?.hero != null")
    .catch(() => false);
  if (running) return;
  run.sample({ reopened: new Date().toISOString() });
  await openOnline(run, cls);
}

const setMode = (run: Run, mode: "manual" | "auto"): Promise<void> =>
  run.page.evaluate<void>(`void window.__gamez.controls.setMode(${JSON.stringify(mode)})`);

/**
 * Bank QA needs gold and an item. A new hero has neither, so the run plays Auto for up
 * to `ms` (monsters drop gold and items on depth 1), then walks back up to town.
 */
async function ensureGoldAndItem(
  run: Run,
  cls: string,
  minGold: number,
  ms: number,
): Promise<HeroState | null> {
  await ensureClassic(run, cls);
  const start = await hero(run);
  if (start && start.gold >= minGold && start.bag > 0) return start;
  const ready = `(() => { const h = window.__gamez.hud?.hero; return !!h && h.gold >= ${minGold} && window.__gamez.hud.inventory.items.length > 0; })()`;
  // In slices, so a dev reload (the page leaves classic) is reopened and Auto set again.
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await ensureClassic(run, cls);
    await setMode(run, "auto");
    if (await waitOk(run, ready, Math.min(20_000, Math.max(1_000, deadline - Date.now())))) break;
  }
  await ensureClassic(run, cls);
  await setMode(run, "manual");
  for (let i = 0; i < 6; i++) {
    const s = await hero(run);
    if (!s || s.town) break;
    await run.page.evaluate<void>("void window.__gamez.controls.interact('stairsUp')");
    await waitOk(run, "window.__gamez.hud?.area?.isTown === true", 15_000);
  }
  return hero(run);
}

/** Makes sure classic runs (reopening after a dev reload) and the bank panel is open. */
async function openBankPanel(run: Run, cls: string): Promise<void> {
  await ensureClassic(run, cls);
  await run.page.evaluate<void>(
    "window.__gamez.ui.panels.includes('bank') || void window.__gamez.controls.openPanel('bank')",
  );
  await waitOk(run, "window.__gamez.ui.panels.includes('bank')", 5_000);
  await run.page.wait(300);
}

/** Dev helper: a JSON fetch from Node (the QA runner), optionally with a session token. */
async function apiFetch(
  base: string,
  method: "GET" | "POST",
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // no JSON body
  }
  return { status: res.status, body: json };
}

interface PlotRow {
  id: string;
  state: string;
  pos: { x: number; y: number };
  shopName: string | null;
  auction: { topBid: number | null; minBid: number } | null;
}

/** Plot auction length (modules/economy/src/lease.ts PLOT_AUCTION_MS); the dev clock jumps past it. */
const PLOT_AUCTION_MS = 30 * 60_000;

/**
 * Dev setup for the market street, from Node with its own registered owner (bids
 * need a registered account; the page's hero stays a guest): when no plot is leased
 * yet, register an owner, grant coin (T-escrow dev route), bid on a free plot, jump
 * the plot clock past the auction (T-shops dev route), then name and open the shop.
 * Best effort: every step is noted. Returns the leased plot, if any.
 */
async function devLeasePlot(base: string): Promise<{ notes: string[]; plot: PlotRow | null }> {
  const notes: string[] = [];
  const world = "classic-town";
  const guest = await apiFetch(base, "POST", "/api/guest");
  if (guest.status !== 200) return { notes: [`guest -> ${guest.status}`], plot: null };
  const listed = await apiFetch(base, "GET", `/api/shops?world=${world}`, guest.body.token);
  notes.push(`plots -> ${listed.status}`);
  const plots = (listed.body?.plots ?? []) as PlotRow[];
  const leased = plots.find((p) => p.state === "leased");
  if (leased) {
    notes.push(`reuse leased ${leased.id}`);
    return { notes, plot: leased };
  }
  const target = plots.find((p) => p.state === "auction" && p.auction?.topBid == null);
  if (!target) return { notes: [...notes, "no free plot"], plot: null };
  const stamp = Date.now().toString(36);
  const reg = await apiFetch(base, "POST", "/api/auth/register", guest.body.token, {
    email: `qa-shop-${stamp}@example.test`,
    password: "correct-horse-battery-9",
    displayName: "QA Keeper",
  });
  notes.push(`register -> ${reg.status}`);
  const token = reg.body?.token as string | undefined;
  if (reg.status !== 200 || !token) return { notes, plot: null };
  const bid = Math.max(100, target.auction?.minBid ?? 100);
  const grant = await apiFetch(base, "POST", "/api/dev/economy/grant", token, {
    opId: `qa-grant-${stamp}`,
    coin: bid,
  });
  notes.push(`grant -> ${grant.status}`);
  const placed = await apiFetch(base, "POST", "/api/shops/plots/bid", token, {
    opId: `qa-bid-${stamp}`,
    world,
    plotId: target.id,
    amount: bid,
  });
  notes.push(`bid ${target.id} -> ${placed.status}`);
  const advance = await apiFetch(base, "POST", "/api/dev/shops/advance", token, {
    world,
    ms: PLOT_AUCTION_MS + 1000,
  });
  notes.push(`advance -> ${advance.status}`);
  const configure = await apiFetch(
    base,
    "POST",
    `/api/shops/${world}/${target.id}/configure`,
    token,
    { name: "QA Curios", open: true },
  );
  notes.push(`configure -> ${configure.status}`);
  const after = await apiFetch(base, "GET", `/api/shops?world=${world}`, token);
  const now = ((after.body?.plots ?? []) as PlotRow[]).find((p) => p.id === target.id) ?? null;
  return { notes, plot: now && now.state === "leased" ? now : null };
}

/** A Node bot that stands still in classic-town, so the page has a remote hero to tap. */
interface Bot {
  name: string;
  close(): void;
}

/** Joins classic-town as a guest and reports one fixed pose (tag set, so the page draws it). */
async function startBot(base: string, at: { x: number; y: number }): Promise<Bot> {
  const res = await fetch(`${base}/api/guest`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/guest -> ${res.status}`);
  const guest = (await res.json()) as { token: string; name: string };
  const WebSocketCtor = (globalThis as unknown as { WebSocket: new (url: string) => any })
    .WebSocket;
  const url = `${base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(guest.token)}&world=classic-town`;
  const ws = await new Promise<any>((resolve, reject) => {
    const sock = new WebSocketCtor(url);
    sock.onopen = () => resolve(sock);
    sock.onerror = () => reject(new Error("bot websocket error"));
  });
  const pose = () =>
    ws.send(
      JSON.stringify({
        t: "pose",
        pos: at,
        path: [],
        speed: 2,
        appearance: "unit.hero.rogue",
        tag: "Lv 5 Bot",
      }),
    );
  pose();
  const timer = setInterval(pose, 2000);
  return {
    name: guest.name,
    close: () => {
      clearInterval(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

/** The presence avatar drawn for a name (centre tile coordinates), or null. */
const avatarNamed = (run: Run, name: string) =>
  run.page.evaluate<{ x: number; y: number; id: string } | null>(
    `(() => { const a = (window.__gamez.presence?.avatars ?? []).find((v) => v.name === ${JSON.stringify(name)}); return a ? { x: a.x, y: a.y, id: a.id } : null; })()`,
  );

export const CLASSIC_C_RUNNERS: Record<string, Runner> = {
  /**
   * The bank in town: open it, deposit gold, send an item to the vault, withdraw
   * it again. Screenshots at each step (1366x768 and 390x844 with --viewport phone).
   */
  "classic-bank": async (run) => {
    const cls = classArg(run);
    const online = await openOnline(run, cls);
    run.check("classic runs online (server-verified hero)", online, await syncOf(run), true);
    await setMode(run, "manual");

    await ensureClassic(run, cls);
    await run.page.evaluate<void>("void window.__gamez.controls.openPanel('bank')");
    await waitOk(run, "window.__gamez.ui.panels.includes('bank')", 5_000);
    await run.page.wait(400);
    await run.shot("bank-open");
    const text = await bodyText(run);
    // The form is always drawn; without api.bank (or with a local bank) the panel adds its note.
    const bankWired =
      text.includes("Gold to deposit") && !text.includes("The bank needs the online game");
    run.check(
      "the bank panel opens with the deposit form (api.bank present)",
      bankWired,
      { sync: await syncOf(run) },
      true,
    );
    if (!bankWired) {
      run.sample({ bank: "absent", note: text.includes("needs the online game") });
      run.check(
        "without api.bank the panel says the bank needs the online game",
        text.includes("The bank needs the online game"),
        undefined,
        true,
      );
      await run.shot("bank-blocked");
      return;
    }

    const before = await ensureGoldAndItem(run, cls, 10, 180_000);
    run.sample({ at: "before", hero: before });
    await openBankPanel(run, cls);
    run.check("hero is in town for the bank", before?.town === true, before, true);
    await run.page.wait(300);
    await run.shot("bank-ready");

    // Gold: deposit a part of the hero's gold (5 % fee, min 1, the server applies it).
    const goldBefore = before?.gold ?? 0;
    if (goldBefore >= 10) {
      const amount = Math.min(goldBefore, 25);
      await openBankPanel(run, cls);
      await run.page.clickText("Gold to deposit", { exact: true, timeoutMs: 8_000 });
      await run.page.type(String(amount));
      await run.page.wait(200);
      await run.shot("bank-gold-typed");
      await run.page.clickText("Deposit gold", { exact: true, timeoutMs: 8_000 });
      const dropped = await waitOk(run, `window.__gamez.hud.hero.gold < ${goldBefore}`, 15_000);
      await run.page.wait(400);
      await run.shot("bank-deposited-gold");
      run.check("gold deposit: the hero's gold went down", dropped, {
        from: goldBefore,
        typed: amount,
      });
      run.check(
        "gold deposit: the bank reports the coin credited",
        (await bodyText(run)).includes("coin added"),
        undefined,
        true,
      );
    } else {
      run.check(
        "gold deposit skipped: the hero has no gold yet",
        false,
        { gold: goldBefore },
        true,
      );
    }

    // Item: send the first bag item to the vault.
    await openBankPanel(run, cls);
    const afterGold = await hero(run);
    const firstName = afterGold?.bagNames[0];
    if (firstName) {
      const bagBefore = afterGold?.bag ?? 0;
      await run.page.clickText(`Send ${firstName} to the vault`, { exact: true, timeoutMs: 8_000 });
      const moved = await waitOk(
        run,
        `window.__gamez.hud.inventory.items.length < ${bagBefore}`,
        15_000,
      );
      await run.page.wait(400);
      await run.shot("bank-deposited-item");
      run.check("item deposit: the bag lost the item", moved, { item: firstName });
    } else {
      run.check("item deposit skipped: the bag is empty", false, undefined, true);
    }

    // Withdraw: the vault's own control (VaultView, T-econ-ui): "Withdraw <name>" of the item
    // just sent (else the first item row). The vault list reloads after each bank op.
    const want = firstName ? `Withdraw ${firstName}` : null;
    const withdrawable = await run.page
      .waitFor(
        `[...document.querySelectorAll('[aria-label="Vault items"] button')].some((b) => /^Withdraw /.test(b.getAttribute('aria-label') || ''))`,
        10_000,
        200,
      )
      .then(
        () => true,
        () => false,
      )
      .then((ok) =>
        ok
          ? run.page.evaluate<{ label: string; x: number; y: number } | null>(
              `(() => {
                const all = [...document.querySelectorAll('[aria-label="Vault items"] button')].filter((b) => /^Withdraw /.test(b.getAttribute('aria-label') || ''));
                const btn = all.find((b) => b.getAttribute('aria-label') === ${JSON.stringify(want)}) || all[0];
                if (!btn) return null;
                btn.scrollIntoView({ block: 'center' });
                const r = btn.getBoundingClientRect();
                return { label: btn.getAttribute('aria-label'), x: r.left + r.width / 2, y: r.top + r.height / 2 };
              })()`,
            )
          : null,
      );
    if (withdrawable) {
      const bagBefore = (await hero(run))?.bag ?? 0;
      await run.page.wait(200);
      await pressAt(run, withdrawable);
      const back = await waitOk(
        run,
        `window.__gamez.hud.inventory.items.length > ${bagBefore}`,
        15_000,
      );
      await run.page.wait(400);
      await run.shot("bank-withdrawn");
      run.check("withdraw: the item came back to the bag", back, { control: withdrawable.label });
    } else {
      run.check(
        "a Withdraw control in the vault list (needs a vault item)",
        false,
        { vault: (await bodyText(run)).includes("Coming soon") ? "placeholder" : "no control" },
        true,
      );
      await run.shot("bank-vault");
    }
    run.check(
      "the bank panel has no uncaught errors",
      run.report.consoleErrors.length === 0,
      {
        errors: run.report.consoleErrors.length,
      },
      true,
    );
  },

  /**
   * Market street: a leased plot in the classic town's east road shows a shopkeeper
   * ghost; a tap on it opens the shop sheet.
   */
  "classic-market-street": async (run) => {
    const cls = classArg(run);
    const online = await openOnline(run, cls);
    run.check("classic runs online (server-verified hero)", online, await syncOf(run), true);
    await setMode(run, "manual");

    const lease = await devLeasePlot(run.args.url);
    run.sample({ devLease: lease.notes, plot: lease.plot });
    run.check(
      "a leased plot on the east road (existing, or set up through the dev routes)",
      lease.plot !== null,
      lease.notes,
      true,
    );

    // Walk to the east road (46-58, 33-38): two tiles south of the leased plot, else its middle.
    const goal = lease.plot ? { x: lease.plot.pos.x, y: lease.plot.pos.y + 2 } : { x: 52, y: 35 };
    await run.page.evaluate<void>(
      `void window.__gamez.controls.act('classic.moveTo', ${JSON.stringify(goal)})`,
    );
    const there = await waitOk(
      run,
      `(() => { const h = window.__gamez.hud?.hero; return !!h && Math.hypot(h.x - ${goal.x}, h.y - ${goal.y}) < 1.5; })()`,
      30_000,
    );
    run.check("hero walked to the east road", there, await hero(run), true);

    const ghost = await waitOk(
      run,
      "(window.__gamez.presence?.avatars ?? []).some((a) => a.id.startsWith('p:shops:'))",
      30_000,
    );
    await run.page.wait(400);
    await run.shot("market-street");
    run.check(
      "a shopkeeper ghost is drawn on the east road",
      ghost,
      await run.page.evaluate<unknown>(
        "(window.__gamez.presence?.avatars ?? []).filter((a) => a.id.startsWith('p:shops:'))",
      ),
      true,
    );
    if (!ghost) return;

    const shop = await run.page.evaluate<{ x: number; y: number; name: string } | null>(
      "(() => { const a = (window.__gamez.presence?.avatars ?? []).find((v) => v.id.startsWith('p:shops:')); return a ? { x: a.x, y: a.y, name: a.name } : null; })()",
    );
    const at = shop
      ? await run.page.evaluate<{ x: number; y: number } | null>(clientPointOf, shop.x, shop.y)
      : null;
    if (!at) {
      run.check("ghost has a screen position", false, shop, true);
      return;
    }
    const dialogs = await dialogCount(run);
    const heroBefore = await hero(run);
    await pressAt(run, at);
    const opened = await waitOk(
      run,
      `document.querySelectorAll('[role=dialog]').length > ${dialogs}`,
      8_000,
    );
    await run.page.wait(500);
    const heroAfter = await hero(run);
    // A tap that is not consumed walks the hero to the ghost: a diagnostic for the report.
    run.sample({
      ghostTap: {
        at,
        ghost: shop,
        heroBefore: heroBefore && { x: heroBefore.x, y: heroBefore.y },
        heroAfter: heroAfter && { x: heroAfter.x, y: heroAfter.y },
      },
    });
    await run.shot("market-street-shop");
    run.check(
      "tapping the ghost opens the shop sheet (shell screen)",
      opened,
      { ghost: shop?.name },
      true,
    );
  },

  /**
   * Trade: a remote hero (a Node bot standing still in classic-town, as the second
   * player) is tapped; the "Trade with <name>" bubble opens the trade sheet with it.
   */
  "classic-trade": async (run) => {
    const cls = classArg(run);
    const online = await openOnline(run, cls);
    run.check("classic runs online (server-verified hero)", online, await syncOf(run), true);
    await setMode(run, "manual");

    const me = await hero(run);
    // One tile south-east of the hero: after the sanity walk (2 tiles south-west) it is
    // about 4 tiles to the right on screen, inside the 390 px phone view too.
    const at = {
      x: Math.min(70, Math.max(1, Math.floor(me?.x ?? 36) + 1)),
      y: Math.min(70, Math.max(1, Math.floor(me?.y ?? 46) + 1)),
    };
    const bot = await startBot(run.args.url, at);
    try {
      const seen = await waitOk(
        run,
        `(window.__gamez.presence?.avatars ?? []).some((a) => a.name === ${JSON.stringify(bot.name)})`,
        20_000,
      );
      run.check(
        "the second hero is drawn in town (after its first pose)",
        seen,
        { bot: bot.name },
        true,
      );
      if (!seen) return;
      await run.page.wait(500);
      // Input sanity: a tap on empty ground walks the hero (so a missed tap shows up below).
      const ground = await run.page.evaluate<{ x: number; y: number } | null>(
        clientPointOf,
        (me?.x ?? 36) - 2,
        (me?.y ?? 46) + 2,
      );
      if (ground) {
        await pressAt(run, ground);
        const walked = await waitOk(
          run,
          `(() => { const h = window.__gamez.hud?.hero; return !!h && Math.abs(h.x - ${me?.x ?? 0}) + Math.abs(h.y - ${me?.y ?? 0}) > 0.3; })()`,
          4_000,
        );
        run.check("input sanity: a tap on the ground walks the hero", walked, { ground }, true);
        await run.page.wait(2_000);
      }
      // The camera follows the hero: locate the remote hero on screen only now, after the walk.
      const av = await avatarNamed(run, bot.name);
      const p = av
        ? await run.page.evaluate<{ x: number; y: number } | null>(clientPointOf, av.x, av.y)
        : null;
      if (!p) {
        run.check("the remote hero has a screen position", false, av, true);
        return;
      }
      const heroBefore = await hero(run);
      await pressAt(run, p);
      const bubble = await waitOk(
        run,
        `document.body.innerText.includes(${JSON.stringify(`Trade with ${bot.name}`)})`,
        5_000,
      );
      await run.page.wait(300);
      const heroAfter = await hero(run);
      // A tap that is not consumed walks the hero there: a diagnostic for the report.
      run.sample({
        botTap: {
          at: p,
          avatar: av,
          heroBefore: heroBefore && { x: heroBefore.x, y: heroBefore.y },
          heroAfter: heroAfter && { x: heroAfter.x, y: heroAfter.y },
        },
      });
      await run.shot("trade-bubble");
      run.check("tapping a remote hero shows the Trade bubble", bubble, { bot: bot.name }, true);
      if (!bubble) return;

      const dialogs = await dialogCount(run);
      await run.page.clickText(`Trade with ${bot.name}`, { exact: true, timeoutMs: 5_000 });
      const sheet = await waitOk(
        run,
        `document.querySelectorAll('[role=dialog]').length > ${dialogs}`,
        8_000,
      );
      await run.page.wait(500);
      await run.shot("trade-sheet");
      run.check("the bubble opens the trade sheet", sheet, { bot: bot.name }, true);
    } finally {
      bot.close();
    }
  },
};

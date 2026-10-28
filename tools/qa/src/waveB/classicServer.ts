/**
 * QA scenario: classic-server (docs/design/wave-B.md §11). OWNER: T-classic-sync.
 *
 *   node tools/qa/src/run.ts classic-server [class] [--viewport phone]
 *
 * Opens classic WITHOUT ?seed (so the hero lives on the server when the host
 * provides services.connectVerified), autostarts a hero of the class, waits
 * until window.__gamez.sync reports mode "server", status "online" and only a
 * little unverified play, screenshots the HUD, then reloads the page and
 * checks that the same hero comes back at a tick >= the verified tick seen
 * before the reload. When the page stays in local mode (no verified
 * connection in this build), the run says so and checks local play instead.
 *
 * window.__gamez.sync (debug.ts): SyncView + localTick, pendingSegments, epoch…
 *
 *   node tools/qa/src/run.ts classic-legacy [class] [--viewport phone]
 *
 * Plays offline first (WebSocket stubbed by a pre-document script), then checks
 * that the local save is imported once when the server is reachable again.
 */
import { classArg, openPicker, pickMode, type Run } from "../run.ts";
import type { Runner } from "./index.ts";

interface SyncInfo {
  mode: "server" | "local";
  status: string;
  verifiedTick: number;
  pendingTicks: number;
  overflow: boolean;
  imported: boolean;
  lastResync: { code: string; message: string } | null;
  localTick: number;
  pendingSegments?: number;
  epoch?: number;
}

interface HeroInfo {
  tick: number;
  hero: { class: string; name: string; level: number; xp: number } | null;
}

const syncOf = (run: Run): Promise<SyncInfo | null> =>
  run.page.evaluate<SyncInfo | null>("window.__gamez?.sync ?? null");
const heroOf = (run: Run): Promise<HeroInfo> =>
  run.page.evaluate<HeroInfo>(
    "(() => { const s = window.__gamez.sim; return { tick: s.tick, hero: s.hero && { class: s.hero.class, name: s.hero.name, level: s.hero.level, xp: s.hero.xp } }; })()",
  );

/** Opens classic (no seed) and waits for the hero; the boot may spend up to 8 s on "Connecting…". */
async function openClassic(run: Run, cls: string): Promise<void> {
  await openPicker(run, `debug=1&class=${encodeURIComponent(cls)}&autostart=1`);
  await pickMode(run, "Classic");
  await run.page.waitFor(
    "window.__gamez?.mode === 'classic' && window.__gamez.sim?.hero != null",
    60_000,
  );
  await run.page.waitFor("(window.__gamez.render?.chunks ?? 0) > 0", 15_000);
}

/** Waits for a condition, returning whether it held (no throw). */
async function waitOk(run: Run, predicate: string, timeoutMs: number): Promise<boolean> {
  try {
    await run.page.waitFor(predicate, timeoutMs, 200);
    return true;
  } catch {
    return false;
  }
}

/**
 * Page script (installed before any document loads) that makes the game's WebSockets fail to
 * connect while localStorage "qa.offline" is "1" (Vite's HMR socket is left alone). Chrome's Network.setBlockedURLs and
 * offline emulation do not stop WebSockets, so this is how the harness plays "offline".
 */
const OFFLINE_SOCKET_STUB = `(() => { try { if (localStorage.getItem('qa.offline') === '1') {
  const Real = window.WebSocket;
  // Only the game's sockets (/ws, /ws/instance, /ws/chat…); Vite's HMR socket must keep working.
  const Stub = function (url, protocols) {
    if (!new URL(String(url), location.href).pathname.startsWith('/ws')) return new Real(url, protocols);
    // A socket that never connects: error then close 1006, like a real outage.
    const ls = {};
    const ws = { url: String(url), readyState: 0, protocol: '', extensions: '', binaryType: 'blob',
      bufferedAmount: 0, onopen: null, onmessage: null, onerror: null, onclose: null,
      send() {}, close() {}, removeEventListener() {},
      addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); } };
    setTimeout(() => {
      ws.readyState = 3;
      const err = { type: 'error', target: ws };
      const close = { type: 'close', code: 1006, reason: '', wasClean: false, target: ws };
      if (ws.onerror) ws.onerror(err);
      for (const f of ls.error || []) f(err);
      if (ws.onclose) ws.onclose(close);
      for (const f of ls.close || []) f(close);
    }, 50);
    return ws;
  };
  Stub.prototype = Real.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Stub[k] = Real[k];
  window.WebSocket = Stub; } } catch (e) {} })();`;
const LEGACY_KEY = "gamez.classic.save.v1";
const IMPORT_TITLE = "now lives on your account";

/** Polls for the import toast (HUD toast list or DOM text) for `ms`; returns whether it showed. */
async function sawImportToast(run: Run, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const seen = await run.page.evaluate<boolean>(
      `(() => { const t = ${JSON.stringify(IMPORT_TITLE)};
        const ui = (window.__gamez?.ui?.toasts ?? []).some((x) => String(x.title ?? '').includes(t));
        return ui || (document.body?.innerText ?? '').includes(t); })()`,
    );
    if (seen) return true;
    await run.page.wait(300);
  }
  return false;
}

export const CLASSIC_SERVER_RUNNERS: Record<string, Runner> = {
  /**
   * Legacy import (wave-B.md §2): play offline so the old local save is written, then come
   * back online and check the save is imported once (toast, ".migrated" key, no repeat).
   */
  "classic-legacy": async (run) => {
    const cls = classArg(run);
    await run.page.send("Page.addScriptToEvaluateOnNewDocument", { source: OFFLINE_SOCKET_STUB });
    await openPicker(run, "debug=1");
    await run.page.evaluate("localStorage.setItem('qa.offline', '1'); true");
    // Offline: the socket throws, the boot gives up on the server and plays locally.
    await openClassic(run, cls);
    const local = await waitOk(
      run,
      `window.__gamez.sync?.mode !== 'server' || window.__gamez.sync?.status !== 'online'`,
      5_000,
    );
    run.check("offline: the page does not reach the server", local, await syncOf(run));
    const saved = await waitOk(run, `localStorage.getItem('${LEGACY_KEY}') !== null`, 25_000);
    run.check("offline: the local save is written", saved, {
      keys: await run.page.evaluate<string[]>("Object.keys(localStorage)"),
    });
    const localHero = await heroOf(run);
    run.sample({ at: "offline", hero: localHero, sync: await syncOf(run) });
    await run.shot("legacy-offline");

    // Back online: the save must be imported into the server hero, once.
    await run.page.evaluate("localStorage.removeItem('qa.offline'); true");
    await openClassic(run, cls);
    const toast = await sawImportToast(run, 15_000);
    const online = await waitOk(run, "window.__gamez.sync?.status === 'online'", 20_000);
    const imported = await heroOf(run);
    const syncAfter = await syncOf(run);
    run.sample({ at: "imported", hero: imported, sync: syncAfter });
    run.check("online again after the import", online, syncAfter);
    run.check(`import toast ("${IMPORT_TITLE}") shown`, toast);
    run.check(
      "the imported hero is the offline one (class and level)",
      imported.hero?.class === localHero.hero?.class &&
        imported.hero?.level === localHero.hero?.level,
      { offline: localHero.hero, imported: imported.hero },
    );
    run.check(
      `local save moved to ${LEGACY_KEY}.migrated`,
      await run.page.evaluate<boolean>(
        `localStorage.getItem('${LEGACY_KEY}') === null && localStorage.getItem('${LEGACY_KEY}.migrated') !== null`,
      ),
    );
    run.check(
      "sync view marks the hero as imported",
      syncAfter?.imported === true,
      syncAfter,
      true,
    );
    await run.shot("legacy-imported");

    // A second reload must not import again.
    await openClassic(run, cls);
    const again = await sawImportToast(run, 6_000);
    const end = await syncOf(run);
    run.check("imported once (no toast on the next reload)", !again);
    run.check("no resync after the import", end?.lastResync == null, end?.lastResync);
  },

  "classic-server": async (run) => {
    const cls = classArg(run);
    await openClassic(run, cls);
    await run.page.wait(800);
    const first = await syncOf(run);
    run.sample({ at: "start", sync: first });
    const server = first?.mode === "server";
    run.check("classic runs in server mode (services.connectVerified present)", server, first);

    if (!server) {
      // Local mode: the client must still play exactly as before.
      const a = await heroOf(run);
      await run.page.wait(2000);
      const b = await heroOf(run);
      run.check("local mode: hero present", a.hero !== null, a.hero);
      run.check("local mode: the sim ticks", b.tick > a.tick, { from: a.tick, to: b.tick });
      await run.shot("hud-local");
      return;
    }

    const online = await waitOk(run, "window.__gamez.sync?.status === 'online'", 20_000);
    run.check("sync status reaches online", online, await syncOf(run));
    // A couple of segments (one every ~2 s) must verify.
    const verified = await waitOk(
      run,
      "window.__gamez.sync?.verifiedTick > 40 && window.__gamez.sync?.pendingTicks < 100",
      30_000,
    );
    const before = await syncOf(run);
    run.sample({ at: "verified", sync: before });
    run.check("segments verify and few ticks stay pending (badge: Saved)", verified, before);
    run.check("no resync during honest play", before?.lastResync == null, before?.lastResync);
    await run.shot("hud-server");

    const heroBefore = await heroOf(run);
    const verifiedTick = before?.verifiedTick ?? 0;
    run.sample({ at: "before-reload", hero: heroBefore, verifiedTick });

    // Reload: the same hero must come back (cache or server) at or after the verified tick.
    await openClassic(run, cls);
    await run.page.wait(1000);
    const heroAfter = await heroOf(run);
    const after = await syncOf(run);
    run.sample({ at: "after-reload", hero: heroAfter, sync: after });
    run.check(
      "same hero after reload",
      heroAfter.hero?.name === heroBefore.hero?.name &&
        heroAfter.hero?.class === heroBefore.hero?.class,
      { before: heroBefore.hero, after: heroAfter.hero },
    );
    run.check("tick after reload >= verified tick before it", heroAfter.tick >= verifiedTick, {
      tick: heroAfter.tick,
      verifiedTick,
    });
    const online2 = await waitOk(
      run,
      `window.__gamez.sync?.status === 'online' && window.__gamez.sync?.verifiedTick > ${verifiedTick}`,
      30_000,
    );
    const end = await syncOf(run);
    run.check("verification continues after reload", online2, end);
    run.check("no resync after reload", end?.lastResync == null, end?.lastResync, true);
    await run.shot("hud-after-reload");

    // New game: connection.restart() (server seed); the new hero made on the placeholder is
    // replayed onto the fresh server state and must verify like any other play.
    const other = cls === "rogue" ? "sorcerer" : "rogue";
    await run.page.evaluate(`window.__gamez.controls.newHero(${JSON.stringify(other)})`);
    const restarted = await waitOk(
      run,
      `window.__gamez.sim.hero?.class === 'classic.${other}' && window.__gamez.sync?.restarting === false && window.__gamez.sync?.status === 'online' && window.__gamez.sync?.verifiedTick > 40`,
      30_000,
    );
    const afterNew = await syncOf(run);
    run.sample({ at: "new-game", sync: afterNew, hero: (await heroOf(run)).hero });
    run.check("new game restarts the server instance and verifies", restarted, afterNew);
    run.check("no resync after the new game", afterNew?.lastResync == null, afterNew?.lastResync);
    await run.shot("hud-new-game");
    await openClassic(run, other);
    await run.page.wait(1000);
    const back = await heroOf(run);
    run.check(
      "the new hero is the one restored after a reload",
      back.hero?.class === `classic.${other}`,
      back.hero,
    );

    // Full Idle x8: 8x sim time per wall second is legal there (speedOf), so the ledger must accept it.
    await waitOk(run, "window.__gamez.sync?.status === 'online'", 20_000);
    await run.page.evaluate(
      "(() => { const c = window.__gamez.controls; c.setMode('idle'); c.setSpeed(8); })()",
    );
    const idleFrom = (await syncOf(run))?.verifiedTick ?? 0;
    await run.page.wait(10_000);
    const idle = await syncOf(run);
    run.sample({ at: "idle-x8", from: idleFrom, sync: idle });
    run.check(
      "Full Idle x8 verifies without too_fast",
      (idle?.verifiedTick ?? 0) > idleFrom && idle?.lastResync == null,
      { from: idleFrom, sync: idle },
    );
    await run.shot("hud-idle-x8");
  },
};

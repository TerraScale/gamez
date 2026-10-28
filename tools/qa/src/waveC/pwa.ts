/**
 * Wave C QA scenarios: pwa (manifest + icons served, service worker registered on a production build, offline reload shows the shell) (docs/design/wave-C.md §12). OWNER: T-ship.
 *
 *   node tools/qa/src/run.ts pwa --out /tmp/gamez-qa/waveC-ship-pwa
 *
 * The scenario needs a production build served on a port, which the harness never starts:
 *
 *   node_modules/.bin/vp -C apps/game build
 *   node_modules/.bin/vp -C apps/game preview --port 5410      # stop it again after the run
 *
 * Address: GAMEZ_QA_PWA_URL (default http://localhost:5410). `localhost` needs ?sw=1 for the worker
 * (docs/ship.md §1.2); the scenario adds it. The dev server on :5173 is not used.
 *
 * Checks: production build (no Vite client), manifest parsed over CDP (Page.getAppManifest),
 * installability errors (Page.getInstallabilityErrors), icons fetched, worker activated and
 * controlling the page, shell precached, offline reload renders the app (not the browser error
 * page), back online, ?nosw=1 unregisters and clears the caches. Screenshots: shell-online,
 * shell-offline, after-nosw.
 *
 * The offline step uses CDP network emulation. That cuts the page's own requests (the API probe),
 * but the worker's network fetches are not always cut by it, so a pass here does not prove the
 * cache served the reload. The true offline proof is to stop the preview and reload; it was run by
 * hand and is described in docs/ship.md §1.5.
 */
import { waitForServer } from "../cdp.ts";
import type { Run } from "../run.ts";
import type { Runner } from "./index.ts";

const PREVIEW = (process.env.GAMEZ_QA_PWA_URL ?? "http://localhost:5410").replace(/\/+$/, "");
const SHELL_CACHE = "gamez-shell-v1";

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

interface ManifestCheck {
  name?: string;
  display?: string;
  start_url?: string;
  scope?: string;
  icons?: ManifestIcon[];
  categories?: string[];
}

interface AppManifestResult {
  url?: string;
  errors?: { message: string; critical: number }[];
  data?: string;
  parsed?: Record<string, unknown>;
}

interface WorkerState {
  supported: boolean;
  registrations: number;
  active: string | null;
  controlled: boolean;
  caches: string[];
}

export const PWA_RUNNERS: Record<string, Runner> = {
  pwa: async (run) => pwaScenario(run),
};

async function pwaScenario(run: Run): Promise<void> {
  const page = run.page;
  try {
    await waitForServer(PREVIEW, 15_000);
  } catch {
    throw new Error(
      `no production preview at ${PREVIEW}: run "node_modules/.bin/vp -C apps/game build" and ` +
        `"node_modules/.bin/vp -C apps/game preview --port 5410" first`,
    );
  }
  await page.send("Network.enable");

  // 1. The production shell loads and is not the Vite dev build.
  await page.open(`${PREVIEW}/?sw=1`);
  await waitRendered(run, 30_000);
  const build = await page.evaluate<{ viteClient: boolean; assetScripts: number; title: string }>(
    () => ({
      viteClient: document.querySelector('script[src*="@vite"]') !== null,
      assetScripts: document.querySelectorAll('script[src^="/assets/"]').length,
      title: document.title,
    }),
  );
  run.check(
    "production build served (no Vite client, hashed assets)",
    !build.viteClient && build.assetScripts > 0 && build.title === "gamez",
    build,
  );

  // 2. Manifest: parsed by Chrome, and matching the file on disk.
  const appManifest = (await page.send("Page.getAppManifest")) as AppManifestResult;
  const fromFile = parseManifest(appManifest.data);
  const parsedName = appManifest.parsed?.name ?? fromFile?.name;
  run.check(
    "manifest served and parsed without errors",
    (appManifest.errors ?? []).length === 0 && parsedName === "gamez",
    { url: appManifest.url, errors: appManifest.errors ?? [], parsedName },
  );
  run.check(
    "manifest: standalone, root scope and start, games category",
    fromFile?.display === "standalone" &&
      fromFile.start_url === "/" &&
      fromFile.scope === "/" &&
      (fromFile.categories ?? []).includes("games"),
    fromFile,
  );
  const icons = fromFile?.icons ?? [];
  run.check(
    "manifest: 192 and 512 icons (any) plus a 512 maskable",
    has(icons, "192x192", "any") &&
      has(icons, "512x512", "any") &&
      has(icons, "512x512", "maskable"),
    icons.map((i) => `${i.sizes}:${i.purpose}`),
  );

  // 3. Installability, as Chrome reports it.
  try {
    const res = (await page.send("Page.getInstallabilityErrors")) as {
      installabilityErrors?: { errorId: string; errorArguments?: unknown[] }[];
    };
    const errors = res.installabilityErrors ?? [];
    run.check("Chrome reports no installability errors", errors.length === 0, errors);
  } catch (err) {
    run.check(
      "Chrome reports no installability errors",
      false,
      { unsupported: err instanceof Error ? err.message : String(err) },
      true,
    );
  }

  // 4. Every icon in the manifest answers with a PNG.
  const iconStatus = await page.evaluate<{ path: string; status: number; type: string | null }[]>(
    async (paths: string[]) => {
      const out: { path: string; status: number; type: string | null }[] = [];
      for (const path of paths) {
        const res = await fetch(path, { cache: "no-store" });
        out.push({ path, status: res.status, type: res.headers.get("content-type") });
      }
      return out;
    },
    icons.map((i) => i.src),
  );
  run.check(
    "every manifest icon loads as image/png",
    iconStatus.length > 0 &&
      iconStatus.every((i) => i.status === 200 && (i.type ?? "").startsWith("image/png")),
    iconStatus,
  );
  const favicon = await page.evaluate<number>(
    async () => (await fetch("/icons/apple-touch-icon.png", { cache: "no-store" })).status,
  );
  run.check("apple-touch-icon loads", favicon === 200, { status: favicon });

  // 5. The worker activates and controls the page; the shell is precached.
  const state = await waitWorker(page, 30_000);
  run.check(
    "service worker registered and activated",
    state.supported && state.registrations > 0 && state.active === "activated",
    state,
  );
  // Reload so the page is controlled by the worker from its first request on.
  await page.open(`${PREVIEW}/?sw=1`);
  await waitRendered(run, 30_000);
  const controlled = await waitWorker(page, 15_000, (s) => s.controlled);
  run.check("page is controlled by the worker", controlled.controlled, controlled);
  const precache = await page.evaluate<string[]>(async (cache: string) => {
    const store = await window.caches.open(cache);
    return (await store.keys()).map((r) => new URL(r.url).pathname).sort();
  }, SHELL_CACHE);
  run.check(
    "shell precached: index.html, the icons and the hashed assets",
    precache.includes("/index.html") &&
      precache.includes("/manifest.webmanifest") &&
      precache.includes("/icons/icon-192.png") &&
      precache.some((p) => p.startsWith("/assets/") && p.endsWith(".js")),
    precache,
  );
  await run.shot("shell-online");

  // 6. Offline: the network is really gone for the page, and a reload still renders the app.
  await page.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  const probe = await page.evaluate<string>(async () => {
    try {
      await fetch("/api/health", { cache: "no-store" });
      return "reachable";
    } catch {
      return "unreachable";
    }
  });
  run.check("network is offline for the page (api unreachable)", probe === "unreachable", {
    probe,
  });
  await page.send("Page.reload", { ignoreCache: false });
  await waitRendered(run, 30_000);
  // The picker fills in after its offline calls fail, so give it a few seconds.
  await waitModeCards(run, 10_000);
  const offline = await page.evaluate<{
    title: string;
    onLine: boolean;
    modeCards: number;
    chromeError: boolean;
    url: string;
  }>(() => ({
    title: document.title,
    onLine: navigator.onLine,
    modeCards: document.querySelectorAll(".mode-card").length,
    chromeError: /ERR_|can.t be reached|No internet/i.test(document.body?.innerText ?? ""),
    url: location.href,
  }));
  run.check(
    "offline reload renders the app shell, not the browser error page",
    offline.title === "gamez" && !offline.chromeError && offline.url.startsWith(PREVIEW),
    offline,
  );
  run.check(
    "offline reload shows the mode picker",
    offline.modeCards > 0,
    { modeCards: offline.modeCards },
    true,
  );
  await run.shot("shell-offline");

  // 7. Back online.
  await page.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  // 8. ?nosw=1 removes the worker and the gamez caches.
  await page.open(`${PREVIEW}/?nosw=1`);
  await waitRendered(run, 30_000);
  const cleared = await waitWorker(
    page,
    15_000,
    (s) => s.registrations === 0 && s.caches.length === 0,
  );
  run.check(
    "?nosw=1 unregisters the worker and clears the gamez caches",
    cleared.registrations === 0 && !cleared.caches.some((c) => c.startsWith("gamez-")),
    cleared,
  );
  await run.shot("after-nosw");

  run.report.data.pwa = {
    preview: PREVIEW,
    offlineMethod: "cdp-emulation (see the module comment for the limit)",
    manifestIcons: icons.map((i) => `${i.src} ${i.sizes} ${i.purpose}`),
    worker: state,
    precacheEntries: precache.length,
    offlineProbe: probe,
  };
}

/** Renders the app: #root has children once React has mounted. */
async function waitRendered(run: Run, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ok = await run.page.evaluate<boolean>(
      () => (document.getElementById("root")?.children.length ?? 0) > 0,
    );
    if (ok) return;
    if (Date.now() > end) throw new Error(`app did not render within ${timeoutMs} ms`);
    await run.page.wait(200);
  }
}

/** Waits up to `timeoutMs` for the mode picker cards (they render after the app's first calls). */
async function waitModeCards(run: Run, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const n = await run.page.evaluate<number>(() => document.querySelectorAll(".mode-card").length);
    if (n > 0) return;
    await run.page.wait(250);
  }
}

/** Polls the worker state in the page until `done` holds (default: registered and activated). */
async function waitWorker(
  page: Run["page"],
  timeoutMs: number,
  done: (s: WorkerState) => boolean = (s) => s.registrations > 0 && s.active === "activated",
): Promise<WorkerState> {
  const end = Date.now() + timeoutMs;
  let last: WorkerState = {
    supported: false,
    registrations: 0,
    active: null,
    controlled: false,
    caches: [],
  };
  for (;;) {
    last = await page.evaluate<WorkerState>(async () => {
      const sw = navigator.serviceWorker;
      if (!sw)
        return { supported: false, registrations: 0, active: null, controlled: false, caches: [] };
      const regs = await sw.getRegistrations();
      const reg = regs[0];
      return {
        supported: true,
        registrations: regs.length,
        active: reg?.active?.state ?? null,
        controlled: sw.controller !== null,
        caches: await window.caches.keys(),
      };
    });
    if (done(last)) return last;
    if (Date.now() > end) return last;
    await page.wait(250);
  }
}

function parseManifest(data: string | undefined): ManifestCheck | null {
  if (!data) return null;
  try {
    return JSON.parse(data) as ManifestCheck;
  } catch {
    return null;
  }
}

function has(icons: ManifestIcon[], sizes: string, purpose: string): boolean {
  return icons.some((i) => i.sizes === sizes && i.purpose === purpose);
}

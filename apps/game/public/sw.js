/*
 * gamez service worker (docs/design/wave-C.md §11, docs/ship.md "PWA").
 *
 * Plain JavaScript served as-is from /sw.js (Vite copies public/ untouched). It is NOT
 * bundled, so it cannot import modules. routeOf() below mirrors apps/game/src/client/pwa/routing.ts,
 * and tests/client/pwa.sw.test.ts evaluates this file to check that both agree on a table of URLs.
 * Change the two together.
 *
 * Caching rules:
 *   - non-GET, /api/* and /ws* are never touched (the browser goes to the network as usual)
 *   - other requests from another origin are never touched
 *   - /assets/* (hashed by Vite) and /art/* are cache-first, and stored on first success
 *   - navigations are network-first with a timeout; the cached /index.html is the offline shell
 *   - everything else goes to the network
 *
 * Install precaches the shell and the whole /assets/ graph: index.html, then every JS and CSS
 * file it refers to, then the files those refer to (chunks import chunks).
 *
 * Versioning: bump CACHE when the precache list or the strategy changes. Activate deletes every
 * other gamez-* cache. Hashed assets are never overwritten, so old tabs keep working until they
 * reload. The worker does not skip waiting on its own; the page may post { type: "SKIP_WAITING" }.
 */
const CACHE = "gamez-shell-v1";
const NAVIGATION_TIMEOUT_MS = 3000;
const PRECACHE_BATCH = 6;
const SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
];

/**
 * Route kind for one request, from its method, path and fetch mode.
 * "bypass" and "network" both leave the request alone; they are kept apart for the tests.
 */
function routeOf(method, pathname, mode) {
  if (method !== "GET") return "bypass";
  if (pathname === "/api" || pathname.indexOf("/api/") === 0) return "bypass";
  if (pathname.indexOf("/ws") === 0) return "bypass";
  if (mode === "navigate") return "navigate";
  if (pathname.indexOf("/assets/") === 0 || pathname.indexOf("/art/") === 0) return "cache-first";
  return "network";
}

/**
 * Same-origin /assets/ files that a text (HTML, JS or CSS) refers to, resolved against `base`
 * (the URL the text came from). Matches the forms Vite emits: src and href attributes, `from"./c.js"`,
 * `import("./c.js")`, `url(./font.woff2)`, and the bare `"assets/c.js"` entries of __vite__mapDeps
 * (those resolve against the site root).
 */
function assetRefsIn(text, base) {
  const refs = [];
  const origin = self.location.origin;
  const re = /["'(]((?:\.{1,2}\/|\/)[^"'()\s<>]+)["')]|["'](assets\/[^"'()\s<>]+)["']/g;
  let match = re.exec(text);
  while (match !== null) {
    const relative = match[1] !== undefined ? match[1] : match[2];
    const from = match[1] !== undefined ? new URL(base, origin) : new URL("/", origin);
    // Minified code has strings that look like paths (a regex literal, say). Those do not parse.
    let url = null;
    try {
      url = new URL(relative, from);
    } catch {
      url = null;
    }
    if (
      url !== null &&
      url.origin === origin &&
      url.pathname.indexOf("/assets/") === 0 &&
      /\.(?:js|css|woff2|png|svg|json|webp)$/.test(url.pathname) &&
      refs.indexOf(url.pathname) < 0
    ) {
      refs.push(url.pathname);
    }
    match = re.exec(text);
  }
  return refs;
}

/** Fetches one URL into the cache. Returns the files it refers to. Assets must succeed. */
async function precacheOne(cache, url) {
  const isAsset = url.indexOf("/assets/") === 0;
  try {
    const res = await fetch(url, { cache: "reload" });
    if (!res.ok) throw new Error(url + " returned " + res.status);
    const type = res.headers.get("content-type") || "";
    const refs = /javascript|css|html/.test(type) ? assetRefsIn(await res.clone().text(), url) : [];
    await cache.put(url, res);
    return refs;
  } catch (err) {
    // A missing asset would break the app offline, so a failed asset fails the install and the
    // browser retries later. Icons and other extras are best effort.
    if (isAsset) throw err;
    console.warn("gamez sw: precache skipped " + url, err);
    return [];
  }
}

async function precache() {
  const cache = await caches.open(CACHE);
  // The shell page first: its references start the crawl.
  const shell = await fetch("/index.html", { cache: "reload" });
  if (!shell.ok) throw new Error("precache: /index.html returned " + shell.status);
  const html = await shell.clone().text();
  await cache.put("/index.html", shell);

  const done = new Set(["/index.html"]);
  const pending = SHELL_URLS.concat(assetRefsIn(html, "/index.html"));
  while (pending.length > 0) {
    const batch = pending.splice(0, PRECACHE_BATCH).filter((url) => !done.has(url));
    for (const url of batch) done.add(url);
    const found = await Promise.all(batch.map((url) => precacheOne(cache, url)));
    for (const refs of found) {
      for (const ref of refs) if (!done.has(ref)) pending.push(ref);
    }
  }
}

/**
 * Cache first, keyed by URL. The build's responses carry `Vary: Origin`, and a module or stylesheet
 * request sends an Origin header that the precached (same-origin) request did not have, so a
 * lookup by the request object misses offline. A URL string carries no headers, so it matches.
 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") cache.put(request.url, res.clone()).catch(() => {});
  return res;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * The offline page answer: a fresh Response built from the cached text. The cached Response keeps
 * its own URL (/index.html), and Chrome fails a navigation to /?sw=1 when the worker answers with
 * it (ERR_FAILED, seen in the QA run). A new Response has no URL, so Chrome accepts it.
 */
function shellResponse(html) {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function navigate(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    if (res.ok && res.type === "basic") {
      // Keep the offline shell at the newest deployed index.html.
      cache.put("/index.html", res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const shell = (await cache.match("/index.html")) || (await cache.match("/"));
    if (shell) return shellResponse(await shell.text());
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>gamez offline</title><body style="font-family:system-ui;background:#10131a;color:#e6e9ef;padding:24px">' +
        "<h1>gamez is offline</h1><p>Connect to the internet and reload to play.</p></body>",
      { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.indexOf("gamez-") === 0 && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const kind = routeOf(request.method, url.pathname, request.mode);
  if (kind === "cache-first") event.respondWith(cacheFirst(request));
  else if (kind === "navigate") event.respondWith(navigate(request));
});

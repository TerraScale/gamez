/**
 * Request routing for the service worker (wave-C.md §11). Pure, so it is unit-tested here.
 *
 * public/sw.js is plain JS and cannot import this file, so it carries a copy of routeOf().
 * tests/client/pwa.sw.test.ts evaluates sw.js and checks that both return the same route for a
 * table of URLs. If you change one, change the other; the test fails when they drift.
 */

/** What the service worker does with one request. */
export type RouteKind =
  /** Not ours: non-GET, /api/*, /ws*. The browser handles it as if no worker existed. */
  | "bypass"
  /** Page navigation: network first with a timeout, the cached shell as the fallback. */
  | "navigate"
  /** Hashed build output and art: cache first, stored on the first success. */
  | "cache-first"
  /** Anything else: the browser handles it. */
  | "network";

/** Cache name of the shell. sw.js declares the same value (CACHE). */
export const SHELL_CACHE = "gamez-shell-v1";

/** How long a navigation waits for the network before falling back to the cached shell. */
export const NAVIGATION_TIMEOUT_MS = 3000;

/**
 * Route kind for a request.
 *
 * @param method   HTTP method as sent (only GET is ever cached)
 * @param pathname URL path, without the origin or query
 * @param mode     the fetch mode (`navigate` for page loads)
 */
export function routeOf(method: string, pathname: string, mode: string | undefined): RouteKind {
  if (method !== "GET") return "bypass";
  if (pathname === "/api" || pathname.indexOf("/api/") === 0) return "bypass";
  if (pathname.indexOf("/ws") === 0) return "bypass";
  if (mode === "navigate") return "navigate";
  if (pathname.indexOf("/assets/") === 0 || pathname.indexOf("/art/") === 0) return "cache-first";
  return "network";
}

/** The paths precached on install, in addition to the assets index.html references. */
export const SHELL_URLS: readonly string[] = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
];

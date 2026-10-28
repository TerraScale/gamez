/**
 * PWA entry point (wave-C.md §11, docs/ship.md "PWA"): service worker registration and the
 * install prompt store. main.ts calls registerPwa() after the app has rendered.
 *
 * Registration rules live in ./registration.ts (pure, tested), the install store in ./install.ts,
 * request routing (mirrored by public/sw.js) in ./routing.ts.
 */
import {
  applyRegistration,
  type RegisterDeps,
  type RegisterOutcome,
  type ServiceWorkerLike,
} from "./registration.ts";
import { createInstallPromptStore, type InstallPromptStore } from "./install.ts";

export {
  decideRegistration,
  applyRegistration,
  SW_SCOPE,
  SW_URL,
  type CacheStorageLike,
  type RegisterDeps,
  type RegisterOutcome,
  type RegistrationAction,
  type RegistrationDecision,
  type RegistrationInput,
  type ServiceWorkerLike,
} from "./registration.ts";
export {
  createInstallPromptStore,
  type BeforeInstallPromptEventLike,
  type InstallChoice,
  type InstallPromptStore,
  type InstallState,
  type InstallStatus,
  type InstallWindowLike,
} from "./install.ts";
export {
  NAVIGATION_TIMEOUT_MS,
  SHELL_CACHE,
  SHELL_URLS,
  routeOf,
  type RouteKind,
} from "./routing.ts";

/** Browser values the registration rules need, read at call time. */
function browserDeps(): RegisterDeps {
  const g = globalThis as {
    location?: { hostname?: string; search?: string };
    navigator?: { serviceWorker?: ServiceWorkerLike };
    caches?: RegisterDeps["caches"];
  };
  return {
    prod: import.meta.env.PROD,
    hostname: g.location?.hostname ?? "",
    search: g.location?.search ?? "",
    serviceWorker: g.navigator?.serviceWorker,
    caches: g.caches,
  };
}

/**
 * Registers /sw.js when the page is a production build on a real host (or `?sw=1`), and
 * unregisters everything for `?nosw=1`. Never throws and never blocks rendering.
 *
 * @param overrides  test seam: replaces any browser value
 */
export function registerPwa(overrides: Partial<RegisterDeps> = {}): Promise<RegisterOutcome> {
  return applyRegistration({ ...browserDeps(), ...overrides });
}

/** Install prompt store for the whole page (created once, on the real window). */
export const installPrompt: InstallPromptStore = createInstallPromptStore(
  typeof window === "undefined" ? undefined : window,
  {
    iosStandalone:
      typeof navigator !== "undefined" &&
      (navigator as unknown as { standalone?: boolean }).standalone === true,
  },
);

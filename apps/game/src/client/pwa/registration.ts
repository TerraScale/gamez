/**
 * Service worker registration rules (wave-C.md §11, docs/ship.md "PWA").
 *
 * The worker is registered only in production builds (`import.meta.env.PROD`), never on the
 * Vite dev server (HMR would fight the cache), and not on localhost unless `?sw=1` asks for it,
 * so `vp preview` can be tested on purpose. `?nosw=1` unregisters every worker on the origin and
 * clears the gamez-* caches; it wins over every other flag.
 */

export const SW_URL = "/sw.js";
export const SW_SCOPE = "/";

/** Hosts that count as local development (the worker needs ?sw=1 there). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface RegistrationInput {
  /** `import.meta.env.PROD`: true only for a production build. */
  prod: boolean;
  /** `location.hostname`. */
  hostname: string;
  /** `location.search`, with or without the leading "?". */
  search: string;
}

export type RegistrationAction = "register" | "unregister" | "skip";

export interface RegistrationDecision {
  action: RegistrationAction;
  /** Why, in a few words. Shown in the QA report and in tests. */
  reason: string;
}

/** Pure decision: what to do with the service worker for this page. */
export function decideRegistration(input: RegistrationInput): RegistrationDecision {
  const params = new URLSearchParams(input.search);
  if (params.get("nosw") === "1") return { action: "unregister", reason: "nosw" };
  if (!input.prod) return { action: "skip", reason: "dev-server" };
  if (params.get("sw") === "1") return { action: "register", reason: "sw-param" };
  if (LOCAL_HOSTS.has(input.hostname)) return { action: "skip", reason: "local-host" };
  return { action: "register", reason: "production-host" };
}

/** The part of ServiceWorkerContainer that registration uses (a fake in tests). */
export interface ServiceWorkerLike {
  register(url: string, options?: { scope?: string }): Promise<unknown>;
  getRegistrations(): Promise<readonly { unregister(): Promise<boolean> }[]>;
}

/** The part of CacheStorage that the nosw cleanup uses. */
export interface CacheStorageLike {
  keys(): Promise<string[]>;
  delete(key: string): Promise<boolean>;
}

export interface RegisterDeps extends RegistrationInput {
  serviceWorker?: ServiceWorkerLike | undefined;
  caches?: CacheStorageLike | undefined;
}

export interface RegisterOutcome {
  action: RegistrationAction;
  reason: string;
  /** False when the browser refused the registration or the unregistration failed. */
  ok: boolean;
  /** Set when `ok` is false. */
  error?: string;
  /** Workers unregistered (nosw only). */
  unregistered?: number;
}

/**
 * Applies decideRegistration() to the browser. Never throws: a failed registration only means
 * the app runs without offline support, so the outcome carries the error instead.
 */
export async function applyRegistration(deps: RegisterDeps): Promise<RegisterOutcome> {
  const decision = decideRegistration(deps);
  const sw = deps.serviceWorker;

  if (decision.action === "unregister") {
    try {
      let unregistered = 0;
      if (sw) {
        for (const reg of await sw.getRegistrations()) {
          if (await reg.unregister()) unregistered++;
        }
      }
      if (deps.caches) {
        for (const key of await deps.caches.keys()) {
          if (key.indexOf("gamez-") === 0) await deps.caches.delete(key);
        }
      }
      return { ...decision, ok: true, unregistered };
    } catch (err) {
      return { ...decision, ok: false, error: describe(err) };
    }
  }

  if (decision.action === "skip") return { ...decision, ok: true };

  if (!sw) return { action: "skip", reason: "unsupported", ok: true };
  try {
    await sw.register(SW_URL, { scope: SW_SCOPE });
    return { ...decision, ok: true };
  } catch (err) {
    return { ...decision, ok: false, error: describe(err) };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

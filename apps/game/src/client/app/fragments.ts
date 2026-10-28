/**
 * URL fragments the shell reacts to (wave C, docs/design/wave-C.md §10.4):
 * `#store=paid&order=<id>` and `#store=cancel` after a payment return, and
 * `#admin` for the live-ops dashboard, with deep links `#admin/<section>[/<arg>]`
 * (docs/design/admin-dashboard.md §10.1). The OAuth `#auth=` fragment is handled
 * by session.ts (consumeAuthFragment) and is not parsed here.
 */

export type ShellFragment =
  | { kind: "store"; outcome: "paid"; order: string | null }
  | { kind: "store"; outcome: "cancel" }
  | { kind: "admin"; section?: string; arg?: string };

/** Longest order id accepted from a URL; longer values are dropped. */
export const ORDER_ID_MAX = 80;
/** Longest admin deep-link argument (an account id); longer ones are dropped. */
export const ADMIN_ARG_MAX = 128;
const ADMIN_SECTION_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * "admin", "admin/<section>" or "admin/<section>/<arg>" (the hash without "#").
 * A malformed section opens the dashboard on its default section; a malformed
 * or too long argument is dropped. The argument is URI-decoded and may contain "/".
 */
function parseAdmin(raw: string): ShellFragment | null {
  if (raw === "admin") return { kind: "admin" };
  if (!raw.startsWith("admin/")) return null;
  const rest = raw.slice("admin/".length);
  const cut = rest.indexOf("/");
  const section = cut < 0 ? rest : rest.slice(0, cut);
  if (!ADMIN_SECTION_RE.test(section)) return { kind: "admin" };
  if (cut < 0) return { kind: "admin", section };
  let arg: string;
  try {
    arg = decodeURIComponent(rest.slice(cut + 1));
  } catch {
    return { kind: "admin", section };
  }
  if (arg.length === 0 || arg.length > ADMIN_ARG_MAX) return { kind: "admin", section };
  return { kind: "admin", section, arg };
}

/** Parses the location hash ("#store=paid&order=x" or "store=paid&order=x"). Unknown fragments give null. */
export function parseShellFragment(hash: string): ShellFragment | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const admin = parseAdmin(raw);
  if (admin) return admin;
  const params = new URLSearchParams(raw);
  const store = params.get("store");
  if (store === "paid") {
    const order = params.get("order");
    return {
      kind: "store",
      outcome: "paid",
      order: order !== null && order.length > 0 && order.length <= ORDER_ID_MAX ? order : null,
    };
  }
  if (store === "cancel") return { kind: "store", outcome: "cancel" };
  return null;
}

/** Removes the fragment without a navigation (the query string stays). Errors are ignored. */
export function clearShellFragment(): void {
  try {
    const loc = globalThis.location;
    if (!loc || loc.hash === "") return;
    globalThis.history.replaceState(globalThis.history.state, "", loc.pathname + loc.search);
  } catch {
    // Sandboxed frames refuse history changes: the fragment just stays.
  }
}

/** localStorage key of the order ids whose "paid" return was already shown. */
export const SEEN_ORDERS_KEY = "gamez.store.seenOrders";
const SEEN_ORDERS_MAX = 20;

type KeyValue = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * True the first time a paid return for `order` is seen on this device, and
 * records it, so reloading (or reopening) an old return URL does not claim a
 * new purchase. Orders without an id, and blocked storage, always count as new.
 */
export function firstPaidReturn(
  order: string | null,
  storage: KeyValue | null = defaultStorage(),
): boolean {
  if (!order || !storage) return true;
  try {
    const raw = storage.getItem(SEEN_ORDERS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const seen = Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
    if (seen.includes(order)) return false;
    storage.setItem(SEEN_ORDERS_KEY, JSON.stringify([...seen, order].slice(-SEEN_ORDERS_MAX)));
    return true;
  } catch {
    return true;
  }
}

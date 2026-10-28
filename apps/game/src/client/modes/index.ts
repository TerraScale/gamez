/**
 * Client-side mode views, keyed by mode id. A mode in the catalog without an
 * entry here shows as "not available" in the picker.
 *
 * Every view is code split (wave-B.md §8.2): `lazyView` is a small stub with
 * the mode's id that imports the real view on its first mount. The picker and
 * the shell only need the ids, so the mode packages stay out of the main chunk.
 */
import type { ClientModeView } from "@gamez/ui-host";
import { classicInfo } from "./plaza-info.ts";

export { classicInfo } from "./plaza-info.ts";

/**
 * A view that loads `load()` on first mount and then mounts the real view.
 * `ownsExitControl` must match the real view (it is needed before loading).
 * A failed load is retried on the next mount.
 */
export function lazyView(
  modeId: string,
  load: () => Promise<ClientModeView>,
  ownsExitControl = false,
): ClientModeView {
  let pending: Promise<ClientModeView> | null = null;
  const loadOnce = (): Promise<ClientModeView> => {
    pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
  return {
    modeId,
    ownsExitControl,
    async mount(host, services) {
      const view = await loadOnce();
      return view.mount(host, services);
    },
  };
}

/** The classic QA gallery (`?qa=gallery`), not in the picker. */
export const galleryView: ClientModeView = lazyView("classic.gallery", () =>
  import("@gamez/mode-classic/client").then((m) => m.classicGalleryView),
);

export const CLIENT_MODE_VIEWS: readonly ClientModeView[] = [
  lazyView("classic", () => import("@gamez/mode-classic/client").then((m) => m.classicView), true),
  lazyView("duel", () => import("@gamez/mode-duel/client").then((m) => m.duelView)),
  lazyView("steps", () => import("@gamez/mode-steps/client").then((m) => m.stepsView)),
  lazyView(classicInfo.id, () => import("./classic.ts").then((m) => m.classicMode)),
];

const byId = new Map(CLIENT_MODE_VIEWS.map((view) => [view.modeId, view]));

export function findModeView(modeId: string): ClientModeView | undefined {
  return byId.get(modeId);
}

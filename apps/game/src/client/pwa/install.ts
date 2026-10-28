/**
 * Install prompt store (wave-C.md §11): captures `beforeinstallprompt` so the shell can offer an
 * "Install" button later (T-shell). Chrome and Edge fire the event; Safari does not, and iOS
 * installs from the share sheet, so the store reports "unavailable" there.
 *
 * Usage from UI code:
 *   const state = installPrompt.getState();          // { status, lastOutcome }
 *   const unsubscribe = installPrompt.subscribe(s => …);
 *   if (state.status === "available") await installPrompt.prompt();
 */

export type InstallStatus =
  /** No prompt is pending: the browser did not offer one, or it was already answered. */
  | "unavailable"
  /** `beforeinstallprompt` fired and nothing was asked yet. prompt() will show the dialog. */
  | "available"
  /** Running standalone, or `appinstalled` fired, or the user accepted the prompt. */
  | "installed";

export type InstallChoice = "accepted" | "dismissed";

export interface InstallState {
  status: InstallStatus;
  /** Result of the last prompt() call that reached the user. */
  lastOutcome: InstallChoice | null;
}

export interface InstallPromptStore {
  getState(): InstallState;
  /** Calls the listener now and after every change. Returns the unsubscribe function. */
  subscribe(listener: (state: InstallState) => void): () => void;
  /**
   * Shows the browser's install dialog. Resolves with the user's choice, or "unavailable" when
   * no prompt is pending (the browser fires the event again later, after more engagement).
   */
  prompt(): Promise<InstallChoice | "unavailable">;
  /** Removes the window listeners (tests, hot reload). */
  dispose(): void;
}

/** The `beforeinstallprompt` event as Chrome delivers it (not in lib.dom). */
export interface BeforeInstallPromptEventLike {
  preventDefault(): void;
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: InstallChoice; platform?: string }>;
}

/** The part of Window that the store uses (a fake in tests). */
export interface InstallWindowLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  matchMedia?: (query: string) => { matches: boolean };
}

export interface InstallStoreOptions {
  /** `navigator.standalone` on iOS Safari when launched from the home screen. */
  iosStandalone?: boolean;
}

export function createInstallPromptStore(
  win: InstallWindowLike | undefined,
  options: InstallStoreOptions = {},
): InstallPromptStore {
  const standaloneNow = (): boolean => {
    if (options.iosStandalone === true) return true;
    try {
      return win?.matchMedia?.("(display-mode: standalone)").matches === true;
    } catch {
      return false;
    }
  };

  let state: InstallState = {
    status: standaloneNow() ? "installed" : "unavailable",
    lastOutcome: null,
  };
  let deferred: BeforeInstallPromptEventLike | null = null;
  const listeners = new Set<(state: InstallState) => void>();

  const set = (patch: Partial<InstallState>): void => {
    state = { ...state, ...patch };
    // Snapshot: a listener may unsubscribe while the others are being told.
    for (const listener of Array.from(listeners)) listener(state);
  };

  const onBeforeInstall = (event: Event): void => {
    event.preventDefault();
    deferred = event as unknown as BeforeInstallPromptEventLike;
    if (state.status !== "installed") set({ status: "available" });
  };
  const onInstalled = (): void => {
    deferred = null;
    set({ status: "installed" });
  };

  win?.addEventListener("beforeinstallprompt", onBeforeInstall);
  win?.addEventListener("appinstalled", onInstalled);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt() {
      const event = deferred;
      // A prompt can be shown once per event: clear it before asking.
      deferred = null;
      if (!event) return "unavailable";
      try {
        await event.prompt();
        const choice = await event.userChoice;
        if (choice.outcome === "accepted") {
          set({ status: "installed", lastOutcome: "accepted" });
        } else {
          set({ status: "unavailable", lastOutcome: "dismissed" });
        }
        return choice.outcome;
      } catch {
        set({ status: "unavailable" });
        return "unavailable";
      }
    },
    dispose() {
      win?.removeEventListener("beforeinstallprompt", onBeforeInstall);
      win?.removeEventListener("appinstalled", onInstalled);
      listeners.clear();
    },
  };
}

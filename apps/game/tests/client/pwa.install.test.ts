import { describe, expect, it, vi } from "vite-plus/test";
import {
  createInstallPromptStore,
  type InstallState,
  type InstallWindowLike,
} from "../../src/client/pwa/index.ts";

/** A fake window that records listeners and can fire events. */
function fakeWindow(standalone = false) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const win: InstallWindowLike = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    matchMedia: (query) => ({ matches: standalone && query.includes("standalone") }),
  };
  const fire = (type: string, event: Event): void => {
    for (const l of Array.from(listeners.get(type) ?? [])) l(event);
  };
  const count = (type: string): number => listeners.get(type)?.size ?? 0;
  return { win, fire, count };
}

/** A fake beforeinstallprompt event with a controllable user choice. */
function fakeInstallEvent(choice: "accepted" | "dismissed" | "throw" = "accepted") {
  const preventDefault = vi.fn();
  const prompt = vi.fn(async () => {
    if (choice === "throw") throw new Error("prompt() called twice");
  });
  const event = {
    preventDefault,
    prompt,
    userChoice: Promise.resolve({ outcome: choice === "dismissed" ? "dismissed" : "accepted" }),
  };
  return { event: event as unknown as Event, preventDefault, prompt };
}

describe("installPrompt store", () => {
  it("starts unavailable in a normal browser tab", () => {
    const { win } = fakeWindow(false);
    const store = createInstallPromptStore(win);
    expect(store.getState()).toEqual({ status: "unavailable", lastOutcome: null });
    store.dispose();
  });

  it("starts installed when running standalone (display-mode or iOS home screen)", () => {
    expect(createInstallPromptStore(fakeWindow(true).win).getState().status).toBe("installed");
    expect(
      createInstallPromptStore(fakeWindow(false).win, { iosStandalone: true }).getState().status,
    ).toBe("installed");
  });

  it("captures beforeinstallprompt, suppresses the mini-infobar and notifies subscribers", () => {
    const { win, fire } = fakeWindow();
    const store = createInstallPromptStore(win);
    const seen: InstallState[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s));
    const { event, preventDefault } = fakeInstallEvent();

    fire("beforeinstallprompt", event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe("available");
    expect(seen.map((s) => s.status)).toEqual(["unavailable", "available"]);
    unsubscribe();
    store.dispose();
  });

  it("prompt() shows the dialog once; accepted becomes installed", async () => {
    const { win, fire } = fakeWindow();
    const store = createInstallPromptStore(win);
    const { event, prompt } = fakeInstallEvent("accepted");
    fire("beforeinstallprompt", event);

    await expect(store.prompt()).resolves.toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ status: "installed", lastOutcome: "accepted" });
    // The event is spent: a second prompt has nothing to show.
    await expect(store.prompt()).resolves.toBe("unavailable");
    store.dispose();
  });

  it("a dismissed prompt is recorded and clears the pending event", async () => {
    const { win, fire } = fakeWindow();
    const store = createInstallPromptStore(win);
    const { event } = fakeInstallEvent("dismissed");
    fire("beforeinstallprompt", event);

    await expect(store.prompt()).resolves.toBe("dismissed");
    expect(store.getState()).toEqual({ status: "unavailable", lastOutcome: "dismissed" });
    store.dispose();
  });

  it("prompt() without a pending event resolves unavailable and changes nothing", async () => {
    const store = createInstallPromptStore(fakeWindow().win);
    await expect(store.prompt()).resolves.toBe("unavailable");
    expect(store.getState()).toEqual({ status: "unavailable", lastOutcome: null });
    store.dispose();
  });

  it("a prompt that throws resolves unavailable", async () => {
    const { win, fire } = fakeWindow();
    const store = createInstallPromptStore(win);
    fire("beforeinstallprompt", fakeInstallEvent("throw").event);
    await expect(store.prompt()).resolves.toBe("unavailable");
    expect(store.getState().status).toBe("unavailable");
    store.dispose();
  });

  it("appinstalled flips the state to installed and drops a pending prompt", async () => {
    const { win, fire } = fakeWindow();
    const store = createInstallPromptStore(win);
    fire("beforeinstallprompt", fakeInstallEvent().event);
    expect(store.getState().status).toBe("available");

    fire("appinstalled", new Event("appinstalled"));

    expect(store.getState().status).toBe("installed");
    await expect(store.prompt()).resolves.toBe("unavailable");
    store.dispose();
  });

  it("subscribe() calls the listener at once and stops after unsubscribe", () => {
    const { win, fire } = fakeWindow();
    const store = createInstallPromptStore(win);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    fire("beforeinstallprompt", fakeInstallEvent().event);
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("dispose() removes the window listeners", () => {
    const { win, count } = fakeWindow();
    const store = createInstallPromptStore(win);
    expect(count("beforeinstallprompt")).toBe(1);
    expect(count("appinstalled")).toBe(1);
    store.dispose();
    expect(count("beforeinstallprompt")).toBe(0);
    expect(count("appinstalled")).toBe(0);
  });

  it("works without a window (server or tests): unavailable, no listeners", async () => {
    const store = createInstallPromptStore(undefined);
    expect(store.getState().status).toBe("unavailable");
    await expect(store.prompt()).resolves.toBe("unavailable");
    store.dispose();
  });
});

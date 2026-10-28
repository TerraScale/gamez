/** App shell: lazy mode views (code split, wave-B.md §8.2). */
import { describe, expect, it } from "vite-plus/test";
import type { ClientModeView, ClientServices } from "@gamez/ui-host";
import { CLIENT_MODE_VIEWS, findModeView, lazyView } from "../../src/client/modes/index.ts";

const HOST = {} as HTMLElement;
const SERVICES = {} as ClientServices;

describe("lazyView", () => {
  it("mounts the loaded view with the same host and services", async () => {
    const cleanup = () => {};
    const calls: unknown[][] = [];
    const real: ClientModeView = {
      modeId: "fake",
      mount(host, services) {
        calls.push([host, services]);
        return cleanup;
      },
    };
    const view = lazyView("fake", async () => real);
    const done = await view.mount(HOST, SERVICES);
    expect(done).toBe(cleanup);
    expect(calls).toEqual([[HOST, SERVICES]]);
  });

  it("loads once and reuses the loaded view", async () => {
    let loads = 0;
    const real: ClientModeView = { modeId: "fake", mount: () => () => {} };
    const view = lazyView("fake", async () => {
      loads++;
      return real;
    });
    await view.mount(HOST, SERVICES);
    await view.mount(HOST, SERVICES);
    expect(loads).toBe(1);
  });

  it("retries a failed load on the next mount", async () => {
    let attempts = 0;
    const real: ClientModeView = { modeId: "fake", mount: () => () => {} };
    const view = lazyView("fake", async () => {
      attempts++;
      if (attempts === 1) throw new Error("chunk failed");
      return real;
    });
    await expect(view.mount(HOST, SERVICES)).rejects.toThrow("chunk failed");
    await expect(view.mount(HOST, SERVICES)).resolves.toBeTypeOf("function");
    expect(attempts).toBe(2);
  });

  it("keeps the id and the exit-control flag without loading", () => {
    let loads = 0;
    const view = lazyView(
      "x",
      async () => {
        loads++;
        return { modeId: "x", mount: () => () => {} };
      },
      true,
    );
    expect(view.modeId).toBe("x");
    expect(view.ownsExitControl).toBe(true);
    expect(loads).toBe(0);
  });
});

describe("mode registry", () => {
  it("lists every client view by mode id, all lazy", () => {
    const ids = CLIENT_MODE_VIEWS.map((v) => v.modeId).sort();
    expect(ids).toEqual(["classic", "duel", "plaza", "steps"]);
    expect(findModeView("classic")?.ownsExitControl).toBe(true);
    expect(findModeView("duel")?.ownsExitControl).toBeFalsy();
    expect(findModeView("nope")).toBeUndefined();
  });
});

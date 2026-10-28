import { describe, expect, it } from "vite-plus/test";
import {
  applyRegistration,
  decideRegistration,
  type CacheStorageLike,
  type ServiceWorkerLike,
} from "../../src/client/pwa/index.ts";

const PROD_HOST = { prod: true, hostname: "gamez.example", search: "" };

describe("decideRegistration (wave-C.md §11)", () => {
  it("registers a production build on a real host", () => {
    expect(decideRegistration(PROD_HOST)).toEqual({
      action: "register",
      reason: "production-host",
    });
  });

  it("never registers on the Vite dev server, not even with ?sw=1 (HMR)", () => {
    expect(decideRegistration({ prod: false, hostname: "gamez.ts.net", search: "" })).toEqual({
      action: "skip",
      reason: "dev-server",
    });
    expect(decideRegistration({ prod: false, hostname: "localhost", search: "?sw=1" })).toEqual({
      action: "skip",
      reason: "dev-server",
    });
  });

  it("skips production builds on localhost and 127.0.0.1 unless ?sw=1 asks for it", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(decideRegistration({ prod: true, hostname, search: "" })).toEqual({
        action: "skip",
        reason: "local-host",
      });
      expect(decideRegistration({ prod: true, hostname, search: "?sw=1" })).toEqual({
        action: "register",
        reason: "sw-param",
      });
    }
  });

  it("?nosw=1 unregisters on every host and wins over ?sw=1", () => {
    expect(
      decideRegistration({ prod: true, hostname: "gamez.example", search: "?nosw=1" }),
    ).toEqual({ action: "unregister", reason: "nosw" });
    expect(
      decideRegistration({ prod: true, hostname: "localhost", search: "?sw=1&nosw=1" }),
    ).toEqual({ action: "unregister", reason: "nosw" });
    expect(decideRegistration({ prod: false, hostname: "localhost", search: "?nosw=1" })).toEqual({
      action: "unregister",
      reason: "nosw",
    });
  });

  it("only the exact values 1 count", () => {
    expect(decideRegistration({ prod: true, hostname: "localhost", search: "?sw=0" }).action).toBe(
      "skip",
    );
    expect(
      decideRegistration({ prod: true, hostname: "localhost", search: "?sw=true" }).action,
    ).toBe("skip");
    expect(
      decideRegistration({ prod: true, hostname: "localhost", search: "?x=1&sw=1" }).action,
    ).toBe("register");
  });
});

/** A fake ServiceWorkerContainer that records calls. */
function fakeSw(options: { failRegister?: string; registrations?: number } = {}) {
  const calls: { url: string; scope: string | undefined }[] = [];
  const unregistered: number[] = [];
  const count = options.registrations ?? 0;
  const sw: ServiceWorkerLike = {
    async register(url, opts) {
      calls.push({ url, scope: opts?.scope });
      if (options.failRegister) throw new Error(options.failRegister);
      return {};
    },
    async getRegistrations() {
      return Array.from({ length: count }, (_, i) => ({
        async unregister() {
          unregistered.push(i);
          return true;
        },
      }));
    },
  };
  return { sw, calls, unregistered };
}

/** A fake CacheStorage with the given cache names. */
function fakeCaches(names: string[]) {
  const deleted: string[] = [];
  const caches: CacheStorageLike = {
    async keys() {
      return names.filter((n) => !deleted.includes(n));
    },
    async delete(key) {
      deleted.push(key);
      return true;
    },
  };
  return { caches, deleted };
}

describe("applyRegistration", () => {
  it("registers /sw.js with scope / in production", async () => {
    const { sw, calls } = fakeSw();
    const outcome = await applyRegistration({ ...PROD_HOST, serviceWorker: sw });
    expect(calls).toEqual([{ url: "/sw.js", scope: "/" }]);
    expect(outcome).toEqual({ action: "register", reason: "production-host", ok: true });
  });

  it("makes no registration call on the dev server", async () => {
    const { sw, calls } = fakeSw();
    const outcome = await applyRegistration({
      prod: false,
      hostname: "gamez.ts.net",
      search: "?sw=1",
      serviceWorker: sw,
    });
    expect(calls).toHaveLength(0);
    expect(outcome.action).toBe("skip");
    expect(outcome.ok).toBe(true);
  });

  it("skips quietly when the browser has no service worker support", async () => {
    const outcome = await applyRegistration({ ...PROD_HOST });
    expect(outcome).toEqual({ action: "skip", reason: "unsupported", ok: true });
  });

  it("reports a refused registration without throwing", async () => {
    const { sw } = fakeSw({ failRegister: "SecurityError: insecure origin" });
    const outcome = await applyRegistration({ ...PROD_HOST, serviceWorker: sw });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("SecurityError: insecure origin");
  });

  it("?nosw=1 unregisters every worker and deletes only gamez-* caches", async () => {
    const { sw } = fakeSw({ registrations: 2 });
    const { caches, deleted } = fakeCaches(["gamez-shell-v1", "gamez-shell-v0", "other-app"]);
    const outcome = await applyRegistration({
      prod: true,
      hostname: "localhost",
      search: "?nosw=1",
      serviceWorker: sw,
      caches,
    });
    expect(outcome).toMatchObject({ action: "unregister", ok: true, unregistered: 2 });
    expect(deleted).toEqual(["gamez-shell-v1", "gamez-shell-v0"]);
  });

  it("?nosw=1 without a service worker still clears the caches", async () => {
    const { caches, deleted } = fakeCaches(["gamez-shell-v1"]);
    const outcome = await applyRegistration({
      prod: false,
      hostname: "localhost",
      search: "nosw=1",
      caches,
    });
    expect(outcome).toMatchObject({ action: "unregister", ok: true, unregistered: 0 });
    expect(deleted).toEqual(["gamez-shell-v1"]);
  });
});

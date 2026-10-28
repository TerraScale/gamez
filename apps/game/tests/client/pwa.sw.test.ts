import { readFileSync } from "node:fs";
import { createContext, runInContext, type Context } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TIMEOUT_MS,
  routeOf,
  SHELL_CACHE,
  SHELL_URLS,
  type RouteKind,
} from "../../src/client/pwa/routing.ts";

/**
 * public/sw.js is evaluated in a vm sandbox with fake self, caches, fetch and timers. Its
 * top-level functions (routeOf, assetRefsIn) become properties of the sandbox, so the routing
 * table can be checked against src/client/pwa/routing.ts.
 */
const SW_SOURCE = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://gamez.test";

type AnyFn = (...args: unknown[]) => unknown;

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

function keyOf(req: string | FakeRequest): string {
  const url = typeof req === "string" ? req : req.url;
  return new URL(url, ORIGIN).pathname;
}

class FakeCache {
  readonly entries = new Map<string, Response>();
  /** Every argument given to match(), so a test can check how the worker looks things up. */
  readonly lookups: (string | FakeRequest)[] = [];
  async put(req: string | FakeRequest, res: Response): Promise<void> {
    this.entries.set(keyOf(req), res);
  }
  async match(req: string | FakeRequest): Promise<Response | undefined> {
    this.lookups.push(req);
    const hit = this.entries.get(keyOf(req));
    return hit ? hit.clone() : undefined;
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return cache;
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

/** A response with a settable `type` (Node always reports "default"; browsers report "basic"). */
function response(body: string, status = 200, type = "basic"): Response {
  const res = new Response(body, { status });
  Object.defineProperty(res, "type", { value: type });
  return res;
}

interface Harness {
  sandbox: Context;
  cache: FakeCacheStorage;
  fetchLog: string[];
  /** Replace to control network answers per URL. */
  network: { handler: (url: string) => Promise<Response> };
  timers: { id: number; fn: () => void; ms: number; cleared: boolean }[];
  claims: number;
  skips: number;
  /** Dispatches a fetch event; resolves with the respondWith() promise, or undefined. */
  fetchEvent(request: FakeRequest): Promise<Response | undefined>;
  install(): Promise<void>;
  activate(): Promise<void>;
  message(data: unknown): void;
}

function loadSw(): Harness {
  const cache = new FakeCacheStorage();
  const fetchLog: string[] = [];
  const timers: Harness["timers"] = [];
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const network: Harness["network"] = {
    handler: async () => {
      throw new Error("network down");
    },
  };
  const harness: Harness = {
    sandbox: {},
    cache,
    fetchLog,
    network,
    timers,
    claims: 0,
    skips: 0,
    fetchEvent: async () => undefined,
    install: async () => {},
    activate: async () => {},
    message: () => {},
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, fn: (event: unknown) => void) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
    },
    clients: {
      claim: async () => {
        harness.claims++;
      },
    },
    skipWaiting: () => {
      harness.skips++;
    },
  };
  const fetchFn = async (input: string | FakeRequest) => {
    const url = typeof input === "string" ? input : input.url;
    fetchLog.push(url);
    return network.handler(new URL(url, ORIGIN).pathname);
  };
  const sandbox: Context = {
    self,
    caches: cache,
    fetch: fetchFn,
    Response,
    URL,
    console,
    setTimeout: (fn: () => void, ms: number) => {
      const id = timers.length + 1;
      timers.push({ id, fn, ms, cleared: false });
      return id;
    },
    clearTimeout: (id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
  };
  createContext(sandbox);
  runInContext(SW_SOURCE, sandbox);
  harness.sandbox = sandbox;

  const fire = (type: string, event: unknown): void => {
    for (const fn of handlers.get(type) ?? []) fn(event);
  };
  harness.fetchEvent = async (request) => {
    let captured: Promise<Response> | undefined;
    fire("fetch", {
      request,
      respondWith(p: Promise<Response>) {
        captured = p;
      },
    });
    return captured ? await captured : undefined;
  };
  harness.install = async () => {
    const pending: Promise<unknown>[] = [];
    fire("install", { waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  };
  harness.activate = async () => {
    const pending: Promise<unknown>[] = [];
    fire("activate", { waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  };
  harness.message = (data) => fire("message", { data });
  return harness;
}

const call = (h: Harness, name: string, ...args: unknown[]): unknown =>
  (h.sandbox[name] as AnyFn)(...args);

const SHELL_HTML =
  '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-1.css">' +
  '</head><body><script type="module" src="/assets/index-1.js"></script></body></html>';

/**
 * A small chunk graph like Vite's output: index-1.js imports chunk-2.js dynamically, chunk-2.js
 * imports chunk-3.js statically, and the stylesheet refers to a font. install must reach all of it.
 */
const GRAPH: Record<string, [string, string]> = {
  "/assets/index-1.js": ["application/javascript", 'console.log(1);import("./chunk-2.js");'],
  "/assets/chunk-2.js": ["application/javascript", 'import{a}from"./chunk-3.js";export{a};'],
  "/assets/chunk-3.js": ["application/javascript", "export const a=1;"],
  "/assets/index-1.css": ["text/css", "@font-face{src:url(./font-4.woff2)}body{}"],
  "/assets/font-4.woff2": ["font/woff2", "font"],
};

/** Fake network: the shell, the hashed assets and every icon answer 200 unless overridden. */
function answerShell(h: Harness, overrides: Record<string, () => Promise<Response>> = {}): void {
  h.network.handler = async (path) => {
    if (overrides[path]) return overrides[path]();
    if (path === "/index.html" || path === "/") return response(SHELL_HTML);
    const asset = GRAPH[path];
    if (asset) return typed(asset[1], asset[0]);
    return response(`asset:${path}`);
  };
}

/** A response with an explicit content type (the precache reads it to find references). */
function typed(body: string, contentType: string): Response {
  const res = response(body);
  res.headers.set("content-type", contentType);
  return res;
}

describe("routing: public/sw.js agrees with src/client/pwa/routing.ts", () => {
  it("the table of URLs gives the documented routes", () => {
    const table: [string, string, string | undefined, RouteKind][] = [
      ["GET", "/", "navigate", "navigate"],
      ["GET", "/index.html", "navigate", "navigate"],
      ["GET", "/some/deep/path", "navigate", "navigate"],
      ["POST", "/", "navigate", "bypass"],
      ["GET", "/api/health", undefined, "bypass"],
      ["GET", "/api/config", "navigate", "bypass"],
      ["GET", "/api", undefined, "bypass"],
      ["GET", "/apiary", undefined, "network"],
      ["GET", "/ws", undefined, "bypass"],
      ["GET", "/ws/instance", undefined, "bypass"],
      ["GET", "/assets/index-abc123.js", "script", "cache-first"],
      ["GET", "/assets/index-abc123.css", "style", "cache-first"],
      ["GET", "/art/kenney/atlas-0.png", "no-cors", "cache-first"],
      ["GET", "/assetsx/a.js", "script", "network"],
      ["GET", "/icons/icon-192.png", "no-cors", "network"],
      ["GET", "/manifest.webmanifest", "same-origin", "network"],
      ["GET", "/sw.js", "same-origin", "network"],
      ["HEAD", "/assets/index-abc123.js", "script", "bypass"],
      ["PUT", "/art/x.png", "no-cors", "bypass"],
    ];
    const h = loadSw();
    for (const [method, path, mode, expected] of table) {
      expect(routeOf(method, path, mode), `${method} ${path} ${mode}`).toBe(expected);
      expect(call(h, "routeOf", method, path, mode), `sw.js ${method} ${path} ${mode}`).toBe(
        expected,
      );
    }
  });

  it("agrees on every combination of method, path and mode", () => {
    const h = loadSw();
    const methods = ["GET", "POST", "HEAD", "PUT", "DELETE"];
    const paths = [
      "/",
      "/index.html",
      "/assets/a.js",
      "/art/a.png",
      "/api",
      "/api/x",
      "/apiary",
      "/ws",
      "/ws/x",
      "/wsx",
      "/icons/a.png",
      "/sw.js",
      "/assetsx/a.js",
    ];
    const modes: (string | undefined)[] = [undefined, "navigate", "cors", "no-cors", "same-origin"];
    for (const m of methods) {
      for (const p of paths) {
        for (const mode of modes) {
          expect(call(h, "routeOf", m, p, mode), `${m} ${p} ${mode}`).toBe(routeOf(m, p, mode));
        }
      }
    }
  });

  it("declares the same cache name, timeout and precache list", () => {
    const h = loadSw();
    expect(evalConst(h, "CACHE")).toBe(SHELL_CACHE);
    expect(evalConst(h, "NAVIGATION_TIMEOUT_MS")).toBe(NAVIGATION_TIMEOUT_MS);
    expect([...(evalConst(h, "SHELL_URLS") as string[])]).toEqual([...SHELL_URLS]);
  });
});

/** Reads a top-level const of sw.js (lexical, so not a sandbox property). */
function evalConst(h: Harness, name: string): unknown {
  return runInContext(name, h.sandbox);
}

describe("service worker lifecycle", () => {
  it("install precaches the shell, the assets it references and the icons", async () => {
    const h = loadSw();
    answerShell(h, { "/icons/icon-512.png": async () => response("nope", 404) });

    await h.install();

    const keys = [...(h.cache.stores.get(SHELL_CACHE)?.entries.keys() ?? [])].sort();
    expect(keys).toContain("/index.html");
    expect(keys).toContain("/");
    expect(keys).toContain("/assets/index-1.js");
    expect(keys).toContain("/assets/index-1.css");
    expect(keys).toContain("/manifest.webmanifest");
    expect(keys).toContain("/icons/icon-192.png");
    // A 404 icon is skipped, not stored and not fatal.
    expect(keys).not.toContain("/icons/icon-512.png");
  });

  it("install precaches the whole asset graph, not only what index.html names", async () => {
    const h = loadSw();
    answerShell(h);

    await h.install();

    const keys = [...(h.cache.stores.get(SHELL_CACHE)?.entries.keys() ?? [])];
    // Reached through a dynamic import, a static import of that chunk, and a CSS url().
    expect(keys).toContain("/assets/chunk-2.js");
    expect(keys).toContain("/assets/chunk-3.js");
    expect(keys).toContain("/assets/font-4.woff2");
  });

  it("install fails when a referenced asset is missing, so the app never ships half-cached", async () => {
    const h = loadSw();
    answerShell(h, { "/assets/chunk-3.js": async () => response("gone", 404) });
    await expect(h.install()).rejects.toThrow("/assets/chunk-3.js returned 404");
  });

  it("install fails when /index.html cannot be fetched, so the browser retries later", async () => {
    const h = loadSw();
    h.network.handler = async () => response("down", 500);
    await expect(h.install()).rejects.toThrow("/index.html returned 500");
  });

  it("activate deletes old gamez-* caches only and claims the clients", async () => {
    const h = loadSw();
    await h.cache.open("gamez-shell-v0");
    await h.cache.open(SHELL_CACHE);
    await h.cache.open("other-app");

    await h.activate();

    expect(await h.cache.keys()).toEqual([SHELL_CACHE, "other-app"]);
    expect(h.claims).toBe(1);
  });

  it("SKIP_WAITING is honoured only when the page asks for it", () => {
    const h = loadSw();
    h.message({ type: "something-else" });
    expect(h.skips).toBe(0);
    h.message({ type: "SKIP_WAITING" });
    expect(h.skips).toBe(1);
  });
});

describe("fetch handling", () => {
  it("cache-first: a hashed asset is fetched once, then served from the cache", async () => {
    const h = loadSw();
    answerShell(h);
    const request = {
      url: `${ORIGIN}/assets/index-1.js`,
      method: "GET",
      mode: "no-cors",
    };

    const first = await h.fetchEvent(request);
    const second = await h.fetchEvent(request);

    const body = 'console.log(1);import("./chunk-2.js");';
    expect(await first?.text()).toBe(body);
    expect(await second?.text()).toBe(body);
    expect(h.fetchLog.filter((u) => u.endsWith("/assets/index-1.js"))).toHaveLength(1);
  });

  it("cache-first looks up by URL, so a request with an Origin header still hits (Vary: Origin)", async () => {
    const h = loadSw();
    answerShell(h);
    await h.install();
    const cache = h.cache.stores.get(SHELL_CACHE)!;
    cache.lookups.length = 0;
    // A module script request in the browser: cors mode, with an Origin header.
    const request = {
      url: `${ORIGIN}/assets/index-1.js`,
      method: "GET",
      mode: "cors",
      headers: { origin: ORIGIN },
    };
    const res = await h.fetchEvent(request);
    expect(await res?.text()).toContain("console.log(1)");
    expect(cache.lookups).toEqual([`${ORIGIN}/assets/index-1.js`]);
    expect(h.fetchLog.filter((u) => u.endsWith("/assets/index-1.js"))).toHaveLength(1);
  });

  it("cache-first does not store error responses", async () => {
    const h = loadSw();
    h.network.handler = async () => response("missing", 404);
    const res = await h.fetchEvent({
      url: `${ORIGIN}/art/gone.png`,
      method: "GET",
      mode: "no-cors",
    });
    expect(res?.status).toBe(404);
    expect(h.cache.stores.get(SHELL_CACHE)?.entries.size ?? 0).toBe(0);
  });

  it("navigation: a successful network answer is served and becomes the cached shell", async () => {
    const h = loadSw();
    h.network.handler = async () => response("<html>fresh</html>");

    const res = await h.fetchEvent({ url: `${ORIGIN}/`, method: "GET", mode: "navigate" });

    expect(await res?.text()).toBe("<html>fresh</html>");
    const cached = await h.cache.open(SHELL_CACHE).then((c) => c.match("/index.html"));
    expect(await cached?.text()).toBe("<html>fresh</html>");
  });

  it("navigation falls back to the cached shell when the network is down", async () => {
    const h = loadSw();
    answerShell(h);
    await h.install();
    h.network.handler = async () => {
      throw new Error("offline");
    };

    const res = await h.fetchEvent({ url: `${ORIGIN}/some/path`, method: "GET", mode: "navigate" });

    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe(SHELL_HTML);
  });

  it("navigation times out after NAVIGATION_TIMEOUT_MS and falls back to the shell", async () => {
    const h = loadSw();
    answerShell(h);
    await h.install();
    // The network never answers: only the timer can end the wait.
    h.network.handler = () => new Promise<Response>(() => {});

    const pending = h.fetchEvent({ url: `${ORIGIN}/`, method: "GET", mode: "navigate" });
    // navigate() awaits caches.open() before it starts the timer: let the microtasks run.
    await new Promise((resolve) => setImmediate(resolve));
    const timer = h.timers.find((t) => !t.cleared);
    expect(timer?.ms).toBe(NAVIGATION_TIMEOUT_MS);
    timer?.fn();

    const res = await pending;
    expect(await res?.text()).toBe(SHELL_HTML);
  });

  it("navigation with nothing cached answers a readable 503 page, not a browser error", async () => {
    const h = loadSw();
    h.network.handler = async () => {
      throw new Error("offline");
    };

    const res = await h.fetchEvent({ url: `${ORIGIN}/`, method: "GET", mode: "navigate" });

    expect(res?.status).toBe(503);
    expect(res?.headers.get("content-type")).toContain("text/html");
    expect(await res?.text()).toContain("gamez is offline");
  });

  it("never intercepts api, websocket, non-GET, cross-origin or plain network requests", async () => {
    const h = loadSw();
    const passthrough: FakeRequest[] = [
      { url: `${ORIGIN}/api/config`, method: "GET", mode: "cors" },
      { url: `${ORIGIN}/api/me`, method: "POST", mode: "cors" },
      { url: `${ORIGIN}/ws/instance`, method: "GET", mode: "websocket" },
      { url: `${ORIGIN}/`, method: "POST", mode: "navigate" },
      { url: `${ORIGIN}/assets/x.js`, method: "HEAD", mode: "no-cors" },
      { url: `https://other.test/assets/x.js`, method: "GET", mode: "no-cors" },
      { url: `${ORIGIN}/icons/icon-192.png`, method: "GET", mode: "no-cors" },
    ];
    for (const request of passthrough) {
      expect(await h.fetchEvent(request), request.url).toBeUndefined();
    }
    expect(h.fetchLog).toHaveLength(0);
  });
});

describe("asset discovery for the precache", () => {
  it("finds /assets/ references in HTML attributes and nothing else", () => {
    const h = loadSw();
    const html = [
      '<script type="module" src="/assets/index-1.js"></script>',
      '<link rel="stylesheet" href="/assets/index-1.css">',
      '<link rel="modulepreload" href="/assets/chunk-2.js">',
      '<script src="https://cdn.example/assets/x.js"></script>',
      '<link href="/manifest.webmanifest">',
      '<script src="/assets/index-1.js"></script>',
    ].join("\n");
    expect([...(call(h, "assetRefsIn", html, `${ORIGIN}/index.html`) as string[])]).toEqual([
      "/assets/index-1.js",
      "/assets/index-1.css",
      "/assets/chunk-2.js",
    ]);
  });

  it("follows Vite's __vite__mapDeps entries, which are bare assets/... paths from the site root", () => {
    const h = loadSw();
    const js =
      'const __vite__fileDeps=["assets/chunk-3.js","assets/index-1.css","assets/font-4.woff2"];';
    expect([...(call(h, "assetRefsIn", js, `${ORIGIN}/assets/chunk-2.js`) as string[])]).toEqual([
      "/assets/chunk-3.js",
      "/assets/index-1.css",
      "/assets/font-4.woff2",
    ]);
  });

  it("ignores path-like strings in minified code that do not parse (no throw, no install failure)", () => {
    const h = loadSw();
    // A regex literal inside a string, as found in the built bundle.
    const minified = String.raw`x("/\/\*[\s\S]*?\*\//g");y("/assets/ok.js");z("//[bad host");`;
    expect([...(call(h, "assetRefsIn", minified, `${ORIGIN}/assets/a.js`) as string[])]).toEqual([
      "/assets/ok.js",
    ]);
  });

  it("follows the import forms Vite emits in JS and CSS, resolved against the file", () => {
    const h = loadSw();
    const js = 'import{a}from"./chunk-3.js";const b=import("./chunk-4.js");x("/assets/z.css");';
    expect([...(call(h, "assetRefsIn", js, `${ORIGIN}/assets/chunk-2.js`) as string[])]).toEqual([
      "/assets/chunk-3.js",
      "/assets/chunk-4.js",
      "/assets/z.css",
    ]);
    const css = "@font-face{src:url(./font-4.woff2)}.x{background:url('/art/k.png')}";
    expect([...(call(h, "assetRefsIn", css, `${ORIGIN}/assets/index-1.css`) as string[])]).toEqual([
      "/assets/font-4.woff2",
    ]);
  });
});

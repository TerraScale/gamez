/**
 * A small Chrome DevTools Protocol driver for browser QA. Runs with plain
 * `node` (Node 24 strips the types) and has no npm dependencies: it spawns
 * chrome-headless-shell, talks CDP over Node's global WebSocket and drives one
 * page through real input events (mouse, touch, keyboard).
 *
 *   const page = await launch({ width: 1366, height: 768 });
 *   await page.open("http://127.0.0.1:5173/?debug=1");
 *   await page.clickText("Classic");
 *   await page.waitFor("window.__gamez?.sim?.hero != null", 30_000);
 *   await page.screenshot("/tmp/gamez-qa/town.png");
 *   console.log(page.consoleErrors());
 *   await page.close();
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The headless shell Playwright installed (no downloads). Override with GAMEZ_QA_CHROME. */
export const DEFAULT_CHROME =
  process.env.GAMEZ_QA_CHROME ??
  join(
    homedir(),
    ".cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell",
  );

export interface Viewport {
  width: number;
  height: number;
  /** Mobile emulation (meta viewport, overlay scrollbars). */
  mobile?: boolean;
  /** Touch emulation (navigator.maxTouchPoints > 0, touch events). */
  touch?: boolean;
  /** Device pixel ratio (default 1). */
  dpr?: number;
}

export const VIEWPORTS = {
  desktop: { width: 1366, height: 768, dpr: 1 },
  phone: { width: 390, height: 844, mobile: true, touch: true, dpr: 2 },
} as const satisfies Record<string, Viewport>;

export type ViewportName = keyof typeof VIEWPORTS;

export interface ConsoleEntry {
  level: "error" | "warning" | "info" | "log" | "debug";
  /** console | exception | log (browser log: network errors, violations) | crash */
  source: string;
  text: string;
  url?: string;
  /** ms since launch. */
  at: number;
}

export interface LaunchOptions {
  chrome?: string;
  /** Extra Chrome flags. */
  args?: string[];
  /** Print CDP traffic summaries to stderr. */
  verbose?: boolean;
  /** Time allowed for Chrome to start (ms). */
  startTimeoutMs?: number;
}

type CdpParams = Record<string, unknown>;
type Listener = (method: string, params: CdpParams, sessionId: string | undefined) => void;

/** Longest a single CDP command may take before it rejects (GAMEZ_QA_CDP_TIMEOUT_MS overrides). */
const CDP_TIMEOUT_MS = Number(process.env.GAMEZ_QA_CDP_TIMEOUT_MS) || 90_000;

interface Pending {
  resolve: (v: CdpParams) => void;
  reject: (e: Error) => void;
  method: string;
}

/** One CDP WebSocket (browser endpoint, flattened page sessions). */
class Cdp {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<Listener>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`CDP closed during ${p.method}`));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`CDP connect failed: ${url}`)), {
        once: true,
      });
    });
  }

  /**
   * Sends one command. A command with no answer within `CDP_TIMEOUT_MS` (default
   * 90 s) rejects, so a hung page (a stalled screenshot on a loaded machine)
   * fails its step instead of blocking the whole scenario.
   */
  send(method: string, params: CdpParams = {}, sessionId?: string): Promise<CdpParams> {
    if (this.closed) return Promise.reject(new Error(`CDP closed (${method})`));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`CDP timeout after ${CDP_TIMEOUT_MS} ms: ${method}`));
        }
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        method,
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close(): void {
    if (!this.closed) this.ws.close();
  }

  private onMessage(text: string): void {
    const msg = JSON.parse(text) as {
      id?: number;
      result?: CdpParams;
      error?: { message: string; data?: string };
      method?: string;
      params?: CdpParams;
      sessionId?: string;
    };
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const extra = msg.error.data ? ` (${msg.error.data})` : "";
        p.reject(new Error(`${p.method}: ${msg.error.message}${extra}`));
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) {
      for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Key definitions for press(): key, code, Windows virtual key code, text. */
const SPECIAL_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Escape: { code: "Escape", keyCode: 27 },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  " ": { code: "Space", keyCode: 32, text: " " },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  "+": { code: "Equal", keyCode: 187, text: "+" },
  "=": { code: "Equal", keyCode: 187, text: "=" },
  "-": { code: "Minus", keyCode: 189, text: "-" },
};

function keyDef(key: string): { key: string; code: string; keyCode: number; text?: string } {
  const special = SPECIAL_KEYS[key];
  if (special) return { key: key === "Space" ? " " : key, ...special };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (/[a-z]/i.test(key))
      return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
    if (/[0-9]/.test(key))
      return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
    return { key, code: "", keyCode: key.charCodeAt(0), text: key };
  }
  if (/^F([1-9]|1[0-2])$/.test(key)) {
    return { key, code: key, keyCode: 111 + Number(key.slice(1)) };
  }
  throw new Error(`press(): unknown key "${key}"`);
}

/** Serialises a function and JSON arguments into an expression for Runtime.evaluate. */
function callExpression(fn: string | ((...args: never[]) => unknown), args: unknown[]): string {
  if (typeof fn === "string") return fn;
  return `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
}

export interface ClickTarget {
  x: number;
  y: number;
  tag: string;
  text: string;
}

/** Finds the smallest visible element whose text (or aria-label/title) matches. Runs in the page. */
function findTextTarget(text: string, exact: boolean): ClickTarget | null {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(text);
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };
  const labelOf = (el: Element): string[] => {
    const out: string[] = [];
    const h = el as HTMLElement;
    if (h.innerText !== undefined) out.push(norm(h.innerText));
    const aria = el.getAttribute("aria-label");
    if (aria) out.push(norm(aria));
    const title = el.getAttribute("title");
    if (title) out.push(norm(title));
    return out;
  };
  let best: Element | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const pass of exact ? [true] : [true, false]) {
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const labels = labelOf(el);
      const hit = pass ? labels.includes(want) : labels.some((l) => l.includes(want));
      if (!hit || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      const clickable = el.closest("button,a,[role=button],input,select,label,summary") !== null;
      const score = r.width * r.height * (clickable ? 1 : 4);
      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (best) break;
  }
  if (!best) return null;
  best.scrollIntoView({ block: "center", inline: "center" });
  const r = best.getBoundingClientRect();
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    tag: best.tagName.toLowerCase(),
    text: ((best as HTMLElement).innerText ?? "").slice(0, 80),
  };
}

export class Page {
  readonly viewport: Viewport;
  private readonly cdp: Cdp;
  private readonly session: string;
  private readonly proc: ChildProcess;
  private readonly profile: string;
  private readonly started = performance.now();
  private readonly log: ConsoleEntry[] = [];
  private readonly verbose: boolean;
  private closed = false;

  constructor(
    cdp: Cdp,
    session: string,
    proc: ChildProcess,
    profile: string,
    viewport: Viewport,
    verbose: boolean,
  ) {
    this.cdp = cdp;
    this.session = session;
    this.proc = proc;
    this.profile = profile;
    this.viewport = viewport;
    this.verbose = verbose;
    cdp.on((method, params, sessionId) => {
      if (sessionId !== this.session) return;
      this.onEvent(method, params);
    });
  }

  /** Sends a raw CDP command to the page session. */
  send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    return this.cdp.send(method, params, this.session);
  }

  /** Navigates and waits for the load event (timeout 30 s). */
  async open(url: string, timeoutMs = 30_000): Promise<void> {
    const loaded = this.nextEvent("Page.loadEventFired", timeoutMs);
    const res = await this.send("Page.navigate", { url });
    if (typeof res.errorText === "string" && res.errorText) {
      throw new Error(`open(${url}): ${res.errorText}`);
    }
    await loaded;
  }

  /** Evaluates an expression (or a function with JSON args) in the page; awaits promises. */
  async evaluate<T = unknown>(
    expr: string | ((...args: never[]) => unknown),
    ...args: unknown[]
  ): Promise<T> {
    const res = (await this.send("Runtime.evaluate", {
      expression: callExpression(expr, args),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`evaluate: ${d.exception?.description ?? d.text ?? "exception"}`);
    }
    return res.result?.value as T;
  }

  /** Polls a JS predicate until it is truthy. Throws with the last error on timeout. */
  async waitFor(predicate: string, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
    const end = performance.now() + timeoutMs;
    let last = "";
    for (;;) {
      try {
        if (await this.evaluate<boolean>(`!!(${predicate})`)) return;
        last = "";
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (performance.now() > end) {
        throw new Error(
          `waitFor timed out after ${timeoutMs} ms: ${predicate}${last ? ` (${last})` : ""}`,
        );
      }
      await sleep(intervalMs);
    }
  }

  wait(ms: number): Promise<void> {
    return sleep(ms);
  }

  /** Mouse click (left by default) at CSS px. On touch viewports use tap(). */
  async click(x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
    });
  }

  /** Moves the mouse (hover). */
  async hover(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  /** Touch tap at CSS px (touchStart + touchEnd). `holdMs` > 350 makes a long press. */
  async tap(x: number, y: number, holdMs = 40): Promise<void> {
    await this.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await sleep(holdMs);
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  /**
   * Clicks (or taps, on touch viewports) the smallest visible element whose
   * text, aria-label or title equals `text` (case-insensitive), else contains
   * it. Retries until `timeoutMs`. Returns what was clicked.
   */
  async clickText(
    text: string,
    opts: { exact?: boolean; timeoutMs?: number } = {},
  ): Promise<ClickTarget> {
    const end = performance.now() + (opts.timeoutMs ?? 5_000);
    for (;;) {
      const t = await this.evaluate<ClickTarget | null>(findTextTarget, text, opts.exact ?? false);
      if (t) {
        if (this.viewport.touch) await this.tap(t.x, t.y);
        else await this.click(t.x, t.y);
        return t;
      }
      if (performance.now() > end)
        throw new Error(`clickText: no visible element with text "${text}"`);
      await sleep(150);
    }
  }

  /** True when a visible element with this text exists. */
  async hasText(text: string, exact = false): Promise<boolean> {
    return (await this.evaluate<ClickTarget | null>(findTextTarget, text, exact)) !== null;
  }

  /** Key press (keyDown + keyUp). Single characters, "Escape", "Tab", "Enter", "ArrowUp", "Space", "F1".. */
  async press(key: string): Promise<void> {
    const d = keyDef(key);
    const base = {
      key: d.key,
      code: d.code,
      windowsVirtualKeyCode: d.keyCode,
      nativeVirtualKeyCode: d.keyCode,
    };
    await this.send("Input.dispatchKeyEvent", {
      type: d.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(d.text ? { text: d.text, unmodifiedText: d.text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Types text into the focused element (IME-style insert; fires input events). */
  async type(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /** PNG screenshot of the viewport; creates the directory. Returns the path. */
  async screenshot(path: string): Promise<string> {
    const res = (await this.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(res.data, "base64"));
    return path;
  }

  /** Console errors, uncaught exceptions, browser log errors and crashes so far. */
  consoleErrors(): ConsoleEntry[] {
    return this.log.filter((e) => e.level === "error");
  }

  consoleWarnings(): ConsoleEntry[] {
    return this.log.filter((e) => e.level === "warning");
  }

  /** Every captured console/log entry. */
  consoleLog(): ConsoleEntry[] {
    return [...this.log];
  }

  clearConsole(): void {
    this.log.length = 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await Promise.race([this.cdp.send("Browser.close"), sleep(2_000)]);
    } catch {
      // Already gone.
    }
    this.cdp.close();
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    try {
      rmSync(this.profile, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }

  private nextEvent(method: string, timeoutMs: number): Promise<CdpParams> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      const off = this.cdp.on((m, params, sessionId) => {
        if (sessionId !== this.session || m !== method) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  private push(entry: Omit<ConsoleEntry, "at">): void {
    const e = { ...entry, at: Math.round(performance.now() - this.started) };
    this.log.push(e);
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
    if (this.verbose) process.stderr.write(`[page ${e.level}] ${e.text}\n`);
  }

  private onEvent(method: string, params: CdpParams): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const type = String(params.type);
        const args =
          (params.args as { value?: unknown; description?: string; type: string }[]) ?? [];
        const text = args
          .map((a) =>
            a.value !== undefined
              ? typeof a.value === "string"
                ? a.value
                : JSON.stringify(a.value)
              : (a.description ?? a.type),
          )
          .join(" ");
        const level: ConsoleEntry["level"] =
          type === "error" || type === "assert"
            ? "error"
            : type === "warning"
              ? "warning"
              : type === "debug"
                ? "debug"
                : type === "info"
                  ? "info"
                  : "log";
        const frame = (params.stackTrace as { callFrames?: { url: string; lineNumber: number }[] })
          ?.callFrames?.[0];
        this.push({
          level,
          source: "console",
          text,
          url: frame ? `${frame.url}:${frame.lineNumber + 1}` : undefined,
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails as {
          text?: string;
          url?: string;
          lineNumber?: number;
          exception?: { description?: string };
        };
        this.push({
          level: "error",
          source: "exception",
          text: d.exception?.description ?? d.text ?? "exception",
          url: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : undefined,
        });
        return;
      }
      case "Log.entryAdded": {
        const e = params.entry as { level: string; text: string; url?: string; source?: string };
        const level: ConsoleEntry["level"] =
          e.level === "error" ? "error" : e.level === "warning" ? "warning" : "info";
        this.push({ level, source: `log:${e.source ?? "other"}`, text: e.text, url: e.url });
        return;
      }
      case "Inspector.targetCrashed":
        this.push({ level: "error", source: "crash", text: "page crashed" });
        return;
    }
  }
}

/** Starts chrome-headless-shell with software GL and returns one page with the viewport applied. */
export async function launch(viewport: Viewport, opts: LaunchOptions = {}): Promise<Page> {
  const chrome = opts.chrome ?? DEFAULT_CHROME;
  const profile = mkdtempSync(join(tmpdir(), "gamez-qa-chrome-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    `--window-size=${viewport.width},${viewport.height}`,
    ...(opts.args ?? []),
    "about:blank",
  ];
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Chrome did not start in time. stderr:\n${buf.slice(-2000)}`));
    }, opts.startTimeoutMs ?? 20_000);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`cannot start ${chrome}: ${err.message}`));
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Chrome exited (${code}) before DevTools was ready. stderr:\n${buf.slice(-2000)}`,
        ),
      );
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      buf += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  // Keep draining stderr so Chrome never blocks on a full pipe.
  proc.stderr?.removeAllListeners("data");
  proc.stderr?.on("data", () => {});
  proc.removeAllListeners("exit");

  const cdp = await Cdp.connect(wsUrl);
  try {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as {
      targetInfos: { targetId: string; type: string }[];
    };
    let targetId = targetInfos.find((t) => t.type === "page")?.targetId;
    if (!targetId) {
      targetId = String(
        ((await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string })
          .targetId,
      );
    }
    const { sessionId } = (await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };
    const page = new Page(cdp, sessionId, proc, profile, viewport, opts.verbose ?? false);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    await page.send("Inspector.enable").catch(() => ({}));
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.dpr ?? 1,
      mobile: viewport.mobile ?? false,
    });
    if (viewport.touch) {
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }
    return page;
  } catch (err) {
    cdp.close();
    proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
    throw err;
  }
}

/** Polls `url` until it answers (any HTTP status below 500). The dev server may be restarting. */
export async function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (performance.now() > end) throw new Error(`server ${url} not reachable: ${last}`);
    await sleep(1_000);
  }
}

/**
 * Instance connections for the app shell: one connection per mode, reused
 * until it is closed. The mode's modules load on first use (modes.ts), so
 * connectInstance stays synchronous: the connection buffers calls until its
 * InstanceClient exists.
 */
import type { DispatchResult, LoadedMode } from "@gamez/kernel";
import type { InstanceConnection, InstanceView, Session } from "@gamez/ui-host";
import { clearSession, getSession } from "../session.ts";
import { loadedMode } from "./modes.ts";
import { InstanceClient } from "./connection.ts";

export { InstanceClient, instanceUrl, PING_MS, type InstanceClientOptions } from "./connection.ts";
export { Prediction, type PendingAction } from "./prediction.ts";

/** A connection whose mode may still be loading; every call waits for it. */
class LazyInstanceConnection implements InstanceConnection {
  readonly mode: string;
  readonly #ready: Promise<InstanceClient | null>;
  readonly #subs = new Set<(view: InstanceView) => void>();
  readonly #onClose: () => void;
  #inner: InstanceClient | null = null;
  #unsubscribe: (() => void) | null = null;
  #closed = false;
  #view: InstanceView = {
    status: "connecting",
    snapshot: null,
    world: null,
    events: [],
    error: null,
    pingMs: null,
  };

  constructor(
    mode: string,
    open: (mode: string) => Promise<InstanceClient | null>,
    onClose: () => void,
  ) {
    this.mode = mode;
    this.#onClose = onClose;
    this.#ready = open(mode).then(
      (inner) => {
        if (!inner) return this.#fail("unknown_mode", `unknown instance mode "${mode}"`);
        if (this.#closed) {
          inner.close();
          return null;
        }
        this.#inner = inner;
        this.#unsubscribe = inner.subscribe((view) => this.#forward(view));
        return inner;
      },
      (err: unknown) => {
        console.warn(`instance: loading mode "${mode}" failed`, err);
        return this.#fail("load_failed", `could not load mode "${mode}"`);
      },
    );
  }

  /** The loaded mode, once it has loaded (reading it earlier throws). */
  get loaded(): LoadedMode {
    if (!this.#inner) throw new Error(`instance mode "${this.mode}" is still loading`);
    return this.#inner.loaded;
  }

  getView(): InstanceView {
    return this.#inner ? this.#inner.getView() : this.#view;
  }

  subscribe(cb: (view: InstanceView) => void): () => void {
    this.#subs.add(cb);
    return () => this.#subs.delete(cb);
  }

  act(name: string, payload: unknown): Promise<DispatchResult> {
    return this.#ready.then((inner) =>
      inner
        ? inner.act(name, payload)
        : {
            ok: false,
            error: { code: "closed", message: "connection closed" },
            events: [],
            tick: 0,
          },
    );
  }

  restart(): void {
    void this.#ready.then((inner) => inner?.restart());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#inner?.close();
    this.#inner = null;
    this.#view = { ...this.#view, status: "offline" };
    this.#subs.clear();
    this.#onClose?.();
  }

  /** Records a failed load: the view goes offline with the error. */
  #fail(code: string, message: string): null {
    this.#view = { ...this.#view, status: "offline", error: { code, message } };
    this.#forward(this.#view);
    return null;
  }

  #forward(view: InstanceView): void {
    if (this.#closed) return;
    for (const cb of this.#subs) cb(view);
  }
}

/** Returns connectInstance(mode) for ClientServices, starting from the app's session. */
export function instanceConnector(initial: Session): (mode: string) => InstanceConnection {
  let session: Session | null = initial;
  const open = new Map<string, LazyInstanceConnection>();
  return (mode) => {
    const live = open.get(mode);
    if (live) return live;
    const conn = new LazyInstanceConnection(
      mode,
      async (id) => {
        const loaded = await loadedMode(id);
        if (!loaded) return null;
        return new InstanceClient({
          mode: id,
          loaded,
          async session() {
            session ??= await getSession();
            return session;
          },
          onUnauthorized() {
            clearSession();
            session = null;
          },
        });
      },
      () => {
        if (open.get(mode) === conn) open.delete(mode);
      },
    );
    open.set(mode, conn);
    return conn;
  };
}

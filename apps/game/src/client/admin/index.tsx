/**
 * Admin dashboard shell (docs/design/admin-dashboard.md §10.1, route "#admin").
 * OWNER: T-ui-shell. App.tsx lazy-loads this module and renders <AdminScreen>.
 *
 * Flow (kept from wave C): GET /api/admin/me first; a player sees NotAdmin
 * (with the dev self-grant on dev hosts) and Close. An admin gets the sidebar
 * of SECTIONS (sections/index.ts), the toolbar (range, bucket, auto-refresh,
 * manual refresh with fresh=1, theme, Close) and the open section, loaded
 * through its `load` with a SectionContext. Section, range, refresh and theme
 * are remembered in localStorage; the hash follows "#admin/<section>[/<arg>]".
 */
import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { PlatformServices, Session } from "@gamez/ui-host";
import { parseShellFragment } from "../app/fragments.ts";
import { adminRequest, checkAdmin, isDevHostname, makeDevAdmin, type AdminResult } from "./api.ts";
import { NotAdmin } from "./dashboard.tsx";
import { CsvRangeContext } from "./kit/table.tsx";
import {
  daysOf,
  queryOf,
  rangeOf,
  RangePicker,
  readPrefs,
  RefreshPicker,
  ThemePicker,
  writeAdminHash,
  writePrefs,
  type AdminPrefs,
} from "./kit/toolbar.tsx";
import type { SectionContext, SectionDef, SectionGroup } from "./kit/types.ts";
import { DEFAULT_SECTION, SECTIONS, sectionById } from "./sections/index.ts";
import { ADMIN_CSS } from "./styles.ts";

export interface AdminScreenProps {
  session: Session;
  platform: PlatformServices | undefined;
  onClose: () => void;
  /** Deep link "#admin/<section>": the section to open (else the remembered one). */
  initialSection?: string;
  /** Deep link "#admin/<section>/<arg>", e.g. the account id for "lookup". */
  initialArg?: string;
}

type Gate =
  | { state: "checking" }
  | { state: "admin" }
  | { state: "denied"; status: number; devHost?: boolean }
  | { state: "error"; message: string };

interface SectionView {
  sectionId: string;
  status: "loading" | "ready" | "error";
  data: unknown;
  error?: string;
  /** When the data arrived (client clock). */
  loadedAt?: number;
}

interface Nav {
  /** "Now" of the range presets; moves on every load. */
  anchor: number;
  /** Load counter (reload, refresh, auto-refresh). */
  n: number;
  /** The load bypasses the server cache (manual refresh). */
  fresh: boolean;
}

const GROUP_ORDER: readonly SectionGroup[] = ["Live", "Players", "Game", "Business", "Ops"];

/** Sections by sidebar group, in group order, each keeping the registry order. */
export function groupSections(
  sections: readonly SectionDef<unknown>[],
): { group: SectionGroup; sections: SectionDef<unknown>[] }[] {
  const groups = [...GROUP_ORDER, ...sections.map((s) => s.group)].filter(
    (g, i, all) => all.indexOf(g) === i,
  );
  return groups
    .map((group) => ({ group, sections: sections.filter((s) => s.group === group) }))
    .filter((g) => g.sections.length > 0);
}

/** The section to open: a known deep link, else the remembered one, else the default. */
export function resolveSection(initial: string | undefined, remembered: string): string {
  if (initial && sectionById(initial)) return initial;
  if (sectionById(remembered)) return remembered;
  return DEFAULT_SECTION;
}

function initialPrefs(initialSection: string | undefined): AdminPrefs {
  const prefs = readPrefs();
  return { ...prefs, section: resolveSection(initialSection, prefs.section) };
}

/** Seconds a response's own `at` lags the moment it arrived (server cache hits). */
export function cachedAge(data: unknown, loadedAt: number | undefined): number | null {
  if (!loadedAt || !data || typeof data !== "object") return null;
  const at = (data as { at?: unknown }).at;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const age = Math.round((loadedAt - at) / 1000);
  return age >= 5 ? age : null;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

class SectionBoundary extends Component<
  { children: ReactNode; label: string },
  { error: string | null }
> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  override componentDidCatch(err: unknown, info: ErrorInfo) {
    console.error(`admin section ${this.props.label} failed`, err, info.componentStack);
  }
  override render() {
    if (this.state.error !== null) {
      return (
        <section className="adm-section adm-error" role="alert">
          <h2>{this.props.label} could not be shown</h2>
          <p className="adm-mono">{this.state.error}</p>
        </section>
      );
    }
    return this.props.children;
  }
}

export function AdminScreen({ session, onClose, initialSection, initialArg }: AdminScreenProps) {
  const token = session.token;
  const [prefs, setPrefs] = useState<AdminPrefs>(() => initialPrefs(initialSection));
  const [arg, setArg] = useState<string | null>(() =>
    initialSection && sectionById(initialSection) ? (initialArg ?? null) : null,
  );
  const [gate, setGate] = useState<Gate>({ state: "checking" });
  const [gateKey, setGateKey] = useState(0);
  const [nav, setNav] = useState<Nav>(() => ({ anchor: Date.now(), n: 0, fresh: false }));
  const [view, setView] = useState<SectionView | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const lastLoadAt = useRef(0);
  const devHost = typeof location !== "undefined" && isDevHostname(location.hostname);

  const section =
    sectionById(prefs.section) ??
    sectionById(DEFAULT_SECTION) ??
    (SECTIONS[0] as SectionDef<unknown>);

  useEffect(() => writePrefs(prefs), [prefs]);

  const patchPrefs = useCallback((patch: Partial<AdminPrefs>) => {
    setPrefs((p) => ({ ...p, ...patch }));
  }, []);

  const reload = useCallback(() => {
    setNav((n) => ({ anchor: Date.now(), n: n.n + 1, fresh: false }));
  }, []);

  const refreshNow = useCallback(() => {
    setNav((n) => ({ anchor: Date.now(), n: n.n + 1, fresh: true }));
  }, []);

  const navigate = useCallback((sectionId: string, nextArg: string | null) => {
    if (!sectionById(sectionId)) return;
    // The hash first, so the section can read its argument in its first render.
    writeAdminHash(sectionId, nextArg);
    setArg(nextArg);
    setStatus("");
    setPrefs((p) => (p.section === sectionId ? p : { ...p, section: sectionId }));
  }, []);

  const openPlayer = useCallback((accountId: string) => navigate("lookup", accountId), [navigate]);

  // Keep "#admin/<section>[/<arg>]" in step with what is open (before sections' effects run).
  useIsoLayoutEffect(() => {
    writeAdminHash(section.id, arg);
  }, [section.id, arg]);

  // A hash typed or followed while the dashboard is open.
  useEffect(() => {
    const onHash = () => {
      const f = parseShellFragment(window.location.hash);
      if (f?.kind === "admin" && f.section && sectionById(f.section)) {
        navigate(f.section, f.arg ?? null);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [navigate]);

  // Admin check (wave C): GET /api/admin/me before any data request.
  useEffect(() => {
    let cancelled = false;
    setGate({ state: "checking" });
    void checkAdmin(fetch, token).then((res) => {
      if (cancelled) return;
      if (res.ok) setGate({ state: "admin" });
      else if (res.status === 401 || res.status === 403)
        setGate({ state: "denied", status: res.status, devHost: res.devHost });
      else setGate({ state: "error", message: res.message });
    });
    return () => {
      cancelled = true;
    };
  }, [token, gateKey]);

  const range = useMemo(
    () => rangeOf(prefs, nav.anchor),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only the range fields matter
    [prefs.preset, prefs.customFrom, prefs.customTo, prefs.bucket, nav.anchor],
  );

  const ctx = useMemo<SectionContext>(
    () => ({
      token,
      range,
      query: queryOf(range, nav.fresh),
      days: daysOf(range),
      get: <T,>(path: string): Promise<AdminResult<T>> =>
        adminRequest<T>(fetch, token, "GET", path),
      post: <T,>(path: string, body: unknown): Promise<AdminResult<T>> =>
        adminRequest<T>(fetch, token, "POST", path, body),
      setStatus,
      reload,
      openPlayer,
    }),
    [token, range, nav.fresh, reload, openPlayer],
  );

  // Run the open section's load: on open, range change, reload and refresh.
  const isAdmin = gate.state === "admin";
  useEffect(() => {
    if (!isAdmin) return;
    const def = section;
    if (!def.load) {
      lastLoadAt.current = Date.now();
      setView({ sectionId: def.id, status: "ready", data: null, loadedAt: Date.now() });
      return;
    }
    let cancelled = false;
    // Refetch keeps the previous render (dimmed) when it is the same section.
    setView((v) =>
      v && v.sectionId === def.id
        ? { ...v, status: "loading" }
        : { sectionId: def.id, status: "loading", data: null },
    );
    const done = (res: AdminResult<unknown>) => {
      if (cancelled) return;
      lastLoadAt.current = Date.now();
      if (res.ok) {
        setView({ sectionId: def.id, status: "ready", data: res.value, loadedAt: Date.now() });
      } else if (res.status === 401 || res.status === 403) {
        setGate({ state: "denied", status: res.status, devHost: res.devHost });
      } else {
        setView((v) => ({
          sectionId: def.id,
          status: "error",
          data: v?.sectionId === def.id ? v.data : null,
          error: res.message,
        }));
      }
    };
    def.load(ctx).then(done, (err: unknown) =>
      done({
        ok: false,
        status: 0,
        code: "client",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [isAdmin, section, ctx, nav.n]);

  // Auto-refresh, paused while the tab is hidden; catches up when it shows again.
  useEffect(() => {
    if (!isAdmin || prefs.refreshMs <= 0) return;
    const ms = prefs.refreshMs;
    const visible = () => typeof document === "undefined" || !document.hidden;
    const timer = setInterval(() => {
      if (visible()) reload();
    }, ms);
    const onVisibility = () => {
      if (visible() && Date.now() - lastLoadAt.current >= ms) reload();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isAdmin, prefs.refreshMs, reload]);

  const onRange = (patch: Partial<AdminPrefs>) => {
    patchPrefs(patch);
    reload();
  };

  const onMakeDevAdmin = async () => {
    setBusy(true);
    setStatus("");
    const res = await makeDevAdmin(fetch, token);
    setBusy(false);
    if (res.ok) setGateKey((k) => k + 1);
    else setStatus(`Could not make you admin: ${res.message}`);
  };

  return (
    <AdminLayout
      prefs={prefs}
      section={section}
      gate={gate}
      view={view}
      ctx={ctx}
      arg={arg}
      status={status}
      busy={busy}
      devHost={devHost}
      onSection={(id) => navigate(id, null)}
      onPrefs={patchPrefs}
      onRange={onRange}
      onRefresh={refreshNow}
      onRetryGate={() => setGateKey((k) => k + 1)}
      onMakeDevAdmin={onMakeDevAdmin}
      onClose={onClose}
    />
  );
}

export interface AdminLayoutProps {
  /** The sidebar's sections (default: the registry). */
  sections?: readonly SectionDef<unknown>[];
  prefs: AdminPrefs;
  section: SectionDef<unknown>;
  gate: Gate;
  view: SectionView | null;
  ctx: SectionContext;
  arg: string | null;
  status: string;
  busy: boolean;
  devHost: boolean;
  onSection: (id: string) => void;
  onPrefs: (patch: Partial<AdminPrefs>) => void;
  onRange: (patch: Partial<AdminPrefs>) => void;
  onRefresh: () => void;
  onRetryGate: () => void;
  onMakeDevAdmin: () => void;
  onClose: () => void;
}

/** The shell's markup from its state (no effects), so it renders in tests. */
export function AdminLayout(props: AdminLayoutProps) {
  const { prefs, section, gate, view, ctx, arg, status, busy, devHost } = props;
  const admin = gate.state === "admin";
  const groups = groupSections(props.sections ?? SECTIONS);
  const current = view && view.sectionId === section.id ? view : null;
  const loading = admin && section.load !== null && (!current || current.status === "loading");
  const age = current ? cachedAge(current.data, current.loadedAt) : null;
  const Body = section.Component;

  return (
    <div
      className="adm adm-shell"
      data-testid="admin-screen"
      data-theme={prefs.theme === "system" ? undefined : prefs.theme}
    >
      <style>{ADMIN_CSS}</style>
      <nav className="adm-side" aria-label="Dashboard sections">
        <p className="adm-brand">
          gamez live ops
          <small>Admin dashboard</small>
        </p>
        {admin
          ? groups.map((g) => (
              <div key={g.group}>
                <p className="adm-nav-group">{g.group}</p>
                <ul className="adm-nav">
                  {g.sections.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        aria-current={s.id === section.id ? "page" : undefined}
                        onClick={() => props.onSection(s.id)}
                      >
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          : null}
      </nav>

      <div className="adm-topbar">
        {admin ? null : <p className="adm-brand">gamez live ops</p>}
        {admin ? (
          <select
            aria-label="Section"
            value={section.id}
            onChange={(e) => props.onSection(e.currentTarget.value)}
          >
            {groups.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : null}
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>

      <main className="adm-main">
        <header className="adm-toolbar">
          {/* On phones the section select names the page, so the heading is for screen readers only. */}
          <h1 className={admin ? "adm-phone-hidden" : undefined}>
            {admin ? section.label : "Live ops"}
          </h1>
          {admin ? (
            <>
              <RangePicker prefs={prefs} onChange={props.onRange} />
              <RefreshPicker
                refreshMs={prefs.refreshMs}
                onChange={(ms) => props.onPrefs({ refreshMs: ms })}
              />
              <button
                type="button"
                onClick={props.onRefresh}
                aria-label="Refresh now (skips the server cache)"
                title="Refresh now (skips the server cache)"
              >
                <span aria-hidden="true">↻</span>
                <span className="adm-wide-only"> Refresh</span>
              </button>
            </>
          ) : null}
          <ThemePicker theme={prefs.theme} onChange={(t) => props.onPrefs({ theme: t })} />
          <span className="adm-spacer" />
          <button type="button" className="adm-wide-only" onClick={props.onClose}>
            Close
          </button>
        </header>

        {admin ? (
          <div className="adm-meta">
            {current?.loadedAt ? (
              <span>
                Updated {new Date(current.loadedAt).toLocaleTimeString()}
                {age !== null ? ` (cached ${age} s)` : ""}
              </span>
            ) : null}
            {loading ? <span>Loading…</span> : null}
            {prefs.refreshMs > 0 ? (
              <span>Auto-refresh every {Math.round(prefs.refreshMs / 1000)} s</span>
            ) : null}
            {ctx.query.includes("fresh=1") ? <span>Cache skipped</span> : null}
          </div>
        ) : null}

        <p className="adm-status" role="status" aria-live="polite">
          {status}
        </p>

        {gate.state === "checking" ? <p className="adm-muted">Loading the dashboard…</p> : null}

        {gate.state === "denied" ? (
          <NotAdmin
            status={gate.status}
            devHost={gate.devHost ?? devHost}
            busy={busy}
            onMakeDevAdmin={props.onMakeDevAdmin}
            onClose={props.onClose}
          />
        ) : null}

        {gate.state === "error" ? (
          <section className="adm-section adm-error">
            <h2>Dashboard unavailable</h2>
            <p>{gate.message}</p>
            <div className="adm-row" style={{ marginTop: 12 }}>
              <button type="button" onClick={props.onRetryGate}>
                Try again
              </button>
            </div>
          </section>
        ) : null}

        {admin ? (
          <CsvRangeContext.Provider value={ctx.range}>
            <SectionBoundary key={section.id} label={section.label}>
              {current?.status === "error" ? (
                <section className="adm-section adm-error" role="alert">
                  <h2>{section.label} could not load</h2>
                  <p>{current.error}</p>
                  <div className="adm-row" style={{ marginTop: 12 }}>
                    <button type="button" onClick={() => ctx.reload()}>
                      Try again
                    </button>
                  </div>
                </section>
              ) : null}
              {section.load === null || (current && current.data !== null) ? (
                <div className="adm-body" aria-busy={loading}>
                  <Body
                    key={`${section.id}/${arg ?? ""}`}
                    data={section.load === null ? null : (current?.data ?? null)}
                    ctx={ctx}
                  />
                </div>
              ) : loading ? (
                <p className="adm-muted">Loading {section.label.toLowerCase()}…</p>
              ) : null}
            </SectionBoundary>
          </CsvRangeContext.Provider>
        ) : null}
      </main>
    </div>
  );
}

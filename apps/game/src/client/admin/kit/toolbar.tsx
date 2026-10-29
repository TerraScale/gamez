/**
 * The admin shell's toolbar and its state model (docs/design/admin-dashboard.md §10.1).
 * OWNER: T-ui-shell. Range presets and custom dates, bucket, auto-refresh,
 * theme; the remembered preferences (localStorage, every access in
 * try/catch); the query string sections get; the "#admin/<section>/<arg>" hash.
 */
import type { RangeState } from "./types.ts";
import { DAY_MS, dayString, HOUR_MS } from "./format.ts";

export type RangePreset = "24h" | "7d" | "30d" | "90d" | "custom";
export type Theme = "system" | "light" | "dark";
export type Bucket = RangeState["bucket"];

export const RANGE_PRESETS: readonly {
  id: Exclude<RangePreset, "custom">;
  label: string;
  ms: number;
}[] = [
  { id: "24h", label: "24 h", ms: DAY_MS },
  { id: "7d", label: "7 d", ms: 7 * DAY_MS },
  { id: "30d", label: "30 d", ms: 30 * DAY_MS },
  { id: "90d", label: "90 d", ms: 90 * DAY_MS },
];

/** Auto-refresh choices in ms (0 = off). */
export const REFRESH_OPTIONS: readonly { ms: number; label: string }[] = [
  { ms: 0, label: "Off" },
  { ms: 30_000, label: "30 s" },
  { ms: 60_000, label: "60 s" },
  { ms: 300_000, label: "5 min" },
];

const THEMES: readonly Theme[] = ["system", "light", "dark"];
const BUCKETS: readonly Bucket[] = ["auto", "hour", "day"];
/** The server keeps at most 90 days (range.ts RANGE_MAX_DAYS). */
export const MAX_RANGE_DAYS = 90;

export interface AdminPrefs {
  section: string;
  preset: RangePreset;
  /** Custom range, "YYYY-MM-DD" (UTC days, both inclusive). */
  customFrom: string;
  customTo: string;
  bucket: Bucket;
  refreshMs: number;
  theme: Theme;
}

export const PREFS_KEY = "gamez.admin.prefs";

export function defaultPrefs(now: number = Date.now()): AdminPrefs {
  return {
    section: "overview",
    preset: "7d",
    customFrom: dayString(now - 6 * DAY_MS),
    customTo: dayString(now),
    bucket: "auto",
    refreshMs: 0,
    theme: "system",
  };
}

type KeyValue = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): KeyValue | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The remembered preferences, field by field (bad or missing fields take the default). */
export function readPrefs(
  storage: KeyValue | null = defaultStorage(),
  now: number = Date.now(),
): AdminPrefs {
  const prefs = defaultPrefs(now);
  if (!storage) return prefs;
  let raw: unknown;
  try {
    const text = storage.getItem(PREFS_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    return prefs;
  }
  if (!raw || typeof raw !== "object") return prefs;
  const r = raw as Record<string, unknown>;
  if (typeof r.section === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(r.section)) {
    prefs.section = r.section;
  }
  if (r.preset === "custom" || RANGE_PRESETS.some((p) => p.id === r.preset)) {
    prefs.preset = r.preset as RangePreset;
  }
  if (typeof r.customFrom === "string" && DAY_RE.test(r.customFrom))
    prefs.customFrom = r.customFrom;
  if (typeof r.customTo === "string" && DAY_RE.test(r.customTo)) prefs.customTo = r.customTo;
  if (BUCKETS.includes(r.bucket as Bucket)) prefs.bucket = r.bucket as Bucket;
  if (REFRESH_OPTIONS.some((o) => o.ms === r.refreshMs)) prefs.refreshMs = r.refreshMs as number;
  if (THEMES.includes(r.theme as Theme)) prefs.theme = r.theme as Theme;
  return prefs;
}

export function writePrefs(prefs: AdminPrefs, storage: KeyValue | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or a full quota: the dashboard just forgets.
  }
}

function dayStart(day: string): number | null {
  if (!DAY_RE.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The range a load asks for. Presets end at `anchor` (the time of the load)
 * rounded up to the minute, so loads within a minute share the server cache;
 * a custom range runs from the start of `customFrom` to the end of
 * `customTo` (UTC), swapped when reversed, at most 90 days.
 */
export function rangeOf(prefs: AdminPrefs, anchor: number): RangeState {
  if (prefs.preset === "custom") {
    let a = dayStart(prefs.customFrom) ?? anchor - 7 * DAY_MS;
    let b = dayStart(prefs.customTo) ?? anchor;
    if (a > b) [a, b] = [b, a];
    const to = b + DAY_MS;
    const from = Math.max(a, to - MAX_RANGE_DAYS * DAY_MS);
    return { from, to, bucket: prefs.bucket };
  }
  const span = RANGE_PRESETS.find((p) => p.id === prefs.preset)?.ms ?? 7 * DAY_MS;
  const to = Math.ceil(anchor / 60_000) * 60_000;
  return { from: to - span, to, bucket: prefs.bucket };
}

/** "from=…&to=…[&bucket=…][&fresh=1]" for /api/admin/* GETs (epoch ms). */
export function queryOf(range: RangeState, fresh = false): string {
  const q = new URLSearchParams({ from: String(range.from), to: String(range.to) });
  if (range.bucket !== "auto") q.set("bucket", range.bucket);
  if (fresh) q.set("fresh", "1");
  return q.toString();
}

/** Whole days in the range, clamped to 1..60 (the wave C /api/admin/economy?days=). */
export function daysOf(range: RangeState): number {
  const days = Math.ceil((range.to - range.from - HOUR_MS / 2) / DAY_MS);
  return Math.min(60, Math.max(1, days));
}

/** The location hash of a section (and its argument, e.g. a looked-up account id). */
export function adminHash(section: string, arg?: string | null): string {
  return `#admin/${section}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
}

/** Replaces the hash without a navigation or a hashchange event (errors ignored). */
export function writeAdminHash(section: string, arg?: string | null): void {
  try {
    const loc = globalThis.location;
    if (!loc) return;
    const hash = adminHash(section, arg);
    if (loc.hash === hash) return;
    globalThis.history.replaceState(globalThis.history.state, "", loc.pathname + loc.search + hash);
  } catch {
    // Sandboxed frames refuse history changes.
  }
}

/**
 * The argument of the open section from the hash ("#admin/lookup/<id>" gives
 * "<id>" for "lookup"), or null. The shell writes the hash before a section
 * mounts, so a section can read it in its first render.
 */
export function adminRouteArg(section: string, hash?: string): string | null {
  let h = hash;
  if (h === undefined) {
    try {
      h = globalThis.location?.hash ?? "";
    } catch {
      return null;
    }
  }
  const prefix = `#admin/${section}/`;
  if (!h.startsWith(prefix)) return null;
  try {
    const arg = decodeURIComponent(h.slice(prefix.length));
    return arg.length > 0 ? arg : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function RangePicker({
  prefs,
  onChange,
}: {
  prefs: AdminPrefs;
  onChange: (next: Partial<AdminPrefs>) => void;
}) {
  return (
    <div className="adm-range">
      <div className="adm-seg" role="group" aria-label="Time range">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={prefs.preset === p.id}
            onClick={() => onChange({ preset: p.id })}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={prefs.preset === "custom"}
          onClick={() => onChange({ preset: "custom" })}
        >
          Custom
        </button>
      </div>
      {prefs.preset === "custom" ? (
        <div className="adm-row adm-custom" role="group" aria-label="Custom range (UTC days)">
          <label>
            <span>From</span>
            <input
              type="date"
              value={prefs.customFrom}
              max={prefs.customTo}
              onChange={(e) => {
                if (DAY_RE.test(e.currentTarget.value))
                  onChange({ customFrom: e.currentTarget.value });
              }}
            />
          </label>
          <label>
            <span>To</span>
            <input
              type="date"
              value={prefs.customTo}
              min={prefs.customFrom}
              onChange={(e) => {
                if (DAY_RE.test(e.currentTarget.value))
                  onChange({ customTo: e.currentTarget.value });
              }}
            />
          </label>
        </div>
      ) : null}
      <select
        aria-label="Bucket"
        value={prefs.bucket}
        onChange={(e) => onChange({ bucket: e.currentTarget.value as Bucket })}
      >
        <option value="auto">Bucket: auto</option>
        <option value="hour">Bucket: hour</option>
        <option value="day">Bucket: day</option>
      </select>
    </div>
  );
}

export function RefreshPicker({
  refreshMs,
  onChange,
}: {
  refreshMs: number;
  onChange: (ms: number) => void;
}) {
  return (
    <select
      aria-label="Auto-refresh"
      value={refreshMs}
      onChange={(e) => onChange(Number(e.currentTarget.value))}
    >
      {REFRESH_OPTIONS.map((o) => (
        <option key={o.ms} value={o.ms}>
          Auto-refresh: {o.label.toLowerCase()}
        </option>
      ))}
    </select>
  );
}

export function ThemePicker({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <select
      aria-label="Theme"
      value={theme}
      onChange={(e) => onChange(e.currentTarget.value as Theme)}
    >
      <option value="system">Theme: system</option>
      <option value="light">Theme: light</option>
      <option value="dark">Theme: dark</option>
    </select>
  );
}

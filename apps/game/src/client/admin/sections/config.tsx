/**
 * Admin section "Flags & config" (docs/design/admin-dashboard.md §8, §10.3). OWNER: T-ui-sections-a.
 * Feature flags (the wave C FlagsPanel: GET /api/config, POST /api/admin/flags)
 * and numeric tunables (GET/POST /api/admin/tunables, e.g. classic.offlineXpPct).
 * Loads by itself (load null).
 */
import { useEffect, useState } from "react";
import type { ConfigResponse, FeatureFlag, TunableSpec, TunablesResponse } from "@gamez/protocol";
import { FlagsPanel } from "../dashboard.tsx";
import { defineSection, Panel, type SectionContext } from "../kit/index.tsx";

export type TunableDrafts = Record<string, string>;

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * Validates one tunable typed in a form. Empty or non-numeric input and values
 * outside [min, max] are errors (the server answers 400 for these too). Valid
 * values are snapped to the spec's step, the same rounding the server applies.
 */
export function parseTunable(spec: TunableSpec, raw: string): ParseResult {
  const text = raw.trim();
  const n = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(n)) return { ok: false, error: `${spec.label}: enter a number` };
  if (n < spec.min || n > spec.max) {
    return {
      ok: false,
      error: `${spec.label}: must be between ${spec.min} and ${spec.max}${spec.unit ? ` ${spec.unit}` : ""}`,
    };
  }
  const steps = Math.round((n - spec.min) / spec.step);
  const snapped = Math.min(spec.max, spec.min + steps * spec.step);
  return { ok: true, value: Number(snapped.toFixed(6)) };
}

/** Validates every spec's draft. Returns the values to POST or the error per key. */
export function validateTunables(
  specs: readonly TunableSpec[],
  drafts: TunableDrafts,
): { ok: true; values: Record<string, number> } | { ok: false; errors: Record<string, string> } {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const spec of specs) {
    const r = parseTunable(spec, drafts[spec.key] ?? "");
    if (r.ok) values[spec.key] = r.value;
    else errors[spec.key] = r.error;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values };
}

/** Drafts (text per key) from the stored values, falling back to each spec's default. */
export function draftsFrom(
  specs: readonly TunableSpec[],
  values: Record<string, number> | undefined,
): TunableDrafts {
  const out: TunableDrafts = {};
  for (const spec of specs) out[spec.key] = String(values?.[spec.key] ?? spec.default);
  return out;
}

/** UTC "YYYY-MM-DD HH:MM", or "–" for 0 / invalid times. */
export function formatWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "–";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function TunablesForm({
  specs,
  stored,
  audit,
  ctx,
  onSaved,
}: {
  specs: readonly TunableSpec[];
  stored: Record<string, number> | undefined;
  audit: TunablesResponse["audit"];
  ctx: SectionContext;
  onSaved: (t: TunablesResponse) => void;
}) {
  const [drafts, setDrafts] = useState<TunableDrafts>(() => draftsFrom(specs, stored));
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A fresh server answer replaces the drafts (after a save or a reload).
  useEffect(() => {
    setDrafts(draftsFrom(specs, stored));
    setAsking(false);
  }, [specs, stored]);

  const checked = validateTunables(specs, drafts);
  const errors = checked.ok ? {} : checked.errors;

  const save = async () => {
    if (!checked.ok) return;
    setSaving(true);
    setSaveError(null);
    const r = await ctx.post<TunablesResponse>("/api/admin/tunables", { values: checked.values });
    setSaving(false);
    setAsking(false);
    if (r.ok) {
      onSaved(r.value);
      ctx.setStatus("Tunables saved.");
    } else {
      setSaveError(r.message);
      ctx.setStatus(`Tunables not saved: ${r.message}`);
    }
  };

  return (
    <div>
      {specs.map((spec) => {
        const id = `tun-${spec.key.replace(/[^a-zA-Z0-9]/g, "-")}`;
        const descId = `${id}-desc`;
        const err = errors[spec.key];
        const draft = drafts[spec.key] ?? "";
        const sliderValue =
          Number.isFinite(Number(draft)) && draft.trim() !== "" ? Number(draft) : spec.default;
        return (
          <div key={spec.key} className="adm-flag" style={{ display: "block" }}>
            <label htmlFor={id}>
              <strong>{spec.label}</strong> <span className="adm-mono">{spec.key}</span>
            </label>
            <p id={descId} className="adm-muted" style={{ margin: "4px 0" }}>
              {spec.description} Range {spec.min} to {spec.max} {spec.unit}, step {spec.step}.
            </p>
            <div className="adm-row">
              <input
                id={id}
                type="number"
                inputMode="decimal"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={draft}
                aria-describedby={descId}
                aria-invalid={err ? true : undefined}
                onChange={(e) => setDrafts((d) => ({ ...d, [spec.key]: e.target.value }))}
                style={{ minHeight: 44, width: 120 }}
              />
              <span>{spec.unit}</span>
              <input
                type="range"
                aria-label={`${spec.label} slider`}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={sliderValue}
                onChange={(e) => setDrafts((d) => ({ ...d, [spec.key]: e.target.value }))}
                style={{ minHeight: 44, flex: "1 1 160px" }}
              />
            </div>
            {err ? (
              <p role="alert" style={{ color: "var(--adm-critical)", margin: "4px 0 0" }}>
                <span aria-hidden="true">✕ </span>
                {err}
              </p>
            ) : null}
          </div>
        );
      })}
      {saveError ? (
        <p role="alert" style={{ color: "var(--adm-critical)" }}>
          <span aria-hidden="true">✕ </span>
          Not saved: {saveError}
        </p>
      ) : null}
      {asking && checked.ok ? (
        <div className="adm-confirm" role="group" aria-label="Confirm tunables">
          <p>
            Save these values for everyone?{" "}
            {specs.map((s) => `${s.label} ${checked.values[s.key]}${s.unit}`).join(", ")}.
          </p>
          <div className="adm-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="adm-primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Confirm: save"}
            </button>
            <button type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          style={{ minHeight: 44, marginTop: 8 }}
          disabled={!checked.ok || saving}
          onClick={() => setAsking(true)}
        >
          Save tunables…
        </button>
      )}
      <h3 style={{ fontSize: 14, marginTop: 16 }}>Audit</h3>
      {audit.length === 0 ? (
        <p className="adm-muted">No tunable changes yet.</p>
      ) : (
        <ol className="adm-muted">
          {audit.map((a, i) => (
            <li key={`${a.at}-${a.key}-${i}`}>
              <span className="adm-mono">{a.key}</span> = {a.value} · by <AuditActor by={a.by} /> ·{" "}
              {formatWhen(a.at)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** "admin:<accountId>" as a short, readable link to that account in lookup. */
export function auditActorLabel(by: string): { label: string; accountId: string | null } {
  const m = /^admin:([0-9a-f-]{8,})$/i.exec(by);
  if (!m) return { label: by, accountId: null };
  const id = m[1]!;
  return { label: `admin ${id.slice(0, 8)}`, accountId: id };
}

function AuditActor({ by }: { by: string }) {
  const { label, accountId } = auditActorLabel(by);
  if (!accountId) return <span className="adm-mono">{label}</span>;
  return (
    <a className="adm-mono" href={`#admin/lookup/${accountId}`} title={by}>
      {label}
    </a>
  );
}

export function ConfigView({ ctx }: { ctx: SectionContext }) {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [tunables, setTunables] = useState<TunablesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyFlag, setBusyFlag] = useState<FeatureFlag | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([
      ctx.get<ConfigResponse>("/api/config"),
      ctx.get<TunablesResponse>("/api/admin/tunables"),
    ]).then(([c, t]) => {
      if (!live) return;
      if (c.ok) setConfig(c.value);
      if (t.ok) setTunables(t.value);
      const failed = !c.ok ? c.message : !t.ok ? t.message : null;
      setLoadError(failed);
    });
    return () => {
      live = false;
    };
  }, [ctx.token]);

  const setFlagValue = (flag: FeatureFlag, value: boolean) => {
    setBusyFlag(flag);
    void ctx.post<ConfigResponse>("/api/admin/flags", { flags: { [flag]: value } }).then((r) => {
      setBusyFlag(null);
      if (r.ok) {
        setConfig(r.value);
        ctx.setStatus(`${flag} turned ${value ? "on" : "off"}.`);
      } else {
        ctx.setStatus(`Flag ${flag} not saved: ${r.message}`);
      }
    });
  };

  return (
    <div className="adm-grid">
      {loadError ? (
        <p role="alert" className="adm-muted">
          Could not load everything: {loadError}
        </p>
      ) : null}
      {config ? (
        // FlagsPanel is its own titled card ("Feature flags"); no outer Panel heading.
        <div className="adm-panel wide">
          <FlagsPanel
            flags={config.flags}
            seasonId={config.seasonId}
            busyFlag={busyFlag}
            onSet={setFlagValue}
          />
        </div>
      ) : (
        <p className="adm-muted">Loading flags…</p>
      )}
      {tunables ? (
        <Panel
          title="Tunables"
          hint="Numeric live config. Values are clamped to their range on the server. Changes apply to the next read (within about 30 seconds)."
          wide
        >
          <TunablesForm
            specs={tunables.specs}
            stored={tunables.values}
            audit={tunables.audit}
            ctx={ctx}
            onSaved={setTunables}
          />
        </Panel>
      ) : (
        <p className="adm-muted">Loading tunables…</p>
      )}
    </div>
  );
}

export const configSection = defineSection<null>({
  id: "config",
  label: "Flags & config",
  group: "Ops",
  load: null,
  Component: ({ ctx }) => <ConfigView ctx={ctx} />,
});

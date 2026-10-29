/**
 * Presentational parts of the admin dashboard (wave-C.md §9.3). OWNER: T-admin.
 * No fetching here: AdminScreen (index.tsx) owns data and actions, so these
 * render from props and are testable with renderToStaticMarkup.
 */
import { useState } from "react";
import type { ConfigResponse, EconomyTelemetry, FeatureFlag } from "@gamez/protocol";
import { FEATURE_FLAGS } from "@gamez/protocol";
import type { ModerationResponse } from "../../server/admin/moderation.ts";
import {
  fmt,
  FlowsChart,
  FlowsTable,
  PriceChart,
  PriceTable,
  SourcesBreakdown,
} from "./charts.tsx";

export interface TileProps {
  label: string;
  value: string;
  hint?: string;
}

export function Tile({ label, value, hint }: TileProps) {
  return (
    <div className="adm-tile">
      <div className="adm-label">{label}</div>
      <div className="adm-value">{value}</div>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function revenueText(minor: Partial<Record<string, number>>): string {
  const parts = Object.entries(minor).map(([cur, v]) => `${cur} ${((v ?? 0) / 100).toFixed(2)}`);
  return parts.length ? parts.join(" · ") : "no revenue";
}

export function Tiles({ telemetry }: { telemetry: EconomyTelemetry }) {
  const { moneySupply, market, shops, purchases } = telemetry;
  return (
    <div className="adm-tiles" aria-label="Key numbers">
      <Tile
        label="Coin in accounts"
        value={fmt(moneySupply.coin)}
        hint="Custody (open market bids, escrow) not included"
      />
      <Tile label="Gems in accounts" value={fmt(moneySupply.gem)} />
      <Tile label="Wallets" value={fmt(telemetry.accounts)} hint="accounts with a wallet row" />
      <Tile label="Active listings" value={fmt(market.active)} />
      <Tile label="Sold, 24 h" value={fmt(market.sold24h)} />
      <Tile label="Volume, 24 h" value={fmt(market.volume24h)} hint="coin" />
      <Tile
        label="Shops"
        value={`${fmt(shops.leased)} / ${fmt(shops.auction)} / ${fmt(shops.grace)}`}
        hint="leased / auction / grace"
      />
      <Tile
        label="Purchases, 24 h"
        value={fmt(purchases.paid24h)}
        hint={revenueText(purchases.revenueMinor24h)}
      />
    </div>
  );
}

export function EconomyCharts({ telemetry }: { telemetry: EconomyTelemetry }) {
  const days = telemetry.flows.map((d) => d.day);
  return (
    <div className="adm-grid two">
      <section className="adm-section" aria-labelledby="adm-flows-title">
        <h2 id="adm-flows-title">Faucets vs sinks per day</h2>
        <p className="adm-muted">Coin created and destroyed, by day (UTC).</p>
        <FlowsChart days={telemetry.flows} label="Faucets and sinks per day" />
        <details>
          <summary>Table view</summary>
          <FlowsTable days={telemetry.flows} />
        </details>
        <h2 id="adm-sources-title">By source</h2>
        <p className="adm-muted">Totals for the selected window.</p>
        <SourcesBreakdown days={telemetry.flows} />
      </section>
      <section className="adm-section" aria-labelledby="adm-price-title">
        <h2 id="adm-price-title">Price index</h2>
        <p className="adm-muted">Daily median sale price per category (market and shops).</p>
        <PriceChart points={telemetry.priceIndex} days={days} />
        <details>
          <summary>Table view</summary>
          <PriceTable points={telemetry.priceIndex} />
        </details>
      </section>
    </div>
  );
}

export interface FlagsPanelProps {
  flags: ConfigResponse["flags"];
  seasonId: string;
  busyFlag: FeatureFlag | null;
  onSet: (flag: FeatureFlag, value: boolean) => void;
}

/** Each flag is a toggle with an inline confirmation before it is written. */
export function FlagsPanel({ flags, seasonId, busyFlag, onSet }: FlagsPanelProps) {
  const [asking, setAsking] = useState<FeatureFlag | null>(null);
  return (
    <section className="adm-section" aria-labelledby="adm-flags-title">
      <h2 id="adm-flags-title">Feature flags</h2>
      <p className="adm-muted">
        Kill switches. A switch off makes the server refuse the feature within about 10 seconds;
        open pages hide it on their next load or when they regain focus (up to 30 seconds later).
        Season <span className="adm-mono">{seasonId}</span>.
      </p>
      {FEATURE_FLAGS.map((flag) => {
        const on = flags[flag] !== false;
        const next = !on;
        const isAsking = asking === flag;
        return (
          <div className="adm-flag" key={flag}>
            <div>
              <strong className="adm-mono">{flag}</strong>{" "}
              <span className={`adm-chip ${on ? "on" : "off"}`}>
                <span aria-hidden="true">{on ? "✓" : "✕"}</span>
                {on ? "On" : "Off"}
              </span>
            </div>
            {isAsking ? (
              <div className="adm-confirm" role="group" aria-label={`Confirm ${flag}`}>
                <p>
                  Turn {flag} {next ? "on" : "off"} for everyone?
                </p>
                <div className="adm-row" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className={next ? "adm-primary" : "adm-danger"}
                    disabled={busyFlag !== null}
                    onClick={() => {
                      setAsking(null);
                      onSet(flag, next);
                    }}
                  >
                    Confirm: turn {next ? "on" : "off"}
                  </button>
                  <button type="button" onClick={() => setAsking(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={busyFlag !== null}
                aria-label={`${next ? "Turn on" : "Turn off"} ${flag}`}
                onClick={() => setAsking(flag)}
              >
                {busyFlag === flag ? "Saving…" : next ? "Turn on" : "Turn off"}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

export interface ModerationPanelProps {
  moderation: ModerationResponse;
  busy: boolean;
  onMute: (accountId: string, channel: string) => void;
  onHide: (channel: string, messageId: string) => void;
}

export function ModerationPanel({ moderation, busy, onMute, onHide }: ModerationPanelProps) {
  return (
    <section className="adm-section" aria-labelledby="adm-mod-title">
      <h2 id="adm-mod-title">Moderation queue</h2>
      <p className="adm-muted">Chat reports by reported account, newest first.</p>
      {moderation.accounts.length === 0 ? (
        <p className="adm-muted">No reports.</p>
      ) : (
        moderation.accounts.map((acc) => {
          const channel = acc.samples[0]?.channel ?? null;
          const verdictText = Object.entries(acc.verdicts)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ");
          return (
            <article className="adm-account" key={acc.accountId}>
              <div className="adm-row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong className="adm-mono">{acc.accountId}</strong>
                  <div className="adm-muted">
                    {acc.reports} reports, {acc.open} open · last{" "}
                    {new Date(acc.lastAt).toLocaleString()}
                  </div>
                  {verdictText ? <small>Verdicts: {verdictText}</small> : null}
                </div>
                <button
                  type="button"
                  disabled={busy || channel === null}
                  onClick={() => channel && onMute(acc.accountId, channel)}
                >
                  Mute 60 min
                </button>
              </div>
              {acc.samples.map((s, i) => (
                <div className="adm-sample" key={`${s.messageId ?? i}-${s.at}`}>
                  <div>
                    <span>{s.text ?? "(no text)"}</span>
                  </div>
                  <small>
                    {s.reason ?? "reported"} · {s.channel ?? "unknown channel"} ·{" "}
                    {new Date(s.at).toLocaleString()}
                    {s.verdict ? ` · ${s.verdict}` : " · open"}
                  </small>
                  {s.channel && s.messageId ? (
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onHide(s.channel!, s.messageId!)}
                      >
                        Hide this message
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </article>
          );
        })
      )}
    </section>
  );
}

export function NotAdmin({
  status,
  devHost,
  busy,
  onMakeDevAdmin,
  onClose,
}: {
  status: number;
  devHost: boolean;
  busy: boolean;
  onMakeDevAdmin: () => void;
  onClose: () => void;
}) {
  return (
    <section className="adm-section" aria-labelledby="adm-denied-title">
      <h2 id="adm-denied-title">{status === 401 ? "Log in to continue" : "Not an admin"}</h2>
      <p>
        {status === 401
          ? "The live-ops dashboard needs a signed-in session."
          : "This account is not on the admin list, so the dashboard stays closed."}
      </p>
      <div className="adm-row" style={{ marginTop: 12 }}>
        {status === 403 && devHost ? (
          <button type="button" className="adm-primary" disabled={busy} onClick={onMakeDevAdmin}>
            Make me admin (dev)
          </button>
        ) : null}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

export function WindowPicker({
  days,
  options,
  onPick,
}: {
  days: number;
  options: number[];
  onPick: (days: number) => void;
}) {
  return (
    <div className="adm-row" role="group" aria-label="Time window">
      {options.map((d) => (
        <button key={d} type="button" aria-pressed={d === days} onClick={() => onPick(d)}>
          {d} days
        </button>
      ))}
    </div>
  );
}

/**
 * Shop plots in the classic town (wave-C.md §5.1): eight plots on the east road.
 * An empty plot is on auction (minimum bid, top bid, timer); a leased plot shows
 * the shop and its owner and opens the shop. Presentational body exported for tests.
 */
import { useState } from "react";
import type { PlotsResponse, PlotView } from "@gamez/protocol";
import type { PlotsViewProps } from "./index.ts";
import { type LoadState, bidPlot, checkPlotBid, loadResult, plotMinBid } from "./parts/flows.ts";
import { useAction, useNow, useReload } from "./parts/hooks.ts";
import { formatCoin, formatTimeLeft, formatWhen, plotStateLabel } from "./parts/text.ts";
import { Banner, Field, StateNote, actionsStyle, rowBox, sectionStyle } from "./parts/ui.tsx";
import {
  SOCIAL_C,
  badgeStyle,
  headingStyle,
  inputStyle,
  mutedStyle,
  sheetStyle,
  socialButtonStyle,
} from "../social/styles.ts";
import type { ShopsApi } from "../platform.ts";

export interface PlotsBodyProps {
  state: LoadState<PlotsResponse> | undefined;
  shops: ShopsApi;
  world: string;
  now: number;
  coin: number | null;
  canTrade: boolean;
  onOpenShop: (plotId: string) => void;
  onChanged: () => void;
  onRetry: () => void;
}

function PlotCard({
  plot,
  shops,
  world,
  now,
  coin,
  canTrade,
  onOpenShop,
  onChanged,
}: {
  plot: PlotView;
  shops: ShopsApi;
  world: string;
  now: number;
  coin: number | null;
  canTrade: boolean;
  onOpenShop: (plotId: string) => void;
  onChanged: () => void;
}) {
  const action = useAction();
  const [bidText, setBidText] = useState(() => String(plotMinBid(plot)));
  const label = `Plot ${plot.id.replace(/^p/, "")}`;
  const auction = plot.auction;
  const lease = plot.lease;
  const bid = () => {
    void action
      .run(() => bidPlot(shops, world, plot, bidText))
      .then((res) => {
        if (res.ok) onChanged();
      });
  };
  const check = checkPlotBid(plot, bidText);

  return (
    <li aria-label={label} style={{ ...sectionStyle, ...rowBox, flexDirection: "column" }}>
      <div style={actionsStyle}>
        <strong style={{ color: SOCIAL_C.goldBright, fontSize: 14 }}>{label}</strong>
        <span style={badgeStyle}>{plotStateLabel(plot.state)}</span>
      </div>

      {plot.state === "auction" && auction ? (
        <>
          <span style={mutedStyle}>
            Ends in {formatTimeLeft(auction.endsAt, now)} · {auction.bids}{" "}
            {auction.bids === 1 ? "bid" : "bids"}
          </span>
          <span style={{ color: SOCIAL_C.text }}>
            {auction.topBid !== null && auction.topBidder
              ? `Top bid ${formatCoin(auction.topBid)} by ${auction.topBidder.displayName}`
              : "No bids yet."}
          </span>
          <span style={mutedStyle}>Minimum bid {formatCoin(plotMinBid(plot))}</span>
          {canTrade ? (
            <form
              aria-label={`Bid on ${label}`}
              style={{ ...actionsStyle, width: "100%" }}
              onSubmit={(e) => {
                e.preventDefault();
                bid();
              }}
            >
              <Field
                label="Your bid (coin)"
                hint={coin !== null ? `You have ${formatCoin(coin)}.` : undefined}
              >
                <input
                  inputMode="numeric"
                  value={bidText}
                  disabled={action.busy}
                  onChange={(e) => setBidText(e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <button
                type="submit"
                disabled={action.busy || !check.ok}
                style={socialButtonStyle({ primary: true, disabled: action.busy || !check.ok })}
              >
                Bid
              </button>
            </form>
          ) : (
            <span style={mutedStyle}>Create an account to bid on a plot.</span>
          )}
        </>
      ) : lease ? (
        <>
          <span style={{ color: SOCIAL_C.text, fontWeight: 700, overflowWrap: "anywhere" }}>
            {plot.shopName ?? "Player shop"}
          </span>
          <span style={mutedStyle}>
            Owner {lease.owner.displayName} · rent {formatCoin(lease.rent)} per period · paid up to{" "}
            {formatWhen(lease.paidUntil)}
          </span>
          {plot.state === "grace" && lease.graceUntil !== null ? (
            <Banner tone="error">
              Rent is overdue. The shop is repossessed if it is not paid by{" "}
              {formatWhen(lease.graceUntil)}.
            </Banner>
          ) : null}
          <div style={actionsStyle}>
            <button
              type="button"
              aria-label={`Open ${plot.shopName ?? label}`}
              onClick={() => onOpenShop(plot.id)}
              style={socialButtonStyle({ primary: true })}
            >
              Open shop
            </button>
          </div>
        </>
      ) : (
        <span style={mutedStyle}>Nothing here yet.</span>
      )}

      {action.error ? <Banner tone="error">{action.error}</Banner> : null}
    </li>
  );
}

export function PlotsBody({
  state,
  shops,
  world,
  now,
  coin,
  canTrade,
  onOpenShop,
  onChanged,
  onRetry,
}: PlotsBodyProps) {
  return (
    <div style={{ ...sheetStyle, padding: 12 }}>
      <h3 style={headingStyle}>Shop plots</h3>
      {state === undefined || state.status === "loading" ? (
        <StateNote kind="loading" message="Loading the plots…" />
      ) : state.status === "error" ? (
        <StateNote kind="error" message={state.message} onRetry={onRetry} />
      ) : state.value.plots.length === 0 ? (
        <StateNote kind="empty" message="No shop plots in this town yet." />
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            minWidth: 0,
          }}
        >
          {state.value.plots.map((plot) => (
            <PlotCard
              key={plot.id}
              plot={plot}
              shops={shops}
              world={world}
              now={now}
              coin={coin}
              canTrade={canTrade}
              onOpenShop={onOpenShop}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function PlotsView({ shops, account, world, canTrade, onOpenShop }: PlotsViewProps) {
  const plots = useReload(() => loadResult(() => shops.plots(world)), world);
  const wallet = useReload(() => loadResult(() => account.wallet()), "wallet");
  const now = useNow(30_000);
  const coin = wallet.state?.status === "ready" ? wallet.state.value.balances.coin : null;
  return (
    <PlotsBody
      state={plots.state}
      shops={shops}
      world={world}
      now={now}
      coin={coin}
      canTrade={canTrade}
      onOpenShop={onOpenShop}
      onChanged={() => {
        plots.reload();
        wallet.reload();
      }}
      onRetry={plots.reload}
    />
  );
}

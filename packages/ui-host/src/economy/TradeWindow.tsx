/**
 * Direct trade between two registered players (EscrowDO saga, wave-C.md §3.3).
 * Two columns (you and them), an offer editor for your side (coin and up to
 * TRADE_MAX_ITEMS tradable vault items), and an accept that names the offer
 * versions it saw: any change clears both accepts, so nobody commits a deal
 * they did not see. The view is polled every pollMs until the trade ends.
 */
import { useEffect, useState, type ReactNode } from "react";
import { TRADE_MAX_ITEMS, type TradeView, type VaultItem } from "@gamez/protocol";
import type { ApiResult } from "../platform.ts";
import type { TradeWindowProps } from "./index.ts";
import {
  type LoadState,
  type Side,
  canAccept,
  canEditOffer,
  loadResult,
  otherSide,
  sendAccept,
  sendOffer,
  sideOf,
  tradeAccepts,
  tradeIsOver,
  tradableItems,
} from "./parts/flows.ts";
import { tradeFee } from "./parts/fees.ts";
import { formatCoin, tradeStatusText } from "./parts/text.ts";
import { type ActionState, useAction, useReload } from "./parts/hooks.ts";
import {
  Banner,
  ItemRow,
  StateNote,
  actionsStyle,
  checkboxLabelStyle,
  sectionStyle,
} from "./parts/ui.tsx";
import {
  SOCIAL_C,
  badgeStyle,
  headingStyle,
  inputStyle,
  mutedStyle,
  sheetStyle,
  socialButtonStyle,
} from "../social/styles.ts";
import { toLoadState } from "../social/flows.ts";

export interface TradeBodyProps {
  state: LoadState<TradeView> | undefined;
  selfId: string;
  canTrade: boolean;
  busy: boolean;
  error: string | null;
  /** Offer editor for my side (only rendered while the trade is open). */
  renderEditor?: (view: TradeView, side: Side) => ReactNode;
  onAccept: () => void;
  onCancel: () => void;
  onClose: () => void;
  onRetry: () => void;
}

function OfferColumn({
  title,
  coin,
  items,
  accepted,
  fee,
}: {
  title: string;
  coin: number;
  items: readonly VaultItem[];
  accepted: string | null;
  fee?: number;
}) {
  return (
    <section
      aria-label={title}
      style={{
        ...sectionStyle,
        flex: "1 1 150px",
        minWidth: 0,
        padding: 8,
        border: `1px solid ${SOCIAL_C.border}`,
        borderRadius: 8,
        background: SOCIAL_C.inner,
      }}
    >
      <div style={actionsStyle}>
        <strong style={{ color: SOCIAL_C.goldBright, overflowWrap: "anywhere" }}>{title}</strong>
        {accepted ? <span style={badgeStyle}>{accepted}</span> : null}
      </div>
      <span style={{ color: SOCIAL_C.gold, fontWeight: 700 }}>{formatCoin(coin)}</span>
      {fee !== undefined ? (
        <span style={mutedStyle}>Trade fee {formatCoin(fee)} (2 % of the coin sent)</span>
      ) : null}
      {items.length === 0 ? (
        <span style={mutedStyle}>No items offered.</span>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {items.map((item) => (
            <ItemRow key={item.uid} item={item} label={item.summary.name} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function TradeBody({
  state,
  selfId,
  canTrade,
  busy,
  error,
  renderEditor,
  onAccept,
  onCancel,
  onClose,
  onRetry,
}: TradeBodyProps) {
  const view = state?.status === "ready" ? state.value : null;
  const side = view ? sideOf(view, selfId) : null;
  const accepts = view && side ? tradeAccepts(view, side) : null;
  const tone = view
    ? view.status === "done"
      ? "ok"
      : view.status === "failed" || view.status === "cancelled"
        ? "error"
        : "info"
    : "info";
  const open = view?.status === "open";

  return (
    <section aria-label="Trade" style={{ ...sheetStyle, padding: 12 }}>
      <div style={actionsStyle}>
        <h3 style={{ ...headingStyle, flex: "1 1 auto" }}>
          {view ? `Trade with ${side === "a" ? view.b.displayName : view.a.displayName}` : "Trade"}
        </h3>
        <button type="button" onClick={onClose} style={socialButtonStyle()}>
          Close
        </button>
      </div>

      {!canTrade ? <Banner tone="info">Create an account to trade.</Banner> : null}

      {!canTrade && !view ? null : state === undefined || state.status === "loading" ? (
        <StateNote kind="loading" message="Opening the trade…" />
      ) : state.status === "error" ? (
        <StateNote kind="error" message={state.message} onRetry={onRetry} />
      ) : (
        <>
          <Banner tone={tone}>{tradeStatusText(state.value, accepts)}</Banner>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
            {side ? (
              <>
                <OfferColumn
                  title="You"
                  coin={state.value.offers[side].coin}
                  items={state.value.offers[side].items}
                  accepted={accepts?.mine ? "Accepted" : null}
                  fee={state.value.fees[side]}
                />
                <OfferColumn
                  title={
                    state.value.offers[otherSide(side)]
                      ? (side === "a" ? state.value.b : state.value.a).displayName
                      : "Them"
                  }
                  coin={state.value.offers[otherSide(side)].coin}
                  items={state.value.offers[otherSide(side)].items}
                  accepted={accepts?.theirs ? "Accepted" : null}
                  fee={state.value.fees[otherSide(side)]}
                />
              </>
            ) : (
              <>
                <OfferColumn
                  title={state.value.a.displayName}
                  coin={state.value.offers.a.coin}
                  items={state.value.offers.a.items}
                  accepted={state.value.accepted.a ? "Accepted" : null}
                />
                <OfferColumn
                  title={state.value.b.displayName}
                  coin={state.value.offers.b.coin}
                  items={state.value.offers.b.items}
                  accepted={state.value.accepted.b ? "Accepted" : null}
                />
              </>
            )}
          </div>

          {open && side && canTrade && renderEditor ? renderEditor(state.value, side) : null}

          <div style={actionsStyle}>
            {open && side ? (
              <button
                type="button"
                disabled={busy || !canTrade || !canAccept(state.value, side)}
                onClick={onAccept}
                style={socialButtonStyle({
                  primary: true,
                  disabled: busy || !canTrade || !canAccept(state.value, side),
                })}
              >
                {accepts?.mine ? "Accepted" : "Accept trade"}
              </button>
            ) : null}
            {open && side ? (
              <button
                type="button"
                disabled={busy || !canTrade}
                onClick={onCancel}
                style={socialButtonStyle({ danger: true, disabled: busy || !canTrade })}
              >
                Cancel trade
              </button>
            ) : null}
          </div>
          {view && view.status === "open" ? (
            <p style={mutedStyle}>
              Any change to an offer clears both accepts. Trades expire after ten minutes.
            </p>
          ) : null}
        </>
      )}

      {error ? <Banner tone="error">{error}</Banner> : null}
    </section>
  );
}

/** My side of the offer: coin and item picks. Remounted (by key) whenever my offer version changes. */
function OfferEditor({
  trade,
  vault,
  view,
  side,
  balance,
  action,
  onView,
}: {
  trade: TradeWindowProps["trade"];
  vault: TradeWindowProps["vault"];
  view: TradeView;
  side: Side;
  balance: number | null;
  action: ActionState;
  onView: (view: TradeView) => void;
}) {
  const mine = view.offers[side];
  const items = useReload(() => loadResult(() => vault.vault()), "vault");
  const [coinText, setCoinText] = useState(mine.coin > 0 ? String(mine.coin) : "");
  const [picks, setPicks] = useState<string[]>(() => mine.items.map((item) => item.uid));
  const editable = canEditOffer(view, side);
  const choices = items.state?.status === "ready" ? tradableItems(items.state.value.items) : [];
  const atLimit = picks.length >= TRADE_MAX_ITEMS;

  const toggle = (uid: string) =>
    setPicks((current) =>
      current.includes(uid) ? current.filter((u) => u !== uid) : [...current, uid],
    );

  return (
    <form
      aria-label="Your offer"
      style={{
        ...sectionStyle,
        padding: 8,
        border: `1px solid ${SOCIAL_C.border}`,
        borderRadius: 8,
      }}
      onSubmit={(e) => {
        e.preventDefault();
        void action
          .run(() => sendOffer(trade, view, coinText, picks, balance ?? Number.MAX_SAFE_INTEGER))
          .then((res: ApiResult<TradeView>) => {
            if (res.ok) onView(res.value);
          });
      }}
    >
      <strong style={{ color: SOCIAL_C.goldBright }}>Your offer</strong>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ color: SOCIAL_C.muted, fontSize: 12 }}>Coin to give</span>
        <input
          inputMode="numeric"
          value={coinText}
          disabled={!editable || action.busy}
          onChange={(e) => setCoinText(e.target.value)}
          style={inputStyle}
          placeholder="0"
        />
      </label>
      <span style={mutedStyle}>
        Your trade fee: {formatCoin(tradeFee(Number(coinText) || 0))} on the coin you send.
      </span>

      {items.state === undefined || items.state.status === "loading" ? (
        <StateNote kind="loading" message="Loading your vault…" />
      ) : items.state.status === "error" ? (
        <StateNote kind="error" message={items.state.message} onRetry={items.reload} />
      ) : choices.length === 0 ? (
        <span style={mutedStyle}>No tradable items in your vault.</span>
      ) : (
        <fieldset
          style={{
            border: 0,
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <legend style={{ ...mutedStyle, marginBottom: 4 }}>
            Items ({picks.length} of {TRADE_MAX_ITEMS})
          </legend>
          {choices.map((item) => {
            const checked = picks.includes(item.uid);
            return (
              <label key={item.uid} style={checkboxLabelStyle}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!editable || action.busy || (!checked && atLimit)}
                  onChange={() => toggle(item.uid)}
                />
                <span style={{ overflowWrap: "anywhere" }}>{item.summary.name}</span>
              </label>
            );
          })}
        </fieldset>
      )}

      {editable ? (
        <div style={actionsStyle}>
          <button
            type="submit"
            disabled={action.busy}
            style={socialButtonStyle({ disabled: action.busy })}
          >
            Update offer
          </button>
        </div>
      ) : null}
    </form>
  );
}

export function TradeWindow({
  trade,
  vault,
  account,
  selfId,
  canTrade,
  with: withWho,
  tradeId,
  pollMs = 1000,
  onClose,
}: TradeWindowProps) {
  const withId = withWho?.accountId ?? null;
  const [state, setState] = useState<LoadState<TradeView>>({ status: "loading" });
  const [id, setId] = useState<string | null>(tradeId ?? null);
  const action = useAction();
  const wallet = useReload(() => loadResult(() => account.wallet()), "wallet");
  const balance: number | null =
    wallet.state?.status === "ready" ? wallet.state.value.balances.coin : null;

  // Open (or resume) the trade once per input. A guest cannot open one: the
  // body shows "Create an account to trade." without a request the server
  // would refuse (403 guest_forbidden, logged by the browser as an error).
  const guestOpen = !canTrade && !tradeId;
  useEffect(() => {
    if (guestOpen) return;
    let live = true;
    const first: Promise<ApiResult<TradeView>> = tradeId
      ? trade.get(tradeId)
      : withId
        ? trade.open(withId)
        : Promise.resolve<ApiResult<TradeView>>({
            ok: false,
            code: "bad_request",
            message: "Pick someone to trade with.",
          });
    first.then(
      (res) => {
        if (!live) return;
        setState(toLoadState(res));
        if (res.ok) setId(res.value.id);
      },
      () => {
        if (live) setState({ status: "error", message: "Could not reach the server." });
      },
    );
    return () => {
      live = false;
    };
  }, [trade, tradeId, withId, guestOpen]);

  const over = state.status === "ready" && tradeIsOver(state.value);
  // Poll until the trade ends (committing trades keep polling).
  useEffect(() => {
    if (!id || over) return;
    const timer = setInterval(() => {
      void trade.get(id).then((res) => {
        if (res.ok) setState({ status: "ready", value: res.value });
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [trade, id, over, pollMs]);

  const apply = (res: ApiResult<TradeView>) => {
    if (res.ok) {
      setState({ status: "ready", value: res.value });
    } else if (res.code === "conflict" && id) {
      // The offers moved under us: fetch the current ones instead of guessing.
      void trade.get(id).then((fresh) => {
        if (fresh.ok) setState({ status: "ready", value: fresh.value });
      });
    }
    return res;
  };

  const view = state.status === "ready" ? state.value : null;

  return (
    <TradeBody
      state={state}
      selfId={selfId}
      canTrade={canTrade}
      busy={action.busy}
      error={action.error}
      onRetry={() => {
        if (id) void trade.get(id).then((res) => apply(res));
        else setState({ status: "loading" });
      }}
      onClose={onClose}
      onAccept={() => {
        if (view) void action.run(() => sendAccept(trade, view)).then(apply);
      }}
      onCancel={() => {
        if (view) void action.run(() => trade.cancel(view.id)).then(apply);
      }}
      renderEditor={(current, mySide) => (
        <OfferEditor
          key={`${current.id}:${current.offers[mySide].version}`}
          trade={trade}
          vault={vault}
          view={current}
          side={mySide}
          balance={balance}
          action={action}
          onView={(next) => apply({ ok: true, value: next })}
        />
      )}
    />
  );
}

/**
 * A player shop on a plot (wave-C.md §5.3). The owner configures name and open
 * state, stocks vault items with a price, takes them off sale and claims
 * earnings. A visitor sees stock, and buys with a confirm step while the shop is
 * open. The shop sells while its owner is offline; lease end is shown.
 */
import { useState } from "react";
import type { ShopEntry, ShopView as ShopData, VaultItem } from "@gamez/protocol";
import type { ShopViewProps } from "./index.ts";
import {
  type LoadState,
  buyFromShop,
  checkShopName,
  claimEarnings,
  configureShop,
  loadResult,
  shopBuyConfirmText,
  stockItem,
  tradableItems,
  unstockItem,
} from "./parts/flows.ts";
import { type ActionState, useAction, useNow, useReload } from "./parts/hooks.ts";
import { formatCoin, formatTimeLeft, formatWhen } from "./parts/text.ts";
import {
  Banner,
  ConfirmRow,
  Field,
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
import type { ShopsApi, VaultApi } from "../platform.ts";

export interface ShopBodyProps {
  state: LoadState<ShopData> | undefined;
  selfId: string;
  canTrade: boolean;
  /** The viewer's coin balance, or null while unknown. */
  coin: number | null;
  now: number;
  action: ActionState;
  shops: ShopsApi;
  vault: VaultApi;
  world: string;
  plotId: string;
  onRefresh: () => void;
  onRetry: () => void;
  onClose: () => void;
}

function EntryRow({
  entry,
  owner,
  canBuy,
  busy,
  onBuy,
  onUnstock,
}: {
  entry: ShopEntry;
  owner: boolean;
  canBuy: boolean;
  busy: boolean;
  onBuy: () => void;
  onUnstock: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const name = entry.item.summary.name;
  return (
    <ItemRow item={entry.item} label={name}>
      <span style={{ color: SOCIAL_C.gold, fontWeight: 700 }}>{formatCoin(entry.price)}</span>
      {owner ? (
        <button
          type="button"
          aria-label={`Take ${name} off sale`}
          disabled={busy}
          onClick={onUnstock}
          style={socialButtonStyle({ disabled: busy })}
        >
          Take off sale
        </button>
      ) : canBuy && !confirming ? (
        <button
          type="button"
          aria-label={`Buy ${name}`}
          disabled={busy}
          onClick={() => setConfirming(true)}
          style={socialButtonStyle({ primary: true, disabled: busy })}
        >
          Buy
        </button>
      ) : null}
      {!owner && confirming ? (
        <ConfirmRow
          text={shopBuyConfirmText(name, entry.price)}
          confirmLabel="Buy now"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onBuy();
          }}
        />
      ) : null}
    </ItemRow>
  );
}

/** Owner controls: configure, earnings, and stocking from the vault. */
function OwnerPanel({
  view,
  shops,
  vault,
  world,
  plotId,
  action,
  onRefresh,
}: {
  view: ShopData;
  shops: ShopsApi;
  vault: VaultApi;
  world: string;
  plotId: string;
  action: ActionState;
  onRefresh: () => void;
}) {
  const [name, setName] = useState(view.name);
  const [open, setOpen] = useState(view.open);
  const [uid, setUid] = useState("");
  const [price, setPrice] = useState("");
  const items = useReload(() => loadResult(() => vault.vault()), "vault");
  const choices: readonly VaultItem[] =
    items.state?.status === "ready" ? tradableItems(items.state.value.items) : [];
  const earnings = view.earnings ?? 0;
  const nameProblem = checkShopName(name);

  return (
    <section
      aria-label="Your shop"
      style={{
        ...sectionStyle,
        padding: 8,
        border: `1px solid ${SOCIAL_C.border}`,
        borderRadius: 8,
      }}
    >
      <strong style={{ color: SOCIAL_C.goldBright }}>Manage your shop</strong>

      <form
        aria-label="Shop settings"
        style={sectionStyle}
        onSubmit={(e) => {
          e.preventDefault();
          void action
            .run(() => configureShop(shops, world, plotId, name, open))
            .then((res) => {
              if (res.ok) onRefresh();
            });
        }}
      >
        <Field label="Shop name" hint={nameProblem ?? "3 to 24 letters, digits, spaces, ' _ -"}>
          <input
            value={name}
            maxLength={24}
            disabled={action.busy}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </Field>
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={open}
            disabled={action.busy}
            onChange={(e) => setOpen(e.target.checked)}
          />
          Open for business
        </label>
        <div style={actionsStyle}>
          <button
            type="submit"
            disabled={action.busy || nameProblem !== null}
            style={socialButtonStyle({ disabled: action.busy || nameProblem !== null })}
          >
            Save settings
          </button>
        </div>
      </form>

      <div style={actionsStyle}>
        <span style={badgeStyle}>Earnings {formatCoin(earnings)} after tax</span>
        <button
          type="button"
          disabled={action.busy || earnings <= 0}
          onClick={() =>
            void action
              .run(() => claimEarnings(shops, world, plotId))
              .then((res) => {
                if (res.ok) onRefresh();
              })
          }
          style={socialButtonStyle({
            primary: earnings > 0,
            disabled: action.busy || earnings <= 0,
          })}
        >
          Claim earnings
        </button>
      </div>

      <form
        aria-label="Stock an item"
        style={sectionStyle}
        onSubmit={(e) => {
          e.preventDefault();
          void action
            .run(() => stockItem(shops, world, plotId, uid, price))
            .then((res) => {
              if (res.ok) {
                setUid("");
                setPrice("");
                onRefresh();
              }
            });
        }}
      >
        <span style={mutedStyle}>
          Only tradable items can go on sale. Sales continue while you are offline.
        </span>
        {items.state === undefined || items.state.status === "loading" ? (
          <StateNote kind="loading" message="Loading your vault…" />
        ) : items.state.status === "error" ? (
          <StateNote kind="error" message={items.state.message} onRetry={items.reload} />
        ) : choices.length === 0 ? (
          <StateNote kind="empty" message="No tradable items in your vault to sell here." />
        ) : (
          <div
            role="radiogroup"
            aria-label="Item to stock"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            {choices.map((item) => (
              <label key={item.uid} style={checkboxLabelStyle}>
                <input
                  type="radio"
                  name="stock-item"
                  value={item.uid}
                  checked={uid === item.uid}
                  disabled={action.busy}
                  onChange={() => setUid(item.uid)}
                />
                <span style={{ overflowWrap: "anywhere" }}>{item.summary.name}</span>
              </label>
            ))}
          </div>
        )}
        <Field label="Price (coin)">
          <input
            inputMode="numeric"
            value={price}
            disabled={action.busy}
            onChange={(e) => setPrice(e.target.value)}
            style={inputStyle}
          />
        </Field>
        <div style={actionsStyle}>
          <button
            type="submit"
            disabled={action.busy || !uid}
            style={socialButtonStyle({ disabled: action.busy || !uid })}
          >
            Put on sale
          </button>
        </div>
      </form>
    </section>
  );
}

export function ShopBody({
  state,
  selfId,
  canTrade,
  coin,
  now,
  action,
  shops,
  vault,
  world,
  plotId,
  onRefresh,
  onRetry,
  onClose,
}: ShopBodyProps) {
  const view = state?.status === "ready" ? state.value : null;
  const owner = view !== null && view.owner.accountId === selfId;
  return (
    <section aria-label="Shop" style={{ ...sheetStyle, padding: 12 }}>
      <div style={actionsStyle}>
        <h3 style={{ ...headingStyle, flex: "1 1 auto" }}>{view ? view.name : "Shop"}</h3>
        <button type="button" onClick={onClose} style={socialButtonStyle()}>
          Back
        </button>
      </div>

      {state === undefined || state.status === "loading" ? (
        <StateNote kind="loading" message="Opening the shop…" />
      ) : state.status === "error" ? (
        <StateNote kind="error" message={state.message} onRetry={onRetry} />
      ) : (
        <>
          <div style={actionsStyle}>
            <span style={mutedStyle}>Owner {view?.owner.displayName}</span>
            <span style={badgeStyle}>{view?.open ? "Open" : "Closed"}</span>
            <span style={mutedStyle}>
              Lease ends in {formatTimeLeft(view?.leaseEndsAt ?? 0, now)}
            </span>
          </div>
          <span style={mutedStyle}>Lease ends {view ? formatWhen(view.leaseEndsAt) : ""}</span>

          {!owner && view && !view.open ? (
            <Banner tone="info">This shop is closed right now.</Banner>
          ) : null}
          {!owner && !canTrade ? <Banner tone="info">Create an account to buy.</Banner> : null}
          {!owner && canTrade && coin !== null ? (
            <span style={mutedStyle}>You have {formatCoin(coin)}.</span>
          ) : null}
          {owner && view && !view.open ? (
            <Banner tone="info">Your shop is closed. Visitors cannot buy until you open it.</Banner>
          ) : null}

          {view && owner ? (
            <OwnerPanel
              key={`${view.name}|${view.open}`}
              view={view}
              shops={shops}
              vault={vault}
              world={world}
              plotId={plotId}
              action={action}
              onRefresh={onRefresh}
            />
          ) : null}

          {view && view.stock.length === 0 ? (
            <StateNote
              kind="empty"
              message={owner ? "Nothing on sale yet." : "Nothing on sale right now."}
            />
          ) : (
            <ul
              aria-label="For sale"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                minWidth: 0,
              }}
            >
              {(view?.stock ?? []).map((entry) => (
                <EntryRow
                  key={entry.entryId}
                  entry={entry}
                  owner={owner}
                  canBuy={canTrade && !!view?.open}
                  busy={action.busy}
                  onBuy={() =>
                    void action
                      .run(() => buyFromShop(shops, world, plotId, entry.entryId))
                      .then((res) => {
                        if (res.ok) onRefresh();
                      })
                  }
                  onUnstock={() =>
                    void action
                      .run(() => unstockItem(shops, world, plotId, entry.entryId))
                      .then((res) => {
                        if (res.ok) onRefresh();
                      })
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}

      {action.error ? <Banner tone="error">{action.error}</Banner> : null}
    </section>
  );
}

export function ShopView({
  shops,
  vault,
  account,
  world,
  plotId,
  selfId,
  canTrade,
  onClose,
}: ShopViewProps) {
  const shop = useReload(() => loadResult(() => shops.shop(world, plotId)), `${world}/${plotId}`);
  const wallet = useReload(() => loadResult(() => account.wallet()), "wallet");
  const action = useAction();
  const now = useNow(30_000);
  const coin = wallet.state?.status === "ready" ? wallet.state.value.balances.coin : null;
  const refresh = () => {
    shop.reload();
    wallet.reload();
  };
  return (
    <ShopBody
      state={shop.state}
      selfId={selfId}
      canTrade={canTrade}
      coin={coin}
      now={now}
      action={action}
      shops={shops}
      vault={vault}
      world={world}
      plotId={plotId}
      onRefresh={refresh}
      onRetry={shop.reload}
      onClose={onClose}
    />
  );
}

/**
 * Auction house: Browse (search, filters, paging, buy and bid), Sell (pick a
 * tradable vault item, buyout and/or start bid, duration, live fee preview) and
 * Mine (my listings and the bids I lead). Guests browse; writes need an
 * account. Presentational bodies are exported for tests.
 */
import { useState, type CSSProperties, type FormEvent } from "react";
import type {
  ItemCategory,
  MarketListing,
  MarketMineResponse,
  MarketSearchResponse,
  VaultResponse,
} from "@gamez/protocol";
import { ITEM_CATEGORIES } from "@gamez/protocol";
import type { MarketViewProps } from "./index.ts";
import {
  BROWSE_SORTS,
  EMPTY_BROWSE,
  EMPTY_SELL,
  MARKET_PAGE,
  type BrowseForm,
  type LoadState,
  type SellForm,
  browseQuery,
  bidFloor,
  buyConfirmText,
  buyListing,
  canBuyOut,
  cancelListing,
  checkBid,
  listItem,
  loadResult,
  placeBid,
  sellFeePreview,
  sellableItems,
} from "./parts/flows.ts";
import { MARKET_DURATIONS_H, type MarketDuration } from "./parts/fees.ts";
import { formatCoin, formatTimeLeft, categoryLabel, RARITIES, rarityLabel } from "./parts/text.ts";
import { useAction, useNow, useReload } from "./parts/hooks.ts";
import {
  Banner,
  ConfirmRow,
  Field,
  ItemBadge,
  ItemText,
  Pager,
  StateNote,
  Success,
  Tabs,
  actionsStyle,
  rowBox,
  sectionStyle,
} from "./parts/ui.tsx";
import {
  SOCIAL_C,
  SOCIAL_TOUCH,
  headingStyle,
  inputStyle,
  mutedStyle,
  sheetStyle,
  socialButtonStyle,
  socialTabStyle,
} from "../social/styles.ts";
import { useDebounced } from "../social/hooks.ts";

type MarketTab = "browse" | "sell" | "mine";

const TABS: readonly { id: MarketTab; label: string }[] = [
  { id: "browse", label: "Browse" },
  { id: "sell", label: "Sell" },
  { id: "mine", label: "Mine" },
];

const selectStyle = { ...inputStyle, appearance: "auto" as const };

export function MarketView(props: MarketViewProps) {
  const { market, vault, selfId, canTrade, initialCategory, initialQuery, sellUid, compact } =
    props;
  const [tab, setTab] = useState<MarketTab>(sellUid ? "sell" : "browse");
  const now = useNow(30_000);
  return (
    <section aria-label="Auction house" style={{ ...sheetStyle, padding: compact ? 8 : 12 }}>
      <h3 style={headingStyle}>Auction house</h3>
      {!canTrade ? (
        <Banner tone="info">Browse freely. Create an account to trade, list items and bid.</Banner>
      ) : null}
      <Tabs label="Auction house sections" tabs={TABS} value={tab} onChange={setTab} />
      {tab === "browse" ? (
        <BrowseTab
          market={market}
          selfId={selfId}
          canTrade={canTrade}
          now={now}
          initialCategory={initialCategory}
          initialQuery={initialQuery}
        />
      ) : null}
      {tab === "sell" ? (
        <SellTab
          market={market}
          vault={vault}
          canTrade={canTrade}
          sellUid={sellUid}
          onListed={() => setTab("mine")}
        />
      ) : null}
      {tab === "mine" ? (
        <MineTab market={market} selfId={selfId} canTrade={canTrade} now={now} />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Listing rows (buy, bid, cancel)
// ---------------------------------------------------------------------------

export interface ListingRowProps {
  listing: MarketListing;
  market: MarketViewProps["market"];
  selfId: string;
  canTrade: boolean;
  now: number;
  variant?: "browse" | "mine";
  onChanged: () => void;
}

export function ListingRow({
  listing,
  market,
  selfId,
  canTrade,
  now,
  variant = "browse",
  onChanged,
}: ListingRowProps) {
  const action = useAction();
  const [mode, setMode] = useState<"idle" | "confirmBuy" | "bid">("idle");
  const [bidText, setBidText] = useState("");
  const mine = listing.seller.accountId === selfId;
  const floor = bidFloor(listing);
  const active = listing.status === "active";
  const canBuy = canTrade && !mine && canBuyOut(listing);
  const canBid = canTrade && !mine && floor !== null;
  const canCancel = canTrade && variant === "mine" && active && listing.bids === 0;

  const prices = [
    listing.buyout !== null ? `Buyout ${formatCoin(listing.buyout)}` : null,
    listing.topBid !== null
      ? `Top bid ${formatCoin(listing.topBid)}`
      : listing.startBid !== null
        ? `Start bid ${formatCoin(listing.startBid)}`
        : null,
  ]
    .filter((p): p is string => p !== null)
    .join(" · ");

  const status = active
    ? `ends in ${formatTimeLeft(listing.endsAt, now)}`
    : listing.status === "sold" && listing.soldFor !== null
      ? `sold for ${formatCoin(listing.soldFor)}`
      : listing.status;

  const after = (res: { ok: boolean }) => {
    if (res.ok) {
      setMode("idle");
      onChanged();
    }
  };

  return (
    <li aria-label={listing.item.summary.name} style={{ ...rowBox, alignItems: "flex-start" }}>
      <ItemBadge summary={listing.item.summary} />
      <div
        style={{ minWidth: 0, flex: "1 1 180px", display: "flex", flexDirection: "column", gap: 3 }}
      >
        <ItemText summary={listing.item.summary} />
        <span style={{ color: SOCIAL_C.gold, fontSize: 13, fontWeight: 700 }}>{prices}</span>
        <span style={mutedStyle}>
          Seller {listing.seller.displayName} · {listing.bids} bids · {status}
          {listing.topBidder ? ` · top bidder ${listing.topBidder.displayName}` : ""}
        </span>
      </div>

      <div style={{ ...actionsStyle, width: "100%" }}>
        {mode === "idle" && canBuy ? (
          <button
            type="button"
            aria-label={`Buy ${listing.item.summary.name}`}
            disabled={action.busy}
            onClick={() => setMode("confirmBuy")}
            style={socialButtonStyle({ primary: true, disabled: action.busy })}
          >
            Buy now
          </button>
        ) : null}
        {mode === "idle" && canBid ? (
          <button
            type="button"
            aria-label={`Bid on ${listing.item.summary.name}`}
            disabled={action.busy}
            onClick={() => {
              setBidText(String(floor ?? ""));
              setMode("bid");
            }}
            style={socialButtonStyle({ disabled: action.busy })}
          >
            Bid
          </button>
        ) : null}
        {mode === "idle" && canCancel ? (
          <button
            type="button"
            aria-label={`Cancel ${listing.item.summary.name}`}
            disabled={action.busy}
            onClick={() => void action.run(() => cancelListing(market, listing.id)).then(after)}
            style={socialButtonStyle({ danger: true, disabled: action.busy })}
          >
            Cancel listing
          </button>
        ) : null}
        {mine && variant === "browse" ? <span style={mutedStyle}>Your listing</span> : null}
        {variant === "mine" && active && listing.bids > 0 ? (
          <span style={mutedStyle}>Bids are placed, so it cannot be cancelled.</span>
        ) : null}
      </div>

      {mode === "confirmBuy" ? (
        <div style={{ width: "100%" }}>
          <ConfirmRow
            text={buyConfirmText(listing)}
            confirmLabel="Buy now"
            busy={action.busy}
            onCancel={() => setMode("idle")}
            onConfirm={() => void action.run(() => buyListing(market, listing)).then(after)}
          />
        </div>
      ) : null}

      {mode === "bid" ? (
        <form
          aria-label="Place a bid"
          style={{ ...actionsStyle, width: "100%" }}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void action
              .run(async () => {
                const check = checkBid(listing, bidText);
                if (!check.ok)
                  return { ok: false as const, code: "too_low", message: check.message };
                return placeBid(market, listing, bidText);
              })
              .then(after);
          }}
        >
          <Field
            label="Your bid (coin)"
            hint={floor !== null ? `At least ${formatCoin(floor)}` : undefined}
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
            disabled={action.busy}
            style={socialButtonStyle({ primary: true, disabled: action.busy })}
          >
            Place bid
          </button>
          <button
            type="button"
            disabled={action.busy}
            onClick={() => setMode("idle")}
            style={socialButtonStyle({ disabled: action.busy })}
          >
            Not now
          </button>
        </form>
      ) : null}

      {action.error ? (
        <div style={{ width: "100%" }}>
          <Banner tone="error">{action.error}</Banner>
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

export function BrowseFilters({
  form,
  onForm,
  disabled,
}: {
  form: BrowseForm;
  onForm: (next: BrowseForm) => void;
  disabled: boolean;
}) {
  const set = (patch: Partial<BrowseForm>) => onForm({ ...form, ...patch, offset: 0 });
  const chip = (active: boolean): CSSProperties => ({
    ...socialTabStyle(active),
    minHeight: SOCIAL_TOUCH,
  });
  return (
    <div style={sectionStyle}>
      <div role="group" aria-label="Category" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <button
          type="button"
          aria-pressed={form.category === ""}
          onClick={() => set({ category: "" })}
          style={chip(form.category === "")}
        >
          All
        </button>
        {ITEM_CATEGORIES.map((category: ItemCategory) => (
          <button
            key={category}
            type="button"
            aria-pressed={form.category === category}
            onClick={() => set({ category })}
            style={chip(form.category === category)}
          >
            {categoryLabel(category)}
          </button>
        ))}
      </div>
      <Field label="Search by name">
        <input
          type="search"
          value={form.q}
          disabled={disabled}
          onChange={(e) => set({ q: e.target.value })}
          style={inputStyle}
          placeholder="Name"
        />
      </Field>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Field label="Rarity">
          <select
            value={form.rarity}
            onChange={(e) => set({ rarity: e.target.value })}
            style={selectStyle}
          >
            <option value="">Any rarity</option>
            {RARITIES.map((r) => (
              <option key={r} value={r}>
                {rarityLabel(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sort">
          <select
            value={form.sort}
            onChange={(e) => set({ sort: e.target.value as BrowseForm["sort"] })}
            style={selectStyle}
          >
            {BROWSE_SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Field label="Min level">
          <input
            inputMode="numeric"
            value={form.minLevel}
            onChange={(e) => set({ minLevel: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="Max level">
          <input
            inputMode="numeric"
            value={form.maxLevel}
            onChange={(e) => set({ maxLevel: e.target.value })}
            style={inputStyle}
          />
        </Field>
      </div>
    </div>
  );
}

export interface BrowseBodyProps {
  state: LoadState<MarketSearchResponse> | undefined;
  form: BrowseForm;
  onForm: (next: BrowseForm) => void;
  onRetry: () => void;
  market: MarketViewProps["market"];
  selfId: string;
  canTrade: boolean;
  now: number;
  onChanged: () => void;
  filterError?: string | null;
}

export function BrowseBody({
  state,
  form,
  onForm,
  onRetry,
  market,
  selfId,
  canTrade,
  now,
  onChanged,
}: BrowseBodyProps) {
  const ready = state?.status === "ready" ? state.value : null;
  return (
    <div style={sectionStyle}>
      <BrowseFilters form={form} onForm={onForm} disabled={false} />
      {ready && !ready.available ? (
        <Banner tone="info">Market search is not available yet. Try again later.</Banner>
      ) : null}
      {state === undefined || state.status === "loading" ? (
        <StateNote kind="loading" message="Loading listings…" />
      ) : state.status === "error" ? (
        <StateNote kind="error" message={state.message} onRetry={onRetry} />
      ) : state.value.listings.length === 0 ? (
        <StateNote kind="empty" message="No listings match these filters." />
      ) : (
        <ul
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
          {state.value.listings.map((listing) => (
            <ListingRow
              key={listing.id}
              listing={listing}
              market={market}
              selfId={selfId}
              canTrade={canTrade}
              now={now}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {ready ? (
        <Pager
          offset={form.offset}
          pageSize={MARKET_PAGE}
          count={ready.listings.length}
          disabled={false}
          onPage={(offset) => onForm({ ...form, offset })}
        />
      ) : null}
    </div>
  );
}

function BrowseTab({
  market,
  selfId,
  canTrade,
  now,
  initialCategory,
  initialQuery,
}: {
  market: MarketViewProps["market"];
  selfId: string;
  canTrade: boolean;
  now: number;
  initialCategory?: ItemCategory;
  initialQuery?: string;
}) {
  const [form, setForm] = useState<BrowseForm>(() => ({
    ...EMPTY_BROWSE,
    category: initialCategory ?? "",
    q: initialQuery ?? "",
  }));
  // Typing waits 300 ms before a search goes out; paging and filters load at once.
  const settled = useDebounced(form, 300);
  const results = useReload(() => {
    const built = browseQuery(settled);
    if (!built.ok) {
      return Promise.resolve<LoadState<MarketSearchResponse>>({
        status: "error",
        message: built.message,
      });
    }
    return loadResult(() => market.search(built.query));
  }, JSON.stringify(settled));
  return (
    <BrowseBody
      state={results.state}
      form={form}
      onForm={setForm}
      onRetry={results.reload}
      market={market}
      selfId={selfId}
      canTrade={canTrade}
      now={now}
      onChanged={results.reload}
    />
  );
}

// ---------------------------------------------------------------------------
// Sell
// ---------------------------------------------------------------------------

export interface SellBodyProps {
  vault: LoadState<VaultResponse> | undefined;
  form: SellForm;
  onForm: (next: SellForm) => void;
  canTrade: boolean;
  busy: boolean;
  error: string | null;
  listed: boolean;
  onSubmit: () => void;
  onRetry: () => void;
}

export function SellBody({
  vault,
  form,
  onForm,
  canTrade,
  busy,
  error,
  listed,
  onSubmit,
  onRetry,
}: SellBodyProps) {
  if (!canTrade) {
    return <Banner tone="info">Create an account to list items for sale.</Banner>;
  }
  const fee = sellFeePreview(form);
  const items = vault?.status === "ready" ? sellableItems(vault.value.items) : [];
  return (
    <form
      aria-label="List an item"
      style={sectionStyle}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {listed ? <Success>Listed. Find it under Mine.</Success> : null}
      {vault === undefined || vault.status === "loading" ? (
        <StateNote kind="loading" message="Loading your vault…" />
      ) : vault.status === "error" ? (
        <StateNote kind="error" message={vault.message} onRetry={onRetry} />
      ) : items.length === 0 ? (
        <StateNote
          kind="empty"
          message="No vault item can be listed yet. Gems, materials, cosmetics and gear of item level 10 or more qualify."
        />
      ) : (
        <div
          role="radiogroup"
          aria-label="Item to sell"
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          {items.map((item) => {
            const selected = form.uid === item.uid;
            return (
              <button
                key={item.uid}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={item.summary.name}
                disabled={busy}
                onClick={() => onForm({ ...form, uid: item.uid })}
                style={{
                  ...rowBox,
                  cursor: "pointer",
                  textAlign: "left",
                  color: SOCIAL_C.text,
                  font: "inherit",
                  borderColor: selected ? SOCIAL_C.borderStrong : SOCIAL_C.border,
                  background: selected ? SOCIAL_C.own : SOCIAL_C.inner,
                }}
              >
                <ItemBadge summary={item.summary} />
                <ItemText summary={item.summary} />
              </button>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Field label="Buyout price (coin)" hint="Optional. Buy-now price.">
          <input
            inputMode="numeric"
            value={form.buyout}
            disabled={busy}
            onChange={(e) => onForm({ ...form, buyout: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="Start bid (coin)" hint="Optional. Lets buyers bid.">
          <input
            inputMode="numeric"
            value={form.startBid}
            disabled={busy}
            onChange={(e) => onForm({ ...form, startBid: e.target.value })}
            style={inputStyle}
          />
        </Field>
      </div>

      <div
        role="radiogroup"
        aria-label="Duration"
        style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
      >
        {MARKET_DURATIONS_H.map((hours) => (
          <button
            key={hours}
            type="button"
            role="radio"
            aria-checked={form.durationH === hours}
            disabled={busy}
            onClick={() => onForm({ ...form, durationH: hours as MarketDuration })}
            style={socialTabStyle(form.durationH === hours)}
          >
            {hours} h
          </button>
        ))}
      </div>

      <p role="status" style={{ ...mutedStyle, color: SOCIAL_C.text }}>
        {fee !== null
          ? `Listing fee: ${formatCoin(fee)}. It is 2 % of the buyout (or the start bid) and is never refunded.`
          : "Enter a price to see the listing fee."}
      </p>
      <p style={mutedStyle}>When it sells, the 5 % sales tax comes out of your proceeds.</p>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div style={actionsStyle}>
        <button
          type="submit"
          disabled={busy || !form.uid}
          style={socialButtonStyle({ primary: true, disabled: busy || !form.uid })}
        >
          List item
        </button>
      </div>
    </form>
  );
}

function SellTab({
  market,
  vault,
  canTrade,
  sellUid,
  onListed,
}: {
  market: MarketViewProps["market"];
  vault: MarketViewProps["vault"];
  canTrade: boolean;
  sellUid?: string;
  onListed: () => void;
}) {
  const [form, setForm] = useState<SellForm>({ ...EMPTY_SELL, uid: sellUid ?? "" });
  const [listed, setListed] = useState(false);
  const action = useAction();
  const items = useReload(
    () =>
      canTrade
        ? loadResult(() => vault.vault())
        : Promise.resolve<LoadState<VaultResponse>>({
            status: "ready",
            value: { items: [], max: 0 },
          }),
    canTrade ? "vault" : "guest",
  );

  const submit = () => {
    setListed(false);
    void action
      .run(() => listItem(market, form))
      .then((res) => {
        if (res.ok) {
          setForm({ ...EMPTY_SELL });
          setListed(true);
          items.reload();
          onListed();
        }
      });
  };

  return (
    <SellBody
      vault={items.state}
      form={form}
      onForm={setForm}
      canTrade={canTrade}
      busy={action.busy}
      error={action.error}
      listed={listed}
      onSubmit={submit}
      onRetry={items.reload}
    />
  );
}

// ---------------------------------------------------------------------------
// Mine
// ---------------------------------------------------------------------------

export interface MineBodyProps {
  state: LoadState<MarketMineResponse> | undefined;
  market: MarketViewProps["market"];
  selfId: string;
  canTrade: boolean;
  now: number;
  onRetry: () => void;
  onChanged: () => void;
}

export function MineBody({
  state,
  market,
  selfId,
  canTrade,
  now,
  onRetry,
  onChanged,
}: MineBodyProps) {
  if (!canTrade)
    return <Banner tone="info">Create an account to see your listings and bids.</Banner>;
  if (state === undefined || state.status === "loading") {
    return <StateNote kind="loading" message="Loading your listings…" />;
  }
  if (state.status === "error") {
    return <StateNote kind="error" message={state.message} onRetry={onRetry} />;
  }
  const { listings, bids } = state.value;
  if (listings.length === 0 && bids.length === 0) {
    return <StateNote kind="empty" message="You have no listings or bids yet." />;
  }
  return (
    <div style={sectionStyle}>
      {listings.length > 0 ? (
        <h4 style={{ margin: 0, color: SOCIAL_C.gold, fontSize: 13 }}>Listed by me</h4>
      ) : null}
      <ul
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
        {listings.map((listing) => (
          <ListingRow
            key={listing.id}
            listing={listing}
            market={market}
            selfId={selfId}
            canTrade={canTrade}
            now={now}
            variant="mine"
            onChanged={onChanged}
          />
        ))}
      </ul>
      {bids.length > 0 ? (
        <h4 style={{ margin: 0, color: SOCIAL_C.gold, fontSize: 13 }}>Where I lead</h4>
      ) : null}
      <ul
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
        {bids.map((listing) => (
          <ListingRow
            key={listing.id}
            listing={listing}
            market={market}
            selfId={selfId}
            canTrade={canTrade}
            now={now}
            onChanged={onChanged}
          />
        ))}
      </ul>
    </div>
  );
}

function MineTab({
  market,
  selfId,
  canTrade,
  now,
}: {
  market: MarketViewProps["market"];
  selfId: string;
  canTrade: boolean;
  now: number;
}) {
  const mine = useReload(
    () =>
      canTrade
        ? loadResult(() => market.mine())
        : Promise.resolve<LoadState<MarketMineResponse>>({
            status: "ready",
            value: { listings: [], bids: [] },
          }),
    canTrade ? "mine" : "guest",
  );
  return (
    <MineBody
      state={mine.state}
      market={market}
      selfId={selfId}
      canTrade={canTrade}
      now={now}
      onRetry={mine.reload}
      onChanged={mine.reload}
    />
  );
}

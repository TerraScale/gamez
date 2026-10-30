import { describe, expect, it } from "vite-plus/test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ItemSummary,
  MarketListing,
  MarketMineResponse,
  MarketSearchResponse,
  Notice,
  PlotsResponse,
  PlotView,
  ShopView,
  TradeView,
  VaultItem,
  VaultResponse,
} from "@gamez/protocol";
import { BrowseBody, ListingRow, MineBody, SellBody } from "../src/economy/MarketView.tsx";
import { NoticesBody } from "../src/economy/NoticesView.tsx";
import { PlotsBody } from "../src/economy/PlotsView.tsx";
import { ShopBody } from "../src/economy/ShopView.tsx";
import { TradeBody } from "../src/economy/TradeWindow.tsx";
import { VaultBody } from "../src/economy/VaultView.tsx";
import { EMPTY_BROWSE, EMPTY_SELL } from "../src/economy/parts/flows.ts";
import type { MarketApi, ShopsApi, VaultApi } from "../src/platform.ts";

// ---------------------------------------------------------------------------
// Fixtures. Static rendering runs no effects, so the APIs are only handed over.
// ---------------------------------------------------------------------------

const NO_API = {} as never as MarketApi & ShopsApi & VaultApi;
const NOOP = () => {};

const SUMMARY: ItemSummary = {
  name: "Iron Wolf Sword",
  rarity: "rare",
  level: 14,
  category: "weapon",
  slot: "weapon",
  icon: "item.sword",
  lines: ["+12 Strength", "Adds 3 to 9 damage"],
};

function vaultItem(uid: string, patch: Partial<VaultItem> = {}): VaultItem {
  return {
    uid,
    itemId: "classic.sword",
    count: 1,
    origin: "classic",
    universal: false,
    tradable: true,
    summary: SUMMARY,
    data: null,
    ...patch,
  };
}

const party = (accountId: string, displayName: string) => ({ accountId, displayName });

function listing(patch: Partial<MarketListing> = {}): MarketListing {
  return {
    id: "classic:weapon/42",
    shard: "classic:weapon",
    seller: party("seller", "Seller Ann"),
    item: {
      itemId: "classic.sword",
      count: 1,
      origin: "classic",
      universal: false,
      tradable: true,
      summary: SUMMARY,
    },
    buyout: 1000,
    startBid: 100,
    topBid: null,
    topBidder: null,
    bids: 0,
    fee: 20,
    createdAt: 1,
    endsAt: 10 * 3_600_000,
    status: "active",
    soldFor: null,
    ...patch,
  };
}

const NOW = 0;

function trade(patch: Partial<TradeView> = {}): TradeView {
  return {
    id: "t0123456789abcdef01234567",
    a: party("me", "Mario"),
    b: party("them", "Ann"),
    offers: {
      a: { coin: 50, items: [vaultItem("u1")], version: 2 },
      b: { coin: 0, items: [], version: 1 },
    },
    accepted: { a: null, b: null },
    status: "open",
    reason: null,
    fees: { a: 1, b: 0 },
    createdAt: 1,
    expiresAt: 600_001,
    ...patch,
  };
}

function plot(patch: Partial<PlotView> = {}): PlotView {
  return {
    id: "p1",
    world: "classic-town",
    pos: { x: 3, y: 4 },
    state: "auction",
    auction: {
      startedAt: 0,
      endsAt: 3_600_000,
      minBid: 50,
      topBid: 80,
      topBidder: party("x", "Bo"),
      bids: 2,
    },
    lease: null,
    shopName: null,
    ...patch,
  } as PlotView;
}

function shopView(patch: Partial<ShopView> = {}): ShopView {
  return {
    plotId: "p2",
    world: "classic-town",
    owner: party("me", "Mario"),
    name: "Ember Forge",
    appearance: "unit.hero",
    open: true,
    stock: [{ entryId: "e7", item: vaultItem("u9"), price: 120 }],
    earnings: 300,
    leaseEndsAt: 5 * 86_400_000,
    ...patch,
  };
}

function notice(id: string, patch: Partial<Notice> = {}): Notice {
  return { id, at: 1000, kind: "system", text: "Notice text", data: {}, read: false, ...patch };
}

/** Every px width written into an inline style (not min-width or max-width). */
function fixedWidths(html: string): number[] {
  return [...html.matchAll(/(?:^|[;"\s])width:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
}

/** Renders a 375 px wide container and asserts nothing inside has a fixed width above it. */
function renderAt375(element: ReactElement): string {
  const html = renderToStaticMarkup(
    <div style={{ width: 375, maxWidth: "100%", boxSizing: "border-box" }}>{element}</div>,
  );
  for (const width of fixedWidths(html)) expect(width).toBeLessThanOrEqual(375);
  return html;
}

// ---------------------------------------------------------------------------

describe("VaultView at 375 px", () => {
  const base = {
    busy: false,
    error: null,
    coinText: "",
    onCoinText: NOOP,
    onWithdrawCoin: NOOP,
    onWithdrawItem: NOOP,
    onRetry: NOOP,
  };
  const wallet = { status: "ready" as const, value: { balances: { coin: 500, gem: 3 } } };

  it("loading state", () => {
    const html = renderAt375(<VaultBody {...base} vault={undefined} wallet={undefined} />);
    expect(html).toContain("Loading your vault");
    expect(html).toContain("coin —");
  });

  it("error state with retry", () => {
    const html = renderAt375(
      <VaultBody
        {...base}
        vault={{ status: "error", message: "Network error, try again" }}
        wallet={wallet}
      />,
    );
    expect(html).toContain("Network error, try again");
    expect(html).toContain("Try again");
  });

  it("empty state points at the bank in town", () => {
    const html = renderAt375(
      <VaultBody
        {...base}
        vault={{ status: "ready", value: { items: [], max: 200 } }}
        wallet={wallet}
        bank={{
          blocked: null,
          withdrawItem: async () => ({ ok: true }),
          withdrawCoin: async () => ({ ok: true }),
        }}
      />,
    );
    expect(html).toContain("Deposit items at the bank in town.");
    expect(html).toContain("0 / 200 items");
  });

  it("data state: rows, balances, bank withdraw and sell, blocked hint", () => {
    const value: VaultResponse = {
      items: [vaultItem("u1"), vaultItem("u2", { tradable: false })],
      max: 200,
    };
    const html = renderAt375(
      <VaultBody
        {...base}
        vault={{ status: "ready", value }}
        wallet={wallet}
        bank={{
          blocked: "Walk to town to use the bank.",
          withdrawItem: async () => ({ ok: true }),
          withdrawCoin: async () => ({ ok: true }),
        }}
        onSell={NOOP}
      />,
    );
    expect(html).toContain("500 coin");
    expect(html).toContain("3 gems");
    expect(html).toContain("Iron Wolf Sword");
    expect(html).toContain("Walk to town to use the bank.");
    expect(html).toContain("Withdraw Iron Wolf Sword");
    expect(html).toContain("Sell Iron Wolf Sword on the market");
    expect(html).toContain("Not tradable");
    expect(html).toContain("Withdraw coin");
    expect(html).toContain("IW");
  });

  it("tells the player when deliveries wait for a free slot", () => {
    const full: VaultResponse = {
      items: [vaultItem("u1")],
      max: 1,
      waiting: { count: 2, since: NOW - 60_000 },
    };
    const html = renderAt375(
      <VaultBody {...base} vault={{ status: "ready", value: full }} wallet={wallet} />,
    );
    expect(html).toContain("2 deliveries are waiting for a free slot");
    const none = renderAt375(
      <VaultBody
        {...base}
        vault={{ status: "ready", value: { ...full, waiting: { count: 0, since: null } } }}
        wallet={wallet}
      />,
    );
    expect(none).not.toContain("waiting for a free slot");
  });

  it("read-only vault has no bank controls", () => {
    const html = renderAt375(
      <VaultBody
        {...base}
        vault={{ status: "ready", value: { items: [vaultItem("u1")], max: 200 } }}
        wallet={wallet}
      />,
    );
    expect(html).not.toContain("Withdraw coin");
    expect(html).not.toContain("Withdraw Iron");
  });
});

describe("MarketView at 375 px", () => {
  const rowProps = { market: NO_API, selfId: "me", canTrade: true, now: NOW, onChanged: NOOP };

  it("browse loading, error and empty", () => {
    const common = {
      form: EMPTY_BROWSE,
      onForm: NOOP,
      onRetry: NOOP,
      market: NO_API,
      selfId: "me",
      canTrade: true,
      now: NOW,
      onChanged: NOOP,
    };
    expect(renderAt375(<BrowseBody {...common} state={undefined} />)).toContain("Loading listings");
    expect(
      renderAt375(
        <BrowseBody {...common} state={{ status: "error", message: "Market is down" }} />,
      ),
    ).toContain("Market is down");
    const empty: MarketSearchResponse = { listings: [], available: true };
    expect(
      renderAt375(<BrowseBody {...common} state={{ status: "ready", value: empty }} />),
    ).toContain("No listings match these filters.");
  });

  it("browse data: filters, rows, unavailable search", () => {
    const common = {
      form: { ...EMPTY_BROWSE, category: "weapon" as const },
      onForm: NOOP,
      onRetry: NOOP,
      market: NO_API,
      selfId: "me",
      canTrade: false,
      now: NOW,
      onChanged: NOOP,
    };
    const html = renderAt375(
      <BrowseBody
        {...common}
        state={{ status: "ready", value: { listings: [listing()], available: true } }}
      />,
    );
    expect(html).toContain("Weapons");
    expect(html).toContain("Buyout 1,000 coin");
    expect(html).toContain("Start bid 100 coin");
    expect(html).toContain("Sort");
    expect(html).toContain("Previous");
    const unavailable = renderAt375(
      <BrowseBody
        {...common}
        state={{ status: "ready", value: { listings: [], available: false } }}
      />,
    );
    expect(unavailable).toContain("Market search is not available yet.");
  });

  it("a buy-now row shows the buy button; a guest sees no buy or bid", () => {
    const member = renderAt375(<ListingRow {...rowProps} listing={listing()} />);
    expect(member).toContain("Buy Iron Wolf Sword");
    expect(member).toContain("Bid on Iron Wolf Sword");
    const guest = renderAt375(<ListingRow {...rowProps} canTrade={false} listing={listing()} />);
    expect(guest).not.toContain("Buy Iron Wolf Sword");
    const own = renderAt375(<ListingRow {...rowProps} selfId="seller" listing={listing()} />);
    expect(own).toContain("Your listing");
    expect(own).not.toContain("Buy Iron Wolf Sword");
  });

  it("sell form: picker, fee preview and the sales tax note", () => {
    const common = {
      form: EMPTY_SELL,
      onForm: NOOP,
      canTrade: true,
      busy: false,
      error: null,
      listed: false,
      onSubmit: NOOP,
      onRetry: NOOP,
    };
    const html = renderAt375(
      <SellBody
        {...common}
        vault={{
          status: "ready",
          value: { items: [vaultItem("u1"), vaultItem("u2", { tradable: false })], max: 200 },
        }}
      />,
    );
    expect(html).toContain('role="radio"');
    expect(html).toContain("Enter a price to see the listing fee.");
    expect(html).toContain("5 % sales tax");
    expect(html).toContain("24 h");

    const priced = renderAt375(
      <SellBody
        {...common}
        form={{ ...EMPTY_SELL, uid: "u1", buyout: "1000" }}
        vault={{ status: "ready", value: { items: [vaultItem("u1")], max: 200 } }}
      />,
    );
    expect(priced).toContain("Listing fee: 20 coin.");
  });

  it("sell for guests and with an empty vault", () => {
    const guest = renderAt375(
      <SellBody
        form={EMPTY_SELL}
        onForm={NOOP}
        canTrade={false}
        busy={false}
        error={null}
        listed={false}
        onSubmit={NOOP}
        onRetry={NOOP}
        vault={undefined}
      />,
    );
    expect(guest).toContain("Create an account to list items for sale.");
    const empty = renderAt375(
      <SellBody
        form={EMPTY_SELL}
        onForm={NOOP}
        canTrade
        busy={false}
        error={null}
        listed={true}
        onSubmit={NOOP}
        onRetry={NOOP}
        vault={{ status: "ready", value: { items: [], max: 200 } }}
      />,
    );
    expect(empty).toContain("No vault item can be listed yet.");
    expect(empty).toContain("Listed. Find it under Mine.");
  });

  it("mine: loading, guest, empty and both lists", () => {
    const common = { market: NO_API, selfId: "me", now: NOW, onRetry: NOOP, onChanged: NOOP };
    expect(renderAt375(<MineBody {...common} canTrade state={undefined} />)).toContain(
      "Loading your listings",
    );
    expect(renderAt375(<MineBody {...common} canTrade={false} state={undefined} />)).toContain(
      "Create an account to see your listings and bids.",
    );
    expect(
      renderAt375(
        <MineBody
          {...common}
          canTrade
          state={{ status: "ready", value: { listings: [], bids: [] } }}
        />,
      ),
    ).toContain("You have no listings or bids yet.");
    const value: MarketMineResponse = {
      listings: [listing()],
      bids: [listing({ id: "classic:weapon/43", topBid: 300, topBidder: party("me", "Mario") })],
    };
    const html = renderAt375(<MineBody {...common} canTrade state={{ status: "ready", value }} />);
    expect(html).toContain("Listed by me");
    expect(html).toContain("Where I lead");
    expect(html).toContain("Cancel Iron Wolf Sword");
  });
});

describe("TradeWindow at 375 px", () => {
  const common = {
    selfId: "me",
    canTrade: true,
    busy: false,
    error: null,
    onAccept: NOOP,
    onCancel: NOOP,
    onClose: NOOP,
    onRetry: NOOP,
  };

  it("loading and error", () => {
    expect(renderAt375(<TradeBody {...common} state={undefined} />)).toContain("Opening the trade");
    expect(
      renderAt375(<TradeBody {...common} state={{ status: "error", message: "Gone" }} />),
    ).toContain("Gone");
  });

  it("a guest without a trade sees the account prompt, not a loading or error note", () => {
    const html = renderAt375(<TradeBody {...common} canTrade={false} state={undefined} />);
    expect(html).toContain("Create an account to trade.");
    expect(html).not.toContain("Opening the trade");
  });

  it("open trade: two columns, status, accept and cancel", () => {
    const html = renderAt375(
      <TradeBody
        {...common}
        state={{ status: "ready", value: trade() }}
        renderEditor={() => <p>editor here</p>}
      />,
    );
    expect(html).toContain("Trade with Ann");
    expect(html).toContain("50 coin");
    expect(html).toContain("Iron Wolf Sword");
    expect(html).toContain("Set your offer");
    expect(html).toContain("Accept trade");
    expect(html).toContain("Cancel trade");
    expect(html).toContain("editor here");
  });

  it("accepted by me on the current versions: button says so and is disabled", () => {
    const html = renderAt375(
      <TradeBody
        {...common}
        state={{ status: "ready", value: trade({ accepted: { a: [2, 1], b: null } }) }}
      />,
    );
    expect(html).toContain("You accepted. Waiting");
    expect(html).toContain("Accepted</button>");
  });

  it("done, failed and guests", () => {
    const done = renderAt375(
      <TradeBody {...common} state={{ status: "ready", value: trade({ status: "done" }) }} />,
    );
    expect(done).toContain("Trade complete.");
    expect(done).not.toContain("Accept trade");
    const failed = renderAt375(
      <TradeBody
        {...common}
        state={{
          status: "ready",
          value: trade({ status: "failed", reason: "insufficient_funds" }),
        }}
      />,
    );
    expect(failed).toContain("Trade failed: Not enough coin.");
    const guest = renderAt375(
      <TradeBody {...common} canTrade={false} state={{ status: "ready", value: trade() }} />,
    );
    expect(guest).toContain("Create an account to trade.");
  });
});

describe("PlotsView at 375 px", () => {
  const common = {
    shops: NO_API,
    world: "classic-town",
    now: NOW,
    coin: 400,
    canTrade: true,
    onOpenShop: NOOP,
    onChanged: NOOP,
    onRetry: NOOP,
  };

  it("loading, error and empty", () => {
    expect(renderAt375(<PlotsBody {...common} state={undefined} />)).toContain("Loading the plots");
    expect(
      renderAt375(<PlotsBody {...common} state={{ status: "error", message: "No plots" }} />),
    ).toContain("No plots");
    expect(
      renderAt375(
        <PlotsBody
          {...common}
          state={{ status: "ready", value: { world: "classic-town", plots: [] } }}
        />,
      ),
    ).toContain("No shop plots in this town yet.");
  });

  it("auction, leased and grace plots", () => {
    const value: PlotsResponse = {
      world: "classic-town",
      plots: [
        plot(),
        plot({
          id: "p2",
          state: "leased",
          auction: null,
          shopName: "Ember Forge",
          lease: {
            owner: party("me", "Mario"),
            startedAt: 0,
            endsAt: 9,
            rent: 30,
            paidUntil: 7_200_000,
            graceUntil: null,
          },
        }),
        plot({
          id: "p3",
          state: "grace",
          auction: null,
          shopName: "Old Shop",
          lease: {
            owner: party("x", "Bo"),
            startedAt: 0,
            endsAt: 9,
            rent: 30,
            paidUntil: 1,
            graceUntil: 3_600_000,
          },
        }),
      ],
    };
    const html = renderAt375(<PlotsBody {...common} state={{ status: "ready", value }} />);
    expect(html).toContain("Plot 1");
    expect(html).toContain("Top bid 80 coin by Bo");
    expect(html).toContain("Minimum bid 84 coin");
    expect(html).toContain("Ember Forge");
    expect(html).toContain("Open Ember Forge");
    expect(html).toContain("Rent is overdue");
    expect(html).toContain("Rent overdue");
  });

  it("guests cannot bid", () => {
    const html = renderAt375(
      <PlotsBody
        {...common}
        canTrade={false}
        state={{ status: "ready", value: { world: "classic-town", plots: [plot()] } }}
      />,
    );
    expect(html).toContain("Create an account to bid on a plot.");
  });
});

describe("ShopView at 375 px", () => {
  const common = {
    now: NOW,
    coin: 400,
    action: {
      busy: false,
      error: null,
      run: async <T,>(
        fn: () => Promise<{ ok: true; value: T } | { ok: false; code: string; message: string }>,
      ) => fn(),
      clear: NOOP,
    },
    shops: NO_API,
    vault: NO_API,
    world: "classic-town",
    plotId: "p2",
    onRefresh: NOOP,
    onRetry: NOOP,
    onClose: NOOP,
  };

  it("loading and error", () => {
    expect(renderAt375(<ShopBody {...common} selfId="me" canTrade state={undefined} />)).toContain(
      "Opening the shop",
    );
    expect(
      renderAt375(
        <ShopBody {...common} selfId="me" canTrade state={{ status: "error", message: "Gone" }} />,
      ),
    ).toContain("Gone");
  });

  it("owner: settings, earnings, claim and the stock list with take off sale", () => {
    const html = renderAt375(
      <ShopBody {...common} selfId="me" canTrade state={{ status: "ready", value: shopView() }} />,
    );
    expect(html).toContain("Manage your shop");
    expect(html).toContain("Earnings 300 coin after tax");
    expect(html).toContain("Claim earnings");
    expect(html).toContain("Take Iron Wolf Sword off sale");
    expect(html).toContain("Put on sale");
    expect(html).toContain("Lease ends in");
  });

  it("visitor: buy, confirm not shown yet, closed and guest hints", () => {
    const open = renderAt375(
      <ShopBody
        {...common}
        selfId="them"
        canTrade
        state={{ status: "ready", value: shopView() }}
      />,
    );
    expect(open).toContain("Buy Iron Wolf Sword");
    expect(open).toContain("You have 400 coin.");
    expect(open).not.toContain("Manage your shop");
    const closed = renderAt375(
      <ShopBody
        {...common}
        selfId="them"
        canTrade
        state={{ status: "ready", value: shopView({ open: false }) }}
      />,
    );
    expect(closed).toContain("This shop is closed right now.");
    expect(closed).not.toContain("Buy Iron Wolf Sword");
    const guest = renderAt375(
      <ShopBody
        {...common}
        selfId=""
        canTrade={false}
        state={{ status: "ready", value: shopView() }}
      />,
    );
    expect(guest).toContain("Create an account to buy.");
    expect(guest).not.toContain("Buy Iron Wolf Sword");
  });
});

describe("NoticesView at 375 px", () => {
  const common = {
    canOpen: true,
    busy: false,
    error: null,
    onOpen: NOOP,
    onMarkAll: NOOP,
    onRetry: NOOP,
  };

  it("loading, error and empty", () => {
    expect(renderAt375(<NoticesBody {...common} state={undefined} />)).toContain("Loading notices");
    expect(
      renderAt375(<NoticesBody {...common} state={{ status: "error", message: "Nope" }} />),
    ).toContain("Nope");
    expect(
      renderAt375(
        <NoticesBody {...common} state={{ status: "ready", value: { notices: [], unread: 0 } }} />,
      ),
    ).toContain("No notices yet.");
  });

  it("data: unread markers, mark all read and Open only on linkable notices", () => {
    const html = renderAt375(
      <NoticesBody
        {...common}
        state={{
          status: "ready",
          value: {
            notices: [
              notice("n1", {
                kind: "trade.invite",
                text: "Ann invites you to trade",
                data: { tradeId: "t1" },
              }),
              notice("n2", { kind: "system", text: "Welcome", read: true }),
            ],
            unread: 1,
          },
        }}
      />,
    );
    expect(html).toContain("Notices (1 new)");
    expect(html).toContain("Mark all read");
    expect(html).toContain("Ann invites you to trade");
    expect(html).toContain('aria-label="Unread"');
    expect(html).toContain("Open: Ann invites you to trade");
    expect(html).not.toContain("Open: Welcome");
  });

  it("no Open buttons without an open handler", () => {
    const html = renderAt375(
      <NoticesBody
        {...common}
        canOpen={false}
        state={{
          status: "ready",
          value: {
            notices: [notice("n1", { kind: "market.sold", data: { listingId: "x/1" } })],
            unread: 0,
          },
        }}
      />,
    );
    expect(html).not.toContain("Open:");
  });
});

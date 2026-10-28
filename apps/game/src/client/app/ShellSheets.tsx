/**
 * The shell's sheet stack (wave C, docs/design/wave-C.md §10.4). Each sheet
 * wraps one screen; the screen bodies are lazy (React.lazy) so the economy UI
 * stays out of the main chunk. A missing platform API renders "not available"
 * instead of a broken screen (every platform field is optional).
 */
import { lazy, Suspense } from "react";
import {
  AccountPanel,
  GuildView,
  LeaderboardView,
  type AccountChange,
  type AccountView,
  type PlatformServices,
  type Session,
} from "@gamez/ui-host";
import { ART_BASE } from "./services.ts";
import { SOCIAL_CLASSES } from "./classes.ts";
import { Sheet } from "./Sheet.tsx";
import { itemTitle, noticeTarget, type ShellItem } from "./screens.ts";

// Lazy: the economy and play views load from their own subpath entries. A
// dynamic import of the "@gamez/ui-host" root (also imported statically) kept
// every view in the entry graph and pulled the classic client chunk in with it
// (QA wave C: the entry graph grew 29 % over wave B). The arena screen comes
// from its mode package.
const MarketView = lazy(() =>
  import("@gamez/ui-host/economy").then((m) => ({ default: m.MarketView })),
);
const VaultView = lazy(() =>
  import("@gamez/ui-host/economy").then((m) => ({ default: m.VaultView })),
);
const TradeWindow = lazy(() =>
  import("@gamez/ui-host/economy").then((m) => ({ default: m.TradeWindow })),
);
const PlotsView = lazy(() =>
  import("@gamez/ui-host/economy").then((m) => ({ default: m.PlotsView })),
);
const ShopView = lazy(() =>
  import("@gamez/ui-host/economy").then((m) => ({ default: m.ShopView })),
);
const NoticesView = lazy(() =>
  import("@gamez/ui-host/economy").then((m) => ({ default: m.NoticesView })),
);
const BattlePassView = lazy(() =>
  import("@gamez/ui-host/play").then((m) => ({ default: m.BattlePassView })),
);
const StoreView = lazy(() => import("@gamez/ui-host/play").then((m) => ({ default: m.StoreView })));
const ArenaScreen = lazy(() =>
  import("@gamez/mode-arena/client").then((m) => ({ default: m.ArenaScreen })),
);

export interface ShellSheetsProps {
  /** The stack, bottom first. The last item is the visible sheet. */
  items: readonly ShellItem[];
  platform: PlatformServices | undefined;
  session: Session;
  account: AccountView | null;
  /** Closes the sheet at `index` and everything above it. */
  onCloseFrom: (index: number) => void;
  /** Pushes a sheet (the app gates it by feature flag). */
  onOpen: (item: ShellItem) => void;
  onAccountChanged: (change: AccountChange) => void;
  /** Re-reads the account (guild changes, renames). */
  onRefreshAccount: () => void;
  /** Payment checkout URL: the app navigates to it. */
  onCheckout: (url: string) => void;
}

/** Shown when the platform does not provide the API a screen needs. */
function Unavailable() {
  return <p className="shell-empty">Not available right now.</p>;
}

function Loading() {
  return <p className="screen-message">Loading…</p>;
}

export function ShellSheets(props: ShellSheetsProps) {
  const top = props.items.length - 1;
  return (
    <>
      {props.items.map((item, index) => (
        // The key carries the content, so a replaced sheet (another trade) remounts its body.
        <Sheet
          key={`${index}:${JSON.stringify(item)}`}
          title={itemTitle(item)}
          active={index === top}
          hidden={index !== top}
          onClose={() => props.onCloseFrom(index)}
        >
          <Suspense fallback={<Loading />}>
            <ScreenBody {...props} item={item} index={index} />
          </Suspense>
        </Sheet>
      ))}
    </>
  );
}

interface BodyProps extends ShellSheetsProps {
  item: ShellItem;
  index: number;
}

function ScreenBody(props: BodyProps) {
  const { item, index, platform, session } = props;
  const selfId = session.accountId;
  // Trading (and buying) needs a registered account; guests browse and bank.
  const canTrade = session.kind === "registered";
  const closeSelf = () => props.onCloseFrom(index);

  if (item.id === "account") {
    if (!platform) return <Unavailable />;
    return (
      <AccountPanel
        auth={platform.auth}
        account={props.account}
        compact
        onChanged={(change) => {
          // Signed out: close the sheet so the header chip is reachable again (phone).
          if (change === "signed-out") closeSelf();
          props.onAccountChanged(change);
        }}
      />
    );
  }
  if (item.id === "leaderboards") {
    if (!platform) return <Unavailable />;
    return (
      <LeaderboardView
        api={platform.leaderboards}
        mode="classic"
        classes={SOCIAL_CLASSES}
        selfId={props.account?.accountId ?? null}
        compact
      />
    );
  }
  if (item.id === "guild") {
    if (!platform) return <Unavailable />;
    return (
      <GuildView
        guilds={platform.guilds}
        account={props.account}
        chat={platform.chat}
        compact
        onChanged={props.onRefreshAccount}
      />
    );
  }

  if (!platform) return <Unavailable />;
  const { vault, market, trade, shops, arena, pass, store } = platform;

  switch (item.id) {
    case "market":
      if (!market || !vault) return <Unavailable />;
      return (
        <MarketView
          market={market}
          vault={vault}
          account={platform.account}
          selfId={selfId}
          canTrade={canTrade}
          initialCategory={item.category}
          initialQuery={item.q}
          sellUid={item.sellUid}
          compact
        />
      );
    case "vault":
      if (!vault) return <Unavailable />;
      return (
        <VaultView
          vault={vault}
          account={platform.account}
          onSell={(uid) => props.onOpen({ id: "market", sellUid: uid })}
          compact
        />
      );
    case "trade":
      if (!trade || !vault) return <Unavailable />;
      return (
        <TradeWindow
          trade={trade}
          vault={vault}
          account={platform.account}
          selfId={selfId}
          canTrade={canTrade}
          with={item.with}
          tradeId={item.tradeId}
          onClose={closeSelf}
        />
      );
    case "plots":
      if (!shops) return <Unavailable />;
      return (
        <PlotsView
          shops={shops}
          account={platform.account}
          world={item.world}
          selfId={selfId}
          canTrade={canTrade}
          onOpenShop={(plotId) => props.onOpen({ id: "shop", world: item.world, plotId })}
        />
      );
    case "shop":
      if (!shops || !vault) return <Unavailable />;
      return (
        <ShopView
          shops={shops}
          vault={vault}
          account={platform.account}
          world={item.world}
          plotId={item.plotId}
          selfId={selfId}
          canTrade={canTrade}
          onClose={closeSelf}
        />
      );
    case "arena":
      if (!arena) return <Unavailable />;
      return (
        <ArenaScreen
          platform={platform}
          accountId={selfId}
          assetBaseUrl={ART_BASE}
          onClose={closeSelf}
          embedded
        />
      );
    case "pass":
      if (!pass) return <Unavailable />;
      return (
        <BattlePassView
          pass={pass}
          account={platform.account}
          onBuyPremium={() => props.onOpen({ id: "store" })}
          canSpendGems={canTrade}
          compact
        />
      );
    case "store":
      if (!store) return <Unavailable />;
      return (
        <StoreView
          store={store}
          account={platform.account}
          country={countryOf(globalThis.navigator?.language)}
          onCheckout={props.onCheckout}
          canBuy={canTrade}
        />
      );
    case "notices":
      if (!vault) return <Unavailable />;
      return (
        <NoticesView
          vault={vault}
          onOpen={(notice) => {
            const target = noticeTarget(notice);
            if (target) props.onOpen(target);
          }}
        />
      );
  }
  return <Unavailable />;
}

/** The region of a BCP 47 language tag ("pt-BR" -> "BR"), for provider routing. */
export function countryOf(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const region = language.split("-").find((part, i) => i > 0 && /^[A-Za-z]{2}$/.test(part));
  return region?.toUpperCase();
}

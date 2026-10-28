/**
 * Store: gem packs, the season pass and cosmetic bundles, paid through a
 * provider (wave-C.md §8). OWNER: T-pay. The store does not navigate itself:
 * a successful checkout hands the provider URL to onCheckout (the shell assigns
 * location). Pure helpers are exported for tests; the component only wires them.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  CheckoutResponse,
  FiatCurrency,
  OrderStatus,
  OrderView,
  PaymentProviderId,
  PaymentProviderInfo,
  Product,
  ProductPrice,
  StoreResponse,
} from "@gamez/protocol";
import type { ApiResult, StoreApi } from "../platform.ts";
import {
  SOCIAL_C,
  SOCIAL_TOUCH,
  badgeStyle,
  errorTextStyle,
  headingStyle,
  listStyle,
  mutedStyle,
  okTextStyle,
  rowStyle,
  sheetStyle,
  socialButtonStyle,
  socialTabStyle,
  subheadingStyle,
} from "../social/styles.ts";
import type { StoreViewProps } from "./index.ts";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export const STORE_CURRENCIES: readonly FiatCurrency[] = ["USD", "BRL"];

/** BRL for Brazilian visitors, USD otherwise. */
export function currencyFor(country: string | null | undefined): FiatCurrency {
  return country?.trim().toUpperCase() === "BR" ? "BRL" : "USD";
}

/** "R$ 4,90" / "$0.99", from minor units. */
export function formatMinor(amountMinor: number, currency: string): string {
  const locale = currency === "BRL" ? "pt-BR" : "en-US";
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amountMinor / 100);
}

export function priceIn(product: Product, currency: FiatCurrency): ProductPrice | null {
  return product.prices.find((p) => p.currency === currency) ?? null;
}

export const KIND_ORDER: readonly Product["kind"][] = ["gems", "pass", "cosmetic"];

export const KIND_TITLE: Record<Product["kind"], string> = {
  gems: "Gem packs",
  pass: "Season pass",
  cosmetic: "Cosmetics",
};

/** Products grouped by kind in KIND_ORDER; empty groups are dropped. */
export function groupProducts(
  products: readonly Product[],
): { kind: Product["kind"]; title: string; items: Product[] }[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    title: KIND_TITLE[kind],
    items: products.filter((p) => p.kind === kind),
  })).filter((g) => g.items.length > 0);
}

export const PROVIDER_NAME: Record<PaymentProviderId, string> = {
  stripe: "Card (Stripe)",
  asaas: "Asaas",
  mercadopago: "Mercado Pago",
  stub: "Sandbox (no money moves)",
};

export interface ProviderOption {
  id: PaymentProviderId;
  label: string;
  badges: string[];
  suggested: boolean;
}

const METHOD_BADGE: Record<string, string> = { pix: "PIX", boleto: "Boleto", card: "Card" };

/**
 * The providers a shopper can pay with in `currency`: enabled, taking that
 * currency, the suggested one first, the rest in the server's order.
 */
export function providerOptions(
  providers: readonly PaymentProviderInfo[],
  suggested: PaymentProviderId | null,
  currency: FiatCurrency,
): ProviderOption[] {
  const usable = providers.filter((p) => p.enabled && p.currencies.includes(currency));
  const ordered = [
    ...usable.filter((p) => p.id === suggested),
    ...usable.filter((p) => p.id !== suggested),
  ];
  return ordered.map((p) => ({
    id: p.id,
    label: PROVIDER_NAME[p.id],
    badges: [
      ...p.methods.map((m) => METHOD_BADGE[m]).filter((b): b is string => b !== undefined),
      ...(p.stub ? ["Sandbox"] : []),
    ],
    suggested: p.id === suggested,
  }));
}

export function checkoutKey(
  sku: string,
  provider: PaymentProviderId,
  currency: FiatCurrency,
): string {
  return `${sku}|${provider}|${currency}`;
}

export function makeOpId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * One checkout attempt. The opId of (sku, provider, currency) is kept in `ops`
 * so a retry after a network failure is the same order on the server; any other
 * answer (success or a real refusal) ends the attempt and forgets the opId.
 */
export async function checkoutOnce(
  store: StoreApi,
  ops: Map<string, string>,
  req: { sku: string; provider: PaymentProviderId; currency: FiatCurrency },
): Promise<ApiResult<CheckoutResponse>> {
  const key = checkoutKey(req.sku, req.provider, req.currency);
  const opId = ops.get(key) ?? makeOpId();
  ops.set(key, opId);
  const res = await store.checkout(req.sku, req.provider, req.currency, opId);
  if (res.ok || res.code !== "network") ops.delete(key);
  return res;
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Waiting for payment",
  paid: "Paid",
  refunded: "Refunded",
  failed: "Failed",
};

export function orderTitle(order: OrderView, products: readonly Product[]): string {
  return products.find((p) => p.sku === order.sku)?.name ?? order.sku;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type CatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: StoreResponse };

type OrdersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; orders: OrderView[] };

const TOUCH_ROW: CSSProperties = { minHeight: SOCIAL_TOUCH, minWidth: 0 };

/** "Balance: 1,200 coin · 100 gems" ("Balance: —" while unknown). */
export function balanceLine(b: { coin: number; gem: number } | null): string {
  if (!b) return "Balance: —";
  return `Balance: ${b.coin.toLocaleString("en-US")} coin · ${b.gem.toLocaleString("en-US")} gems`;
}

export function StoreView(props: StoreViewProps) {
  const { store, country, canBuy } = props;
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  const [orders, setOrders] = useState<OrdersState>({ status: "loading" });
  const [currency, setCurrency] = useState<FiatCurrency>(() => currencyFor(country));
  const [picked, setPicked] = useState<PaymentProviderId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const opIds = useRef(new Map<string, string>());
  const [balance, setBalance] = useState<{ coin: number; gem: number } | null>(null);

  useEffect(() => {
    let live = true;
    props.account
      .wallet()
      .then((res) => {
        if (live && res.ok)
          setBalance({ coin: res.value.balances.coin, gem: res.value.balances.gem });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [props.account]);

  useEffect(() => {
    let live = true;
    setCatalog({ status: "loading" });
    store
      .catalog(country)
      .then((res) => {
        if (!live) return;
        setCatalog(
          res.ok ? { status: "ready", data: res.value } : { status: "error", message: res.message },
        );
      })
      .catch(() => {
        if (live) setCatalog({ status: "error", message: "Could not load the store." });
      });
    return () => {
      live = false;
    };
  }, [store, country, catalogRevision]);

  useEffect(() => {
    let live = true;
    store
      .orders()
      .then((res) => {
        if (!live) return;
        setOrders(
          res.ok
            ? { status: "ready", orders: res.value.orders }
            : { status: "error", message: res.message },
        );
      })
      .catch(() => {
        if (live) setOrders({ status: "error", message: "Could not load your orders." });
      });
    return () => {
      live = false;
    };
  }, [store]);

  if (catalog.status === "loading") {
    return (
      <section aria-label="Store" style={sheetStyle}>
        <h2 style={headingStyle}>Store</h2>
        <p style={mutedStyle} role="status">
          Loading the store…
        </p>
      </section>
    );
  }
  if (catalog.status === "error") {
    return (
      <section aria-label="Store" style={sheetStyle}>
        <h2 style={headingStyle}>Store</h2>
        <p style={errorTextStyle} role="alert">
          {catalog.message}
        </p>
        <button
          type="button"
          style={socialButtonStyle({ primary: true })}
          onClick={() => setCatalogRevision((r) => r + 1)}
        >
          Try again
        </button>
      </section>
    );
  }

  const data = catalog.data;
  const options = providerOptions(data.providers, data.suggested, currency);
  const provider = options.find((o) => o.id === picked)?.id ?? options[0]?.id ?? null;
  const groups = groupProducts(data.products);

  async function buy(product: Product): Promise<void> {
    if (!provider) return;
    const price = priceIn(product, currency);
    if (!price) return;
    setBusy(checkoutKey(product.sku, provider, currency));
    setMessage(null);
    const res = await checkoutOnce(store, opIds.current, {
      sku: product.sku,
      provider,
      currency,
    });
    setBusy(null);
    if (res.ok) {
      props.onCheckout(res.value.url);
      return;
    }
    setMessage(res.message);
  }

  return (
    <section aria-label="Store" style={sheetStyle}>
      <header style={{ ...rowStyle, justifyContent: "space-between" }}>
        <h2 style={headingStyle}>Store</h2>
        <div role="radiogroup" aria-label="Currency" style={rowStyle}>
          {STORE_CURRENCIES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === currency}
              style={{ ...socialTabStyle(c === currency), ...TOUCH_ROW, padding: "0 10px" }}
              onClick={() => setCurrency(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </header>

      <p style={mutedStyle} aria-label="Balance">
        {balanceLine(balance)}
      </p>

      {!canBuy ? (
        <p style={mutedStyle}>Create an account to buy. You can look around as a guest.</p>
      ) : null}

      <h3 style={subheadingStyle}>Pay with</h3>
      {options.length === 0 ? (
        <p style={mutedStyle}>Payments are not set up on this server for {currency}.</p>
      ) : (
        <div role="radiogroup" aria-label="Payment provider" style={listStyle}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={o.id === provider}
              style={{
                ...socialButtonStyle({ pressed: o.id === provider, fullWidth: true }),
                flexDirection: "column",
                alignItems: "flex-start",
                justifyContent: "center",
                gap: 6,
                textAlign: "left",
              }}
              onClick={() => setPicked(o.id)}
            >
              <span>
                {o.label}
                {o.suggested ? " (suggested)" : ""}
              </span>
              <span style={{ ...rowStyle, flexWrap: "wrap", gap: 6 }}>
                {o.badges.map((b) => (
                  <span key={b} style={badgeStyle}>
                    {b}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      )}

      {message ? (
        <p style={errorTextStyle} role="alert">
          {message}
        </p>
      ) : null}

      {data.products.length === 0 ? (
        <p style={mutedStyle}>No products right now. Check back soon.</p>
      ) : null}

      {groups.map((group) => (
        <section
          key={group.kind}
          aria-label={group.title}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <h3 style={subheadingStyle}>{group.title}</h3>
          <ul style={listStyle}>
            {group.items.map((product) => {
              const price = priceIn(product, currency);
              const key = provider ? checkoutKey(product.sku, provider, currency) : "";
              const disabled = !canBuy || !provider || !price || busy !== null;
              return (
                <li key={product.sku} style={{ ...rowStyle, justifyContent: "space-between" }}>
                  <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                    <strong style={{ color: SOCIAL_C.text }}>{product.name}</strong>
                    <div style={mutedStyle}>{product.description}</div>
                  </div>
                  {price ? (
                    <button
                      type="button"
                      aria-label={`Buy ${product.name} for ${formatMinor(price.amountMinor, currency)}`}
                      disabled={disabled}
                      style={socialButtonStyle({ primary: true, disabled })}
                      onClick={() => void buy(product)}
                    >
                      {busy === key ? "Opening…" : formatMinor(price.amountMinor, currency)}
                    </button>
                  ) : (
                    <span style={mutedStyle}>Not sold in {currency}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section
        aria-label="Your orders"
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <h3 style={subheadingStyle}>Your orders</h3>
        {orders.status === "loading" ? <p style={mutedStyle}>Loading orders…</p> : null}
        {orders.status === "error" ? <p style={errorTextStyle}>{orders.message}</p> : null}
        {orders.status === "ready" && orders.orders.length === 0 ? (
          <p style={mutedStyle}>No orders yet.</p>
        ) : null}
        {orders.status === "ready" && orders.orders.length > 0 ? (
          <ul style={listStyle}>
            {orders.orders.map((order) => (
              <li key={order.orderId} style={{ ...rowStyle, justifyContent: "space-between" }}>
                <span>{orderTitle(order, data.products)}</span>
                <span style={order.status === "paid" ? okTextStyle : mutedStyle}>
                  {ORDER_STATUS_LABEL[order.status]} ·{" "}
                  {formatMinor(order.price.amountMinor, order.price.currency)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </section>
  );
}

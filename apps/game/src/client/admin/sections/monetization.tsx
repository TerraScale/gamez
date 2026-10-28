/**
 * Admin section "Monetization" (docs/design/admin-dashboard.md §2.5, §10.3). OWNER: T-ui-sections-b.
 * Revenue by provider and currency (minor units), revenue per currency over
 * time, purchase status, by SKU, payers, ARPU / ARPPU and the battle pass
 * conversion. Provider "stub" is the sandbox / test data.
 */
import type { AdminMonetization, FiatCurrency, PaymentProviderId } from "@gamez/protocol";
import {
  DataTable,
  Panel,
  SourcesNote,
  StatTile,
  TimeSeriesChart,
  defineSection,
} from "../kit/index.tsx";
import type { DataColumn } from "../kit/index.tsx";

const CURRENCIES: readonly FiatCurrency[] = ["USD", "BRL", "EUR"];

const PROVIDERS: readonly { id: PaymentProviderId; label: string }[] = [
  { id: "stripe", label: "Stripe" },
  { id: "asaas", label: "Asaas" },
  { id: "mercadopago", label: "Mercado Pago" },
  { id: "stub", label: "Stub (sandbox / test data)" },
];

type SkuRow = AdminMonetization["bySku"][number];

interface RevenueRow {
  provider: string;
  USD: number;
  BRL: number;
  EUR: number;
}

interface PerCurrencyRow {
  currency: FiatCurrency;
  arpu: number;
  arppu: number;
}

export const monetizationSection = defineSection<AdminMonetization>({
  id: "monetization",
  label: "Monetization",
  group: "Business",
  load: (ctx) => ctx.get<AdminMonetization>(`/api/admin/monetization?${ctx.query}`),
  Component: ({ data }) =>
    data ? <MonetizationView d={data} /> : <p className="adm-muted">Loading monetization…</p>,
});

/** "USD 12.34" from minor units (cents, centavos). Missing values print as 0. */
export function money(minor: number | undefined, currency: string): string {
  const v = Number.isFinite(minor) ? (minor as number) : 0;
  return `${currency} ${(v / 100).toFixed(2)}`;
}

/** Minor units as a plain major-unit number for CSV (1234 -> 12.34). */
export function major(minor: number | undefined): number {
  const v = Number.isFinite(minor) ? (minor as number) : 0;
  return Math.round(v) / 100;
}

function currencyTotal(byProvider: Partial<Record<PaymentProviderId, number>> | undefined): number {
  return Object.values(byProvider ?? {}).reduce<number>((a, v) => a + (v ?? 0), 0);
}

function Empty() {
  return <p className="adm-muted">No data in this range yet.</p>;
}

function MonetizationView({ d }: { d: AdminMonetization }) {
  const bucketMs = d.range.bucketMs;
  const p = d.purchases;

  const revenueRows: RevenueRow[] = PROVIDERS.map((prov) => ({
    provider: prov.label,
    USD: d.revenueMinor.USD?.[prov.id] ?? 0,
    BRL: d.revenueMinor.BRL?.[prov.id] ?? 0,
    EUR: d.revenueMinor.EUR?.[prov.id] ?? 0,
  }));
  const totalRow: RevenueRow = {
    provider: "All providers",
    USD: currencyTotal(d.revenueMinor.USD),
    BRL: currencyTotal(d.revenueMinor.BRL),
    EUR: currencyTotal(d.revenueMinor.EUR),
  };
  const anyRevenue = [...revenueRows, totalRow].some((r) => r.USD + r.BRL + r.EUR > 0);

  const revenueColumns: DataColumn<RevenueRow>[] = [
    { key: "provider", label: "Provider", value: (r) => r.provider },
    ...CURRENCIES.map((c): DataColumn<RevenueRow> => ({
      key: c,
      label: c,
      value: (r) => money(r[c], c),
      raw: (r) => major(r[c]),
      align: "right",
    })),
  ];

  const skuColumns: DataColumn<SkuRow>[] = [
    { key: "sku", label: "SKU", value: (r) => r.sku },
    { key: "paid", label: "Paid", value: (r) => r.paid, align: "right" },
    { key: "refunded", label: "Refunded", value: (r) => r.refunded, align: "right" },
    {
      key: "revenue",
      label: "Revenue",
      value: (r) => money(r.revenueMinor, r.currency),
      raw: (r) => major(r.revenueMinor),
      align: "right",
    },
    { key: "currency", label: "Currency", value: (r) => r.currency },
  ];

  const perCurrency: PerCurrencyRow[] = CURRENCIES.filter(
    (c) => d.arpuMinor[c] !== undefined || d.arppuMinor[c] !== undefined,
  ).map((c) => ({
    currency: c,
    arpu: d.arpuMinor[c] ?? 0,
    arppu: d.arppuMinor[c] ?? 0,
  }));
  const perCurrencyColumns: DataColumn<PerCurrencyRow>[] = [
    { key: "currency", label: "Currency", value: (r) => r.currency },
    {
      key: "arpu",
      label: "ARPU",
      value: (r) => money(r.arpu, r.currency),
      raw: (r) => major(r.arpu),
      align: "right",
    },
    {
      key: "arppu",
      label: "ARPPU",
      value: (r) => money(r.arppu, r.currency),
      raw: (r) => major(r.arppu),
      align: "right",
    },
  ];

  const pass = d.pass;
  const conversion = Number.isFinite(pass.conversion) ? pass.conversion : 0;

  return (
    <>
      <SourcesNote sources={d.sources} />

      <Panel
        title="Revenue by provider"
        hint="Paid purchases in the range, in minor units shown as money. Stub rows are sandbox data."
      >
        {anyRevenue ? (
          <DataTable
            caption="Revenue by provider and currency"
            columns={revenueColumns}
            rows={[...revenueRows, totalRow]}
            csvName="monetization-revenue"
          />
        ) : (
          <Empty />
        )}
      </Panel>

      {d.revenueSeries.length > 0 ? (
        d.revenueSeries.map((s) => (
          <Panel
            key={s.key}
            title={`Revenue per bucket, ${s.label}`}
            hint="One chart per currency."
          >
            <TimeSeriesChart
              title={`Revenue per bucket, ${s.label}`}
              series={[s]}
              kind="bar"
              format={{ money: s.key }}
              bucketMs={bucketMs}
              csvName={`monetization-revenue-${s.key}`}
              emptyText="No revenue in this range."
            />
          </Panel>
        ))
      ) : (
        <Panel title="Revenue per bucket">
          <Empty />
        </Panel>
      )}

      <Panel
        title="Purchases"
        hint="Paid and refunded by update time; pending and failed by creation time."
      >
        <div className="adm-tiles" aria-label="Purchase status">
          <StatTile label="Paid" value={p.paid} status="good" />
          <StatTile
            label="Refunded"
            value={p.refunded}
            status={p.refunded > 0 ? "warning" : undefined}
          />
          <StatTile label="Pending" value={p.pending} />
          <StatTile label="Failed" value={p.failed} status={p.failed > 0 ? "warning" : undefined} />
        </div>
      </Panel>

      <Panel title="By SKU" hint="Paid, refunded and revenue per SKU and currency.">
        {d.bySku.length > 0 ? (
          <DataTable
            caption="Purchases by SKU"
            columns={skuColumns}
            rows={d.bySku}
            csvName="monetization-sku"
          />
        ) : (
          <Empty />
        )}
      </Panel>

      <Panel
        title="Payers and ARPU"
        hint="ARPU divides by the accounts active in the range plus the accounts that paid in it (paying counts as activity), so ARPU ≤ ARPPU; ARPPU divides by paying accounts."
      >
        <div className="adm-tiles" aria-label="Payers">
          <StatTile label="Payers" value={d.payers} hint="paying accounts in the range" />
        </div>
        {perCurrency.length > 0 ? (
          <DataTable
            caption="ARPU and ARPPU per currency"
            columns={perCurrencyColumns}
            rows={perCurrency}
            csvName="monetization-arpu"
          />
        ) : (
          <Empty />
        )}
      </Panel>

      <Panel
        title="Battle pass"
        hint={`Season ${pass.seasonId}, all time. Premium = accounts with the premium flag in pass progress or a paid (not refunded) premium pass purchase. Players = pass progress rows plus premium holders. Conversion = premium / players.`}
      >
        <div className="adm-tiles" aria-label="Battle pass">
          <StatTile label="Players" value={pass.players} />
          <StatTile label="Premium" value={pass.premium} />
          <StatTile label="Conversion" value={conversion} format="pct" />
        </div>
      </Panel>
    </>
  );
}

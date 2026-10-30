/**
 * AccountDO orders and fulfilment (wave-C.md §8.3). OWNER: T-pay.
 *
 * createOrder: a pending row, idempotent by orderId (a replay returns the row).
 * fulfillOrder: once per orderId, and only for the order's own provider with
 * the provider-reported charge (VerifiedWebhook.paid) equal to the stored price
 * in currency and minor units. Anything else (another provider, another
 * currency or amount, no usable amount) marks the order "failed" with an
 * admin-visible fail_reason, pushes a "store.failed" notice, appends the outbox
 * row and grants nothing. "failed" is terminal like "paid": later events replay.
 * On a match it credits the product's gems (vault.walletTx,
 * txId "store:<orderId>:gems", flow "faucet", gems are not coin), grants each
 * entitlement (economy.grantEntitlement, txId "store:<orderId>:<sku>", source
 * "store"), pushes a "store.granted" notice and marks the order paid. The
 * outbox "purchase" row is appended in the same transaction as the status.
 * Every step is idempotent by its txId, so a crash in the middle is repaired by
 * the next webhook delivery (the status is written last).
 * refundOrder: status refunded. Gems debited down to 0 at most (flow "sink");
 * the order's entitlement rows get `revoked_at` set (the column belongs to
 * economy.ts, which also adds it here guarded for older tables), so the grant
 * rows stay for audit. economy.ts entitlements() and cosmetics() skip revoked
 * rows, so a refunded cosmetic or premium pass (pass.ts) is no longer owned.
 *
 * The AccountDO RPCs are synchronous inside, so no other request interleaves
 * with one fulfilment; the idempotent txIds cover crashes.
 */
import type { Outbox } from "@gamez/sync";
import { productBySku } from "@gamez/economy";
import type { OrderStatus, PaymentProviderId, Product, ProductPrice } from "@gamez/protocol";
import type { EconResult, OrderRecord, PaidAmount, SqlStore } from "../contracts.ts";
import { formatPaid } from "../payments/amount.ts";
import type { AccountEconomy } from "./economy.ts";
import type { AccountNotices } from "./notices.ts";
import type { AccountVault } from "./vault.ts";

type OrderRow = {
  order_id: string;
  sku: string;
  provider: string;
  currency: string;
  amount_minor: number;
  status: string;
  provider_ref: string | null;
  last_event: string | null;
  created_at: number;
  updated_at: number;
  paid_currency: string | null;
  paid_minor: number | null;
  fail_reason: string | null;
};

const MAX_EVENT_ID = 200;
const MAX_FAIL_REASON = 200;
const ORDER_COLUMNS =
  "order_id, sku, provider, currency, amount_minor, status, provider_ref, last_event, created_at, updated_at, paid_currency, paid_minor, fail_reason";
/** Columns added after the first orders table shipped (guarded ALTER in init). */
const LATER_COLUMNS: readonly (readonly [string, string])[] = [
  ["paid_currency", "TEXT"],
  ["paid_minor", "INTEGER"],
  ["fail_reason", "TEXT"],
];

export interface FulfillInput {
  orderId: string;
  providerRef: string | null;
  eventId: string;
  /** The provider whose verified webhook this is. */
  provider: PaymentProviderId;
  /** The provider-reported charge, null when it reported none we can read. */
  paid: PaidAmount | null;
}

function toRecord(row: OrderRow, accountId: string): OrderRecord {
  return {
    orderId: row.order_id,
    sku: row.sku,
    provider: row.provider as PaymentProviderId,
    price: { currency: row.currency, amountMinor: row.amount_minor } as ProductPrice,
    status: row.status as OrderStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accountId,
    providerRef: row.provider_ref,
    paid:
      row.paid_currency !== null && row.paid_minor !== null
        ? ({ currency: row.paid_currency, amountMinor: row.paid_minor } as PaidAmount)
        : null,
    failReason: row.fail_reason,
  };
}

/** Why a paid event cannot fulfil this order, or null when it matches exactly. */
function paymentProblem(row: OrderRow, input: FulfillInput): string | null {
  const order = { currency: row.currency, amountMinor: row.amount_minor };
  if (input.provider !== row.provider)
    return `provider_mismatch: paid through ${input.provider}, the order is for ${row.provider}`;
  const paid = input.paid;
  if (
    !paid ||
    typeof paid.currency !== "string" ||
    typeof paid.amountMinor !== "number" ||
    !Number.isSafeInteger(paid.amountMinor)
  )
    return `amount_unknown: ${row.provider} reported no usable amount, the order is ${formatPaid(order)}`;
  if (paid.currency !== row.currency)
    return `currency_mismatch: paid ${formatPaid(paid)}, the order is ${formatPaid(order)}`;
  if (paid.amountMinor !== row.amount_minor)
    return `amount_mismatch: paid ${formatPaid(paid)}, the order is ${formatPaid(order)}`;
  return null;
}

export class AccountPurchases {
  constructor(
    readonly store: SqlStore,
    readonly economy: AccountEconomy,
    readonly vault: AccountVault,
    readonly notices: AccountNotices,
    readonly outbox: Outbox,
    readonly accountId: string,
    readonly now: () => number = Date.now,
  ) {}

  init(): void {
    const sql = this.store.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      provider TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider_ref TEXT,
      last_event TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      paid_currency TEXT,
      paid_minor INTEGER,
      fail_reason TEXT
    )`);
    const orders =
      sql
        .exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'",
        )
        .toArray()[0]?.sql ?? "";
    for (const [column, type] of LATER_COLUMNS) {
      if (!new RegExp(`\\b${column}\\b`).test(orders))
        sql.exec(`ALTER TABLE orders ADD COLUMN ${column} ${type}`);
    }
    // Refunds mark the grant row revoked. economy.ts owns the table and creates it
    // first (AccountDO init order); the column is added once, only when missing.
    // sqlite_master, like economy.ts's stash upgrade (PRAGMA is restricted in DOs).
    const table =
      sql
        .exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entitlements'",
        )
        .toArray()[0]?.sql ?? "";
    if (table !== "" && !/\brevoked_at\b/.test(table))
      sql.exec("ALTER TABLE entitlements ADD COLUMN revoked_at INTEGER");
  }

  createOrder(input: {
    orderId: string;
    sku: string;
    provider: PaymentProviderId;
    price: ProductPrice;
  }): OrderRecord {
    return this.store.transactionSync(() => {
      const prior = this.#row(input.orderId);
      if (prior) return toRecord(prior, this.accountId);
      const t = this.now();
      this.store.sql.exec(
        `INSERT INTO orders (order_id, sku, provider, currency, amount_minor, status, provider_ref, last_event, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        input.orderId,
        input.sku,
        input.provider,
        input.price.currency,
        input.price.amountMinor,
        t,
        t,
      );
      const row = this.#row(input.orderId);
      if (!row) throw new Error("order vanished after insert");
      return toRecord(row, this.accountId);
    });
  }

  fulfillOrder(input: FulfillInput): EconResult<OrderRecord> {
    const row = this.#row(input.orderId);
    if (!row) return { ok: false, code: "not_found", message: "no such order" };
    if (row.status === "paid" || row.status === "refunded" || row.status === "failed") {
      // Replayed or late webhook: nothing to grant again, and a failed order stays failed.
      return { ok: true, value: toRecord(row, this.accountId), replayed: true };
    }
    const problem = paymentProblem(row, input);
    if (problem !== null) return this.#fail(row, input, problem);
    const product = productBySku(row.sku);
    if (!product) return { ok: false, code: "internal", message: "product no longer sold" };

    // Each step is idempotent by txId; the status is written last.
    const gems = product.grants.gems;
    if (gems > 0) {
      const credited = this.vault.walletTx({
        txId: `store:${row.order_id}:gems`,
        currency: "gem",
        amount: gems,
        reason: `store.gems:${product.sku}`,
        flow: "faucet",
      });
      if (!credited.ok) return { ok: false, code: "internal", message: "could not credit gems" };
    }
    for (const sku of product.grants.entitlements) {
      this.economy.grantEntitlement({ txId: `store:${row.order_id}:${sku}`, sku, source: "store" });
    }
    this.notices.notify({
      id: `store:${row.order_id}:granted`,
      kind: "store.granted",
      text: noticeText(product),
      data: { orderId: row.order_id, sku: product.sku, gems },
    });

    return this.store.transactionSync(() => {
      const t = this.now();
      this.store.sql.exec(
        `UPDATE orders SET status = 'paid', provider_ref = COALESCE(?, provider_ref), last_event = ?, updated_at = ?,
           paid_currency = ?, paid_minor = ?
         WHERE order_id = ?`,
        input.providerRef,
        clip(input.eventId),
        t,
        input.paid?.currency ?? null,
        input.paid?.amountMinor ?? null,
        row.order_id,
      );
      const next = this.#row(row.order_id);
      if (!next) throw new Error("order vanished during fulfilment");
      const record = toRecord(next, this.accountId);
      this.outbox.append("purchase", row.order_id, "upsert", { order: record });
      return { ok: true, value: record, replayed: false };
    });
  }

  /**
   * A verified paid event that does not match the order: status "failed" with
   * the reason, nothing granted. The notice goes first (idempotent by id), the
   * status last, so a crash in between replays to the same result.
   */
  #fail(row: OrderRow, input: FulfillInput, reason: string): EconResult<OrderRecord> {
    const product = productBySku(row.sku);
    this.notices.notify({
      id: `store:${row.order_id}:failed`,
      kind: "store.failed",
      text: failedText(product?.name ?? row.sku),
      data: { orderId: row.order_id, sku: row.sku },
    });
    const paid = input.paid && Number.isSafeInteger(input.paid.amountMinor) ? input.paid : null;
    return this.store.transactionSync(() => {
      const t = this.now();
      this.store.sql.exec(
        `UPDATE orders SET status = 'failed', provider_ref = COALESCE(?, provider_ref), last_event = ?, updated_at = ?,
           paid_currency = ?, paid_minor = ?, fail_reason = ?
         WHERE order_id = ?`,
        input.providerRef,
        clip(input.eventId),
        t,
        paid ? String(paid.currency).slice(0, 8) : null,
        paid ? paid.amountMinor : null,
        reason.length <= MAX_FAIL_REASON ? reason : reason.slice(0, MAX_FAIL_REASON),
        row.order_id,
      );
      const next = this.#row(row.order_id);
      if (!next) throw new Error("order vanished while failing");
      const record = toRecord(next, this.accountId);
      this.outbox.append("purchase", row.order_id, "upsert", { order: record });
      return { ok: true, value: record, replayed: false };
    });
  }

  refundOrder(input: { orderId: string; eventId: string }): EconResult<OrderRecord> {
    const row = this.#row(input.orderId);
    if (!row) return { ok: false, code: "not_found", message: "no such order" };
    if (row.status === "refunded")
      return { ok: true, value: toRecord(row, this.accountId), replayed: true };
    const product = productBySku(row.sku);

    if (row.status === "paid" && product) {
      const gems = product.grants.gems;
      if (gems > 0) {
        // Debit at most what the account still holds: spent gems are not clawed back.
        const take = Math.min(gems, this.economy.balanceOf("gem"));
        if (take > 0) {
          const debited = this.vault.walletTx({
            txId: `store:${row.order_id}:gems:refund`,
            currency: "gem",
            amount: -take,
            reason: `store.refund:${product.sku}`,
            flow: "sink",
          });
          if (!debited.ok) return { ok: false, code: "internal", message: "could not debit gems" };
        }
      }
      for (const sku of product.grants.entitlements) {
        this.store.sql.exec(
          "UPDATE entitlements SET revoked_at = ? WHERE tx_id = ? AND revoked_at IS NULL",
          this.now(),
          `store:${row.order_id}:${sku}`,
        );
      }
    }

    return this.store.transactionSync(() => {
      const t = this.now();
      this.store.sql.exec(
        `UPDATE orders SET status = 'refunded', last_event = ?, updated_at = ? WHERE order_id = ?`,
        clip(input.eventId),
        t,
        row.order_id,
      );
      const next = this.#row(row.order_id);
      if (!next) throw new Error("order vanished during refund");
      const record = toRecord(next, this.accountId);
      this.outbox.append("purchase", row.order_id, "upsert", { order: record });
      return { ok: true, value: record, replayed: false };
    });
  }

  orders(): OrderRecord[] {
    return this.store.sql
      .exec<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders ORDER BY created_at, order_id`)
      .toArray()
      .map((row) => toRecord(row, this.accountId));
  }

  #row(orderId: string): OrderRow | null {
    return (
      this.store.sql
        .exec<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE order_id = ?`, orderId)
        .toArray()[0] ?? null
    );
  }
}

function failedText(name: string): string {
  const text = `We could not match your payment for ${name} to its order, so nothing was granted. Support will refund it.`;
  return text.length <= 140 ? text : text.slice(0, 140);
}

function noticeText(product: Product): string {
  const text = `Thanks! ${product.name} is yours.`;
  return text.length <= 140 ? text : text.slice(0, 140);
}

function clip(eventId: string): string {
  return eventId.length <= MAX_EVENT_ID ? eventId : eventId.slice(0, MAX_EVENT_ID);
}

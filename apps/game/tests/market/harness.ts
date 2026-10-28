/**
 * Test harness for the auction house (T-market): one MarketBook over the
 * in-memory SQLite fake, an in-memory account gateway, a clock the tests move
 * by hand, and item/party factories.
 */
import { salesTax, listingFee } from "@gamez/economy";
import type { ItemSummary, MarketListing, Party, VaultItemInput } from "@gamez/protocol";
import { Outbox } from "@gamez/sync";
import { MarketBook } from "../../src/server/market/book.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";
import { FakeAccounts } from "./fake-accounts.ts";

export const SHARD = "classic:weapon";
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

export function makeClock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

export type Clock = ReturnType<typeof makeClock>;

export function summary(over: Partial<ItemSummary> = {}): ItemSummary {
  return {
    name: "Ember Blade",
    rarity: "rare",
    level: 12,
    category: "weapon",
    slot: "weapon",
    icon: "item.sword",
    lines: ["+12 Strength"],
    ...over,
  };
}

let serial = 0;

/** A tradable, eligible, classic-origin weapon, with a unique `data` tag. */
export function item(
  over: Partial<VaultItemInput> = {},
  sum: Partial<ItemSummary> = {},
): VaultItemInput {
  serial += 1;
  return {
    itemId: "classic.item.sword",
    count: 1,
    origin: "classic",
    universal: false,
    tradable: true,
    summary: summary(sum),
    data: JSON.stringify({ tag: `gear-${serial}` }),
    ...over,
  };
}

export function party(accountId: string): Party {
  return { accountId, displayName: accountId.toUpperCase() };
}

let opSerial = 0;
/** A fresh opId (8..64 chars). */
export function opId(label = "op"): string {
  opSerial += 1;
  return `${label}-${opSerial}-abcdef`;
}

export interface Harness {
  clock: Clock;
  accounts: FakeAccounts;
  outbox: Outbox;
  book: MarketBook;
  store: ReturnType<typeof fakeSqlStore>;
  /** Re-opens a book over the same storage (a "restart" of the DO). */
  restart(): MarketBook;
}

/** One shard over in-memory storage. */
export function harness(shard = SHARD, clock = makeClock()): Harness {
  const accounts = new FakeAccounts();
  const store = fakeSqlStore();
  const outbox = new Outbox(store.sql, `market:${shard}`);
  outbox.init();
  const book = new MarketBook(store, accounts, outbox, shard, clock.now);
  book.init();
  return {
    clock,
    accounts,
    outbox,
    book,
    store,
    restart() {
      const again = new MarketBook(store, accounts, outbox, shard, clock.now);
      again.init();
      return again;
    },
  };
}

/** Fee and tax numbers the tests use, from the economy rules. */
export const fee = listingFee;
export const tax = salesTax;

/** Money and item conservation over every listing this test created (see wave-C.md §4). */
export function assertConserved(
  h: Harness,
  listingIds: string[],
  grantedCoin: number,
  grantedItems: number,
): void {
  const listings = listingIds.map((id) => h.book.get(id));
  let custody = 0;
  let heldItems = 0;
  for (const l of listings) {
    if (!l) continue;
    if (l.status === "active") {
      heldItems += 1;
      custody += l.topBid ?? 0;
    }
  }
  const vaultItems = [...h.accounts.vaults.values()].reduce((n, v) => n + v.size, 0);
  const coinTotal = h.accounts.walletSum() + h.accounts.sinkNet() + custody;
  if (coinTotal !== grantedCoin) {
    throw new Error(
      `coin not conserved: wallets+sinks+custody=${coinTotal}, granted=${grantedCoin}`,
    );
  }
  if (vaultItems + heldItems !== grantedItems) {
    throw new Error(
      `items not conserved: vaults=${vaultItems} listed=${heldItems}, granted=${grantedItems}`,
    );
  }
}

/** The listing's money view, for readable assertions. */
export function viewOf(l: MarketListing | null): MarketListing {
  if (!l) throw new Error("expected a listing");
  return l;
}

/** Auction house D1 reads on node:sqlite with the 0006 migration (wave-C.md §4). OWNER: T-market. */
import { describe, expect, it } from "vite-plus/test";
import type { ItemCategory, MarketListing, Party } from "@gamez/protocol";
import {
  buildSearchSql,
  likeEscape,
  mapListings,
  myListings,
  parseSearch,
  searchListings,
  type SearchParams,
} from "../../src/server/market/search.ts";
import { FakeD1, projectRow } from "./fakes.ts";

const NOW = 1_800_000_000_000;
const seller: Party = { accountId: "acc-s", displayName: "Seller" };
const bidder: Party = { accountId: "acc-b", displayName: "Bidder" };

function listing(
  id: string,
  over: Partial<MarketListing> & {
    name?: string;
    category?: ItemCategory;
    rarity?: string;
    level?: number;
    scope?: string;
  } = {},
): MarketListing {
  const {
    name = "Ember Blade",
    category = "weapon",
    rarity = "rare",
    level = 12,
    scope = "classic",
    ...rest
  } = over;
  return {
    id,
    shard: `${scope}:${category}`,
    seller,
    item: {
      itemId: "classic.item.sword",
      count: 1,
      origin: scope,
      universal: false,
      tradable: true,
      summary: { name, rarity, level, category, slot: "weapon", icon: "item.sword", lines: [] },
    },
    buyout: 1000,
    startBid: null,
    topBid: null,
    topBidder: null,
    bids: 0,
    fee: 20,
    createdAt: NOW - 1000,
    endsAt: NOW + 3_600_000,
    status: "active",
    soldFor: null,
    ...rest,
  };
}

function seed(d1: FakeD1, listings: MarketListing[]): void {
  for (const l of listings) {
    const row = projectRow(l);
    const cols = Object.keys(row);
    d1.db
      .prepare(
        `INSERT INTO market_listing (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...(cols.map((c) => row[c]) as never[]));
  }
}

function fresh(): FakeD1 {
  return new FakeD1().migrate(["0006_market.sql"]);
}

function base(over: Partial<SearchParams> = {}): SearchParams {
  return {
    scope: null,
    category: null,
    q: null,
    rarity: null,
    minLevel: null,
    maxLevel: null,
    sort: "ending",
    limit: 30,
    offset: 0,
    ...over,
  };
}

const ids = (rows: MarketListing[]) => rows.map((r) => r.id);

describe("parseSearch", () => {
  it("fills the defaults", () => {
    const r = parseSearch(new URLSearchParams(""));
    expect(r).toEqual({ ok: true, value: base() });
  });

  it("rejects bad filters with a message", () => {
    const bad = [
      "sort=bogus",
      "limit=0",
      "limit=51",
      "limit=abc",
      "offset=-1",
      "category=sword",
      "scope=Classic%20Town",
      "rarity=Rare!",
      "q=" + "x".repeat(41),
      "minLevel=abc",
      "maxLevel=10000",
    ];
    for (const qs of bad) {
      const r = parseSearch(new URLSearchParams(qs));
      expect(r.ok, qs).toBe(false);
    }
  });

  it("accepts the full filter set", () => {
    const r = parseSearch(
      new URLSearchParams(
        "scope=classic&category=weapon&rarity=rare&minLevel=10&maxLevel=20&q=Blade&sort=price_desc&limit=50&offset=10",
      ),
    );
    expect(r).toEqual({
      ok: true,
      value: base({
        scope: "classic",
        category: "weapon",
        rarity: "rare",
        minLevel: 10,
        maxLevel: 20,
        q: "Blade",
        sort: "price_desc",
        limit: 50,
        offset: 10,
      }),
    });
  });
});

describe("buildSearchSql", () => {
  it("always filters to active, not ended, not deleted rows", () => {
    const { sql, params } = buildSearchSql(base(), NOW);
    expect(sql).toContain("_deleted = 0");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("ends_at > ?");
    expect(params[0]).toBe(NOW);
    expect(params.slice(-2)).toEqual([30, 0]);
  });

  it("escapes LIKE wildcards so 100% matches only itself", () => {
    expect(likeEscape("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    const { params } = buildSearchSql(base({ q: "100%" }), NOW);
    expect(params).toContain("%100\\%%");
  });
});

describe("searchListings on node:sqlite", () => {
  it("returns only active listings that have not ended", async () => {
    const d1 = fresh();
    seed(d1, [
      listing("classic:weapon/1"),
      listing("classic:weapon/2", { status: "sold", soldFor: 900 }),
      listing("classic:weapon/3", { status: "expired" }),
      listing("classic:weapon/4", { status: "cancelled" }),
      listing("classic:weapon/5", { endsAt: NOW - 1 }),
    ]);
    d1.db.prepare("UPDATE market_listing SET _deleted = 1 WHERE id = ?").run("classic:weapon/1");
    seed(d1, [listing("classic:weapon/6")]);
    const r = await searchListings(d1.asD1(), base(), NOW);
    expect(r.available).toBe(true);
    expect(ids(r.listings)).toEqual(["classic:weapon/6"]);
  });

  it("filters by category, rarity, level range, scope and name (case-insensitive)", async () => {
    const d1 = fresh();
    seed(d1, [
      listing("classic:weapon/1", { name: "Ember Blade", level: 12 }),
      listing("classic:weapon/2", { name: "Frost Blade", level: 30, rarity: "unique" }),
      listing("classic:armor/3", { name: "Ember Mail", category: "armor", level: 12 }),
      listing("universal:material/4", {
        name: "Ember Dust",
        category: "material",
        level: 0,
        scope: "universal",
      }),
    ]);
    const q = async (p: Partial<SearchParams>) =>
      ids((await searchListings(d1.asD1(), base(p), NOW)).listings).sort();
    expect(await q({ category: "armor" })).toEqual(["classic:armor/3"]);
    expect(await q({ rarity: "unique" })).toEqual(["classic:weapon/2"]);
    expect(await q({ minLevel: 20, maxLevel: 40 })).toEqual(["classic:weapon/2"]);
    expect(await q({ scope: "universal" })).toEqual(["universal:material/4"]);
    expect(await q({ q: "EMBER" })).toEqual(
      ["classic:armor/3", "classic:weapon/1", "universal:material/4"].sort(),
    );
  });

  it("matches a literal 100% in names and nothing else", async () => {
    const d1 = fresh();
    seed(d1, [
      listing("classic:weapon/1", { name: "Blade 100%" }),
      listing("classic:weapon/2", { name: "Blade 1000" }),
      listing("classic:weapon/3", { name: "Blade 100_" }),
    ]);
    const r = await searchListings(d1.asD1(), base({ q: "100%" }), NOW);
    expect(ids(r.listings)).toEqual(["classic:weapon/1"]);
  });

  it("sorts by price, ending time and newest", async () => {
    const d1 = fresh();
    seed(d1, [
      listing("classic:weapon/1", { buyout: 300, endsAt: NOW + 3000, createdAt: 10 }),
      listing("classic:weapon/2", { buyout: 100, endsAt: NOW + 1000, createdAt: 30 }),
      listing("classic:weapon/3", {
        buyout: null,
        startBid: 200,
        topBid: 250,
        endsAt: NOW + 2000,
        createdAt: 20,
      }),
    ]);
    const sorted = async (sort: SearchParams["sort"]) =>
      ids((await searchListings(d1.asD1(), base({ sort }), NOW)).listings);
    expect(await sorted("price_asc")).toEqual([
      "classic:weapon/2",
      "classic:weapon/3",
      "classic:weapon/1",
    ]);
    expect(await sorted("price_desc")).toEqual([
      "classic:weapon/1",
      "classic:weapon/3",
      "classic:weapon/2",
    ]);
    expect(await sorted("ending")).toEqual([
      "classic:weapon/2",
      "classic:weapon/3",
      "classic:weapon/1",
    ]);
    expect(await sorted("newest")).toEqual([
      "classic:weapon/2",
      "classic:weapon/3",
      "classic:weapon/1",
    ]);
  });

  it("pages with limit and offset", async () => {
    const d1 = fresh();
    seed(
      d1,
      Array.from({ length: 5 }, (_, i) =>
        listing(`classic:weapon/${i + 1}`, { endsAt: NOW + 1000 * (i + 1) }),
      ),
    );
    const page = await searchListings(d1.asD1(), base({ limit: 2, offset: 2 }), NOW);
    expect(ids(page.listings)).toEqual(["classic:weapon/3", "classic:weapon/4"]);
  });

  it("answers available:false with no rows when the table is not migrated", async () => {
    const r = await searchListings(new FakeD1().asD1(), base(), NOW);
    expect(r).toEqual({ listings: [], available: false });
  });

  it("maps a corrupt listing_json row away instead of failing", () => {
    expect(mapListings([{ listing_json: "{not json" }, { listing_json: null }])).toEqual([]);
  });
});

describe("myListings on node:sqlite", () => {
  it("returns my listings as seller and the active ones I lead", async () => {
    const d1 = fresh();
    seed(d1, [
      listing("classic:weapon/1"),
      listing("classic:weapon/2", { status: "sold", soldFor: 900 }),
      listing("classic:weapon/3", {
        seller: { accountId: "acc-x", displayName: "X" },
        topBid: 120,
        topBidder: bidder,
        bids: 1,
      }),
      listing("classic:weapon/4", {
        seller: { accountId: "acc-x", displayName: "X" },
        topBid: 90,
        topBidder: bidder,
        status: "sold",
        soldFor: 90,
      }),
    ]);
    const mine = await myListings(d1.asD1(), "acc-s", NOW);
    expect(mine.listings.map((l) => l.id).sort()).toEqual(["classic:weapon/1", "classic:weapon/2"]);
    const leading = await myListings(d1.asD1(), "acc-b", NOW);
    expect(leading.listings).toEqual([]);
    expect(leading.bids.map((l) => l.id)).toEqual(["classic:weapon/3"]);
  });

  it("answers empty lists when the table is not migrated", async () => {
    expect(await myListings(new FakeD1().asD1(), "acc-s", NOW)).toEqual({ listings: [], bids: [] });
  });
});

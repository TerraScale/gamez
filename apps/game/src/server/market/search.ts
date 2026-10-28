/**
 * Auction house read model (wave-C.md §4): search and "my listings" over the
 * D1 projection market_listing (migrations/0006_market.sql). OWNER: T-market.
 *
 * Display only: gameplay never reads these rows. A missing table (the
 * migration not applied yet) answers available: false with no rows, never a 500.
 */
import {
  ITEM_CATEGORIES,
  type ItemCategory,
  type MarketListing,
  type MarketMineResponse,
  type MarketSearchQuery,
  type MarketSearchResponse,
} from "@gamez/protocol";

export const SEARCH_LIMIT_DEFAULT = 30;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_OFFSET_MAX = 10_000;
export const MINE_LIMIT = 100;

export type SearchSort = NonNullable<MarketSearchQuery["sort"]>;

const SORTS: readonly SearchSort[] = ["price_asc", "price_desc", "ending", "newest"];

/** Validated search parameters (the defaults filled in). */
export interface SearchParams {
  scope: string | null;
  category: ItemCategory | null;
  q: string | null;
  rarity: string | null;
  minLevel: number | null;
  maxLevel: number | null;
  sort: SearchSort;
  limit: number;
  offset: number;
}

export type ParseResult = { ok: true; value: SearchParams } | { ok: false; message: string };

function intParam(v: string | null, min: number, max: number): number | null | "bad" {
  if (v === null || v === "") return null;
  if (!/^\d{1,9}$/.test(v)) return "bad";
  const n = Number(v);
  return n >= min && n <= max ? n : "bad";
}

/** Parses GET /api/market/search query parameters. */
export function parseSearch(params: URLSearchParams): ParseResult {
  const scope = params.get("scope");
  if (scope !== null && scope !== "" && !/^[a-z0-9_-]{1,32}$/.test(scope))
    return { ok: false, message: "scope: a mode id such as classic or universal" };

  const category = params.get("category");
  if (
    category !== null &&
    category !== "" &&
    !(ITEM_CATEGORIES as readonly string[]).includes(category)
  )
    return { ok: false, message: `category: one of ${ITEM_CATEGORIES.join(", ")}` };

  const rarity = params.get("rarity");
  if (rarity !== null && rarity !== "" && !/^[a-z]{1,16}$/.test(rarity))
    return { ok: false, message: "rarity: a lowercase word" };

  const q = params.get("q")?.trim() ?? "";
  if (q.length > 40) return { ok: false, message: "q: at most 40 characters" };

  const sortRaw = params.get("sort") ?? "ending";
  if (!(SORTS as readonly string[]).includes(sortRaw))
    return { ok: false, message: `sort: one of ${SORTS.join(", ")}` };

  const minLevel = intParam(params.get("minLevel"), 0, 9_999);
  if (minLevel === "bad") return { ok: false, message: "minLevel: integer 0..9999" };
  const maxLevel = intParam(params.get("maxLevel"), 0, 9_999);
  if (maxLevel === "bad") return { ok: false, message: "maxLevel: integer 0..9999" };

  const limit = intParam(params.get("limit"), 1, SEARCH_LIMIT_MAX);
  if (limit === "bad") return { ok: false, message: `limit: integer 1..${SEARCH_LIMIT_MAX}` };
  const offset = intParam(params.get("offset"), 0, SEARCH_OFFSET_MAX);
  if (offset === "bad") return { ok: false, message: `offset: integer 0..${SEARCH_OFFSET_MAX}` };

  return {
    ok: true,
    value: {
      scope: scope === null || scope === "" ? null : scope,
      category: category === null || category === "" ? null : (category as ItemCategory),
      q: q === "" ? null : q,
      rarity: rarity === null || rarity === "" ? null : rarity,
      minLevel,
      maxLevel,
      sort: sortRaw as SearchSort,
      limit: limit ?? SEARCH_LIMIT_DEFAULT,
      offset: offset ?? 0,
    },
  };
}

/** Escapes LIKE wildcards so a search for "100%" matches literally. */
export function likeEscape(q: string): string {
  return q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
}

const ORDER: Record<SearchSort, string> = {
  price_asc: "price ASC, id ASC",
  price_desc: "price DESC, id ASC",
  ending: "ends_at ASC, id ASC",
  newest: "created_at DESC, id DESC",
};

/** The SELECT for an active, not-yet-ended listing that matches the filters. */
export function buildSearchSql(
  p: SearchParams,
  now: number,
): { sql: string; params: (string | number)[] } {
  const where = ["_deleted = 0", "status = 'active'", "ends_at > ?"];
  const params: (string | number)[] = [now];
  if (p.scope !== null) {
    where.push("scope = ?");
    params.push(p.scope);
  }
  if (p.category !== null) {
    where.push("category = ?");
    params.push(p.category);
  }
  if (p.rarity !== null) {
    where.push("rarity = ?");
    params.push(p.rarity);
  }
  if (p.minLevel !== null) {
    where.push("level >= ?");
    params.push(p.minLevel);
  }
  if (p.maxLevel !== null) {
    where.push("level <= ?");
    params.push(p.maxLevel);
  }
  if (p.q !== null) {
    where.push("name_lower LIKE ? ESCAPE '\\'");
    params.push(`%${likeEscape(p.q)}%`);
  }
  const sql = `SELECT listing_json FROM market_listing WHERE ${where.join(" AND ")} ORDER BY ${ORDER[p.sort]} LIMIT ? OFFSET ?`;
  params.push(p.limit, p.offset);
  return { sql, params };
}

/** True for D1/SQLite errors caused by a table that is not migrated yet. */
export function isMissingTable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(msg);
}

/** Maps listing_json rows back to listings; rows that do not parse are skipped. */
export function mapListings(rows: { listing_json?: unknown }[]): MarketListing[] {
  const out: MarketListing[] = [];
  for (const r of rows) {
    if (typeof r.listing_json !== "string") continue;
    try {
      out.push(JSON.parse(r.listing_json) as MarketListing);
    } catch {
      // A corrupt row is dropped from the display, never fatal.
    }
  }
  return out;
}

/** Runs a search against the D1 read model. */
export async function searchListings(
  db: D1Database,
  p: SearchParams,
  now: number,
): Promise<MarketSearchResponse> {
  const { sql, params } = buildSearchSql(p, now);
  try {
    const res = await db
      .prepare(sql)
      .bind(...params)
      .all<{ listing_json: string | null }>();
    return { listings: mapListings(res.results), available: true };
  } catch (err) {
    if (isMissingTable(err)) return { listings: [], available: false };
    throw err;
  }
}

/** The account's own listings (as seller) and the active listings it leads (as top bidder). */
export async function myListings(
  db: D1Database,
  accountId: string,
  now: number,
): Promise<MarketMineResponse> {
  try {
    const selling = await db
      .prepare(
        `SELECT listing_json FROM market_listing WHERE _deleted = 0 AND seller_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(accountId, MINE_LIMIT)
      .all<{ listing_json: string | null }>();
    const leading = await db
      .prepare(
        `SELECT listing_json FROM market_listing WHERE _deleted = 0 AND top_bidder_id = ?
           AND status = 'active' AND ends_at > ?
         ORDER BY ends_at ASC, id ASC LIMIT ?`,
      )
      .bind(accountId, now, MINE_LIMIT)
      .all<{ listing_json: string | null }>();
    return { listings: mapListings(selling.results), bids: mapListings(leading.results) };
  } catch (err) {
    if (isMissingTable(err)) return { listings: [], bids: [] };
    throw err;
  }
}

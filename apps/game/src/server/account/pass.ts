/**
 * AccountDO battle pass (wave-C.md §7). OWNER: T-pass.
 * State per season: xp, per-source last totals (seasonProgress), claimed
 * tiers per track, xp txIds (addSeasonXp idempotency). premium = owns the
 * entitlement season.premiumSku (economy.entitlements()). claim: tier reached,
 * reward exists on that track, premium for the premium track, not claimed;
 * cosmetic rewards -> economy.grantEntitlement({txId:
 * "pass:<season>:<track>:<tier>", sku, source: "pass"}); coin -> wallet tx
 * (flow "faucet", reason "pass.reward:<season>:<tier>", same txId). Crossing a
 * tier pushes a "pass.tier" notice with id "pass:<season>:<tier>".
 *
 * Source baselines are global (not per season): a delta always counts toward
 * the season running when it arrives, so a new season never re-counts the
 * history of a source. A source total going DOWN only resets its baseline.
 *
 * Atomicity: the xp and baseline writes run in one transactionSync. Claims call
 * the economy/vault (each its own idempotent transaction) before the claim row
 * is written, so a retry after a crash replays the grant and never doubles it.
 * Notices go out after the commit (notify is idempotent by id).
 */
import {
  currentSeason,
  PASS_PREMIUM_GEMS,
  passReward,
  tierForXp,
  type SeasonDef,
} from "@gamez/economy";
import type { NoticeInput, PassTrack, PassView } from "@gamez/protocol";
import type { EconResult, SqlStore } from "../contracts.ts";
import type { AccountEconomy } from "./economy.ts";
import type { AccountNotices } from "./notices.ts";
import type { AccountVault } from "./vault.ts";

/** Largest xp of one addSeasonXp call (arena wins, dev grants). */
export const PASS_MAX_TX_XP = 10_000;
const MAX_TX_ID = 128;
const MAX_SOURCE = 100;
const MAX_REASON = 200;
const TRACKS: readonly PassTrack[] = ["free", "premium"];

type XpRow = { xp: number };
type TotalRow = { total: number };
type ClaimRow = { tier: number; track: string };

function isTxId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_TX_ID;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isTrack(v: unknown): v is PassTrack {
  return typeof v === "string" && (TRACKS as readonly string[]).includes(v);
}

export class AccountPass {
  constructor(
    readonly store: SqlStore,
    readonly economy: AccountEconomy,
    readonly vault: AccountVault,
    readonly notices: AccountNotices,
    readonly now: () => number = Date.now,
  ) {}

  init(): void {
    const sql = this.store.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS pass_xp (
      season TEXT PRIMARY KEY,
      xp INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS pass_source (
      source TEXT PRIMARY KEY,
      total INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS pass_tx (
      tx_id TEXT PRIMARY KEY,
      season TEXT NOT NULL,
      xp INTEGER NOT NULL,
      reason TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS pass_claim (
      season TEXT NOT NULL,
      track TEXT NOT NULL,
      tier INTEGER NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (season, track, tier)
    )`);
  }

  view(): PassView {
    const s = currentSeason(this.now());
    const xp = this.#xpOf(s.id);
    return {
      seasonId: s.id,
      name: s.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      xp,
      tier: tierForXp(s, xp),
      premium: this.#hasPremium(s),
      premiumSku: s.premiumSku,
      premiumGems: PASS_PREMIUM_GEMS,
      tiers: s.tiers,
      claimed: this.#claimedOf(s.id),
    };
  }

  /**
   * Monotonic progress of `source`: adds max(0, total - last) xp to the running
   * season and stores `total` as the new baseline. Replays add nothing. A total
   * below the baseline resets the baseline without adding xp.
   */
  seasonProgress(source: string, total: number): PassView {
    if (typeof source !== "string" || source.length === 0 || source.length > MAX_SOURCE)
      return this.view();
    if (!isNonNegInt(total)) return this.view();
    const season = currentSeason(this.now());
    const crossed = this.store.transactionSync(() => {
      const last = this.#lastTotal(source) ?? 0;
      this.store.sql.exec(
        "INSERT INTO pass_source (source, total) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET total = excluded.total",
        source,
        total,
      );
      if (total <= last) return null;
      return this.#addXpRow(season, total - last);
    });
    if (crossed) this.#announce(season, crossed.from, crossed.to);
    return this.view();
  }

  /**
   * One-off xp (arena wins, dev grants), idempotent by txId. Invalid input
   * (empty txId, xp not an integer in 1..PASS_MAX_TX_XP) changes nothing.
   */
  addXp(txId: string, xp: number, reason: string): PassView {
    if (!isTxId(txId)) return this.view();
    if (!Number.isSafeInteger(xp) || xp < 1 || xp > PASS_MAX_TX_XP) return this.view();
    const safeReason = typeof reason === "string" ? reason.slice(0, MAX_REASON) : "";
    const season = currentSeason(this.now());
    const crossed = this.store.transactionSync(() => {
      if (this.#findXpTx(txId)) return null;
      const change = this.#addXpRow(season, xp);
      this.store.sql.exec(
        "INSERT INTO pass_tx (tx_id, season, xp, reason, at) VALUES (?, ?, ?, ?, ?)",
        txId,
        season.id,
        xp,
        safeReason,
        this.now(),
      );
      return change;
    });
    if (crossed) this.#announce(season, crossed.from, crossed.to);
    return this.view();
  }

  /**
   * Claims one reward of the running season. Replays answer the view with
   * replayed=true and grant nothing again.
   */
  claim(tier: number, track: PassTrack): EconResult<PassView> {
    if (!isTrack(track))
      return { ok: false, code: "bad_request", message: "track: free or premium" };
    const season = currentSeason(this.now());
    if (!Number.isSafeInteger(tier) || tier < 1 || !season.tiers.some((t) => t.tier === tier))
      return { ok: false, code: "not_found", message: "no such tier this season" };
    const xp = this.#xpOf(season.id);
    if (tierForXp(season, xp) < tier)
      return { ok: false, code: "too_low", message: `reach tier ${tier} first` };
    const reward = passReward(season, tier, track);
    if (!reward) return { ok: false, code: "not_found", message: "no reward on this track" };
    if (track === "premium" && !this.#hasPremium(season))
      return { ok: false, code: "forbidden", message: "the premium track needs the premium pass" };
    if (this.#isClaimed(season.id, track, tier))
      return { ok: true, value: this.view(), replayed: true };

    const txId = `pass:${season.id}:${track}:${tier}`;
    try {
      if (reward.kind === "coin") {
        const credited = this.vault.walletTx({
          txId,
          currency: "coin",
          amount: reward.amount,
          reason: `pass.reward:${season.id}:${tier}`,
          flow: "faucet",
        });
        if (!credited.ok) return { ok: false, code: "internal", message: "could not credit coin" };
      } else {
        this.economy.grantEntitlement({ txId, sku: reward.sku, source: "pass" });
      }
    } catch {
      return { ok: false, code: "internal", message: "could not grant the reward" };
    }
    this.store.transactionSync(() => {
      this.store.sql.exec(
        "INSERT OR IGNORE INTO pass_claim (season, track, tier, at) VALUES (?, ?, ?, ?)",
        season.id,
        track,
        tier,
        this.now(),
      );
    });
    return { ok: true, value: this.view() };
  }

  // ---- helpers ------------------------------------------------------------

  /** Adds xp to the season's total (inside the caller's transaction). */
  #addXpRow(season: SeasonDef, xp: number): { season: SeasonDef; from: number; to: number } {
    const from = this.#xpOf(season.id);
    const to = from + xp;
    this.store.sql.exec(
      "INSERT INTO pass_xp (season, xp) VALUES (?, ?) ON CONFLICT(season) DO UPDATE SET xp = excluded.xp",
      season.id,
      to,
    );
    return { season, from, to };
  }

  /** Pushes one "pass.tier" notice per tier crossed between two xp totals. */
  #announce(season: SeasonDef, from: number, to: number): void {
    const before = tierForXp(season, from);
    const after = tierForXp(season, to);
    for (let tier = before + 1; tier <= after; tier++) {
      const notice: NoticeInput = {
        id: `pass:${season.id}:${tier}`,
        at: this.now(),
        kind: "pass.tier",
        text: `${season.name}: tier ${tier} reached`,
        data: { season: season.id, tier, xp: to },
      };
      this.notices.notify(notice);
    }
  }

  #xpOf(seasonId: string): number {
    const row = this.store.sql
      .exec<XpRow>("SELECT xp FROM pass_xp WHERE season = ?", seasonId)
      .toArray()[0];
    return row?.xp ?? 0;
  }

  #lastTotal(source: string): number | null {
    const row = this.store.sql
      .exec<TotalRow>("SELECT total FROM pass_source WHERE source = ?", source)
      .toArray()[0];
    return row?.total ?? null;
  }

  #findXpTx(txId: string): boolean {
    return (
      this.store.sql.exec("SELECT tx_id FROM pass_tx WHERE tx_id = ?", txId).toArray().length > 0
    );
  }

  #hasPremium(season: SeasonDef): boolean {
    return this.economy.entitlements().some((e) => e.sku === season.premiumSku);
  }

  #isClaimed(seasonId: string, track: PassTrack, tier: number): boolean {
    return (
      this.store.sql
        .exec(
          "SELECT tier FROM pass_claim WHERE season = ? AND track = ? AND tier = ?",
          seasonId,
          track,
          tier,
        )
        .toArray().length > 0
    );
  }

  #claimedOf(seasonId: string): Record<PassTrack, number[]> {
    const out: Record<PassTrack, number[]> = { free: [], premium: [] };
    const rows = this.store.sql
      .exec<ClaimRow>(
        "SELECT tier, track FROM pass_claim WHERE season = ? ORDER BY track, tier",
        seasonId,
      )
      .toArray();
    for (const r of rows) if (isTrack(r.track)) out[r.track].push(r.tier);
    return out;
  }
}

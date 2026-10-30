/**
 * Admin dashboard projections (migration 0010; docs/design/admin-dashboard.md §6):
 * the outbox records of AccountDO flow through the real applyBatch into D1.
 * Checks the columns, and that shuffled, duplicated and split batches end in
 * the same state as one ordered delivery (chaos). OWNER: T-projections.
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Outbox, applyBatch, SYNC_CURSOR_DDL, type ReplicationBatch } from "@gamez/sync";
import { AccountActivityStore, DAY_MS } from "../src/server/account/activity.ts";
import { AccountEconomy } from "../src/server/account/economy.ts";
import { AccountPass } from "../src/server/account/pass.ts";
import { AccountProfileStore } from "../src/server/account/profile.ts";
import { AccountPurchases } from "../src/server/account/purchases.ts";
import { AccountVault } from "../src/server/account/vault.ts";
import type { AccountNotices } from "../src/server/account/notices.ts";
import { projections } from "../src/server/projections.ts";
import { RecordingNotices, S1_START } from "./pass/support.ts";
import { fakeSqlStore } from "./support/fake-sql.ts";

type Bound = { sql: string; params: unknown[] };
type Row = Record<string, unknown>;

/**
 * A D1 over node:sqlite with the statement API applyBatch uses (bind, run with
 * meta.changes, batch as one transaction), migrated with every migration in order.
 */
class ChaosD1 {
  readonly db = new DatabaseSync(":memory:");

  constructor() {
    const dir = join(import.meta.dirname, "..", "migrations");
    const names = readdirSync(dir)
      .filter((n) => n.endsWith(".sql"))
      .sort();
    for (const name of names) this.db.exec(readFileSync(join(dir, name), "utf8"));
    this.db.exec(SYNC_CURSOR_DDL);
  }

  asD1(): D1Database {
    const db = this.db;
    const stmt = (sql: string, params: unknown[]) => ({
      sql,
      params,
      bind: (...more: unknown[]) => stmt(sql, more),
      run: async () => {
        const r = db.prepare(sql).run(...(params as never[]));
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
      all: async () => ({
        success: true,
        results: db.prepare(sql).all(...(params as never[])),
        meta: {},
      }),
      first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    });
    return {
      prepare: (sql: string) => stmt(sql, []),
      batch: async (statements: Bound[]) => {
        const out: unknown[] = [];
        db.exec("BEGIN");
        try {
          for (const s of statements) {
            const r = db.prepare(s.sql).run(...(s.params as never[]));
            out.push({ success: true, meta: { changes: Number(r.changes) } });
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
        return out;
      },
    } as unknown as D1Database;
  }

  all(sql: string): Row[] {
    return this.db.prepare(sql).all() as Row[];
  }
}

/** One AccountDO worth of projected state over fake storage. */
function account(accountId: string, startAt: number) {
  const clock = { t: startAt };
  const now = () => clock.t;
  const store = fakeSqlStore();
  const outbox = new Outbox(store.sql, `account:${accountId}`);
  outbox.init();
  const profile = new AccountProfileStore(store, accountId, outbox, now);
  profile.init();
  const activity = new AccountActivityStore(store, profile, outbox, accountId);
  activity.init();
  const economy = new AccountEconomy(store, now);
  economy.init();
  const vault = new AccountVault(store, economy, outbox, accountId, now);
  vault.init();
  const pass = new AccountPass(
    store,
    economy,
    vault,
    new RecordingNotices() as unknown as AccountNotices,
    now,
    outbox,
    accountId,
  );
  pass.init();
  return { clock, outbox, profile, activity, economy, pass };
}

/** Drives three accounts through a day of play and returns their outboxes. */
function playStream() {
  const a = account("acc-a", S1_START + 1_000);
  a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
  a.activity.touch(a.clock.t);
  a.pass.addXp("arena:1", 40, "arena");
  a.clock.t += 60_000;
  a.pass.addXp("arena:2", 70, "arena");
  a.clock.t += 60_000;
  a.profile.addIdentity({ provider: "email", subject: "a@example.test", email: "a@example.test" });
  a.economy.grantEntitlement({
    txId: "store:o1:premium",
    sku: "pass.premium.2026-s1",
    source: "store",
  });
  a.pass.syncProgress();
  a.clock.t += DAY_MS;
  a.activity.touch(a.clock.t);
  a.pass.seasonProgress("classic:1", 30);
  a.clock.t += DAY_MS;
  a.activity.touch(a.clock.t);

  const b = account("acc-b", S1_START + 5_000);
  b.profile.ensure({ kind: "registered", displayName: "Ana Lima" });
  b.activity.touch(b.clock.t);
  b.pass.addXp("arena:9", 15, "arena");
  b.clock.t += DAY_MS;
  b.profile.setDisplayName("Ana Lima Jr");
  b.activity.touch(b.clock.t);

  const c = account("acc-c", S1_START + 9_000);
  c.profile.ensure({ kind: "guest", displayName: "Guest-0C0C" });
  c.activity.touch(c.clock.t);
  return [a.outbox, b.outbox, c.outbox];
}

async function applyOrdered(d1: ChaosD1, outboxes: Outbox[]): Promise<void> {
  for (const outbox of outboxes) {
    const records = outbox.pending(10_000);
    if (records.length === 0) continue;
    await applyBatch(d1.asD1(), { source: outbox.source, records }, projections);
  }
}

/** Every projected table as sorted rows (sync_cursor is monitoring only). */
function dump(d1: ChaosD1): Record<string, Row[]> {
  return {
    account_summary: d1.all("SELECT * FROM account_summary ORDER BY account_id"),
    account_activity: d1.all("SELECT * FROM account_activity ORDER BY id"),
    pass_progress: d1.all("SELECT * FROM pass_progress ORDER BY id"),
  };
}

describe("projections for migration 0010", () => {
  it("account_summary carries registered_at (null for guests)", async () => {
    const [a, b, c] = playStream();
    const d1 = new ChaosD1();
    await applyOrdered(d1, [a!, b!, c!]);
    const rows = d1.all(
      "SELECT account_id, kind, display_name, created_at, registered_at FROM account_summary ORDER BY account_id",
    );
    expect(typeof rows[0]!.display_name).toBe("string");
    expect(rows).toEqual([
      {
        account_id: "acc-a",
        kind: "registered",
        display_name: rows[0]!.display_name, // derived from the email, checked above
        created_at: S1_START + 1_000,
        registered_at: S1_START + 121_000,
      },
      {
        account_id: "acc-b",
        kind: "registered",
        display_name: "Ana Lima Jr",
        created_at: S1_START + 5_000,
        registered_at: S1_START + 5_000,
      },
      {
        account_id: "acc-c",
        kind: "guest",
        display_name: "Guest-0C0C",
        created_at: S1_START + 9_000,
        registered_at: null,
      },
    ]);
  });

  it("account_activity has one row per account per UTC day", async () => {
    const outboxes = playStream();
    const d1 = new ChaosD1();
    await applyOrdered(d1, outboxes);
    const rows = d1.all(
      "SELECT id, account_id, day, kind, first_at FROM account_activity ORDER BY id",
    );
    const day0 = Math.floor((S1_START + 1_000) / DAY_MS);
    expect(rows).toEqual([
      // Day 0 was touched as a guest; the upgrade on day 0 does not rewrite that row.
      {
        id: `acc-a/${day0}`,
        account_id: "acc-a",
        day: day0,
        kind: "guest",
        first_at: S1_START + 1_000,
      },
      {
        id: `acc-a/${day0 + 1}`,
        account_id: "acc-a",
        day: day0 + 1,
        kind: "registered",
        first_at: S1_START + 1_000 + 120_000 + DAY_MS,
      },
      {
        id: `acc-a/${day0 + 2}`,
        account_id: "acc-a",
        day: day0 + 2,
        kind: "registered",
        first_at: S1_START + 1_000 + 120_000 + 2 * DAY_MS,
      },
      {
        id: `acc-b/${day0}`,
        account_id: "acc-b",
        day: day0,
        kind: "registered",
        first_at: S1_START + 5_000,
      },
      {
        id: `acc-b/${day0 + 1}`,
        account_id: "acc-b",
        day: day0 + 1,
        kind: "registered",
        first_at: S1_START + 5_000 + DAY_MS,
      },
      {
        id: `acc-c/${day0}`,
        account_id: "acc-c",
        day: day0,
        kind: "guest",
        first_at: S1_START + 9_000,
      },
    ]);
  });

  it("pass_progress carries level, xp, premium and premium_at", async () => {
    const outboxes = playStream();
    const d1 = new ChaosD1();
    await applyOrdered(d1, outboxes);
    const rows = d1.all(
      "SELECT account_id, season_id, level, xp, premium, premium_at, updated_at, _version FROM pass_progress ORDER BY id",
    );
    const a = rows.find((r) => r.account_id === "acc-a")!;
    expect(a).toMatchObject({
      season_id: "2026-s1",
      xp: 140,
      premium: 1,
      premium_at: S1_START + 121_000,
    });
    // xp 40, xp 70, premium grant, then seasonProgress +30: one row version per change.
    expect(a._version).toBe(4);
    const b = rows.find((r) => r.account_id === "acc-b")!;
    expect(b).toMatchObject({ xp: 15, premium: 0, premium_at: null });
    expect(rows.some((r) => r.account_id === "acc-c")).toBe(false);
  });

  it("a stale replay never overwrites a newer row", async () => {
    const [a] = playStream();
    const records = a!.pending(10_000);
    const d1 = new ChaosD1();
    await applyBatch(d1.asD1(), { source: "acc-a", records }, projections);
    const newest = dump(d1);
    // The oldest record of the stream arrives last.
    await applyBatch(d1.asD1(), { source: "acc-a", records: [records[0]!] }, projections);
    expect(dump(d1)).toEqual(newest);
  });
});

describe("chaos: shuffled, duplicated and split batches", () => {
  /** Small seeded PRNG (mulberry32) so a failure reproduces. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle<T>(xs: T[], rand: () => number): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  it("ends in the latest state for every seed", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed);
      const outboxes = playStream();

      const reference = new ChaosD1();
      await applyOrdered(reference, outboxes);
      const expected = dump(reference);

      // Split each source into random batches, duplicate some, shuffle everything.
      const batches: ReplicationBatch[] = [];
      for (const outbox of outboxes) {
        const records = outbox.pending(10_000);
        let i = 0;
        while (i < records.length) {
          const size = 1 + Math.floor(rand() * 3);
          batches.push({ source: outbox.source, records: records.slice(i, i + size) });
          i += size;
        }
        if (records.length > 0) {
          const dupe = records[Math.floor(rand() * records.length)]!;
          batches.push({ source: outbox.source, records: [dupe] });
        }
      }
      // Each batch is applied twice at most: duplicated deliveries are harmless.
      const delivered = shuffle([...batches, ...batches.filter(() => rand() < 0.5)], rand);

      const chaos = new ChaosD1();
      for (const batch of delivered) {
        await applyBatch(chaos.asD1(), batch, projections);
      }
      expect(dump(chaos), `seed ${seed}`).toEqual(expected);
    }
  });
});

describe("purchase projection (migration 0011)", () => {
  it("carries the reported charge and the fail reason of an order whose amount did not match", async () => {
    const store = fakeSqlStore();
    const outbox = new Outbox(store.sql, "account:acc-pay");
    outbox.init();
    const economy = new AccountEconomy(store, () => S1_START);
    economy.init();
    const vault = new AccountVault(store, economy, outbox, "acc-pay", () => S1_START);
    vault.init();
    const purchases = new AccountPurchases(
      store,
      economy,
      vault,
      new RecordingNotices() as unknown as AccountNotices,
      outbox,
      "acc-pay",
      () => S1_START,
    );
    purchases.init();
    const price = { currency: "BRL" as const, amountMinor: 490 };
    const good = "o00000000000000000000bb01";
    const bad = "o00000000000000000000bb02";
    for (const orderId of [good, bad])
      purchases.createOrder({ orderId, sku: "gems.small", provider: "asaas", price });
    purchases.fulfillOrder({
      orderId: good,
      providerRef: "pay_1",
      eventId: "e1",
      provider: "asaas",
      paid: price,
    });
    purchases.fulfillOrder({
      orderId: bad,
      providerRef: "pay_2",
      eventId: "e2",
      provider: "asaas",
      paid: { currency: "BRL", amountMinor: 1 },
    });
    const d1 = new ChaosD1();
    await applyOrdered(d1, [outbox]);
    expect(
      d1.all(
        "SELECT id, status, currency, amount_minor, paid_currency, paid_minor, fail_reason FROM purchase ORDER BY id",
      ),
    ).toEqual([
      {
        id: good,
        status: "paid",
        currency: "BRL",
        amount_minor: 490,
        paid_currency: "BRL",
        paid_minor: 490,
        fail_reason: null,
      },
      {
        id: bad,
        status: "failed",
        currency: "BRL",
        amount_minor: 490,
        paid_currency: "BRL",
        paid_minor: 1,
        fail_reason: "amount_mismatch: paid BRL 0.01, the order is BRL 4.90",
      },
    ]);
  });
});

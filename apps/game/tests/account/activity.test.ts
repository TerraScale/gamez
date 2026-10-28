/**
 * Admin dashboard D1 feeds (docs/design/admin-dashboard.md §6), on FakeSqlStorage:
 * account_activity (one row per UTC day, checkSession touches), registered_at
 * on the profile and summary, and pass_progress on xp / premium changes.
 * OWNER: T-projections.
 */
import { describe, expect, it } from "vite-plus/test";
import { currentSeason, tierForXp } from "@gamez/economy";
import { Outbox, type OutboxRecord } from "@gamez/sync";
import { AccountActivityStore, DAY_MS, utcDay } from "../../src/server/account/activity.ts";
import { AccountEconomy } from "../../src/server/account/economy.ts";
import { AccountPass } from "../../src/server/account/pass.ts";
import { AccountProfileStore } from "../../src/server/account/profile.ts";
import { AccountVault } from "../../src/server/account/vault.ts";
import type { AccountNotices } from "../../src/server/account/notices.ts";
import { RecordingNotices, S1_START } from "../pass/support.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";

const SKU_PREMIUM = "pass.premium.2026-s1";

function account(accountId = "acc-1") {
  const clock = { t: S1_START + 1_000 };
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
  const notices = new RecordingNotices();
  const pass = new AccountPass(
    store,
    economy,
    vault,
    notices as unknown as AccountNotices,
    now,
    outbox,
    accountId,
  );
  pass.init();
  return { clock, store, outbox, profile, activity, economy, pass };
}

/** Outbox records of one table, in seq order. */
function rowsOf(outbox: Outbox, table: string): OutboxRecord[] {
  return outbox.pending(10_000).filter((r) => r.table === table);
}

describe("utcDay", () => {
  it("counts UTC days from the epoch", () => {
    expect(utcDay(0)).toBe(0);
    expect(utcDay(DAY_MS - 1)).toBe(0);
    expect(utcDay(DAY_MS)).toBe(1);
    expect(utcDay(S1_START)).toBe(S1_START / DAY_MS);
  });
});

describe("account_activity", () => {
  it("writes one row per account per UTC day", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    expect(a.activity.touch(a.clock.t)).toBe(true);
    expect(a.activity.touch(a.clock.t + 5_000)).toBe(false); // same day: nothing
    const rows = rowsOf(a.outbox, "account_activity");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "upsert",
      pk: `acc-1/${utcDay(S1_START + 1_000)}`,
      version: 1,
      payload: {
        accountId: "acc-1",
        day: utcDay(S1_START + 1_000),
        kind: "guest",
        firstAt: S1_START + 1_000,
      },
    });
  });

  it("writes again on a new day, with the next version of that pk", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    a.activity.touch(a.clock.t);
    expect(a.activity.touch(a.clock.t + DAY_MS)).toBe(true);
    expect(a.activity.touch(a.clock.t + DAY_MS + 1)).toBe(false);
    const rows = rowsOf(a.outbox, "account_activity");
    expect(rows.map((r) => r.pk)).toEqual([
      `acc-1/${utcDay(S1_START + 1_000)}`,
      `acc-1/${utcDay(S1_START + 1_000 + DAY_MS)}`,
    ]);
    expect(a.activity.lastDay()).toBe(utcDay(S1_START + 1_000 + DAY_MS));
  });

  it("ignores a touch on an older day and writes nothing without a profile", () => {
    const a = account();
    expect(a.activity.touch(a.clock.t)).toBe(false); // no profile yet
    expect(rowsOf(a.outbox, "account_activity")).toHaveLength(0);
    a.profile.ensure({ kind: "registered", displayName: "Ana" });
    a.activity.touch(a.clock.t + DAY_MS);
    expect(a.activity.touch(a.clock.t)).toBe(false);
    expect(rowsOf(a.outbox, "account_activity")).toHaveLength(1);
  });

  it("checkSession touches activity, at most once a day", () => {
    const a = account();
    a.profile.ensure({ kind: "registered", displayName: "Ana" });
    const { sid } = a.profile.openSession("test-agent");
    expect(a.activity.checkSession(sid, a.clock.t)).toBe(true);
    expect(rowsOf(a.outbox, "account_activity")).toHaveLength(1);
    expect(a.activity.checkSession(sid, a.clock.t + 60_000)).toBe(true);
    expect(rowsOf(a.outbox, "account_activity")).toHaveLength(1);
    expect(a.activity.checkSession(sid, a.clock.t + DAY_MS)).toBe(true);
    expect(rowsOf(a.outbox, "account_activity")).toHaveLength(2);
  });

  it("an invalid session touches nothing", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    expect(a.activity.checkSession("no-such-sid", a.clock.t)).toBe(false);
    expect(rowsOf(a.outbox, "account_activity")).toHaveLength(0);
  });
});

describe("registered_at", () => {
  function lastSummary(outbox: Outbox): { registeredAt?: number | null; kind: string } {
    const rows = rowsOf(outbox, "account_summary");
    const payload = rows[rows.length - 1]!.payload as {
      registeredAt?: number | null;
      kind: string;
    };
    return { kind: payload.kind, registeredAt: payload.registeredAt ?? null };
  }

  it("is null for a guest", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    expect(lastSummary(a.outbox)).toMatchObject({ kind: "guest", registeredAt: null });
  });

  it("is set when a guest upgrades through addIdentity, and kept afterwards", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    a.clock.t += 3 * DAY_MS;
    const upgradedAt = a.clock.t;
    a.profile.addIdentity({
      provider: "email",
      subject: "ana@example.test",
      email: "ana@example.test",
    });
    expect(lastSummary(a.outbox)).toMatchObject({ kind: "registered", registeredAt: upgradedAt });
    a.clock.t += DAY_MS;
    a.profile.addIdentity({ provider: "google", subject: "g-1", email: null });
    expect(lastSummary(a.outbox)).toMatchObject({ kind: "registered", registeredAt: upgradedAt });
  });

  it("is set when a registered account is ensured", () => {
    const a = account();
    a.profile.ensure({ kind: "registered", displayName: "Ana" });
    expect(lastSummary(a.outbox)).toMatchObject({
      kind: "registered",
      registeredAt: S1_START + 1_000,
    });
  });

  it("is filled in once for registered accounts that predate the column", () => {
    const store = fakeSqlStore();
    const outbox = new Outbox(store.sql, "account:legacy");
    outbox.init();
    // The table as it was before migration 0010 (no registered_at).
    store.sql.exec(`CREATE TABLE account_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    store.sql.exec(
      "INSERT INTO account_profile (id, kind, display_name, created_at) VALUES (1, 'registered', 'Old Hand', 1234)",
    );
    const profile = new AccountProfileStore(store, "legacy", outbox, () => 9_999);
    profile.init();
    expect(lastSummary(outbox)).toMatchObject({ registeredAt: 1234 });
    const before = outbox.size();
    profile.init(); // a second init changes nothing
    expect(outbox.size()).toBe(before);
  });
});

describe("pass_progress", () => {
  function lastProgress(outbox: Outbox) {
    const rows = rowsOf(outbox, "pass_progress");
    return rows[rows.length - 1];
  }

  it("is appended on every xp change, in the same call", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    const seasonId = currentSeason(a.clock.t).id;
    a.pass.addXp("arena:m1:xp", 40, "arena");
    const first = lastProgress(a.outbox);
    expect(first).toMatchObject({
      pk: `acc-1/${seasonId}`,
      version: 1,
      payload: {
        accountId: "acc-1",
        seasonId,
        xp: 40,
        premium: false,
        premiumAt: null,
        updatedAt: a.clock.t,
      },
    });
    // Replayed txId: no xp change, no new row.
    a.pass.addXp("arena:m1:xp", 40, "arena");
    expect(rowsOf(a.outbox, "pass_progress")).toHaveLength(1);
    a.pass.seasonProgress("classic:1", 25);
    const second = lastProgress(a.outbox);
    expect(second).toMatchObject({ version: 2, payload: { xp: 65 } });
  });

  it("carries the level for the xp reached", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    const season = currentSeason(a.clock.t);
    a.pass.addXp("t-big", 5_000, "dev");
    const row = lastProgress(a.outbox)!.payload as { level: number; xp: number };
    expect(row.xp).toBe(5_000);
    expect(row.level).toBe(tierForXp(season, 5_000));
  });

  it("is appended when the premium pass is granted and when it is revoked", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    a.pass.addXp("t1", 10, "x");
    expect(a.pass.view().premium).toBe(false);
    a.clock.t += 2_000;
    a.economy.grantEntitlement({ txId: "store:o1:premium", sku: SKU_PREMIUM, source: "store" });
    a.pass.syncProgress();
    expect(lastProgress(a.outbox)).toMatchObject({
      payload: { premium: true, premiumAt: S1_START + 1_000 + 2_000 },
    });
    // A second sync with no change writes nothing.
    const count = rowsOf(a.outbox, "pass_progress").length;
    a.pass.syncProgress();
    expect(rowsOf(a.outbox, "pass_progress")).toHaveLength(count);
    // A refund sets revoked_at on the grant.
    a.store.sql.exec(
      "UPDATE entitlements SET revoked_at = ? WHERE sku = ?",
      a.clock.t,
      SKU_PREMIUM,
    );
    a.pass.syncProgress();
    expect(lastProgress(a.outbox)).toMatchObject({ payload: { premium: false, premiumAt: null } });
  });

  it("writes a premium row for a paid pass with no other pass activity", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    a.economy.grantEntitlement({ txId: "store:o9:premium", sku: SKU_PREMIUM, source: "store" });
    a.pass.syncProgress(); // AccountDO.fulfillOrder calls this after the grant
    expect(rowsOf(a.outbox, "pass_progress")).toHaveLength(1);
    expect(lastProgress(a.outbox)).toMatchObject({ payload: { premium: true, xp: 0 } });
  });

  it("writes nothing for an account with no pass activity", () => {
    const a = account();
    a.profile.ensure({ kind: "guest", displayName: "Guest-00AB" });
    a.economy.grantEntitlement({
      txId: "store:o2:cos",
      sku: "cosmetic.title.founder",
      source: "store",
    });
    a.pass.syncProgress();
    expect(rowsOf(a.outbox, "pass_progress")).toHaveLength(0);
  });
});

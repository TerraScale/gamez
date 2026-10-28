/** ConfigDO logic (admin/flags-store.ts) on node:sqlite: defaults, audit, dev admins. */
import { describe, expect, it } from "vite-plus/test";
import { FlagsStore, AUDIT_KEEP } from "../../src/server/admin/flags-store.ts";
import { DEFAULT_FLAGS } from "../../src/server/config/flags.ts";
import { FakeSqlStorage } from "../support/fake-sql.ts";

function store(now = () => 1_000) {
  const fake = new FakeSqlStorage();
  const s = new FlagsStore(
    { sql: fake.asSql(), transactionSync: (fn) => fake.transactionSync(fn) },
    now,
  );
  return { fake, s };
}

describe("FlagsStore", () => {
  it("answers every flag on when none was written", () => {
    const { s } = store();
    expect(s.flags()).toEqual(DEFAULT_FLAGS);
    expect(Object.values(s.flags()).every(Boolean)).toBe(true);
  });

  it("stores a patch, keeps the other flags, and audits each write", () => {
    let t = 5_000;
    const { s } = store(() => t);
    const after = s.setFlags({ market: false, trade: true }, "admin:acc-1");
    expect(after.market).toBe(false);
    expect(after.trade).toBe(true);
    expect(after.bank).toBe(true);
    t = 6_000;
    s.setFlags({ market: true }, "admin:acc-2");
    expect(s.flags().market).toBe(true);
    expect(s.audit(10)).toEqual([
      { flag: "market", value: true, by: "admin:acc-2", at: 6_000 },
      { flag: "trade", value: true, by: "admin:acc-1", at: 5_000 },
      { flag: "market", value: false, by: "admin:acc-1", at: 5_000 },
    ]);
  });

  it("ignores unknown flags and non-boolean values", () => {
    const { s } = store();
    const bad = { nope: false, shops: "no" } as unknown as Partial<Record<"shops", boolean>>;
    expect(s.setFlags(bad, "admin:x")).toEqual(DEFAULT_FLAGS);
    expect(s.audit()).toEqual([]);
  });

  it("keeps the audit trail bounded", () => {
    const { s, fake } = store();
    for (let i = 0; i < AUDIT_KEEP + 25; i++) s.setFlags({ pass: i % 2 === 0 }, "admin:x");
    const count = fake.db.prepare("SELECT COUNT(*) AS n FROM config_flag_audit").get() as {
      n: number;
    };
    expect(count.n).toBe(AUDIT_KEEP);
  });

  it("grants and checks dev admins", () => {
    const { s } = store();
    expect(s.isDevAdmin("acc-dev")).toBe(false);
    s.grantDevAdmin("acc-dev");
    s.grantDevAdmin("acc-dev");
    expect(s.isDevAdmin("acc-dev")).toBe(true);
    expect(s.isDevAdmin("acc-other")).toBe(false);
  });

  it("returns the public config with the current season and server time", () => {
    const { s } = store(() => 1_234);
    const config = s.config();
    expect(config.serverTime).toBe(1_234);
    expect(config.seasonId.length).toBeGreaterThan(0);
    expect(config.flags).toEqual(DEFAULT_FLAGS);
  });

  it("survives a second migrate (the DO constructor runs on every wake)", () => {
    const { s } = store();
    s.setFlags({ arena: false }, "admin:x");
    s.migrate();
    expect(s.flags().arena).toBe(false);
  });
});

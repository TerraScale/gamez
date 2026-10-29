/** ConfigDO logic (admin/flags-store.ts) on node:sqlite: defaults, audit, dev admins. */
import { describe, expect, it } from "vite-plus/test";
import { AUDIT_KEEP, FlagsStore, normalizeTunable } from "../../src/server/admin/flags-store.ts";
import { DEFAULT_FLAGS } from "../../src/server/config/flags.ts";
import { TUNABLES, type TunableSpec } from "@gamez/protocol";
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

const OFFLINE = "classic.offlineXpPct";

describe("FlagsStore tunables", () => {
  it("answers every tunable at its spec default when none was written", () => {
    const { s } = store();
    expect(s.tunables()).toEqual({ [OFFLINE]: 20 });
    expect(TUNABLES.find((t) => t.key === OFFLINE)?.default).toBe(20);
  });

  it("clamps to [min, max] on write", () => {
    const { s } = store();
    expect(s.setTunables({ [OFFLINE]: 250 }, "admin:a")[OFFLINE]).toBe(100);
    expect(s.setTunables({ [OFFLINE]: -5 }, "admin:a")[OFFLINE]).toBe(0);
    expect(s.tunables()[OFFLINE]).toBe(0);
  });

  it("rounds to the step, counted from min", () => {
    const spec: TunableSpec = {
      key: "t.frac",
      label: "t",
      description: "t",
      min: 0,
      max: 10,
      step: 0.5,
      default: 0,
      unit: "",
    };
    expect(normalizeTunable(spec, 2.3)).toBe(2.5);
    expect(normalizeTunable(spec, 2.1)).toBe(2);
    expect(normalizeTunable(spec, 99)).toBe(10);
    const offset: TunableSpec = { ...spec, min: 1, max: 10, step: 3 };
    expect(normalizeTunable(offset, 5)).toBe(4);
    // Offline XP is a whole percent.
    const { s } = store();
    expect(s.setTunables({ [OFFLINE]: 37.6 }, "admin:a")[OFFLINE]).toBe(38);
  });

  it("ignores unknown keys and non-finite values", () => {
    const { s } = store();
    const bad = {
      nope: 5,
      [OFFLINE]: Number.NaN,
    } as Record<string, number>;
    expect(s.setTunables(bad, "admin:x")).toEqual({ [OFFLINE]: 20 });
    expect(s.setTunables({ [OFFLINE]: Number.POSITIVE_INFINITY }, "admin:x")[OFFLINE]).toBe(20);
    expect(s.tunableAudit()).toEqual([]);
  });

  it("audits each change of an effective value, newest first", () => {
    let t = 1_000;
    const { s } = store(() => t);
    s.setTunables({ [OFFLINE]: 30 }, "admin:a");
    t = 2_000;
    s.setTunables({ [OFFLINE]: 30 }, "admin:b"); // no change: no audit row
    t = 3_000;
    s.setTunables({ [OFFLINE]: 40 }, "admin:c");
    expect(s.tunableAudit(10)).toEqual([
      { key: OFFLINE, value: 40, by: "admin:c", at: 3_000 },
      { key: OFFLINE, value: 30, by: "admin:a", at: 1_000 },
    ]);
    expect(s.tunables()[OFFLINE]).toBe(40);
  });

  it("keeps the tunable audit trail bounded", () => {
    const { s, fake } = store();
    for (let i = 0; i < AUDIT_KEEP + 25; i++) {
      s.setTunables({ [OFFLINE]: i % 2 === 0 ? 0 : 100 }, "admin:x");
    }
    const count = fake.db.prepare("SELECT COUNT(*) AS n FROM config_tunable_audit").get() as {
      n: number;
    };
    expect(count.n).toBe(AUDIT_KEEP);
  });

  it("includes the tunables in the public config", () => {
    const { s } = store(() => 1_234);
    s.setTunables({ [OFFLINE]: 15 }, "admin:x");
    expect(s.config().tunables).toEqual({ [OFFLINE]: 15 });
  });

  it("keeps stored tunables across a second migrate", () => {
    const { s } = store();
    s.setTunables({ [OFFLINE]: 60 }, "admin:x");
    s.migrate();
    expect(s.tunables()[OFFLINE]).toBe(60);
  });
});

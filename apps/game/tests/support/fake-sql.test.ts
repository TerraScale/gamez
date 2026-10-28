import { describe, expect, it } from "vite-plus/test";
import { fakeSqlStore } from "./fake-sql.ts";

describe("fakeSqlStore", () => {
  it("runs SQL and rolls back failed transactions", () => {
    const s = fakeSqlStore();
    s.sql.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)");
    s.transactionSync(() => s.sql.exec("INSERT INTO t VALUES (?, ?)", "a", 1));
    expect(() =>
      s.transactionSync(() => {
        s.sql.exec("INSERT INTO t VALUES (?, ?)", "b", 2);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.sql.exec("SELECT k, v FROM t").toArray()).toEqual([{ k: "a", v: 1 }]);
  });
});

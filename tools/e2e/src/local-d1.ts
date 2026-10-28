import { readdirSync, readFileSync } from "node:fs";

type Row = Record<string, unknown>;

interface RawResult {
  success: boolean;
  errors?: { message: string }[];
  result?: { results: { columns: string[]; rows: unknown[][] } }[];
}

/**
 * The dev server's local D1, reached through the Cloudflare Vite plugin's local
 * explorer API (`/cdn-cgi/local/explorer/api`). That API only exists in local
 * dev, so nothing here can touch a remote database.
 *
 * Why not `cf d1 … --local`: cf accepts only a database UUID, while the dev
 * server keys its local D1 by the binding id ("DB-gamez") until the binding
 * gets a real id in cloudflare.config.ts.
 */
export class LocalD1 {
  readonly baseUrl: string;
  readonly databaseId: string;

  private constructor(baseUrl: string, databaseId: string) {
    this.baseUrl = baseUrl;
    this.databaseId = databaseId;
  }

  /** Finds the local database behind `binding`. */
  static async open(baseUrl: string, binding = "DB"): Promise<LocalD1> {
    const res = await fetch(`${baseUrl}/cdn-cgi/local/explorer/api/d1/database`);
    const body = (await res.json()) as { result?: { name: string; uuid: string }[] };
    const db = body.result?.find((d) => d.name === binding);
    if (!db) throw new Error(`no local D1 binding "${binding}" at ${baseUrl}`);
    return new LocalD1(baseUrl, db.uuid);
  }

  /**
   * Runs SQL and returns the rows of the last statement as objects.
   *
   * The explorer's `/raw` endpoint rejects non-string params ("Invalid input"),
   * so numbers are sent as strings. Comparisons against INTEGER columns still
   * work because SQLite applies the column's affinity to the bound text.
   */
  async query<T extends Row = Row>(sql: string, rawParams: unknown[] = []): Promise<T[]> {
    const params = rawParams.map((p) =>
      typeof p === "number" || typeof p === "bigint" ? String(p) : p,
    );
    const res = await fetch(
      `${this.baseUrl}/cdn-cgi/local/explorer/api/d1/database/${encodeURIComponent(this.databaseId)}/raw`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql, params }),
      },
    );
    const body = (await res.json()) as RawResult;
    if (!res.ok || !body.success) {
      throw new Error(
        `D1 query failed: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`,
      );
    }
    const last = body.result?.at(-1)?.results;
    if (!last) return [];
    return last.rows.map((r) => Object.fromEntries(last.columns.map((c, i) => [c, r[i]])) as T);
  }

  /**
   * Applies `<dir>/*.sql` in name order, skipping files already recorded in
   * `d1_migrations` (the same table shape `cf d1 migrations apply` uses).
   * Returns the names it applied.
   */
  async migrate(dir: string): Promise<string[]> {
    await this.query(`CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`);
    const done = new Set(
      (await this.query<{ name: string }>("SELECT name FROM d1_migrations")).map((r) => r.name),
    );
    const applied: string[] = [];
    for (const name of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (done.has(name)) continue;
      await this.query(readFileSync(`${dir}/${name}`, "utf8"));
      await this.query("INSERT INTO d1_migrations (name) VALUES (?)", [name]);
      applied.push(name);
    }
    return applied;
  }
}

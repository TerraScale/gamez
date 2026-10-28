/**
 * Applies apps/game/migrations to the local D1 of a running `vp dev`.
 * Usage: vp run migrate-local [baseUrl]   (default http://localhost:5173)
 */
import { LocalD1 } from "./local-d1.ts";
import { MIGRATIONS_DIR } from "./paths.ts";

const baseUrl = process.argv[2] ?? "http://localhost:5173";
try {
  const db = await LocalD1.open(baseUrl);
  const applied = await db.migrate(MIGRATIONS_DIR);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "local D1 is up to date");
} catch (err) {
  console.error(`could not migrate the local D1 at ${baseUrl} (is \`vp dev\` running?):`, err);
  process.exitCode = 1;
}

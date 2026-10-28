/**
 * End-to-end check against a real `vp dev` (workerd + Miniflare):
 *
 *  1. starts the dev server and applies the D1 migrations to its local D1;
 *  2. two guests connect, each gets a welcome and sees the other;
 *  3. A walks to a tile; B must get a delta with A's path ending there;
 *  4. the end tile must reach D1 (ChunkDO -> CharacterDO outbox -> Queue -> D1);
 *  5. A plays the instanced test modes (steps, duel) over /ws/instance: scripted
 *     actions replayed on a local sim, invalid / unknown / stale actions rejected;
 *  6. the dev server restarts: A's welcome must put it on that tile, and each
 *     instance must resume from its persisted snapshot; a fresh join resets it;
 *  7. the client module graph (classic runs its whole sim in the browser) loads:
 *     every module the page imports, statically or dynamically, answers 200.
 *
 * Usage: `vp run e2e` (plain node, type stripping). Env: E2E_PORT, default 5299;
 * E2E_LOG, default /tmp/gamez-e2e-dev.log.
 * Exit code 0 only when every check passed. Prints the measured timings.
 */
import { townMap } from "@gamez/classic.town";
import type { EntityState, ServerMessage, TilePos } from "@gamez/protocol";
import { findPath, isWalkable, pathDuration } from "@gamez/world";
import { BotClient, loginGuest, type Received } from "./client.ts";
import { crawlClientGraph } from "./client-graph.ts";
import { FEATURES, type E2eContext } from "./features.ts";
import { startDevServer, type DevServer } from "./dev-server.ts";
import { play, resume, SCRIPTS, type PlayedInstance } from "./instance.ts";
import { LocalD1 } from "./local-d1.ts";
import { MIGRATIONS_DIR } from "./paths.ts";
import { check, fail, failureCount, timings } from "./report.ts";

type Welcome = Extract<ServerMessage, { t: "welcome" }>;
type Delta = Extract<ServerMessage, { t: "delta" }>;

const PORT = Number(process.env.E2E_PORT ?? 5299);
const LOG = process.env.E2E_LOG ?? "/tmp/gamez-e2e-dev.log";
const REPLICATION_TIMEOUT_MS = 20_000;
/** Modules the client graph must reach: the classic view and the wave A modules. */
const CLIENT_MODULES = [
  "modules/classic/src/client/game.ts",
  "modules/classic/src/client/audio/index.ts",
  "modules/classic/src/talents/index.ts",
  "modules/classic/src/crafting/index.ts",
  "modules/classic/src/rift/index.ts",
  "modules/classic/src/achievements/index.ts",
  "modules/steps/src/client",
  "modules/duel/src/client",
];

const isWelcome = (m: ServerMessage): m is Welcome => m.t === "welcome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (n: number) => `${n.toFixed(0)} ms`;

function same(a: TilePos | undefined, b: TilePos): boolean {
  return a !== undefined && a.x === b.x && a.y === b.y;
}

/** A walkable, reachable tile a few steps from `from`, so the walk takes about two seconds. */
function pickTarget(from: TilePos): TilePos {
  for (const [dx, dy] of [
    [6, 3],
    [-6, 3],
    [3, -6],
    [-3, -6],
    [4, 0],
    [0, 4],
  ] as const) {
    const t = { x: from.x + dx, y: from.y + dy };
    if (isWalkable(townMap, t.x, t.y) && findPath(townMap, from, t)) return t;
  }
  throw new Error(`no reachable target near ${from.x},${from.y}`);
}

function welcomeOf(bot: BotClient): Promise<Received<Welcome>> {
  return bot.waitFor("welcome", isWelcome);
}

/** A walks to `target`; B must see the path, then D1 must get the end tile. */
async function walkAndReplicate(
  a: BotClient,
  b: BotClient,
  db: LocalD1,
  target: TilePos,
  label: string,
): Promise<void> {
  const from = b.log.length;
  const errorsBefore = a.log.filter((r) => r.msg.t === "error").length;
  const sentAt = performance.now();
  a.send({ t: "moveTo", target });
  const moved = await b.waitFor(
    `delta with A's path (${label})`,
    (m): m is Delta =>
      m.t === "delta" &&
      m.upserts.some((e) => e.id === a.characterId && same(e.path.at(-1), target)),
    10_000,
    from,
  );
  timings[`${label}: moveTo -> delta at B`] = moved.at - sentAt;
  const walk = moved.msg.upserts.find((e) => e.id === a.characterId) as EntityState;
  check(walk.path.length > 0, `${label}: B sees A walking to ${target.x},${target.y}`);
  check(
    a.log.filter((r) => r.msg.t === "error").length === errorsBefore,
    `${label}: A got no error`,
  );

  // Same machine, so the server's epoch ms and ours agree.
  const walkEndsAt = walk.pathStartedAt + pathDuration(walk.pos, walk.path, walk.speed) * 1000;
  timings[`${label}: walk duration`] = walkEndsAt - walk.pathStartedAt;
  let row: { x: number; y: number; _version: number } | undefined;
  let rowAt = 0;
  while (Date.now() < walkEndsAt + REPLICATION_TIMEOUT_MS) {
    [row] = await db.query<{ x: number; y: number; _version: number }>(
      "SELECT x, y, _version FROM character_summary WHERE character_id = ?",
      [a.characterId],
    );
    if (row && same(row, target)) {
      rowAt = Date.now();
      break;
    }
    await sleep(100);
  }
  const got = row ? `${row.x},${row.y} v${row._version}` : "no row";
  check(
    rowAt > 0,
    `${label}: D1 character_summary for A is at ${target.x},${target.y} (got ${got})`,
  );
  if (rowAt > 0) timings[`${label}: walk end -> row in D1 (replication lag)`] = rowAt - walkEndsAt;
  const [cursor] = await db.query<{ last_seq: number }>(
    "SELECT last_seq FROM sync_cursor WHERE source = ?",
    [`character:${a.characterId}`],
  );
  check(
    cursor !== undefined && cursor.last_seq >= (row?._version ?? 1),
    `${label}: sync_cursor advanced (last_seq ${cursor?.last_seq ?? "none"})`,
  );
}

async function run(): Promise<void> {
  let server: DevServer | null = null;
  try {
    // 1. dev server + local D1 migrations
    server = await startDevServer(PORT, LOG);
    timings["dev server startup"] = server.startupMs;
    const db = await LocalD1.open(server.url);
    const applied = await db.migrate(MIGRATIONS_DIR);
    console.log(
      `local D1 ${db.databaseId}: ${applied.length ? `applied ${applied.join(", ")}` : "migrations already applied"}`,
    );
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    check(
      ["character_summary", "sync_cursor"].every((t) => tables.some((r) => r.name === t)),
      "local D1 has character_summary and sync_cursor",
    );

    // 2. two guests see each other
    const [guestA, guestB] = await Promise.all([loginGuest(server.url), loginGuest(server.url)]);
    const a = new BotClient(server.url, guestA);
    const wa = await welcomeOf(a);
    timings["welcome latency A (cold DOs)"] = wa.at - a.openedAt;
    const selfA = wa.msg.entities.find((e) => e.id === a.characterId);
    check(
      wa.msg.selfId === a.characterId && selfA !== undefined,
      "A's welcome has selfId and its own entity",
    );

    const b = new BotClient(server.url, guestB);
    const wb = await welcomeOf(b);
    timings["welcome latency B (warm DOs)"] = wb.at - b.openedAt;
    check(
      wb.msg.entities.some((e) => e.id === a.characterId),
      "B's welcome contains A",
    );
    const seesB = await a.waitFor(
      "delta with B",
      (m): m is Delta => m.t === "delta" && m.upserts.some((e) => e.id === b.characterId),
    );
    check(
      seesB.msg.upserts.some((e) => e.name === guestB.name),
      "A gets a delta with B (by name)",
    );

    // 3 + 4, twice: the first walk races the alarm armed when A was created; the
    // second shows the steady-state lag (outbox alarm delay + queue batch timeout).
    if (!selfA) throw new Error("A has no entity");
    const first = pickTarget(selfA.pos);
    await walkAndReplicate(a, b, db, first, "1st walk");
    const target = pickTarget(first);
    await walkAndReplicate(a, b, db, target, "2nd walk");

    // Leave cleanly: B must see A go before the restart.
    const beforeLeave = b.log.length;
    await a.close();
    await b.waitFor(
      "A's remove",
      (m): m is Delta => m.t === "delta" && m.removes.includes(a.characterId),
      5000,
      beforeLeave,
    );
    await b.close();

    // 5. instanced test modes, as A
    const played: PlayedInstance[] = [];
    for (const script of SCRIPTS) played.push(await play(server.url, guestA, script));

    // 5b. wave B features (features.ts), each with its own fresh guests
    const [wbA, wbB] = await Promise.all([loginGuest(server.url), loginGuest(server.url)]);
    const wave: E2eContext = { url: server.url, db, guestA: wbA, guestB: wbB, state: new Map() };
    for (const f of FEATURES) {
      const t0 = performance.now();
      try {
        await f.run(wave);
      } catch (err) {
        fail(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      timings[`wave B ${f.name}`] = performance.now() - t0;
    }

    // 6. restart the dev server (every DO restarts) and reconnect A
    await server.stop();
    server = null;
    server = await startDevServer(PORT, LOG);
    timings["dev server restart"] = server.startupMs;
    const a2 = new BotClient(server.url, guestA);
    const wa2 = await welcomeOf(a2);
    timings["welcome latency A after restart"] = wa2.at - a2.openedAt;
    const back = wa2.msg.entities.find((e) => e.id === a.characterId);
    check(
      back !== undefined && same(back.pos, target) && back.path.length === 0,
      `after restart A's welcome puts A at ${target.x},${target.y} (got ${back ? `${back.pos.x},${back.pos.y}` : "no entity"})`,
    );
    check(
      !wa2.msg.entities.some((e) => e.id === b.characterId),
      "after restart B (who left) is gone",
    );
    await a2.close();
    for (const run of played) await resume(server.url, run);
    wave.url = server.url;
    for (const f of FEATURES) {
      if (!f.afterRestart) continue;
      try {
        await f.afterRestart(wave);
      } catch (err) {
        fail(`${f.name} after restart: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 7. the client module graph, including every classic module (sim + client)
    const graphStart = performance.now();
    const graph = await crawlClientGraph(server.url);
    timings["client module graph (cold transform)"] = performance.now() - graphStart;
    check(
      graph.failed.length === 0,
      `client module graph: ${graph.modules.length} modules, ${graph.failed.length} failed${graph.failed
        .slice(0, 5)
        .map((f) => `\n      ${f.status} ${f.url}`)
        .join("")}`,
    );
    for (const want of CLIENT_MODULES) {
      check(
        graph.modules.some((u) => u.includes(want)),
        `client module graph includes ${want}`,
      );
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    await server?.stop();
  }

  console.log("\ntimings:");
  for (const [k, v] of Object.entries(timings)) console.log(`  ${k.padEnd(52)} ${ms(v)}`);
  const failures = failureCount();
  console.log(
    failures === 0
      ? "\ne2e: all checks passed"
      : `\ne2e: ${failures} check(s) failed (dev log: ${LOG})`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await run();

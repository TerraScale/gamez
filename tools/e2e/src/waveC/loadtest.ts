/**
 * Wave C e2e: presence at scale (docs/design/wave-C.md §12). OWNER: T-scale.
 *
 * - world fixtures: the dev hook /api/dev/presence/fixtures sets a "loadtest"
 *   shopkeeper; a bad set is refused;
 * - 50 pose bots (tools/loadtest BotPool, in process) join classic-town and
 *   pose at 3/s for about 8 s: every bot sees at least 45 others, p95 pose ->
 *   delivery under 1 s, no errors or closes, and the bots spread over several
 *   relay shards that the chunk fans out to;
 * - a fixture change reaches connected bots as an upsert, a fresh bot gets the
 *   fixture in its welcome, a removal reaches them as a remove;
 * - after the dev server restarts, a persisted fixture is still in a fresh
 *   bot's welcome (then the group is cleared).
 */
import type { EntityState, ServerMessage } from "@gamez/protocol";
import { BotPool } from "../../../loadtest/src/pool.ts";
import { PoseBot, SwarmSink } from "../../../loadtest/src/bot.ts";
import { Histogram } from "../../../loadtest/src/stats.ts";
import type { E2eContext, E2eFeature } from "../features.ts";
import { check } from "../report.ts";

const WORLD = "classic-town";
const GROUP = "loadtest";
const BOTS = 50;
const WINDOW_MS = 8000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function keeper(name: string, x = 40, y = 40): Record<string, unknown> {
  return {
    id: `${GROUP}:k1`,
    kind: "shopkeeper",
    name,
    appearance: "unit.hero",
    pos: { x, y },
    path: [],
    pathStartedAt: 0,
    speed: 0,
    tag: "e2e · Open",
  };
}

async function setFixtures(
  url: string,
  fixtures: unknown,
): Promise<{
  status: number;
  body: { ok?: boolean; fixtures?: EntityState[]; error?: { code: string } };
}> {
  const res = await fetch(`${url}/api/dev/presence/fixtures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ world: WORLD, group: GROUP, fixtures }),
  });
  return { status: res.status, body: (await res.json()) as never };
}

/** Resolves with the first message `bot` receives (from now on) that matches, or null after `ms`. */
function next(
  bot: PoseBot,
  match: (m: ServerMessage) => boolean,
  ms = 5000,
): Promise<ServerMessage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, ms);
    const off = bot.on((m) => {
      if (!match(m)) return;
      clearTimeout(timer);
      off();
      resolve(m);
    });
  });
}

/** The entity with this id in a fresh bot's welcome (the bot leaves again). */
async function freshWelcome(url: string, id: string): Promise<EntityState | undefined> {
  const bot = new PoseBot({ url, world: WORLD, poseHz: 1, width: 72, height: 72 }, new SwarmSink());
  let seen: EntityState | undefined;
  bot.on((m) => {
    if (m.t === "welcome") seen = m.entities.find((e) => e.id === id);
  });
  try {
    await bot.join();
  } catch {
    return undefined;
  } finally {
    await bot.stop();
  }
  return seen;
}

export const loadtestFeature: E2eFeature = {
  name: "loadtest",
  async run(ctx: E2eContext) {
    const url = ctx.url;

    // Fixtures: a bad set is refused, a good one is stored and echoed.
    const bad = await setFixtures(url, [{ ...keeper("Nope"), kind: "player" }]);
    check(
      bad.status === 400 && bad.body.error?.code === "bad-kind",
      `a fixture of kind "player" is refused (${bad.status} ${bad.body.error?.code})`,
    );
    const outside = await setFixtures(url, [keeper("Nope", 72, 0)]);
    check(outside.status === 400, `a fixture outside the town is refused (${outside.status})`);
    const set = await setFixtures(url, [keeper("E2E Keeper")]);
    check(
      set.status === 200 && set.body.fixtures?.[0]?.name === "E2E Keeper",
      `the dev hook stores a shopkeeper fixture (${set.status})`,
    );

    // 50 bots.
    const pool = new BotPool({ url, world: WORLD, poseHz: 3, width: 72, height: 72 }, 10);
    try {
      const started = performance.now();
      const grow = await pool.grow(BOTS);
      const joinMs = performance.now() - started;
      check(
        grow.failed === 0 && pool.bots.length === BOTS,
        `${BOTS} pose bots join ${WORLD} (${pool.bots.length} in ${joinMs.toFixed(0)} ms${grow.errors.length ? `; ${grow.errors[0]}` : ""})`,
      );
      await sleep(2000);
      pool.reset();
      await sleep(WINDOW_MS);
      const r = pool.report();
      const e2e = new Histogram();
      e2e.merge(r.e2e);
      const lat = e2e.summary();
      const minSeen = Math.min(...r.seenPlayers);
      check(
        minSeen >= BOTS - 5,
        `every bot sees at least ${BOTS - 5} others (min ${minSeen}, mean ${(r.seenPlayers.reduce((a, b) => a + b, 0) / r.seenPlayers.length).toFixed(1)})`,
      );
      check(
        lat.n > 0 && lat.p95 < 1000,
        `pose -> delivery p95 under 1 s (p50 ${lat.p50} / p95 ${lat.p95} / p99 ${lat.p99} ms over ${lat.n} deliveries)`,
      );
      const expected = r.posesSent * (BOTS - 1);
      check(
        r.upserts >= expected * 0.95,
        `bots receive >= 95 % of the others' poses (${((r.upserts / Math.max(1, expected)) * 100).toFixed(1)} %)`,
      );
      check(
        Object.keys(r.errors).length === 0 && r.closes === 0,
        `no errors or closes under load (${JSON.stringify(r.errors)}, closes ${r.closes})`,
      );
      check(
        Math.min(...r.seenFixtures) >= 1,
        `every bot's world includes the shopkeeper fixture (min ${Math.min(...r.seenFixtures)})`,
      );
      const stats = (await (
        await fetch(`${url}/api/dev/presence/stats?world=${WORLD}`)
      ).json()) as { relays: string[]; avatars: number; fixtures: number };
      const shards = stats.relays.filter((n) => n.includes(`:${WORLD}:`));
      check(
        shards.length >= 2,
        `the chunk fans out to several relay shards (${shards.join(", ")}; ${stats.avatars} avatars)`,
      );

      // A fixture change reaches connected bots; a fresh bot gets it in its welcome.
      const watcher = pool.bots[0]!;
      const renamed = next(watcher, (m) =>
        m.t === "delta"
          ? m.upserts.some((e) => e.id === `${GROUP}:k1` && e.name === "Renamed")
          : false,
      );
      await setFixtures(url, [keeper("Renamed", 41, 40)]);
      const upsert = await renamed;
      const got =
        upsert?.t === "delta" ? upsert.upserts.find((e) => e.id === `${GROUP}:k1`) : undefined;
      check(
        got?.kind === "shopkeeper" && got.pos.x === 41 && got.path.length === 0,
        `a connected bot gets the changed fixture as an upsert (${got ? `${got.kind} at ${got.pos.x},${got.pos.y}` : "none"})`,
      );
      const fresh = await freshWelcome(url, `${GROUP}:k1`);
      check(
        fresh?.kind === "shopkeeper" && fresh.name === "Renamed" && fresh.tag === "e2e · Open",
        `a fresh bot's welcome includes the fixture (${fresh ? `${fresh.kind} "${fresh.name}"` : "missing"})`,
      );

      const removed = next(watcher, (m) => m.t === "delta" && m.removes.includes(`${GROUP}:k1`));
      await setFixtures(url, []);
      check((await removed) !== null, "clearing the group reaches connected bots as a remove");
    } finally {
      await pool.stop();
    }

    // Leave one fixture for the restart check.
    const keep = await setFixtures(url, [keeper("Survivor", 42, 42)]);
    ctx.state.set("loadtest", keep.status === 200);
  },

  async afterRestart(ctx: E2eContext) {
    if (ctx.state.get("loadtest") !== true) {
      check(false, "loadtest: the restart fixture was not stored before the restart");
      return;
    }
    const fresh = await freshWelcome(ctx.url, `${GROUP}:k1`);
    check(
      fresh?.kind === "shopkeeper" && fresh.name === "Survivor",
      `a fixture survives a dev-server restart (fresh welcome: ${fresh ? fresh.name : "missing"})`,
    );
    await setFixtures(ctx.url, []);
  },
};

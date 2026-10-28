/**
 * Wave B e2e: classic_hero rows reach D1 after a verified play and close, and
 * GET /api/leaderboards returns the account's row. OWNER: T-leaderboards.
 * Uses ClassicBot (T-verify).
 */
import { ClassicBot } from "./classic-bot.ts";
import { check, fail } from "./report.ts";
import { loginGuest } from "./client.ts";
import type { E2eContext, E2eFeature } from "./features.ts";

type HeroRow = {
  account_id: string;
  level: number;
  xp: number;
  _deleted: number;
  imported: number;
};

type BoardBody = {
  board: string;
  available: boolean;
  rows: { rank: number; accountId: string; value: number; heroLevel: number; imported: boolean }[];
};

const PLAY_TICKS = 400;
const POLL_MS = 20_000;

/** Polls D1 until the account's classic_hero row exists (queue apply is async). */
async function waitForHeroRow(ctx: E2eContext, accountId: string): Promise<HeroRow | null> {
  const until = Date.now() + POLL_MS;
  while (Date.now() < until) {
    const rows = await ctx.db.query<HeroRow>(
      "SELECT account_id, level, xp, _deleted, imported FROM classic_hero WHERE account_id = ? AND _deleted = 0",
      [accountId],
    );
    if (rows[0]) return rows[0];
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

export const leaderboardsFeature: E2eFeature = {
  name: "leaderboards",
  async run(ctx) {
    const guest = await loginGuest(ctx.url);
    const bot = await ClassicBot.join(ctx.url, guest, {
      fresh: true,
      classId: "classic.warrior",
      heroName: "Board",
    });

    try {
      const played = await bot.play(PLAY_TICKS);
      check(played.resyncs.length === 0, "leaderboards: verified play has no resync");
    } finally {
      // The last close compacts and reports the hero into the outbox.
      await bot.close();
    }

    const row = await waitForHeroRow(ctx, guest.accountId);
    check(row !== null, "leaderboards: classic_hero row reached D1 within 20 s");
    if (!row) return;
    check(row.imported === 0, "leaderboards: a fresh guest's row is not imported");

    const res = await fetch(`${ctx.url}/api/leaderboards?board=level&mode=classic&limit=100`);
    check(res.status === 200, "leaderboards: GET /api/leaderboards answers 200");
    check(
      res.headers.get("cache-control") === "public, max-age=15",
      "leaderboards: public cache-control header",
    );
    const body = (await res.json()) as BoardBody;
    check(body.board === "level" && body.available === true, "leaderboards: level board available");

    // Rank from D1 (level DESC, xp DESC). Only rows inside the top 100 must show up.
    const ahead = await ctx.db.query<{ n: number }>(
      // Imported heroes are never ranked (ADR 0007 R1).
      "SELECT COUNT(*) AS n FROM classic_hero WHERE _deleted = 0 AND COALESCE(imported, 0) = 0 AND mode = 'classic' AND (level > ? OR (level = ? AND xp > ?))",
      [row.level, row.level, row.xp],
    );
    const rank = (ahead[0]?.n ?? 0) + 1;
    const mine = body.rows.find((r) => r.accountId === guest.accountId);
    if (rank <= 100) {
      check(mine !== undefined, `leaderboards: account is on the level board (rank ${rank})`);
      if (mine) {
        check(
          mine.heroLevel === row.level && mine.value === row.level,
          "leaderboards: row level matches D1",
        );
      }
    } else {
      check(
        mine === undefined,
        `leaderboards: account beyond the top 100 (rank ${rank}) is not listed`,
      );
    }
    if (body.rows.length === 0) fail("leaderboards: level board returned no rows");
  },
};

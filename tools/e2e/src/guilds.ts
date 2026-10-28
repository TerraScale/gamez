/**
 * Wave B e2e: guild create/join/leave, roster, guild_index in D1, search and
 * the guest rule (docs/design/wave-B.md §6, §10). OWNER: T-guilds.
 *
 * Needs registered accounts (POST /api/auth/register).
 */
import type { GuildInfo, GuildSummary } from "@gamez/protocol";
import { api, registerGuest, type Registered } from "./accounts.ts";
import { loginGuest } from "./client.ts";
import type { E2eContext, E2eFeature } from "./features.ts";
import { check } from "./report.ts";

const POLL_MS = 20_000;

/** Calls `read` until it returns a value or the time runs out (the sync queue is asynchronous). */
async function poll<T>(read: () => Promise<T | null>, timeoutMs = POLL_MS): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null || Date.now() >= until) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export const guildsFeature: E2eFeature = {
  name: "guilds",
  async run(ctx: E2eContext) {
    const suffix = Date.now().toString(36);
    const id = `e2e-${suffix}`;
    const name = `E2E ${suffix}`;
    const tag = `G${String(Date.now() % 1000).padStart(3, "0")}`;

    const a: Registered = await registerGuest(
      ctx.url,
      await loginGuest(ctx.url),
      `Ada ${suffix.slice(-4)}`,
    );
    const b: Registered = await registerGuest(
      ctx.url,
      await loginGuest(ctx.url),
      `Bo ${suffix.slice(-4)}`,
    );

    // Create, mine, join, roster.
    const created = await api<{ guild?: GuildInfo }>(ctx.url, "/api/guilds", {
      token: a.token,
      body: { name, tag, open: true },
    });
    check(created.status === 201 && created.body.guild?.id === id, "guild: A creates it (201)");

    const mine = await api<{ guild: GuildInfo | null }>(ctx.url, "/api/guilds/mine", {
      token: a.token,
    });
    check(mine.body.guild?.id === id, "guild: GET /api/guilds/mine shows it for A");

    const joined = await api<{ guild?: GuildInfo }>(ctx.url, `/api/guilds/${id}/join`, {
      token: b.token,
      method: "POST",
    });
    check(
      joined.status === 200 && joined.body.guild?.members.length === 2,
      "guild: B joins, roster has 2",
    );

    const roster = await api<{ guild: GuildInfo }>(ctx.url, `/api/guilds/${id}`);
    check(
      roster.body.guild?.members.some((m) => m.accountId === b.accountId && m.role === "member") ===
        true,
      "guild: GET /api/guilds/:id lists B as a member",
    );

    // The D1 read model follows the DO outbox.
    const row = await poll(async () => {
      const rows = await ctx.db.query<{ member_count: number; open: number; tag: string }>(
        "SELECT member_count, open, tag FROM guild_index WHERE guild_id = ? AND _deleted = 0",
        [id],
      );
      return rows[0]?.member_count === 2 ? rows[0] : null;
    });
    check(
      row !== null && row.open === 1 && row.tag === tag,
      "guild: D1 guild_index row with member_count 2 (within 20 s)",
    );

    const search = await api<{ guilds: GuildSummary[] }>(
      ctx.url,
      `/api/guilds?q=${encodeURIComponent(suffix)}`,
    );
    check(
      search.body.guilds?.some((g) => g.id === id && g.memberCount === 2) === true,
      "guild: search by name finds it with 2 members",
    );

    // Guests browse but never join or create.
    const guest = await loginGuest(ctx.url);
    const guestJoin = await api<{ error?: { code: string } }>(ctx.url, `/api/guilds/${id}/join`, {
      token: guest.token,
      method: "POST",
    });
    check(
      guestJoin.status === 403 && guestJoin.body.error?.code === "guest_forbidden",
      "guild: a guest cannot join (403 guest_forbidden)",
    );
    const guestCreate = await api<{ error?: { code: string } }>(ctx.url, "/api/guilds", {
      token: guest.token,
      body: { name: `Guest ${suffix}`, tag: "GG", open: true },
    });
    check(
      guestCreate.status === 403 && guestCreate.body.error?.code === "guest_forbidden",
      "guild: a guest cannot create (403 guest_forbidden)",
    );

    // Leadership moves when the leader leaves; the last member disbands the guild.
    const aLeaves = await api<{ guild: GuildInfo | null }>(ctx.url, "/api/guilds/leave", {
      token: a.token,
      method: "POST",
    });
    check(aLeaves.status === 200, "guild: A leaves");
    const afterA = await api<{ guild: GuildInfo }>(ctx.url, `/api/guilds/${id}`);
    check(
      afterA.body.guild?.members.length === 1 &&
        afterA.body.guild.members[0]?.accountId === b.accountId &&
        afterA.body.guild.members[0]?.role === "leader",
      "guild: B is the leader after A leaves",
    );

    const bLeaves = await api<{ guild: GuildInfo | null }>(ctx.url, "/api/guilds/leave", {
      token: b.token,
      method: "POST",
    });
    check(
      bLeaves.status === 200 && bLeaves.body.guild === null,
      "guild: B leaves and the guild disbands",
    );
    const gone = await api<{ error?: { code: string } }>(ctx.url, `/api/guilds/${id}`);
    check(gone.status === 404, "guild: GET of a disbanded guild is 404");

    const tombstone = await poll(async () => {
      const rows = await ctx.db.query<{ _deleted: number }>(
        "SELECT _deleted FROM guild_index WHERE guild_id = ?",
        [id],
      );
      return rows[0]?._deleted === 1 ? rows[0] : null;
    });
    check(tombstone !== null, "guild: D1 row is a tombstone (_deleted = 1) after disband");
  },
};

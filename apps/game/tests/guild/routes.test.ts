/**
 * /api/guilds routes over in-memory stand-ins (support.ts), authenticated by
 * the real auth/session.ts: registered tokens are checked against the fake
 * AccountDO's checkSession, a token without `kind` is a guest.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { call, makeWorld, tokenFor, type World } from "./support.ts";

let world: World;
let alice: string;
let bob: string;
let carol: string;
let guest: string;

beforeEach(async () => {
  world = makeWorld();
  alice = await tokenFor("acc-alice", "Alice", "registered");
  bob = await tokenFor("acc-bob", "Bob", "registered");
  carol = await tokenFor("acc-carol", "Carol", "registered");
  guest = await tokenFor("acc-guest", "Guest-0001");
});

const create = (token: string, body: unknown = { name: "Ash Wardens", tag: "ASH", open: true }) =>
  call(world, "POST", "/api/guilds", { token, body });

describe("create", () => {
  it("needs a signed-in account", async () => {
    expect((await call(world, "POST", "/api/guilds", { body: {} })).status).toBe(401);
    const res = await call(world, "POST", "/api/guilds", { token: "bogus", body: {} });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("refuses a registered token whose session was revoked", async () => {
    world.account("acc-alice").revoked = true;
    const res = await create(alice);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("refuses guests with guest_forbidden", async () => {
    const res = await create(guest);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("guest_forbidden");
  });

  it("validates name, tag and open before touching any object", async () => {
    expect((await create(alice, { name: "ab", tag: "ASH" })).body.error.code).toBe("bad_name");
    expect((await create(alice, { name: "Ash Wardens", tag: "ash" })).body.error.code).toBe(
      "bad_tag",
    );
    expect(
      (await create(alice, { name: "Ash Wardens", tag: "ASH", open: "yes" })).body.error.code,
    ).toBe("bad_request");
    expect((await call(world, "POST", "/api/guilds", { token: alice, body: [1] })).status).toBe(
      400,
    );
  });

  it("founds the guild, answers 201 and records the leader on the account", async () => {
    const res = await create(alice);
    expect(res.status).toBe(201);
    expect(res.body.guild).toMatchObject({
      id: "ash-wardens",
      name: "Ash Wardens",
      tag: "ASH",
      open: true,
      members: [{ accountId: "acc-alice", displayName: "Alice", role: "leader" }],
    });
    expect(world.account("acc-alice").social.guild()).toEqual({
      guildId: "ash-wardens",
      tag: "ASH",
      role: "leader",
    });
    const mine = await call(world, "GET", "/api/guilds/mine", { token: alice });
    expect(mine.body.guild.id).toBe("ash-wardens");
  });

  it("answers name_taken and releases the reservation, so the founder can still join elsewhere", async () => {
    await create(alice);
    const res = await create(bob);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("name_taken");
    expect(world.account("acc-bob").social.guild()).toBeNull();
    expect(world.account("acc-bob").social.reserveGuild("probe", "other")).toEqual({
      ok: true,
      current: null,
    });
  });

  it("refuses a second guild while in one", async () => {
    await create(alice);
    const res = await create(alice, { name: "Iron Fist", tag: "IRN", open: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_in_guild");
  });
});

describe("join", () => {
  it("refuses guests and unknown guilds", async () => {
    await create(alice);
    const g = await call(world, "POST", "/api/guilds/ash-wardens/join", { token: guest });
    expect(g.status).toBe(403);
    expect(g.body.error.code).toBe("guest_forbidden");
    const missing = await call(world, "POST", "/api/guilds/no-such-guild/join", { token: bob });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
    expect(world.account("acc-bob").social.guild()).toBeNull();
  });

  it("joins an open guild, shows two members, and treats a repeat as success", async () => {
    await create(alice);
    const res = await call(world, "POST", "/api/guilds/ash-wardens/join", { token: bob });
    expect(res.status).toBe(200);
    expect(res.body.guild.members.map((m: { role: string }) => m.role)).toEqual([
      "leader",
      "member",
    ]);
    expect(world.account("acc-bob").social.guild()).toEqual({
      guildId: "ash-wardens",
      tag: "ASH",
      role: "member",
    });
    const again = await call(world, "POST", "/api/guilds/ash-wardens/join", { token: bob });
    expect(again.status).toBe(200);
    expect(again.body.guild.members).toHaveLength(2);
  });

  it("refuses closed guilds with 403 closed and leaves the slot free", async () => {
    await call(world, "POST", "/api/guilds", {
      token: alice,
      body: { name: "Quiet Hall", tag: "QH", open: false },
    });
    const res = await call(world, "POST", "/api/guilds/quiet-hall/join", { token: bob });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("closed");
    expect(world.account("acc-bob").social.guild()).toBeNull();
  });

  it("refuses a second guild while in one", async () => {
    await create(alice);
    await call(world, "POST", "/api/guilds", {
      token: bob,
      body: { name: "Iron Fist", tag: "IRN", open: true },
    });
    const res = await call(world, "POST", "/api/guilds/ash-wardens/join", { token: bob });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_in_guild");
  });

  it("a crash between GuildDO and confirmGuild heals on retry (same guild, new op)", async () => {
    await create(alice);
    // Simulate the saga dying after GuildDO.join: the account has no membership yet.
    const guildStub = world.guild("ash-wardens");
    guildStub.roster.join({
      opId: "crashed-op",
      member: { accountId: "acc-bob", displayName: "Bob" },
    });
    expect(world.account("acc-bob").social.guild()).toBeNull();
    const retry = await call(world, "POST", "/api/guilds/ash-wardens/join", { token: bob });
    expect(retry.status).toBe(200);
    expect(world.account("acc-bob").social.guild()).toMatchObject({ guildId: "ash-wardens" });
  });
});

describe("leave and kick", () => {
  beforeEach(async () => {
    await create(alice);
    await call(world, "POST", "/api/guilds/ash-wardens/join", { token: bob });
    await call(world, "POST", "/api/guilds/ash-wardens/join", { token: carol });
  });

  it("answers not_in_guild when there is nothing to leave", async () => {
    const res = await call(world, "POST", "/api/guilds/leave", { token: guest });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_in_guild");
  });

  it("leader leaves: the longest-standing member becomes leader and the leaver is free", async () => {
    const res = await call(world, "POST", "/api/guilds/leave", { token: alice });
    expect(res.status).toBe(200);
    expect(res.body.guild.members[0]).toMatchObject({ accountId: "acc-bob", role: "leader" });
    expect(world.account("acc-alice").social.guild()).toBeNull();
    const mine = await call(world, "GET", "/api/guilds/mine", { token: alice });
    expect(mine.body).toEqual({ guild: null });
  });

  it("the last member out disbands the guild and its D1 row is a tombstone", async () => {
    await world.syncD1();
    expect(world.db.prepare("SELECT member_count FROM guild_index").get()).toMatchObject({
      member_count: 3,
    });
    await call(world, "POST", "/api/guilds/leave", { token: alice });
    await call(world, "POST", "/api/guilds/leave", { token: bob });
    await call(world, "POST", "/api/guilds/leave", { token: carol });
    expect((await call(world, "GET", "/api/guilds/ash-wardens", {})).status).toBe(404);
    await world.syncD1();
    expect(world.db.prepare("SELECT _deleted FROM guild_index").get()).toMatchObject({
      _deleted: 1,
    });
  });

  it("members may not kick, the leader may", async () => {
    const denied = await call(world, "POST", "/api/guilds/kick", {
      token: bob,
      body: { accountId: "acc-carol" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("forbidden");
    const kicked = await call(world, "POST", "/api/guilds/kick", {
      token: alice,
      body: { accountId: "acc-carol" },
    });
    expect(kicked.status).toBe(200);
    expect(kicked.body.guild.members.map((m: { accountId: string }) => m.accountId)).toEqual([
      "acc-alice",
      "acc-bob",
    ]);
    expect(world.account("acc-carol").social.guild()).toBeNull();
  });

  it("kick needs a target id and an own guild, and never kicks the leader", async () => {
    expect(
      (await call(world, "POST", "/api/guilds/kick", { token: alice, body: {} })).body.error.code,
    ).toBe("bad_request");
    expect(
      (await call(world, "POST", "/api/guilds/kick", { token: guest, body: { accountId: "x" } }))
        .status,
    ).toBe(403);
    const leaderKick = await call(world, "POST", "/api/guilds/kick", {
      token: bob,
      body: { accountId: "acc-alice" },
    });
    expect(leaderKick.status).toBe(403);
    expect(world.account("acc-alice").social.guild()).toMatchObject({ role: "leader" });
  });
});

describe("browse", () => {
  it("answers an empty list when the read model is not migrated yet", async () => {
    const bare = makeWorld({ readModel: false });
    const res = await call(bare, "GET", "/api/guilds", {});
    expect(res).toEqual({ status: 200, body: { guilds: [] } });
  });

  it("searches by name over the D1 read model, most members first, wildcards escaped", async () => {
    await create(alice);
    await call(world, "POST", "/api/guilds", {
      token: bob,
      body: { name: "Ashen Dawn", tag: "AD", open: false },
    });
    await call(world, "POST", "/api/guilds/ash-wardens/join", { token: carol });
    await world.syncD1();

    const all = await call(world, "GET", "/api/guilds", {});
    expect(all.body.guilds.map((g: { id: string }) => g.id)).toEqual(["ash-wardens", "ashen-dawn"]);
    expect(all.body.guilds[0]).toEqual({
      id: "ash-wardens",
      name: "Ash Wardens",
      tag: "ASH",
      open: true,
      memberCount: 2,
    });
    expect(all.body.guilds[1]).toMatchObject({ open: false, memberCount: 1 });

    const ash = await call(world, "GET", "/api/guilds?q=ASH", {});
    expect(ash.body.guilds).toHaveLength(2);
    const wildcard = await call(world, "GET", "/api/guilds?q=%25", {});
    expect(wildcard.body.guilds).toEqual([]);
    const underscore = await call(world, "GET", "/api/guilds?q=_", {});
    expect(underscore.body.guilds).toEqual([]);
  });

  it("returns guild info by id and 404 for an invalid or unknown id", async () => {
    await create(alice);
    const ok = await call(world, "GET", "/api/guilds/ash-wardens", {});
    expect(ok.status).toBe(200);
    expect(ok.body.guild.name).toBe("Ash Wardens");
    expect((await call(world, "GET", "/api/guilds/Ash!", {})).status).toBe(404);
    expect((await call(world, "GET", "/api/guilds/nothing-here", {})).status).toBe(404);
  });

  it("mine is null for an account without a guild", async () => {
    const res = await call(world, "GET", "/api/guilds/mine", { token: bob });
    expect(res).toEqual({ status: 200, body: { guild: null } });
  });
});

describe("chat revoke on kick and leave (R10)", () => {
  async function ashWardens() {
    await create(alice);
    const joined = await call(world, "POST", "/api/guilds/ash-wardens/join", { token: bob });
    expect(joined.status).toBe(200);
  }

  it("kick revokes the kicked account's guild channel with reason kicked", async () => {
    await ashWardens();
    const res = await call(world, "POST", "/api/guilds/kick", {
      token: alice,
      body: { accountId: "acc-bob" },
    });
    expect(res.status).toBe(200);
    expect(world.chat.revokes).toEqual([
      { channel: "guild:ash-wardens", accountId: "acc-bob", reason: "kicked" },
    ]);
  });

  it("leave revokes the leaver's guild channel with reason left", async () => {
    await ashWardens();
    const res = await call(world, "POST", "/api/guilds/leave", { token: bob });
    expect(res.status).toBe(200);
    expect(world.chat.revokes).toEqual([
      { channel: "guild:ash-wardens", accountId: "acc-bob", reason: "left" },
    ]);
  });

  it("a failed revoke does not fail the kick", async () => {
    await ashWardens();
    world.chat.failRevoke = true;
    const res = await call(world, "POST", "/api/guilds/kick", {
      token: alice,
      body: { accountId: "acc-bob" },
    });
    expect(res.status).toBe(200);
    expect(res.body.guild.members.map((m: { accountId: string }) => m.accountId)).toEqual([
      "acc-alice",
    ]);
  });

  it("a kick retried after a failed release still revokes (R10 variant 3)", async () => {
    await ashWardens();
    world.account("acc-bob").failReleaseOnce = true;
    // GuildDO.kick succeeds, then the release throws: the route fails before revoking.
    const first = await call(world, "POST", "/api/guilds/kick", {
      token: alice,
      body: { accountId: "acc-bob" },
    }).catch(() => null);
    expect(first?.status ?? 500).toBeGreaterThanOrEqual(500);
    expect(world.chat.revokes).toEqual([]);
    // The officer retries: GuildDO answers not_found, the release heals the slot,
    // and the target's guild chat is revoked too.
    const retry = await call(world, "POST", "/api/guilds/kick", {
      token: alice,
      body: { accountId: "acc-bob" },
    });
    expect(retry.status).toBe(404);
    expect(world.chat.revokes).toEqual([
      { channel: "guild:ash-wardens", accountId: "acc-bob", reason: "kicked" },
    ]);
  });

  it("a refused kick revokes nothing", async () => {
    await ashWardens();
    const res = await call(world, "POST", "/api/guilds/kick", {
      token: bob,
      body: { accountId: "acc-alice" },
    });
    expect(res.status).toBe(403);
    expect(world.chat.revokes).toEqual([]);
  });
});

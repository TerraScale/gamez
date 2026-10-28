import { describe, expect, it } from "vite-plus/test";
import { GUILD_MAX_MEMBERS } from "@gamez/protocol";
import { FakeGuild, makeClock } from "./support.ts";

const founder = { accountId: "acc-lead", displayName: "Lead" };
const create = (g: FakeGuild, name = "Ash Wardens", open = true) =>
  g.roster.create({
    opId: "op-create",
    name,
    tag: "ASH",
    open,
    founder,
  });
const join = (g: FakeGuild, accountId: string, opId = `op-${accountId}`) =>
  g.roster.join({ opId, member: { accountId, displayName: accountId.toUpperCase() } });

/** Records of the outbox, oldest first. */
const records = (g: FakeGuild) => g.outbox.pending(500);

describe("create", () => {
  it("founds the guild with the founder as leader and writes a guild_index upsert", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    const res = create(g);
    expect(res).toMatchObject({
      ok: true,
      guild: {
        id: "ash-wardens",
        name: "Ash Wardens",
        tag: "ASH",
        open: true,
        members: [{ accountId: "acc-lead", displayName: "Lead", role: "leader" }],
      },
    });
    const last = records(g).at(-1)!;
    expect(last).toMatchObject({
      table: "guild_index",
      pk: "ash-wardens",
      op: "upsert",
      payload: {
        guildId: "ash-wardens",
        name: "Ash Wardens",
        tag: "ASH",
        open: true,
        memberCount: 1,
        leaderId: "acc-lead",
      },
    });
  });

  it("rejects a name whose slug is not the guild id, and bad tags", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    expect(create(g, "Iron Fist")).toEqual({ ok: false, code: "bad_request" });
    expect(
      g.roster.create({ opId: "x", name: "Ash Wardens", tag: "ash", open: true, founder }),
    ).toEqual({
      ok: false,
      code: "bad_request",
    });
    expect(records(g)).toHaveLength(0);
  });

  it("answers name_taken for a second founder, and is idempotent for the leader", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    create(g);
    const again = create(g);
    expect(again).toMatchObject({ ok: true, guild: { id: "ash-wardens" } });
    expect(records(g)).toHaveLength(1); // the retry wrote nothing new
    expect(
      g.roster.create({
        opId: "op-other",
        name: "Ash Wardens",
        tag: "ASH",
        open: true,
        founder: { accountId: "acc-other", displayName: "Other" },
      }),
    ).toEqual({ ok: false, code: "name_taken" });
  });
});

describe("join", () => {
  it("is not_found without a guild", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    expect(join(g, "acc-a")).toEqual({ ok: false, code: "not_found" });
  });

  it("adds an open-guild member and is idempotent for an existing member", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    create(g);
    const res = join(g, "acc-a");
    expect(res).toMatchObject({
      ok: true,
      guild: { members: [{ role: "leader" }, { accountId: "acc-a", role: "member" }] },
    });
    const before = records(g).length;
    expect(join(g, "acc-a", "op-retry")).toMatchObject({ ok: true });
    expect(records(g)).toHaveLength(before);
  });

  it("refuses closed guilds and full guilds", () => {
    const closed = new FakeGuild("quiet-hall", makeClock());
    create(closed, "Quiet Hall", false);
    expect(join(closed, "acc-a")).toEqual({ ok: false, code: "closed" });

    const full = new FakeGuild("ash-wardens", makeClock());
    create(full);
    for (let i = 1; i < GUILD_MAX_MEMBERS; i++) join(full, `acc-${i}`);
    expect(full.roster.info()!.members).toHaveLength(GUILD_MAX_MEMBERS);
    expect(join(full, "acc-extra")).toEqual({ ok: false, code: "full" });
  });
});

describe("leave", () => {
  it("removes a member and keeps the guild", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    create(g);
    join(g, "acc-a");
    const res = g.roster.leave({ opId: "op-leave", accountId: "acc-a" });
    expect(res.guild?.members.map((m) => m.accountId)).toEqual(["acc-lead"]);
    expect(records(g).at(-1)!.payload).toMatchObject({ memberCount: 1 });
  });

  it("is a no-op for a non-member", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    create(g);
    const before = records(g).length;
    expect(g.roster.leave({ opId: "op", accountId: "stranger" }).guild?.id).toBe("ash-wardens");
    expect(records(g)).toHaveLength(before);
  });

  it("promotes the longest-standing officer when the leader leaves", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    create(g);
    join(g, "acc-m1");
    join(g, "acc-o1");
    join(g, "acc-m2");
    // Officers come from outside this wave's API; set one directly.
    g.store.sql.exec("UPDATE guild_member SET role = 'officer' WHERE account_id = 'acc-o1'");
    const res = g.roster.leave({ opId: "op", accountId: "acc-lead" });
    const leader = res.guild!.members.find((m) => m.role === "leader");
    expect(leader?.accountId).toBe("acc-o1");
    expect(res.guild!.members.map((m) => m.accountId)).not.toContain("acc-lead");
  });

  it("promotes the longest-standing member when there is no officer", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    create(g);
    join(g, "acc-m1");
    join(g, "acc-m2");
    const res = g.roster.leave({ opId: "op", accountId: "acc-lead" });
    expect(res.guild!.members[0]).toMatchObject({ accountId: "acc-m1", role: "leader" });
    expect(records(g).at(-1)!.payload).toMatchObject({ leaderId: "acc-m1", memberCount: 2 });
  });

  it("disbands when the last member leaves: info is null and the outbox holds a delete", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    create(g);
    const res = g.roster.leave({ opId: "op", accountId: "acc-lead" });
    expect(res).toEqual({ guild: null });
    expect(g.roster.info()).toBeNull();
    const last = records(g).at(-1)!;
    expect(last).toMatchObject({
      table: "guild_index",
      pk: "ash-wardens",
      op: "delete",
      payload: null,
    });
    expect(last.version).toBeGreaterThan(records(g)[0]!.version);
  });

  it("a re-created guild after disband bumps the version past the tombstone", () => {
    const g = new FakeGuild("ash-wardens", makeClock());
    create(g);
    g.roster.leave({ opId: "op", accountId: "acc-lead" });
    const tombstone = records(g).at(-1)!;
    expect(create(g)).toMatchObject({ ok: true });
    const revived = records(g).at(-1)!;
    expect(revived.op).toBe("upsert");
    expect(revived.version).toBeGreaterThan(tombstone.version);
  });
});

describe("kick", () => {
  function rostered(): FakeGuild {
    const g = new FakeGuild("ash-wardens", makeClock());
    create(g);
    join(g, "acc-m1");
    join(g, "acc-m2");
    join(g, "acc-o1");
    g.store.sql.exec("UPDATE guild_member SET role = 'officer' WHERE account_id = 'acc-o1'");
    return g;
  }

  it("lets the leader remove officers and members", () => {
    const g = rostered();
    expect(g.roster.kick({ by: "acc-lead", target: "acc-o1" })).toMatchObject({ ok: true });
    expect(g.roster.kick({ by: "acc-lead", target: "acc-m1" })).toMatchObject({ ok: true });
    expect(g.roster.info()!.members.map((m) => m.accountId)).toEqual(["acc-lead", "acc-m2"]);
  });

  it("lets an officer remove members but not the leader or other officers", () => {
    const g = rostered();
    g.store.sql.exec("UPDATE guild_member SET role = 'officer' WHERE account_id = 'acc-m2'");
    expect(g.roster.kick({ by: "acc-m2", target: "acc-lead" })).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(g.roster.kick({ by: "acc-m2", target: "acc-o1" })).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(g.roster.kick({ by: "acc-m2", target: "acc-m1" })).toMatchObject({ ok: true });
  });

  it("forbids members, outsiders and kicking the leader", () => {
    const g = rostered();
    expect(g.roster.kick({ by: "acc-m1", target: "acc-m2" })).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(g.roster.kick({ by: "stranger", target: "acc-m2" })).toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(g.roster.kick({ by: "acc-o1", target: "acc-lead" })).toEqual({
      ok: false,
      code: "forbidden",
    });
  });

  it("answers not_found for a target outside the roster or a missing guild", () => {
    const g = rostered();
    expect(g.roster.kick({ by: "acc-lead", target: "nobody" })).toEqual({
      ok: false,
      code: "not_found",
    });
    const empty = new FakeGuild("iron-fist", makeClock());
    expect(empty.roster.kick({ by: "x", target: "y" })).toEqual({ ok: false, code: "not_found" });
  });
});

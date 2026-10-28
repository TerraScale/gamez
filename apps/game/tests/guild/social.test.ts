import { describe, expect, it } from "vite-plus/test";
import {
  AccountSocial,
  BLOCK_LIMIT,
  GUILD_RESERVATION_MS,
  SocialError,
} from "../../src/server/account/social.ts";
import { fakeSqlStore } from "../support/fake-sql.ts";
import { makeClock } from "./support.ts";

function social(owner: string | null = null) {
  const clock = makeClock();
  const store = fakeSqlStore();
  const s = new AccountSocial(store, clock, owner);
  s.init();
  return { s, clock, store };
}

const membership = (guildId: string, role: "leader" | "officer" | "member" = "member") => ({
  guildId,
  tag: "ASH",
  role,
});

describe("block list", () => {
  it("keeps ids sorted, ignores duplicates and removes on unblock", () => {
    const { s } = social();
    s.setBlocked("zed", true);
    s.setBlocked("amy", true);
    expect(s.setBlocked("amy", true)).toEqual(["amy", "zed"]);
    expect(s.setBlocked("zed", false)).toEqual(["amy"]);
    expect(s.blocks()).toEqual(["amy"]);
  });

  it("refuses to block yourself when the owner is known", () => {
    const { s } = social("me");
    expect(() => s.setBlocked("me", true)).toThrow(SocialError);
    expect(() => s.setBlocked("me", true)).toThrow(/yourself/);
  });

  it("rejects empty and oversized targets", () => {
    const { s } = social();
    expect(() => s.setBlocked("", true)).toThrow(/block target/);
    expect(() => s.setBlocked("x".repeat(65), true)).toThrow(/block target/);
  });

  it("caps the list at 200 and still allows re-blocking an existing id at the cap", () => {
    const { s } = social();
    for (let i = 0; i < BLOCK_LIMIT; i++) s.setBlocked(`acc-${String(i).padStart(3, "0")}`, true);
    expect(s.blocks()).toHaveLength(BLOCK_LIMIT);
    expect(() => s.setBlocked("one-more", true)).toThrow(/at most 200/);
    expect(s.setBlocked("acc-000", true)).toHaveLength(BLOCK_LIMIT);
    expect(s.setBlocked("acc-000", false)).toHaveLength(BLOCK_LIMIT - 1);
    expect(s.setBlocked("one-more", true)).toHaveLength(BLOCK_LIMIT);
  });
});

describe("guild slot saga", () => {
  it("reserves a free slot, then confirms it as membership", () => {
    const { s } = social();
    expect(s.guild()).toBeNull();
    expect(s.reserveGuild("op-1", "ash")).toEqual({ ok: true, current: null });
    expect(s.guild()).toBeNull(); // a reservation is not membership
    s.confirmGuild("op-1", membership("ash"));
    expect(s.guild()).toEqual(membership("ash"));
  });

  it("treats a retry of the same operation as success", () => {
    const { s } = social();
    s.reserveGuild("op-1", "ash");
    expect(s.reserveGuild("op-1", "ash")).toEqual({ ok: true, current: null });
    s.confirmGuild("op-1", membership("ash"));
    expect(s.reserveGuild("op-1", "ash")).toEqual({ ok: true, current: null });
  });

  it("fails with the current membership when the account is in another guild", () => {
    const { s } = social();
    s.reserveGuild("op-1", "ash");
    s.confirmGuild("op-1", membership("ash"));
    expect(s.reserveGuild("op-2", "iron")).toEqual({ ok: false, current: membership("ash") });
  });

  it("fails without membership while another operation's reservation is live", () => {
    const { s, clock } = social();
    s.reserveGuild("op-1", "ash");
    clock.advance(GUILD_RESERVATION_MS - 1);
    expect(s.reserveGuild("op-2", "iron")).toEqual({ ok: false, current: null });
  });

  it("treats a stale reservation (crashed saga) as free", () => {
    const { s, clock } = social();
    s.reserveGuild("op-1", "ash");
    clock.advance(GUILD_RESERVATION_MS + 1);
    expect(s.reserveGuild("op-2", "iron")).toEqual({ ok: true, current: null });
    expect(() => s.confirmGuild("op-1", membership("ash"))).toThrow(/in progress|another guild/);
    s.confirmGuild("op-2", membership("iron"));
    expect(s.guild()).toEqual(membership("iron"));
  });

  it("refuses to confirm a reservation that another live operation holds", () => {
    const { s } = social();
    s.reserveGuild("op-1", "ash");
    expect(() => s.confirmGuild("op-2", membership("ash"))).toThrow(SocialError);
  });

  it("confirm is idempotent for the same guild and refuses a different one", () => {
    const { s } = social();
    s.reserveGuild("op-1", "ash");
    s.confirmGuild("op-1", membership("ash"));
    s.confirmGuild("op-1", membership("ash"));
    expect(s.guild()).toEqual(membership("ash"));
    expect(() => s.confirmGuild("op-9", membership("iron"))).toThrow(/another guild/);
  });

  it("release clears only the slot held for that guild", () => {
    const { s } = social();
    s.reserveGuild("op-1", "ash");
    s.releaseGuild("op-other", "iron"); // wrong guild: no effect
    expect(s.reserveGuild("op-2", "iron")).toEqual({ ok: false, current: null });
    s.releaseGuild("op-1", "ash"); // undo of the reservation
    expect(s.reserveGuild("op-2", "iron")).toEqual({ ok: true, current: null });
  });

  it("a reservation release needs its own operation id, a membership release does not", () => {
    const { s } = social();
    s.reserveGuild("op-1", "ash");
    s.releaseGuild("op-2", "ash"); // different op, reservation: kept
    expect(s.reserveGuild("op-3", "iron")).toEqual({ ok: false, current: null });
    s.confirmGuild("op-1", membership("ash"));
    s.releaseGuild("op-4", "ash"); // leave: any op clears a confirmed membership
    expect(s.guild()).toBeNull();
  });

  it("release is idempotent", () => {
    const { s } = social();
    s.releaseGuild("op-1", "ash");
    s.releaseGuild("op-1", "ash");
    expect(s.guild()).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  MAX_SESSIONS,
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_MS,
} from "../../src/server/account/profile.ts";
import {
  normaliseEmail,
  suggestDisplayName,
  validDisplayName,
} from "../../src/server/auth/names.ts";
import { identityKey } from "../../src/server/contracts.ts";
import { Clock, FakeAccount } from "./fakes.ts";

function account(clock = new Clock()) {
  return { acc: new FakeAccount("acc-1", clock.now), clock };
}

describe("display names and emails", () => {
  it("applies the 3-20 [A-Za-z0-9 _-] rule, trimmed", () => {
    expect(validDisplayName("  Ember  Knight ", "registered")).toBe("Ember Knight");
    expect(validDisplayName("ab", "registered")).toBeNull();
    expect(validDisplayName("x".repeat(21), "registered")).toBeNull();
    expect(validDisplayName("x".repeat(20), "registered")).toBe("x".repeat(20));
    expect(validDisplayName("bad<name>", "registered")).toBeNull();
    expect(validDisplayName("Émile", "registered")).toBeNull();
    expect(validDisplayName(42, "registered")).toBeNull();
  });

  it("keeps Guest- names for guests only", () => {
    expect(validDisplayName("Guest-00AB", "guest")).toBe("Guest-00AB");
    expect(validDisplayName("Guest-00AB", "registered")).toBeNull();
    expect(validDisplayName("guest-x1", "registered")).toBeNull();
  });

  it("suggests valid names from free text", () => {
    expect(suggestDisplayName("Ana Lúcia ✨")).toBe("Ana L cia");
    expect(suggestDisplayName("john.doe")).toBe("john doe");
    expect(suggestDisplayName("Guest-1234")).toMatch(/^Player-[0-9A-F]{4}$/);
    expect(suggestDisplayName("")).toMatch(/^Player-[0-9A-F]{4}$/);
    expect(validDisplayName(suggestDisplayName("a".repeat(80)), "registered")).not.toBeNull();
  });

  it("normalises emails and identity keys", () => {
    expect(normaliseEmail("  Ana@Example.TEST ")).toBe("ana@example.test");
    expect(normaliseEmail("nope")).toBeNull();
    expect(normaliseEmail("a@b")).toBeNull();
    expect(normaliseEmail(`${"a".repeat(250)}@b.cd`)).toBeNull();
    expect(identityKey("email", " Ana@Example.TEST")).toBe("email:ana@example.test");
    expect(identityKey("google", "AbC")).toBe("google:AbC");
  });
});

describe("AccountProfileStore", () => {
  it("creates the profile lazily and once", () => {
    const { acc } = account();
    expect(acc.profileStore.profile()).toBeNull();
    const p = acc.profileStore.ensure({ kind: "guest", displayName: "Guest-00AB" });
    expect(p).toMatchObject({ accountId: "acc-1", kind: "guest", displayName: "Guest-00AB" });
    const again = acc.profileStore.ensure({ kind: "registered", displayName: "Other" });
    expect(again).toEqual(p);
    expect(acc.outbox.pending().map((r) => [r.table, r.pk])).toEqual([
      ["account_summary", "acc-1"],
    ]);
    expect(acc.outbox.pending()[0]!.payload).toEqual({
      accountId: "acc-1",
      displayName: "Guest-00AB",
      kind: "guest",
      createdAt: p.createdAt,
    });
  });

  it("init is idempotent", () => {
    const { acc } = account();
    acc.profileStore.init();
    acc.profileStore.init();
    expect(acc.profileStore.profile()).toBeNull();
  });

  it("upgrades a guest in place with addIdentity and replaces the guest name", () => {
    const { acc } = account();
    acc.profileStore.ensure({ kind: "guest", displayName: "Guest-00AB" });
    const p = acc.profileStore.addIdentity({
      provider: "email",
      subject: "ember@example.test",
      email: "ember@example.test",
    });
    expect(p.kind).toBe("registered");
    expect(p.accountId).toBe("acc-1");
    expect(p.displayName).toBe("ember");
    expect(p.identities).toEqual([
      { provider: "email", subject: "ember@example.test", email: "ember@example.test" },
    ]);
    // idempotent
    acc.profileStore.addIdentity({
      provider: "email",
      subject: "ember@example.test",
      email: "ember@example.test",
    });
    expect(acc.profileStore.profile()!.identities).toHaveLength(1);
    const kinds = acc.outbox.pending().map((r) => (r.payload as { kind: string }).kind);
    expect(kinds).toEqual(["guest", "registered"]);
  });

  it("validates display names by kind and records each change", () => {
    const { acc } = account();
    acc.profileStore.ensure({ kind: "guest", displayName: "Guest-00AB" });
    expect(acc.profileStore.setDisplayName("  Ash  ").displayName).toBe("Ash");
    expect(acc.profileStore.setDisplayName("Guest-ABCD").displayName).toBe("Guest-ABCD");
    acc.profileStore.addIdentity({ provider: "discord", subject: "d1", email: null });
    expect(() => acc.profileStore.setDisplayName("Guest-ABCD")).toThrow(/bad_name/);
    expect(() => acc.profileStore.setDisplayName("x")).toThrow(/bad_name/);
    const before = acc.outbox.size();
    acc.profileStore.setDisplayName(acc.profileStore.profile()!.displayName);
    expect(acc.outbox.size()).toBe(before);
  });

  it("requires a profile before changes", () => {
    const { acc } = account();
    expect(() => acc.profileStore.setDisplayName("Valid")).toThrow(/no_profile/);
    expect(() =>
      acc.profileStore.addIdentity({ provider: "google", subject: "g", email: null }),
    ).toThrow(/no_profile/);
  });

  it("opens, checks and closes sessions with 128-bit ids", () => {
    const { acc, clock } = account();
    const s = acc.profileStore.openSession("Mozilla/5.0 ".repeat(40));
    expect(s.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(s.userAgent.length).toBe(200);
    expect(acc.profileStore.checkSession(s.sid)).toBe(true);
    expect(acc.profileStore.checkSession("other")).toBe(false);
    expect(acc.profileStore.checkSession("")).toBe(false);
    acc.profileStore.closeSession(s.sid);
    expect(acc.profileStore.checkSession(s.sid)).toBe(false);
    void clock;
  });

  it("touches lastSeenAt at most once a minute", () => {
    const { acc, clock } = account();
    const s = acc.profileStore.openSession("ua");
    clock.advance(SESSION_TOUCH_MS - 1);
    acc.profileStore.checkSession(s.sid);
    expect(acc.profileStore.sessions()[0]!.lastSeenAt).toBe(s.createdAt);
    clock.advance(1);
    acc.profileStore.checkSession(s.sid);
    expect(acc.profileStore.sessions()[0]!.lastSeenAt).toBe(s.createdAt + SESSION_TOUCH_MS);
  });

  it("expires old sessions and caps how many stay open", () => {
    const { acc, clock } = account();
    const old = acc.profileStore.openSession("old");
    clock.advance(SESSION_MAX_AGE_MS + 1);
    expect(acc.profileStore.checkSession(old.sid)).toBe(false);
    const sids: string[] = [];
    for (let i = 0; i < MAX_SESSIONS + 3; i++) {
      clock.advance(1000);
      sids.push(acc.profileStore.openSession(`ua${i}`).sid);
    }
    expect(acc.profileStore.sessions()).toHaveLength(MAX_SESSIONS);
    expect(acc.profileStore.checkSession(sids[0]!)).toBe(false);
    expect(acc.profileStore.checkSession(sids.at(-1)!)).toBe(true);
  });
});

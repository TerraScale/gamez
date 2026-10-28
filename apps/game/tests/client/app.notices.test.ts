/** App shell: OAuth return handling and plain-words error notices (wave-B.md §3, §8.2). */
import { describe, expect, it } from "vite-plus/test";
import { applyAuthFragment, applyOAuthLink, describeError } from "../../src/client/app/notices.ts";
import type { GuestSession } from "../../src/client/session.ts";

const SESSION: GuestSession = {
  token: "t.ok",
  accountId: "acc-1",
  name: "Mira",
  kind: "registered",
};

describe("applyAuthFragment", () => {
  it("does nothing when the page was not an OAuth return", () => {
    const set: GuestSession[] = [];
    expect(applyAuthFragment(null, (s) => set.push(s))).toBeNull();
    expect(set).toHaveLength(0);
  });

  it("stores the session and confirms the sign-in", () => {
    const set: GuestSession[] = [];
    const notice = applyAuthFragment({ session: SESSION }, (s) => set.push(s));
    expect(set).toEqual([SESSION]);
    expect(notice).toEqual({ tone: "ok", text: "Signed in as Mira." });
  });

  it("shows an error and keeps the stored session on failure", () => {
    const set: GuestSession[] = [];
    const notice = applyAuthFragment({ error: "identity_taken" }, (s) => set.push(s));
    expect(set).toHaveLength(0);
    expect(notice?.tone).toBe("error");
    expect(notice?.text).toBe(describeError("identity_taken"));
  });

  it("never echoes an unknown error code from the URL", () => {
    const notice = applyAuthFragment({ error: "<img src=x onerror=alert(1)>" }, () => {});
    expect(notice?.tone).toBe("error");
    expect(notice?.text).not.toContain("<img");
    expect(notice?.text.length).toBeGreaterThan(0);
  });
});

describe("applyOAuthLink (ADR 0007 R3)", () => {
  const GUEST: GuestSession = { token: "guest.tok", accountId: "g-1", name: "Guest-1" };

  it("a link fragment is not a session: applyAuthFragment leaves it to applyOAuthLink", () => {
    const set: GuestSession[] = [];
    expect(applyAuthFragment({ link: "abc.def" }, (s) => set.push(s))).toBeNull();
    expect(set).toHaveLength(0);
  });

  it("redeems the code with the current session's token and stores the answer", async () => {
    const set: GuestSession[] = [];
    const seen: string[][] = [];
    const upgraded: GuestSession = { ...GUEST, token: "reg.tok", kind: "registered" };
    const out = await applyOAuthLink(
      "abc.def",
      GUEST,
      async (code, token) => {
        seen.push([code, token]);
        return { ok: true, value: upgraded };
      },
      (s) => set.push(s),
    );
    expect(seen).toEqual([["abc.def", "guest.tok"]]);
    expect(set).toEqual([upgraded]);
    expect(out.session).toEqual(upgraded);
    expect(out.notice.tone).toBe("ok");
  });

  it("keeps the current session when the redeem fails or throws", async () => {
    const set: GuestSession[] = [];
    const taken = await applyOAuthLink(
      "abc.def",
      GUEST,
      async () => ({ ok: false, code: "identity_taken", message: "x" }),
      (s) => set.push(s),
    );
    expect(taken.session).toBe(GUEST);
    expect(taken.notice).toEqual({ tone: "error", text: describeError("identity_taken") });
    const offline = await applyOAuthLink(
      "abc.def",
      GUEST,
      () => Promise.reject(new Error("offline")),
      (s) => set.push(s),
    );
    expect(offline.session).toBe(GUEST);
    expect(set).toHaveLength(0);
  });

  it("says a dropped return (wrong or missing nonce) expired, in plain words", () => {
    expect(applyAuthFragment({ error: "oauth_expired" }, () => {})).toEqual({
      tone: "error",
      text: "Sign-in expired. Try again.",
    });
  });
});

describe("describeError", () => {
  it("uses plain words for the known codes", () => {
    expect(describeError("bad_credentials")).toBe("Wrong email or password.");
    expect(describeError("access_denied")).toBe("Sign-in was cancelled.");
    expect(describeError("email_taken")).toContain("already registered");
  });

  it("gives a generic line for anything else", () => {
    expect(describeError("nope")).toBe("Something went wrong. Try again.");
  });
});

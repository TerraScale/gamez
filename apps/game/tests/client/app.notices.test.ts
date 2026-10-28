/** App shell: OAuth return handling and plain-words error notices (wave-B.md §3, §8.2). */
import { describe, expect, it } from "vite-plus/test";
import { applyAuthFragment, describeError } from "../../src/client/app/notices.ts";
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

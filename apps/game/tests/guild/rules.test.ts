import { describe, expect, it } from "vite-plus/test";
import { guildSlug } from "../../src/server/contracts.ts";
import { checkGuildName, checkGuildTag, isGuildId } from "../../src/server/guild/rules.ts";

describe("guildSlug", () => {
  it("lowercases, joins spaces with hyphens and strips the rest", () => {
    expect(guildSlug("  Ash  Wardens!  ")).toBe("ash-wardens");
    expect(guildSlug("A--B")).toBe("a-b");
    expect(guildSlug("ab")).toBeNull();
    expect(guildSlug("x".repeat(25))).toBeNull();
  });
});

describe("checkGuildName", () => {
  it("accepts names that produce a valid slug", () => {
    expect(checkGuildName("Ash Wardens")).toEqual({
      ok: true,
      name: "Ash Wardens",
      id: "ash-wardens",
    });
    expect(checkGuildName("  Iron-Fist 9 ")).toMatchObject({ ok: true, id: "iron-fist-9" });
  });

  it("rejects length, shape, reserved ids and non-text", () => {
    expect(checkGuildName("ab")).toMatchObject({ ok: false, code: "bad_name" });
    expect(checkGuildName("a".repeat(33))).toMatchObject({ ok: false, code: "bad_name" });
    expect(checkGuildName("-lead")).toMatchObject({ ok: false, code: "bad_name" });
    expect(checkGuildName("trail-")).toMatchObject({ ok: false, code: "bad_name" });
    expect(checkGuildName("no!bang")).toMatchObject({ ok: false, code: "bad_name" });
    expect(checkGuildName("Mine")).toMatchObject({ ok: false, code: "bad_name" });
    expect(checkGuildName("leave")).toMatchObject({ ok: false, code: "bad_name" });
    expect(checkGuildName(42)).toMatchObject({ ok: false, code: "bad_name" });
  });

  it("rejects names whose slug is too long even when the name fits 32 characters", () => {
    const name = "abcdefghijklmnopqrstuvwxyz";
    expect(name.length).toBeLessThanOrEqual(32);
    expect(checkGuildName(`${name} abcdefgh`)).toMatchObject({ ok: false, code: "bad_name" });
  });
});

describe("checkGuildTag", () => {
  it("accepts 2..5 uppercase letters or digits", () => {
    expect(checkGuildTag("AB")).toEqual({ ok: true, tag: "AB" });
    expect(checkGuildTag("Z9X8Y")).toEqual({ ok: true, tag: "Z9X8Y" });
  });

  it("rejects lowercase, symbols, bad lengths and non-text", () => {
    for (const bad of ["a", "ABCDEF", "ab", "A-B", "A B", "", 7]) {
      expect(checkGuildTag(bad)).toMatchObject({ ok: false, code: "bad_tag" });
    }
  });
});

describe("isGuildId", () => {
  it("accepts only canonical slugs of 3..24 characters", () => {
    expect(isGuildId("ash-wardens")).toBe(true);
    expect(isGuildId("Ash")).toBe(false);
    expect(isGuildId("a--b")).toBe(false);
    expect(isGuildId("ab")).toBe(false);
  });
});

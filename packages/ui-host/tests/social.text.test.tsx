import { describe, expect, it } from "vite-plus/test";
import { CHAT_MAX_LEN, DISPLAY_NAME_MAX, PASSWORD_MIN } from "@gamez/protocol";
import {
  authErrorText,
  canKick,
  chatErrorText,
  formatInt,
  guildErrorText,
  guildSlug,
  isMuted,
  isNearBottom,
  memberCountText,
  parseReportReason,
  providerButtonText,
  roleLabel,
  validateDisplayName,
  validateEmail,
  validateGuildName,
  validateGuildTag,
  validatePassword,
} from "../src/social/text.ts";

describe("error copy", () => {
  it("maps every auth code to plain words", () => {
    expect(authErrorText("email_taken")).toContain("already has an account");
    expect(authErrorText("bad_credentials")).toBe("Email or password is wrong.");
    expect(authErrorText("weak_password")).toContain(`${PASSWORD_MIN} characters`);
    expect(authErrorText("locked")).toContain("Too many attempts");
  });

  it("falls back to the server message, then to a generic line", () => {
    expect(authErrorText("who_knows", "Server says no")).toBe("Server says no");
    expect(authErrorText("who_knows")).toBe("Something went wrong. Try again.");
  });

  it("maps guild codes, including guest_forbidden", () => {
    expect(guildErrorText("guest_forbidden")).toBe("Create an account to join a guild.");
    expect(guildErrorText("name_taken")).toContain("already taken");
    expect(guildErrorText("unknown", "Nope")).toBe("Nope");
  });

  it("maps chat errors, with the mute end time when known", () => {
    const until = new Date(2026, 9, 28, 14, 5).getTime();
    expect(chatErrorText("muted", { mutedUntil: until })).toBe("You are muted until 14:05.");
    expect(chatErrorText("muted", { mutedUntil: null })).toBe("You are muted for a while.");
    expect(chatErrorText("rate_limited")).toContain("Slow down");
    expect(chatErrorText("too_long")).toContain(`${CHAT_MAX_LEN} characters`);
    expect(chatErrorText("filtered")).toContain("word filter");
    expect(chatErrorText("weird", { message: "Raw" })).toBe("Raw");
  });
});

describe("validation mirrors the server", () => {
  it("checks emails", () => {
    expect(validateEmail("  ")).toBe("Enter your email address.");
    expect(validateEmail("hero@example")).toBe("Enter a valid email address.");
    expect(validateEmail(" hero@example.com ")).toBeNull();
  });

  it("checks password length bounds", () => {
    expect(validatePassword("x".repeat(PASSWORD_MIN - 1))).toMatch(/at least/);
    expect(validatePassword("x".repeat(PASSWORD_MIN))).toBeNull();
    expect(validatePassword("x".repeat(129))).toMatch(/at most/);
  });

  it("allows an empty display name and checks the length otherwise", () => {
    expect(validateDisplayName("")).toBeNull();
    expect(validateDisplayName("ab")).not.toBeNull();
    expect(validateDisplayName("a".repeat(DISPLAY_NAME_MAX))).toBeNull();
    expect(validateDisplayName("a".repeat(DISPLAY_NAME_MAX + 1))).not.toBeNull();
  });

  it("slugs guild names exactly like guildSlug() on the server", () => {
    expect(guildSlug("  Iron Wolves!  ")).toBe("iron-wolves");
    expect(guildSlug("Ab")).toBeNull();
    expect(guildSlug("a".repeat(25))).toBeNull();
    expect(guildSlug("Café Ünïcode")).toBe("caf-ncode");
    expect(validateGuildName("Iron Wolves")).toBeNull();
    expect(validateGuildName("!!")).not.toBeNull();
  });

  it("checks guild tags: 2 to 5 letters or digits, case-insensitive", () => {
    expect(validateGuildTag("ab")).toBeNull();
    expect(validateGuildTag("ab1c2")).toBeNull();
    expect(validateGuildTag("a")).not.toBeNull();
    expect(validateGuildTag("abcdef")).not.toBeNull();
    expect(validateGuildTag("a-b")).not.toBeNull();
  });
});

describe("rules and formatters", () => {
  it("formats integers with separators, without locale", () => {
    expect(formatInt(0)).toBe("0");
    expect(formatInt(1234567)).toBe("1,234,567");
    expect(formatInt(-4200)).toBe("-4,200");
  });

  it("pluralises member counts", () => {
    expect(memberCountText(1)).toBe("1 member");
    expect(memberCountText(12)).toBe("12 members");
  });

  it("scrolls: follows the bottom within the threshold only", () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true);
    expect(isNearBottom(500, 100, 1000)).toBe(false);
    expect(isNearBottom(0, 0, 0)).toBe(true);
  });

  it("knows when a mute is still running", () => {
    expect(isMuted(null, 10)).toBe(false);
    expect(isMuted(20, 10)).toBe(true);
    expect(isMuted(10, 10)).toBe(false);
  });

  it("only lets leaders kick non-leaders and officers kick members", () => {
    expect(canKick("leader", "officer", false)).toBe(true);
    expect(canKick("leader", "member", false)).toBe(true);
    expect(canKick("leader", "leader", false)).toBe(false);
    expect(canKick("officer", "member", false)).toBe(true);
    expect(canKick("officer", "officer", false)).toBe(false);
    expect(canKick("member", "member", false)).toBe(false);
    expect(canKick("leader", "member", true)).toBe(false);
    expect(canKick(null, "member", false)).toBe(false);
  });

  it("labels providers, marking the dev stub and disabled ones", () => {
    expect(providerButtonText({ id: "google", enabled: true, stub: false })).toBe(
      "Continue with Google",
    );
    expect(providerButtonText({ id: "discord", enabled: true, stub: true })).toBe(
      "Continue with Discord (dev stub)",
    );
    expect(providerButtonText({ id: "apple", enabled: false, stub: false })).toBe(
      "Apple sign-in is not set up here",
    );
  });

  it("names roles and parses report reasons with a safe default", () => {
    expect(roleLabel("officer")).toBe("Officer");
    expect(parseReportReason("abuse")).toBe("abuse");
    expect(parseReportReason("nonsense")).toBe("other");
  });
});

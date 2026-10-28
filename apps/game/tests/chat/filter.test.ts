import { describe, expect, it } from "vite-plus/test";
import { filterChat, hasLink, skeleton } from "../../src/server/chat/filter.ts";

const registered = { allowLinks: true };
const guest = { allowLinks: false };

describe("filterChat", () => {
  it("passes ordinary text through unchanged", () => {
    expect(filterChat("hello there, friend!", registered)).toEqual({
      ok: true,
      text: "hello there, friend!",
      masked: false,
    });
  });

  it("masks listed words with stars and keeps the spaces", () => {
    expect(filterChat("damn it", registered)).toEqual({ ok: true, text: "**** it", masked: true });
  });

  it("sees through leetspeak, repeats and separators", () => {
    expect(filterChat("D4MN", registered)).toMatchObject({ ok: true, text: "****", masked: true });
    expect(filterChat("sh1t", registered)).toMatchObject({ ok: true, text: "****", masked: true });
    expect(filterChat("fuuuuck", registered)).toMatchObject({ text: "*******", masked: true });
    expect(filterChat("f.u.c.k off", registered)).toMatchObject({
      text: "******* off",
      masked: true,
    });
    expect(filterChat("f_u_c_k", registered)).toMatchObject({ masked: true });
  });

  it("matches whole words only", () => {
    expect(filterChat("scrap metal", registered)).toMatchObject({
      text: "scrap metal",
      masked: false,
    });
    expect(filterChat("classic", registered)).toMatchObject({ masked: false });
    expect(filterChat("crap!", registered)).toMatchObject({ text: "****!", masked: true });
  });

  it("blocks messages with a block word or phrase", () => {
    expect(filterChat("please kys", registered)).toEqual({ ok: false, reason: "blocked" });
    expect(filterChat("go kill yourself", registered)).toEqual({ ok: false, reason: "blocked" });
    expect(filterChat("KILL-YOURSELF", registered)).toEqual({ ok: false, reason: "blocked" });
  });

  it("does not block a word that merely contains a block word", () => {
    expect(filterChat("skysports today", registered)).toMatchObject({ ok: true, masked: false });
  });

  it("rejects links for guests but not for registered accounts", () => {
    expect(filterChat("see https://example.com/x", guest)).toEqual({ ok: false, reason: "link" });
    expect(filterChat("visit mysite.io now", guest)).toEqual({ ok: false, reason: "link" });
    expect(filterChat("see https://example.com/x", registered)).toMatchObject({ ok: true });
  });

  it("builds a skeleton with the original index of each letter", () => {
    // "." is a joiner (dropped); the trailing "!" is punctuation, not an i.
    const sk = skeleton("Ha.a!");
    expect(sk.letters.join("")).toBe("haa");
    expect(sk.from).toEqual([0, 1, 3]);
    expect(sk.to).toEqual([0, 1, 3]);
    expect(sk.gap).toEqual([false, false, false]);
    // A leetspeak symbol inside a word is a letter.
    expect(skeleton("$hit").letters.join("")).toBe("shit");
  });
});

describe("hasLink", () => {
  it("detects schemes, www and common domains", () => {
    expect(hasLink("https://a.b")).toBe(true);
    expect(hasLink("www.example.org")).toBe(true);
    expect(hasLink("game.gg")).toBe(true);
    expect(hasLink("no links here")).toBe(false);
  });
});

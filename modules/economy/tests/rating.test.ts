import { describe, expect, it } from "vite-plus/test";
import {
  RATING_FLOOR,
  START_RATING,
  arenaRewards,
  eloUpdate,
  expectedScore,
  kFactor,
  roundHalfAway,
} from "../src/index.ts";

describe("rating constants", () => {
  it("pins the ladder numbers", () => {
    expect(START_RATING).toBe(1000);
    expect(RATING_FLOOR).toBe(100);
  });
});

describe("roundHalfAway", () => {
  it("rounds halves away from zero", () => {
    expect(roundHalfAway(2.5)).toBe(3);
    expect(roundHalfAway(-2.5)).toBe(-3);
    expect(roundHalfAway(2.4999)).toBe(2);
    expect(roundHalfAway(-2.4999)).toBe(-2);
    expect(roundHalfAway(0)).toBe(0);
  });
});

describe("kFactor", () => {
  it("is 32 under 30 games and 24 from game 30 on", () => {
    expect(kFactor(0)).toBe(32);
    expect(kFactor(29)).toBe(32);
    expect(kFactor(30)).toBe(24);
    expect(kFactor(500)).toBe(24);
  });
});

describe("expectedScore", () => {
  it("is one half between equals and favours the higher rating", () => {
    expect(expectedScore(1000, 1000)).toBe(0.5);
    expect(expectedScore(1000, 1100)).toBeCloseTo(0.3599, 4);
    expect(expectedScore(1100, 1000)).toBeCloseTo(0.6401, 4);
  });
});

describe("eloUpdate (pinned numbers)", () => {
  it("equal new players: a win moves 16 points each way", () => {
    expect(eloUpdate({ rating: 1000, games: 0 }, { rating: 1000, games: 0 }, 1)).toEqual({
      a: 1016,
      b: 984,
    });
  });

  it("equal players: a loss mirrors the win", () => {
    expect(eloUpdate({ rating: 1000, games: 0 }, { rating: 1000, games: 0 }, 0)).toEqual({
      a: 984,
      b: 1016,
    });
  });

  it("equal players: a draw changes nothing", () => {
    expect(eloUpdate({ rating: 1000, games: 0 }, { rating: 1000, games: 0 }, 0.5)).toEqual({
      a: 1000,
      b: 1000,
    });
  });

  it("an underdog win gains more than 16 (rounded)", () => {
    // Expected 0.36 for the 1000 player: +32 * 0.64 = 20.48 -> 1020; the 1100 player loses 20.48 -> 1080.
    expect(eloUpdate({ rating: 1000, games: 0 }, { rating: 1100, games: 0 }, 1)).toEqual({
      a: 1020,
      b: 1080,
    });
  });

  it("a favourite loss takes the rounded delta", () => {
    // 1000 loses to 1100: -11.52 -> 988 ; 1100 gains 11.52 -> 1112.
    expect(eloUpdate({ rating: 1000, games: 0 }, { rating: 1100, games: 0 }, 0)).toEqual({
      a: 988,
      b: 1112,
    });
  });

  it("uses K 24 for players past 30 games", () => {
    expect(eloUpdate({ rating: 1000, games: 40 }, { rating: 1000, games: 40 }, 1)).toEqual({
      a: 1012,
      b: 988,
    });
  });

  it("each side uses its own K", () => {
    // a is new (K 32), b is veteran (K 24); both at 1000, a wins.
    expect(eloUpdate({ rating: 1000, games: 2 }, { rating: 1000, games: 99 }, 1)).toEqual({
      a: 1016,
      b: 988,
    });
  });

  it("never goes below RATING_FLOOR", () => {
    expect(eloUpdate({ rating: 100, games: 0 }, { rating: 900, games: 0 }, 0)).toEqual({
      a: 100,
      b: 900,
    });
  });

  it("is symmetric: a's win is b's loss", () => {
    const x = eloUpdate({ rating: 1234, games: 5 }, { rating: 1100, games: 50 }, 0.5);
    const y = eloUpdate({ rating: 1100, games: 50 }, { rating: 1234, games: 5 }, 0.5);
    expect(x.a).toBe(y.b);
    expect(x.b).toBe(y.a);
  });
});

describe("arenaRewards", () => {
  it("pins the attacker rewards", () => {
    expect(arenaRewards("win")).toEqual({ coin: 25, seasonXp: 60 });
    expect(arenaRewards("draw")).toEqual({ coin: 10, seasonXp: 30 });
    expect(arenaRewards("loss")).toEqual({ coin: 5, seasonXp: 20 });
  });
});

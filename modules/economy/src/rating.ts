/**
 * Arena rating (wave-C.md §6). OWNER: T-arena (implement + tests; keep the
 * signatures). Elo with K = 32 under 30 games, 24 after; draws score 0.5;
 * ratings are integers (round half away from zero), never below RATING_FLOOR.
 */
export const START_RATING = 1000;
export const RATING_FLOOR = 100;
/** Opponent band for matchmaking: +-BAND, widening by BAND_STEP per empty search, up to BAND_MAX. */
export const MATCH_BAND = 100;
export const MATCH_BAND_STEP = 100;
export const MATCH_BAND_MAX = 600;
export const FIGHTS_PER_DAY = 20;

/** Rating K factor: new players move faster (K 32 under 30 rated games, then 24). */
export function kFactor(games: number): number {
  return games < 30 ? 32 : 24;
}

/** Rounds half away from zero (Math.round rounds -2.5 up to -2). */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

/** Expected score of a player rated `own` against `other` (standard Elo logistic). */
export function expectedScore(own: number, other: number): number {
  return 1 / (1 + Math.pow(10, (other - own) / 400));
}

/** New ratings of attacker (a) and defender (b); score = 1 a wins, 0 b wins, 0.5 draw. */
export function eloUpdate(
  a: { rating: number; games: number },
  b: { rating: number; games: number },
  score: 0 | 0.5 | 1,
): { a: number; b: number } {
  const ea = expectedScore(a.rating, b.rating);
  const eb = expectedScore(b.rating, a.rating);
  const na = roundHalfAway(a.rating + kFactor(a.games) * (score - ea));
  const nb = roundHalfAway(b.rating + kFactor(b.games) * (1 - score - eb));
  return {
    a: Math.max(RATING_FLOOR, na),
    b: Math.max(RATING_FLOOR, nb),
  };
}

/** Attacker rewards for a fight: coin (faucet) and season xp. */
export function arenaRewards(result: "win" | "loss" | "draw"): { coin: number; seasonXp: number } {
  switch (result) {
    case "win":
      return { coin: 25, seasonXp: 60 };
    case "draw":
      return { coin: 10, seasonXp: 30 };
    case "loss":
      return { coin: 5, seasonXp: 20 };
  }
}

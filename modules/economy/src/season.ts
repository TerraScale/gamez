/**
 * Battle pass seasons (wave-C.md §7). OWNER: T-pass (fill the tiers and
 * rewards, implement tierForXp, keep the signatures and season ids).
 * Original names only. Rewards are cosmetics (titles, nameplates, chat
 * colours) and small coin amounts on the free track; never power.
 *
 * Tier t needs the cumulative xp 100·t + 10·t² (tierXp). Free track: a coin
 * reward on every 5th tier (at most 50), alternating titles and chat colours
 * otherwise. Premium track: a nameplate, title or chat colour on every tier.
 * Cosmetic skus are "cosmetic.<slot>.<slug>" (CosmeticSlot in protocol platform.ts).
 */
import type { PassReward, PassTierView } from "@gamez/protocol";
import type { CosmeticSlot } from "@gamez/protocol";

export interface SeasonDef {
  /** Stable id, e.g. "2026-s1". Also part of ArenaDO names. */
  id: string;
  name: string;
  startsAt: number;
  endsAt: number;
  /** Entitlement sku unlocking premium ("pass.premium.<id>"). */
  premiumSku: string;
  tiers: PassTierView[];
}

/** Tiers in every season. */
export const SEASON_TIERS = 30;

/** Gems that buy the premium track through POST /api/pass/premium (the first gem sink). */
export const PASS_PREMIUM_GEMS = 500;

/** 2026-10-01T00:00:00Z (no Date in module code: determinism lint). */
const S1_START = 1_790_812_800_000;
/** 2027-01-01T00:00:00Z. */
const S1_END = 1_798_761_600_000;

/** Cumulative season xp needed for `tier` (1-based). */
export function tierXp(tier: number): number {
  return 100 * tier + 10 * tier * tier;
}

/** Lowercase slug of a display name: "Ember Initiate" -> "ember-initiate". */
function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cosmetic(slot: CosmeticSlot, name: string): PassReward {
  return { kind: "cosmetic", sku: `cosmetic.${slot}.${slugOf(name)}`, name, slot };
}

// Original names (no franchise names, no real-world brands).
const FREE_TITLES = [
  "Ember Initiate",
  "Ashen Wanderer",
  "Kindled Hopeful",
  "Cinder Scout",
  "Smoke Runner",
  "Lantern Bearer",
  "Hearthkeeper",
  "Dusk Pilgrim",
  "Ember Touched",
  "Soot Walker",
  "Flint Seeker",
  "Torchbearer",
] as const;
const FREE_COLOURS = [
  "Amber",
  "Ochre",
  "Rust",
  "Copper",
  "Saffron",
  "Vermilion",
  "Honey",
  "Ash Grey",
  "Ember Glow",
  "Dusk Violet",
  "Sage",
  "Tide Blue",
] as const;
const PREMIUM_PLATES = [
  "Gilded Plate",
  "Obsidian Plate",
  "Ember Crest",
  "Brass Scroll",
  "Iron Sigil",
  "Moonsilver Frame",
  "Runed Oak",
  "Storm Slate",
  "Sunforged Band",
  "Hollow Ring",
] as const;
const PREMIUM_TITLES = [
  "Ember Sovereign",
  "Ashen Champion",
  "Cinder Lord",
  "Flame Warden",
  "Dawnkindled",
  "Ember Vanguard",
  "Glowing Oath",
  "Pyre Sworn",
  "Starlit Ember",
  "Season Vigil",
] as const;
const PREMIUM_COLOURS = [
  "Crimson Flare",
  "Gold Leaf",
  "Ice Ember",
  "Verdant",
  "Pale Ember",
  "Midnight Ink",
  "Coral",
  "Bronze",
  "Lilac Ember",
  "Ivory",
] as const;

/** Free track: coin on every 5th tier, else even tiers get a title, odd tiers a chat colour. */
function freeReward(tier: number, titles: { i: number }, colours: { i: number }): PassReward {
  if (tier % 5 === 0) return { kind: "coin", amount: Math.min(50, 10 * (tier / 5)) };
  if (tier % 2 === 0) return cosmetic("title", FREE_TITLES[titles.i++]!);
  return cosmetic("chatColor", FREE_COLOURS[colours.i++]!);
}

/** Premium track: every tier gives a cosmetic: nameplate, title or chat colour in turn. */
function premiumReward(
  tier: number,
  next: { plate: number; title: number; colour: number },
): PassReward {
  const r = tier % 3;
  if (r === 1) return cosmetic("nameplate", PREMIUM_PLATES[next.plate++]!);
  if (r === 2) return cosmetic("title", PREMIUM_TITLES[next.title++]!);
  return cosmetic("chatColor", PREMIUM_COLOURS[next.colour++]!);
}

function buildTiers(): PassTierView[] {
  const titles = { i: 0 };
  const colours = { i: 0 };
  const premium = { plate: 0, title: 0, colour: 0 };
  const out: PassTierView[] = [];
  for (let tier = 1; tier <= SEASON_TIERS; tier++) {
    out.push({
      tier,
      xp: tierXp(tier),
      free: freeReward(tier, titles, colours),
      premium: premiumReward(tier, premium),
    });
  }
  return out;
}

export const SEASONS: readonly SeasonDef[] = [
  {
    id: "2026-s1",
    name: "Season of Embers",
    startsAt: S1_START,
    endsAt: S1_END,
    premiumSku: "pass.premium.2026-s1",
    tiers: buildTiers(),
  },
];

/** The season running at `now`, else the latest one that started, else the first. */
export function currentSeason(now: number): SeasonDef {
  let best: SeasonDef = SEASONS[0]!;
  for (const s of SEASONS) if (s.startsAt <= now && s.startsAt >= best.startsAt) best = s;
  return best;
}

/** Highest tier whose cumulative xp is <= xp (0 = none). */
export function tierForXp(season: SeasonDef, xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 0;
  let tier = 0;
  for (const t of season.tiers) if (t.xp <= xp && t.tier > tier) tier = t.tier;
  return tier;
}

/** The reward of (tier, track), or null. */
export function passReward(
  season: SeasonDef,
  tier: number,
  track: "free" | "premium",
): PassReward | null {
  const t = season.tiers.find((x) => x.tier === tier);
  return t ? (track === "free" ? t.free : t.premium) : null;
}

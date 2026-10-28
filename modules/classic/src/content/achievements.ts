/**
 * Achievements (wave A, docs/design/wave-A.md §9). Ids "classic.achievement.<name>".
 * Every AchievementMetric is used, in tiers. Gold rewards are small: about
 * 24,000 in total, ~2 % of the ~1.18 M gold a hero earns from kills alone on
 * the way to level 60 (analytic estimate from balance.ts and the regular
 * monsters' xp, before item sales); titles are display-only (client-side choice).
 * Icons are logical ids: "icon.achievement.<name>". OWNER: T-achievements.
 */
import type { AchievementProto } from "../types.ts";

interface Row {
  /** Id slug: "classic.achievement.<slug>", icon "icon.achievement.<slug>". */
  slug: string;
  /** Display name. */
  name: string;
  description: string;
  metric: AchievementProto["metric"];
  target: number;
  gold: number;
  title?: string;
  hidden?: boolean;
}

const ROWS: Row[] = [
  // kills
  {
    slug: "first_blood",
    name: "First Blood",
    description: "Slay your first monster.",
    metric: "kills",
    target: 1,
    gold: 10,
  },
  {
    slug: "pest_control",
    name: "Pest Control",
    description: "Slay 100 monsters.",
    metric: "kills",
    target: 100,
    gold: 55,
  },
  {
    slug: "grave_reaper",
    name: "Grave Reaper",
    description: "Slay 1,000 monsters.",
    metric: "kills",
    target: 1000,
    gold: 300,
    title: "Reaper",
  },
  {
    slug: "ten_thousand_dead",
    name: "Ten Thousand Dead",
    description: "Slay 10,000 monsters.",
    metric: "kills",
    target: 10000,
    gold: 1500,
    title: "Doomwalker",
    hidden: true,
  },
  // championKills
  {
    slug: "champion_hunter",
    name: "Champion Hunter",
    description: "Slay 25 champion monsters.",
    metric: "championKills",
    target: 25,
    gold: 75,
  },
  {
    slug: "champion_breaker",
    name: "Champion Breaker",
    description: "Slay 250 champion monsters.",
    metric: "championKills",
    target: 250,
    gold: 575,
    title: "Breaker",
  },
  // uniqueKills
  {
    slug: "unmasked",
    name: "Unmasked",
    description: "Slay 5 unique monsters.",
    metric: "uniqueKills",
    target: 5,
    gold: 115,
  },
  {
    slug: "relic_hunter",
    name: "Relic Hunter",
    description: "Slay 50 unique monsters.",
    metric: "uniqueKills",
    target: 50,
    gold: 750,
    hidden: true,
  },
  // bossKills
  {
    slug: "giant_slayer",
    name: "Giant Slayer",
    description: "Slay your first boss.",
    metric: "bossKills",
    target: 1,
    gold: 75,
  },
  {
    slug: "four_crowns",
    name: "Four Crowns",
    description: "Slay 4 bosses.",
    metric: "bossKills",
    target: 4,
    gold: 450,
    title: "Crown Breaker",
  },
  // level
  {
    slug: "coming_of_age",
    name: "Coming of Age",
    description: "Reach level 10.",
    metric: "level",
    target: 10,
    gold: 40,
  },
  {
    slug: "seasoned",
    name: "Seasoned",
    description: "Reach level 20.",
    metric: "level",
    target: 20,
    gold: 150,
  },
  {
    slug: "veteran",
    name: "Veteran",
    description: "Reach level 30.",
    metric: "level",
    target: 30,
    gold: 450,
    title: "Veteran",
  },
  {
    slug: "hardened",
    name: "Hardened",
    description: "Reach level 45.",
    metric: "level",
    target: 45,
    gold: 1100,
  },
  {
    slug: "legend_of_the_realm",
    name: "Legend of the Realm",
    description: "Reach level 60.",
    metric: "level",
    target: 60,
    gold: 1900,
    title: "Legend",
    hidden: true,
  },
  // deepest
  {
    slug: "into_the_cellars",
    name: "Into the Cellars",
    description: "Reach depth 4.",
    metric: "deepest",
    target: 4,
    gold: 55,
  },
  {
    slug: "halfway_down",
    name: "Halfway Down",
    description: "Reach depth 8.",
    metric: "deepest",
    target: 8,
    gold: 225,
  },
  {
    slug: "ever_downward",
    name: "Ever Downward",
    description: "Reach depth 12.",
    metric: "deepest",
    target: 12,
    gold: 575,
  },
  {
    slug: "bottom_of_the_pit",
    name: "Bottom of the Pit",
    description: "Reach depth 16, the bottom of the main dungeon.",
    metric: "deepest",
    target: 16,
    gold: 1500,
    title: "Delver",
  },
  // goldEarned
  {
    slug: "coin_purse",
    name: "Coin Purse",
    description: "Earn 10,000 gold.",
    metric: "goldEarned",
    target: 10000,
    gold: 75,
  },
  {
    slug: "treasure_chest",
    name: "Treasure Chest",
    description: "Earn 100,000 gold.",
    metric: "goldEarned",
    target: 100000,
    gold: 375,
  },
  {
    slug: "dragons_hoard",
    name: "Dragon's Hoard",
    description: "Earn 1,000,000 gold.",
    metric: "goldEarned",
    target: 1000000,
    gold: 1900,
    hidden: true,
  },
  // goldSpent
  {
    slug: "big_spender",
    name: "Big Spender",
    description: "Spend 10,000 gold.",
    metric: "goldSpent",
    target: 10000,
    gold: 115,
  },
  {
    slug: "patron_of_merchants",
    name: "Patron of Merchants",
    description: "Spend 100,000 gold.",
    metric: "goldSpent",
    target: 100000,
    gold: 750,
  },
  // itemsFound
  {
    slug: "pack_rat",
    name: "Pack Rat",
    description: "Find 100 items.",
    metric: "itemsFound",
    target: 100,
    gold: 75,
  },
  {
    slug: "magpie",
    name: "Magpie",
    description: "Find 1,000 items.",
    metric: "itemsFound",
    target: 1000,
    gold: 375,
  },
  // uniquesFound
  {
    slug: "unique_find",
    name: "Unique Find",
    description: "Find a unique item.",
    metric: "uniquesFound",
    target: 1,
    gold: 115,
  },
  {
    slug: "collector_of_legends",
    name: "Collector of Legends",
    description: "Find 10 unique items.",
    metric: "uniquesFound",
    target: 10,
    gold: 575,
    title: "Curator",
  },
  // setItemsFound
  {
    slug: "set_piece",
    name: "Set Piece",
    description: "Find a set item.",
    metric: "setItemsFound",
    target: 1,
    gold: 75,
  },
  {
    slug: "matched_wardrobe",
    name: "Matched Wardrobe",
    description: "Find 10 set items.",
    metric: "setItemsFound",
    target: 10,
    gold: 575,
  },
  // setComplete
  {
    slug: "full_panoply",
    name: "Full Panoply",
    description: "Wear every piece of one set at once.",
    metric: "setComplete",
    target: 1,
    gold: 950,
    title: "Panoply",
  },
  // questsCompleted
  {
    slug: "errand_runner",
    name: "Errand Runner",
    description: "Complete a quest.",
    metric: "questsCompleted",
    target: 1,
    gold: 20,
  },
  {
    slug: "dependable",
    name: "Dependable",
    description: "Complete 5 quests.",
    metric: "questsCompleted",
    target: 5,
    gold: 150,
  },
  {
    slug: "trusted_by_the_town",
    name: "Trusted by the Town",
    description: "Complete every quest.",
    metric: "questsCompleted",
    target: 10,
    gold: 575,
    hidden: true,
  },
  // potionsUsed
  {
    slug: "flask_fiend",
    name: "Flask Fiend",
    description: "Drink 50 potions.",
    metric: "potionsUsed",
    target: 50,
    gold: 20,
  },
  {
    slug: "thirst_unquenched",
    name: "Thirst Unquenched",
    description: "Drink 500 potions.",
    metric: "potionsUsed",
    target: 500,
    gold: 150,
  },
  // itemsCrafted
  {
    slug: "apprentice_smith",
    name: "Apprentice Smith",
    description: "Craft an item at the smith.",
    metric: "itemsCrafted",
    target: 1,
    gold: 55,
  },
  {
    slug: "master_smith",
    name: "Master Smith",
    description: "Craft 25 items at the smith.",
    metric: "itemsCrafted",
    target: 25,
    gold: 450,
    title: "Smith",
  },
  // gemsSocketed
  {
    slug: "jewellers_touch",
    name: "Jeweller's Touch",
    description: "Put 5 gems into sockets.",
    metric: "gemsSocketed",
    target: 5,
    gold: 150,
  },
  // gambles
  {
    slug: "lucky_dice",
    name: "Lucky Dice",
    description: "Buy 3 items from the gambler.",
    metric: "gambles",
    target: 3,
    gold: 75,
    hidden: true,
  },
  {
    slug: "high_roller",
    name: "High Roller",
    description: "Buy 25 items from the gambler.",
    metric: "gambles",
    target: 25,
    gold: 300,
  },
  // talentPoints
  {
    slug: "studied",
    name: "Studied",
    description: "Spend 10 talent points.",
    metric: "talentPoints",
    target: 10,
    gold: 115,
  },
  {
    slug: "ascendant",
    name: "Ascendant",
    description: "Spend 40 talent points.",
    metric: "talentPoints",
    target: 40,
    gold: 750,
    title: "Ascendant",
    hidden: true,
  },
  // riftLevel
  {
    slug: "through_the_rift",
    name: "Through the Rift",
    description: "Complete a rift at level 1.",
    metric: "riftLevel",
    target: 1,
    gold: 375,
  },
  {
    slug: "rift_walker",
    name: "Rift Walker",
    description: "Complete a rift at level 10.",
    metric: "riftLevel",
    target: 10,
    gold: 1900,
    title: "Rift Walker",
  },
  {
    slug: "lord_of_rifts",
    name: "Lord of Rifts",
    description: "Complete a rift at level 25.",
    metric: "riftLevel",
    target: 25,
    gold: 1900,
    hidden: true,
  },
  // riftsCompleted
  {
    slug: "repeat_rifter",
    name: "Repeat Rifter",
    description: "Complete 10 rift runs.",
    metric: "riftsCompleted",
    target: 10,
    gold: 750,
  },
  // playMinutes
  {
    slug: "an_hours_work",
    name: "An Hour's Work",
    description: "Play for one hour.",
    metric: "playMinutes",
    target: 60,
    gold: 40,
  },
  {
    slug: "ten_hours_in",
    name: "Ten Hours in",
    description: "Play for ten hours.",
    metric: "playMinutes",
    target: 600,
    gold: 375,
    title: "Devoted",
  },
];

function toProto(row: Row, order: number): AchievementProto {
  return {
    name: row.name,
    description: row.description,
    icon: `icon.achievement.${row.slug}`,
    metric: row.metric,
    target: row.target,
    reward: { gold: row.gold, title: row.title ?? null },
    hidden: row.hidden === true,
    order,
  };
}

export const ACHIEVEMENTS: Record<string, AchievementProto> = Object.fromEntries(
  ROWS.map((row, i) => [`classic.achievement.${row.slug}`, toProto(row, i + 1)]),
);

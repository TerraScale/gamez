/**
 * classic.progression.kills (post 0): XP for hero-credited monster deaths,
 * life/mana on kill, run stats and kill quests; depth and level quests are
 * checked every tick here as well (docs/design/classic.md §6.3, §16).
 */
import type { SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, type DeathRecord } from "../bus.ts";
import { HeroStats, Level, Life, Mana } from "../components.ts";
import { SYSTEM } from "../ids.ts";
import { heroOf, RES, runStatsOf, type DungeonState } from "../resources.ts";
import { xpForKill } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../types.ts";
import { addXp } from "./level.ts";
import { advanceKillQuests, advanceLevelQuests } from "./quests.ts";

/** Life and mana on kill (HeroStats.lifeOnKill / manaOnKill), clamped to the maxima. */
function onKillRestore(world: World, hero: number): void {
  const sheet = world.read(hero, HeroStats);
  if (sheet.lifeOnKill > 0 && world.has(hero, Life)) {
    const l = world.read(hero, Life);
    world.update(hero, Life, { hp: Math.min(l.max, l.hp + sheet.lifeOnKill) });
  }
  if (sheet.manaOnKill > 0 && world.has(hero, Mana)) {
    const m = world.read(hero, Mana);
    world.update(hero, Mana, { mp: Math.min(m.max, m.mp + sheet.manaOnKill) });
  }
}

/** A death the hero's side gets credit for, excluding the hero's own units and summons. */
function isCreditedKill(d: DeathRecord): boolean {
  return d.creditTeam === "hero" && !d.isHero && d.rarity !== "summon";
}

export const progressionKills: SystemDef = {
  ...SYSTEM.progressionKills,
  run(world, ctx) {
    const hero = heroOf(world);
    if (hero === 0) return;
    const deaths = busOf(world).deaths;
    const kills = deaths.filter(isCreditedKill);
    if (kills.length > 0) creditKills(world, ctx, hero, kills);
    advanceLevelQuests(world, ctx, levelDeathThisTick(world, deaths));
  },
};

/**
 * True when a monster died on the live level this tick, credited or not (an
 * exploder that kills itself leaves no hero credit, but may empty the level).
 */
function levelDeathThisTick(world: World, deaths: DeathRecord[]): boolean {
  const live = world.getResource<DungeonState>(RES.dungeon)?.live ?? 0;
  if (live === 0) return false;
  return deaths.some((d) => !d.isHero && d.team === "monster" && d.depth === live);
}

function creditKills(world: World, ctx: SimContext, hero: number, kills: DeathRecord[]): void {
  const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
  const stats = runStatsOf(world);
  for (const d of kills) {
    const heroLevel = world.read(hero, Level).level;
    const xp = d.xp > 0 ? xpForKill(bal, heroLevel, d.level, d.xp) : 0;
    addXp(world, ctx, hero, xp, "kill");
    onKillRestore(world, hero);
    stats.kills++;
    if (d.rarity === "champion") stats.championKills++;
    if (d.rarity === "unique") stats.uniqueKills++;
    if (d.rarity === "boss") stats.bossKills++;
    advanceKillQuests(world, ctx, d);
  }
  world.setResource(RES.stats, stats);
}

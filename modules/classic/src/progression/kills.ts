/**
 * classic.progression.kills (post 0): XP for hero-credited monster deaths,
 * life/mana on kill, run stats and kill quests; depth and level quests are
 * checked every tick here as well (docs/design/classic.md §6.3, §16).
 *
 * Party (docs/design/party.md §7.2): every STANDING member in the current
 * area gets rules.partyKillXp for its own level and the party size; life and
 * mana on kill and PartyMember.kills go to the hero credited with the kill
 * (items/common.ts creditedHero: the killer, a killing summon's owner, else
 * the controlled hero). RunStats and quests advance once per kill. A solo
 * game (no party, or a party of one) keeps the exact solo path.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { busOf, type DeathRecord } from "../bus.ts";
import { AreaTag, Dead, HeroStats, Level, Life, Mana, PartyMember } from "../components.ts";
import { SYSTEM } from "../ids.ts";
import { creditedHero } from "../items/common.ts";
import { partyMembers, partySize } from "../party/shared.ts";
import { currentDepth, heroOf, RES, runStatsOf, type DungeonState } from "../resources.ts";
import { partyKillXp, partyProtoOf, xpForKill } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../types.ts";
import { addXp } from "./level.ts";
import { advanceKillQuests, advanceLevelQuests } from "./quests.ts";

/** Life and mana on kill (HeroStats.lifeOnKill / manaOnKill), clamped to the maxima. */
function onKillRestore(world: World, hero: number): void {
  const sheet = world.get(hero, HeroStats);
  if (!sheet) return;
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
    if (kills.length > 0) {
      if (partySize(world) > 1) creditPartyKills(world, ctx, kills);
      else creditKills(world, ctx, hero, kills);
    }
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

/** One credited kill's run stats (counters by rarity). */
function countKill(stats: ReturnType<typeof runStatsOf>, d: DeathRecord): void {
  stats.kills++;
  if (d.rarity === "champion") stats.championKills++;
  if (d.rarity === "unique") stats.uniqueKills++;
  if (d.rarity === "boss") stats.bossKills++;
}

/** Solo (and a party of one): the hero gets everything (the pre-party path, bit-identical). */
function creditKills(world: World, ctx: SimContext, hero: number, kills: DeathRecord[]): void {
  const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
  const stats = runStatsOf(world);
  for (const d of kills) {
    const heroLevel = world.read(hero, Level).level;
    const xp = d.xp > 0 ? xpForKill(bal, heroLevel, d.level, d.xp) : 0;
    addXp(world, ctx, hero, xp, "kill");
    onKillRestore(world, hero);
    const pm = world.get(hero, PartyMember);
    if (pm) world.update(hero, PartyMember, { kills: pm.kills + 1 });
    countKill(stats, d);
    advanceKillQuests(world, ctx, d);
  }
  world.setResource(RES.stats, stats);
}

/** Standing members in the current area (slot order): the ones a kill's XP is shared with. */
function xpReceivers(world: World): Entity[] {
  const depth = currentDepth(world);
  return partyMembers(world).filter(
    (e) => !world.has(e, Dead) && world.get(e, AreaTag)?.depth === depth && world.has(e, Level),
  );
}

/** A party of two or more: shared XP, killer credit (docs/design/party.md §7.2). */
function creditPartyKills(world: World, ctx: SimContext, kills: DeathRecord[]): void {
  const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
  const proto = partyProtoOf(ctx.registry);
  const size = partySize(world);
  const stats = runStatsOf(world);
  for (const d of kills) {
    for (const m of xpReceivers(world)) {
      const own = world.read(m, Level).level;
      const xp = d.xp > 0 ? partyKillXp(bal, proto, size, own, d.level, d.xp) : 0;
      addXp(world, ctx, m, xp, "kill");
    }
    const killer = creditedHero(world, d.killer);
    if (killer !== 0 && world.exists(killer)) {
      if (!world.has(killer, Dead)) onKillRestore(world, killer);
      const pm = world.get(killer, PartyMember);
      if (pm) world.update(killer, PartyMember, { kills: pm.kills + 1 });
    }
    countKill(stats, d);
    advanceKillQuests(world, ctx, d);
  }
  world.setResource(RES.stats, stats);
}

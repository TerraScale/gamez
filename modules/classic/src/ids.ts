/**
 * Module ids and THE system table (CONTRACT). Every system of the mode is
 * listed here with its stage and order; implementers must use exactly these
 * ids, stages and orders (spread `...SYSTEM.x` into the SystemDef). Systems
 * of the same stage run by order, so the table is the tick pipeline.
 *
 * Tick pipeline (one sim tick, 50 ms):
 *   pre     area transitions -> spawns -> spatial grid -> hero init -> stats -> wake/sleep -> auto think
 *   update  commands -> hero intent -> monster AI -> cast orders -> movement -> dashes -> casting
 *           -> projectiles -> ground effects -> statuses (dots) -> resolve hits -> on-death bursts
 *   post    kills/XP/quests -> loot drops -> boss/level bookkeeping -> corpses & summons
 *           -> regen -> exploration -> hero death/respawn -> cleanup
 */
import type { SystemStage } from "@gamez/kernel";

export const MODULE = {
  content: "classic.content",
  core: "classic.core",
  world: "classic.world",
  combat: "classic.combat",
  monsters: "classic.monsters",
  items: "classic.items",
  progression: "classic.progression",
  auto: "classic.auto",
  // ---- wave A
  talents: "classic.talents",
  crafting: "classic.crafting",
  rift: "classic.rift",
  achievements: "classic.achievements",
  // ---- wave C (docs/design/wave-C.md §2)
  /** Bank between the hero and the account (src/platform/bank.ts). */
  platform: "classic.platform",
  /** QA-only cheat module (src/debug), never part of the default `modules`. */
  debug: "classic.debug",
  // ---- party (docs/design/party.md)
  /** Party resource, recruit/dismiss/control actions, revive, give (src/party). */
  party: "classic.party",
} as const;

interface SysRow {
  id: string;
  stage: SystemStage;
  order: number;
}

function sys(id: string, stage: SystemStage, order: number): SysRow {
  return { id, stage, order };
}

export const SYSTEM = {
  // ----- pre
  /** world: drain Bus.transitions; switch area, (de)spawn levels, place the hero. */
  worldTransition: sys("classic.world.transition", "pre", -1100),
  /** monsters: drain Bus.spawns into monster entities. */
  monstersSpawn: sys("classic.monsters.spawn", "pre", -1050),
  /** core: rebuild the spatial grid of the current area (units with Body). */
  coreSpatial: sys("classic.core.spatial", "pre", -1000),
  /** items: give a new hero Inventory/Equipment/Belt/Wallet/Supplies + starter kit. */
  itemsHeroInit: sys("classic.items.heroInit", "pre", -900),
  /** progression: recompute hero CombatStats + HeroStats from attributes, level, items, buffs. */
  progressionStats: sys("classic.progression.stats", "pre", -500),
  /** monsters: sleep far monsters, wake near ones (staggered by entity id). */
  monstersWake: sys("classic.monsters.wake", "pre", -100),
  /**
   * auto: the Auto/Idle controller writes the hero Intent and queues commands.
   * Party: runs the LEADER brain for the acting leader (party/shared.ts
   * actingLeaderOf) when Auto/Idle drives it (docs/design/party.md §6.1).
   */
  autoThink: sys("classic.auto.think", "pre", 0),
  /**
   * auto (party): the FOLLOWER brain of every other living member, always on
   * (any control mode): formation, assist, protect, revive, loot, town routine.
   * No-op without a party resource or with one member.
   */
  autoParty: sys("classic.auto.party", "pre", 5),
  /** auto: stat/skill point auto-allocation in auto/idle (queues commands). */
  autoAllocate: sys("classic.auto.allocate", "pre", 10),
  /** talents (wave A): grant points on level ups, auto-spend them in auto/idle, keep BonusStats in sync. */
  talentsPoints: sys("classic.talents.points", "pre", 12),

  // ----- update
  itemsCommands: sys("classic.items.commands", "update", 50),
  worldCommands: sys("classic.world.commands", "update", 51),
  progressionCommands: sys("classic.progression.commands", "update", 52),
  /** talents (wave A): learnTalent / resetTalents ops. */
  talentsCommands: sys("classic.talents.commands", "update", 53),
  /** crafting (wave A): repair / upgrade / reroll / sockets / gems ops. */
  craftingCommands: sys("classic.crafting.commands", "update", 54),
  /** rift (wave A): openRift / leaveRift ops. */
  riftCommands: sys("classic.rift.commands", "update", 55),
  /** party: revive / give ops (HeroCommand owner classic.party). */
  partyCommands: sys("classic.party.commands", "update", 56),
  /** core: execute the hero Intent (path, approach, CastOrder, pickup/interact commands). */
  coreIntent: sys("classic.core.intent", "update", 100),
  /** monsters: AI behaviours set Mover goals/paths and CastOrders. */
  monstersThink: sys("classic.monsters.think", "update", 200),
  /** combat: start casts from CastOrders (range, mana, cooldown, busy checks). */
  combatOrders: sys("classic.combat.orders", "update", 250),
  /** core: move every Mover of the current area (paths, steering, walls, separation, facing). */
  coreMovement: sys("classic.core.movement", "update", 300),
  /** combat: advance dashes (charge, tumble). */
  combatDashes: sys("classic.combat.dashes", "update", 350),
  /** combat: fire casts reaching hitAt (melee, arc, projectile spawn, nova, chain, blink, summon, self, pulse). */
  combatCasting: sys("classic.combat.casting", "update", 400),
  combatProjectiles: sys("classic.combat.projectiles", "update", 500),
  combatEffects: sys("classic.combat.effects", "update", 550),
  /** combat: status expiry and damage-over-time ticks. */
  combatStatuses: sys("classic.combat.statuses", "update", 600),
  /** combat: drain Bus.hits -> damage, crits, lifesteal, statuses, knockback, deaths (Dead + Bus.deaths). */
  combatResolve: sys("classic.combat.resolveHits", "update", 700),
  /** monsters: on-death skills (exploder burst, Emberbound), minion bookkeeping. */
  monstersOnDeath: sys("classic.monsters.onDeath", "update", 750),

  // ----- post
  /** progression: XP for kills, level ups, run stats, quest progress. */
  progressionKills: sys("classic.progression.kills", "post", 0),
  /** items: drop loot for monster deaths. */
  itemsDrops: sys("classic.items.drops", "post", 100),
  /** items (wave A): durability wear from hero kills and hero deaths (Bus.deaths). */
  itemsWear: sys("classic.items.wear", "post", 110),
  /** world: boss killed, level cleared, live-level counters. */
  worldLevelState: sys("classic.world.levelState", "post", 150),
  /** rift (wave A): unlock, progress from Bus.deaths, guardian spawn, completion / failure, rewards. */
  riftTrack: sys("classic.rift.track", "post", 160),
  /** monsters: remove corpses after corpseTicks, expire summons. */
  monstersCorpses: sys("classic.monsters.corpses", "post", 200),
  /** progression: life/mana regen (hero) and monster regen. */
  progressionRegen: sys("classic.progression.regen", "post", 300),
  /** world: reveal tiles around the hero. */
  worldExplore: sys("classic.world.explore", "post", 500),
  /** progression: hero death penalty, respawn timer (auto respawn handled by classic.auto). Party: per member (docs/design/party.md §7.4). */
  progressionHeroDeath: sys("classic.progression.heroDeath", "post", 600),
  /** party: revive channels (Reviving), town revive of downed members, downed / wiped events. */
  partyRevive: sys("classic.party.revive", "post", 610),
  /** party: control auto-switch when the controlled hero is down (Auto/Idle, PartyConfig.autoSwitch). */
  partyControl: sys("classic.party.control", "post", 620),
  /** achievements (wave A): check metrics (every 20 ticks), unlock, grant rewards. */
  achievementsCheck: sys("classic.achievements.check", "post", 900),
  /** core: clear Bus.hits/deaths, drop leftover commands, tick RunStats.ticksPlayed. */
  coreCleanup: sys("classic.core.cleanup", "post", 1000),
} as const;

export type SystemKey = keyof typeof SYSTEM;

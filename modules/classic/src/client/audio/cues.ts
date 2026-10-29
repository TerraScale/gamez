/**
 * Event -> sound table (wave A audio). `TABLE` is typed over every
 * ClassicEventType, so a new event without an entry fails to compile; an entry
 * that returns null is an explicit "silent". Client only.
 */
import type { FrozenRegistry, GameEvent } from "@gamez/kernel";
import { KIND, type Element, type SkillProto } from "../../types.ts";
import type { ClassicEvent, ClassicEventType } from "../../events.ts";
import { TICK_HZ } from "../../fixed.ts";
import * as S from "./sfx.ts";
import type { Recipe } from "./sfx.ts";

/** 0 = minor (dropped at speed x8), 1 = normal, 2 = important (last to be stolen). */
export type Prio = 0 | 1 | 2;

export interface Pos {
  /** Sub units (256 per tile), like the event fields. */
  x: number;
  y: number;
}

export interface Cue {
  /** Rate-limit key: the same key is not replayed inside `gapMs`. */
  key: string;
  prio: Prio;
  gapMs: number;
  /** Voice gain before distance attenuation. */
  vol: number;
  /** Positioned cues fall off with distance from the hero; null = centred. */
  pos: Pos | null;
  play: Recipe;
}

export interface CueEnv {
  readonly registry: FrozenRegistry;
  /** Hero entity (for "is this mine" decisions). */
  readonly hero: number;
}

type Entry<K extends ClassicEventType> = (
  ev: Extract<ClassicEvent, { type: K }>,
  env: CueEnv,
) => Cue | null;

function cue(
  key: string,
  prio: Prio,
  gapMs: number,
  vol: number,
  play: Recipe,
  pos: Pos | null = null,
): Cue {
  return { key, prio, gapMs, vol, pos, play };
}

const at = (x: number, y: number): Pos => ({ x, y });

/** Ground-loot cue by rarity (the rarity is known to be one of these). */
function lootCue(rarity: string): Cue {
  switch (rarity) {
    case "magic":
      return cue("loot.magic", 0, 120, 0.4, S.magicChime);
    case "rare":
      return cue("loot.rare", 1, 150, 0.45, S.rareArpeggio);
    case "set":
    case "unique":
      return cue(`loot.${rarity}`, 2, 300, 0.5, S.fanfare);
    default:
      return cue("loot.normal", 0, 60, 0.45, S.tick);
  }
}

function castFamily(
  proto: SkillProto,
  skill: string,
): { recipe: Recipe; key: string; prio: Prio; vol: number } {
  const element: Element = proto.damage?.element ?? "phys";
  const isSelf = proto.target === "self" || proto.shape === "self";
  if (isSelf) {
    if (skill.includes("mend") || skill.includes("heal")) {
      return { recipe: S.castHeal, key: "cast.heal", prio: 1, vol: 0.5 };
    }
    return { recipe: S.castBuff, key: "cast.buff", prio: 1, vol: 0.5 };
  }
  switch (proto.shape) {
    case "melee":
      return { recipe: S.castSwing, key: "cast.swing", prio: 0, vol: 0.45 };
    case "arc":
      return { recipe: S.castArc, key: "cast.arc", prio: 0, vol: 0.5 };
    case "dash":
      return { recipe: S.castDash, key: "cast.dash", prio: 1, vol: 0.5 };
    case "pulse":
      return { recipe: S.castPulse, key: "cast.pulse", prio: 1, vol: 0.45 };
    case "blink":
      return { recipe: S.blinkWhoosh, key: "cast.blink", prio: 1, vol: 0.6 };
    case "summon":
      return { recipe: S.castSummon, key: "cast.summon", prio: 1, vol: 0.5 };
    case "projectile":
      if (proto.damage === null) {
        return { recipe: S.castBow, key: "cast.bow", prio: 0, vol: 0.45 };
      }
      return {
        recipe: S.spellCharge(element, true),
        key: `cast.spell.${element}`,
        prio: 1,
        vol: 0.5,
      };
    default:
      return {
        recipe: S.spellCharge(element, false),
        key: `cast.spell.${element}`,
        prio: 1,
        vol: 0.5,
      };
  }
}

function effectRecipe(effect: string, radius: number): { recipe: Recipe; key: string } | null {
  const key = effect.replace(/^fx\./, "");
  if (/frost|cold|ice/.test(key)) return { recipe: S.freezeRing, key: "fx.freeze" };
  if (/phase|blink/.test(key)) return { recipe: S.blinkWhoosh, key: "fx.blink" };
  if (/chain|arc|spark|lightning/.test(key)) return { recipe: S.chainZap, key: "fx.zap" };
  if (radius > 0) {
    return { recipe: S.boom(1 + radius / 1024), key: `fx.boom.${key}` };
  }
  return null;
}

const TABLE: { [K in ClassicEventType]: Entry<K> } = {
  // ---- combat
  "classic.hit": (ev, env) => {
    if (ev.dot) {
      // Damage-over-time ticks are frequent: only poison bubbles, and quietly.
      return ev.element === "poison"
        ? cue("hit.poison", 0, 260, 0.2, S.hitPoison, at(ev.x, ev.y))
        : null;
    }
    if (ev.heroHit) {
      // The controlled hero's hurt sound is full; party followers' is quieter (docs §10.6).
      if (ev.target === env.hero || env.hero === 0) {
        return cue("hit.hero", 1, 90, 0.7, S.heroHurt, at(ev.x, ev.y));
      }
      return cue("hit.party", 0, 150, 0.3, S.heroHurt, at(ev.x, ev.y));
    }
    const prio: Prio = ev.crit ? 1 : 0;
    const hit = S.hitRecipe(ev.element);
    const play: Recipe = ev.crit
      ? (v) => {
          hit(v);
          S.critThump(v);
        }
      : hit;
    return cue(
      `hit.${ev.element}${ev.crit ? ".crit" : ""}`,
      prio,
      45,
      ev.crit ? 0.75 : 0.5,
      play,
      at(ev.x, ev.y),
    );
  },
  "classic.miss": (ev) => cue("miss", 0, 110, 0.3, S.swish, at(ev.x, ev.y)),
  "classic.cast": (ev, env) => {
    const proto = env.registry.get<SkillProto>(KIND.skill, ev.skill);
    if (!proto) return null;
    const fam = castFamily(proto, ev.skill);
    const mine = ev.caster === env.hero;
    return cue(
      fam.key,
      mine ? fam.prio : 0,
      80,
      fam.vol * (mine ? 1 : 0.5),
      fam.recipe,
      at(ev.x, ev.y),
    );
  },
  "classic.cast.failed": () => null,
  "classic.effect": (ev) => {
    // Arc swings carry one aim point: the cast sound already covers them.
    if (ev.points.length === 1) return null;
    if (ev.points.length >= 2) {
      return cue("fx.zap", 1, 60, 0.5, S.chainZap, at(ev.x, ev.y));
    }
    const fx = effectRecipe(ev.effect, ev.radius);
    if (!fx) return null;
    return cue(fx.key, 1, 120, 0.55, fx.recipe, at(ev.x, ev.y));
  },
  "classic.status": () => null,
  "classic.death": (ev, env) => {
    if (ev.isHero || ev.rarity === "hero") {
      // A party follower going down is announced by classic.party.downed (a thud).
      if (ev.entity !== env.hero && env.hero !== 0) return null;
      return cue("death.hero", 2, 500, 0.8, S.heroDeath);
    }
    const pos = at(ev.x, ev.y);
    switch (ev.rarity) {
      case "boss":
        return cue("death.boss", 2, 600, 0.9, S.deathBoss, pos);
      case "unique":
        return cue("death.unique", 2, 200, 0.8, S.deathHeavy, pos);
      case "champion":
        return cue("death.champion", 1, 120, 0.6, S.deathHeavy, pos);
      default:
        return cue("death.normal", 0, 70, 0.45, S.deathNormal, pos);
    }
  },
  "classic.heal": (ev, env) => {
    if (ev.target !== env.hero) return null;
    return cue("heal", 1, 150, 0.35, S.chime(523), at(ev.x, ev.y));
  },
  // ---- progression
  "classic.xp": () => null,
  // The fanfare is the controlled hero's; a party member's level-up is a quiet chime.
  "classic.levelUp": (ev, env) =>
    ev.hero === undefined || ev.hero === env.hero
      ? cue("levelUp", 2, 0, 0.7, S.levelUp)
      : cue("levelUp.party", 0, 200, 0.3, S.chime(1046)),
  "classic.statAllocated": () => cue("ui.stat", 0, 60, 0.35, S.click),
  "classic.skillLearned": () => cue("ui.skill", 1, 100, 0.5, S.chime(659)),
  "classic.hero.created": () => cue("hero.created", 1, 300, 0.5, S.chime(523)),
  // The death itself is already announced by classic.death (isHero).
  "classic.hero.died": () => null,
  "classic.hero.respawned": () => cue("hero.respawned", 1, 300, 0.4, S.chime(784)),
  "classic.quest.accepted": () => cue("quest.accepted", 0, 100, 0.35, S.click),
  "classic.quest.progress": () => null,
  "classic.quest.done": () => cue("quest.done", 1, 200, 0.5, S.chime(784)),
  "classic.quest.completed": () => cue("quest.completed", 1, 300, 0.6, S.fanfare),
  // ---- items
  "classic.loot.dropped": (ev) => {
    const pos = at(ev.x, ev.y);
    if (ev.kind === "gold") return cue("loot.gold", 0, 80, 0.4, S.coins, pos);
    if (ev.kind === "potion") return cue("loot.potion", 0, 100, 0.35, S.tick, pos);
    return { ...lootCue(ev.rarity), pos };
  },
  "classic.loot.picked": (ev, env) => {
    if (ev.kind !== "item") return null;
    const follower = ev.hero !== undefined && ev.hero !== env.hero;
    if (ev.rarity === "rare" || ev.rarity === "set" || ev.rarity === "unique") {
      // The loot chime is the controlled hero's; a follower's rare pickup is a soft tick.
      if (follower) return cue("pick.party", 0, 200, 0.2, S.tick);
      return cue("pick.rare", 1, 150, 0.45, S.chime(880));
    }
    if (follower) return null;
    return cue("pick.item", 0, 60, 0.35, S.click);
  },
  // Pickup chimes come from classic.gold / classic.potion; loot.picked stays quiet for gold and potions.
  "classic.gold": () => cue("gold", 0, 70, 0.5, S.coins),
  "classic.potion": (ev) => cue(`potion.${ev.kind}`, 1, 150, 0.6, S.gulp(ev.kind)),
  "classic.item.equipped": () => cue("equip", 0, 80, 0.4, S.clink),
  "classic.item.unequipped": () => null,
  "classic.vendor.bought": () => cue("vendor.buy", 1, 80, 0.5, S.clink),
  "classic.vendor.sold": () => cue("vendor.sell", 1, 80, 0.5, S.coinsDown),
  "classic.bag.full": () => cue("bag.full", 1, 800, 0.4, S.error),
  // ---- world
  "classic.area.changed": () => cue("area", 2, 0, 0.6, S.whoosh),
  "classic.level.cleared": () => cue("level.cleared", 1, 500, 0.6, S.chime(784)),
  "classic.boss.spawned": () => cue("boss.spawned", 2, 0, 0.8, S.bossSting(1)),
  "classic.boss.killed": () => cue("boss.killed", 2, 0, 0.8, S.fanfare),
  "classic.waypoint.unlocked": () => cue("waypoint.unlocked", 1, 300, 0.5, S.chime(988)),
  "classic.portal.opened": () => cue("portal.opened", 1, 500, 0.6, S.portalHum),
  "classic.npc.opened": () => cue("npc.opened", 0, 200, 0.3, S.click),
  "classic.stash.opened": () => cue("stash.opened", 1, 200, 0.4, S.click),
  "classic.waypoint.opened": () => cue("waypoint.opened", 0, 200, 0.3, S.click),
  // ---- auto (the controller is silent; its notices are text)
  "classic.control": () => null,
  "classic.auto.plan": () => null,
  "classic.auto.notice": () => null,
  "classic.offline.summary": () => cue("offline", 1, 500, 0.5, S.chime(659)),
  "classic.command.failed": () => cue("command.failed", 1, 300, 0.4, S.error),
  // ---- wave A: bosses
  "classic.telegraph": (ev) =>
    cue(`telegraph.${ev.effect}`, 2, 200, 0.5, S.telegraphWarn(ev.ticks / TICK_HZ), at(ev.x, ev.y)),
  "classic.boss.phase": (ev) =>
    cue("boss.phase", 2, 800, 0.8, S.bossSting(ev.enraged ? 1.3 : 1), null),
  // ---- wave A: items
  "classic.item.broken": () => cue("item.broken", 1, 200, 0.7, S.crack),
  "classic.item.worn": () => cue("item.worn", 1, 300, 0.5, S.wornWarn),
  "classic.gambled": (ev) => {
    if (ev.rarity === "unique" || ev.rarity === "set") {
      return cue("gamble.top", 2, 300, 0.6, S.fanfare);
    }
    if (ev.rarity === "rare") return cue("gamble.rare", 1, 200, 0.5, S.rareArpeggio);
    if (ev.rarity === "magic") return cue("gamble.magic", 1, 150, 0.45, S.magicChime);
    return cue("gamble.roll", 1, 120, 0.4, S.rattle);
  },
  "classic.set.bonus": () => cue("set.bonus", 1, 400, 0.6, S.rareArpeggio),
  "classic.stash.moved": () => cue("stash.moved", 0, 60, 0.35, S.click),
  "classic.lootFilter.changed": () => cue("filter.changed", 0, 100, 0.3, S.click),
  // ---- wave A: smith
  "classic.repaired": () => cue("repaired", 1, 200, 0.5, S.hammer),
  "classic.upgraded": (ev) =>
    ev.success
      ? cue("upgrade.ok", 1, 200, 0.6, S.sparkle)
      : cue("upgrade.fail", 1, 200, 0.5, S.thunk),
  "classic.rerolled": () => cue("rerolled", 1, 200, 0.45, S.rattle),
  "classic.socket.added": () => cue("socket.added", 1, 150, 0.5, S.tap),
  "classic.gem.socketed": () => cue("gem.socketed", 1, 150, 0.5, S.gemChime),
  "classic.gems.removed": () => cue("gems.removed", 1, 200, 0.4, S.sigh),
  "classic.gems.combined": () => cue("gems.combined", 1, 200, 0.6, S.gemChime),
  // ---- wave A: talents
  "classic.talent.points": () => cue("talent.points", 1, 300, 0.6, S.chime(1046)),
  "classic.talent.learned": () => cue("talent.learned", 0, 100, 0.45, S.chime(784)),
  "classic.talents.reset": () => cue("talents.reset", 1, 300, 0.5, S.sigh),
  // ---- wave A: rift
  "classic.rift.panel": () => cue("rift.panel", 1, 200, 0.4, S.click),
  "classic.rift.unlocked": () => cue("rift.unlocked", 2, 500, 0.7, S.fanfare),
  "classic.rift.opened": () => cue("rift.opened", 2, 500, 0.7, S.portalHum),
  "classic.rift.progress": () => cue("rift.progress", 0, 300, 0.2, S.tick),
  "classic.rift.guardian": () => cue("rift.guardian", 2, 600, 0.8, S.bossSting(1)),
  "classic.rift.completed": () => cue("rift.completed", 2, 500, 0.8, S.fanfare),
  "classic.rift.failed": () => cue("rift.failed", 2, 500, 0.7, S.riftFail),
  // ---- wave A: achievements
  "classic.achievement.unlocked": () => cue("achievement", 2, 500, 0.7, S.fanfare),
  // ---- party (docs/design/party.md §10.6)
  "classic.party.recruited": () => cue("party.recruited", 2, 500, 0.7, S.fanfare),
  "classic.party.dismissed": () => cue("party.dismissed", 1, 200, 0.4, S.click),
  "classic.party.renamed": () => null,
  "classic.party.reordered": () => null,
  "classic.party.control": () => cue("party.control", 1, 150, 0.4, S.click),
  "classic.party.config": () => null,
  "classic.party.slots": () => cue("party.slots", 2, 500, 0.7, S.fanfare),
  "classic.party.downed": () => cue("party.downed", 2, 400, 0.6, S.downThud),
  "classic.party.reviving": () => null,
  "classic.party.reviveCancelled": () => null,
  "classic.party.revived": () => cue("party.revived", 2, 300, 0.6, S.chime(587)),
  "classic.party.wiped": () => cue("party.wiped", 2, 500, 0.5, S.heroDeath),
  "classic.party.itemGiven": () => cue("party.itemGiven", 1, 150, 0.4, S.click),
};

/**
 * Sound for one event, or null (silent). Never throws for a known type; the
 * caller still wraps it (the engine must never break the game).
 */
export function cueFor(ev: GameEvent, env: CueEnv): Cue | null {
  if (!Object.prototype.hasOwnProperty.call(TABLE, ev.type)) return null;
  const fn = (TABLE as unknown as Record<string, (e: GameEvent, env: CueEnv) => Cue | null>)[
    ev.type
  ];
  return fn ? fn(ev, env) : null;
}

/** Every event type that has a table entry (sorted). Used by the tests. */
export function mappedEventTypes(): string[] {
  return Object.keys(TABLE).sort();
}

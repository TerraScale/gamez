/**
 * Hero creation (docs/design/classic.md §4): the identity, level, attributes,
 * skills, vitals and the movement/combat components. World adds Pos and
 * AreaTag on the next tick; items add the starter kit; progression computes
 * the stats every tick after that.
 */
import type { Entity, SimContext, World } from "@gamez/kernel";
import {
  Attributes,
  Body,
  CombatStats,
  Faction,
  Hero,
  HeroStats,
  Intent,
  Level,
  Life,
  Mana,
  Mover,
  SkillBar,
  SkillBook,
  Statuses,
} from "../components.ts";
import { pushTransition } from "../bus.ts";
import { emit } from "../events.ts";
import { ERR, fail, type OpResult, OK } from "../actions.ts";
import { RES, type GameState } from "../resources.ts";
import { KIND, type ClassProto } from "../types.ts";
import { computeHeroStats } from "./stats.ts";
import { byString } from "./util.ts";

export const NAME_MAX = 16;

/** The trimmed name when it is 1..16 letters, digits, spaces, '_' or '-'; else null. */
export function cleanHeroName(raw: string): string | null {
  const name = raw.trim();
  const len = Array.from(name).length;
  if (len < 1 || len > NAME_MAX) return null;
  if (!/^[\p{L}\p{Nd} _-]+$/u.test(name)) return null;
  return name;
}

/** Creates the hero (phase "choose" only). Queues the transition to town. */
export function execNewHero(
  world: World,
  ctx: SimContext,
  classId: string,
  rawName: string,
): OpResult {
  const game = world.getResource<GameState>(RES.game);
  if (!game || game.phase !== "choose") return fail(ERR.heroExists, "a hero already exists");
  const cls = ctx.registry.get<ClassProto>(KIND.class, classId);
  if (!cls) return fail(ERR.unknownId, `unknown class "${classId}"`);
  const name = cleanHeroName(rawName);
  if (name === null) {
    return fail(ERR.badPayload, "name must be 1-16 letters, digits, spaces, _ or -");
  }

  const e = spawnHeroEntity(world, ctx, cls, classId, name);

  game.hero = e;
  game.phase = "play";
  world.setResource(RES.game, game);
  pushTransition(world, { to: 0, via: "new" });
  emit(ctx, { type: "classic.hero.created", hero: e, classId, name });
  return OK;
}

/**
 * Creates a level-1 hero entity of class `cls` with every progression-owned
 * component (identity, level, attributes, skills, bar, vitals, stats,
 * movement, body, faction, intent, statuses). It has NO Pos/AreaTag (the
 * caller places it: world transition for classic.newHero, classic.party for
 * recruits) and no items (classic.items.heroInit adds them next tick).
 * Does not touch GameState. Shared by classic.newHero and
 * classic.party.recruit (docs/design/party.md §4.1); `name` must already be
 * clean (cleanHeroName).
 */
export function spawnHeroEntity(
  world: World,
  ctx: SimContext,
  cls: ClassProto,
  classId: string,
  name: string,
): Entity {
  const res = computeHeroStats(ctx.registry, {
    classId,
    level: 1,
    base: { str: cls.base.str, dex: cls.base.dex, mag: cls.base.mag, vit: cls.base.vit },
    equipment: null,
    buffs: [],
  });

  const e = world.create();
  world.add(e, Hero, { classId, name, createdTick: ctx.tick });
  world.add(e, Level, { level: 1, xp: 0, statPoints: 0, skillPoints: 0 });
  world.add(e, Attributes, {
    str: cls.base.str,
    dex: cls.base.dex,
    mag: cls.base.mag,
    vit: cls.base.vit,
  });
  const ranks = [...new Set(cls.startingSkills)]
    .sort(byString)
    .map((skill) => ({ skill, rank: 1 }));
  world.add(e, SkillBook, { ranks, cooldowns: [] });
  world.add(e, SkillBar, { slots: cls.defaultBar.map((s) => s ?? null) });
  world.add(e, Life, { hp: res.sheet.lifeMax, max: res.sheet.lifeMax, acc: 0 });
  world.add(e, Mana, { mp: res.sheet.manaMax, max: res.sheet.manaMax, acc: 0 });
  world.add(e, CombatStats, res.combat);
  world.add(e, HeroStats, res.sheet);
  world.add(e, Mover, {
    speed: cls.moveSpeed,
    path: [],
    goalX: -1,
    goalY: -1,
    moving: false,
    facing: "s",
    blocked: 0,
  });
  world.add(e, Body, { radius: 80, solid: true });
  world.add(e, Faction, { team: "hero" });
  world.add(e, Intent, { kind: "idle", source: "manual", at: ctx.tick });
  world.add(e, Statuses, { list: [] });
  return e;
}

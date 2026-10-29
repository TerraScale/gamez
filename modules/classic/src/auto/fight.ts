/**
 * Fight decisions of the auto controller (§15.2 step 5): danger scan,
 * target scoring, skill choice from SkillProto.ai hints, mobility and
 * kiting. Read-only except for the Intent/AutoState writes done by the
 * caller through util.ts.
 */
import type { Entity } from "@gamez/kernel";
import {
  Ai,
  CombatStats,
  Dead,
  Faction,
  HeroStats,
  Life,
  Mana,
  Monster,
  Pos,
  SkillBar,
  SkillBook,
  Statuses,
  Summoned,
} from "../components.ts";
import { angleDiff, angleOf, angleVec, isqrt, pct, scaleTo } from "../fixed.ts";
import { skillModsOf } from "../bonus.ts";
import { effectiveManaCost, effectiveRank, resistOf } from "../rules.ts";
import { gridOf } from "../spatial.ts";
import {
  KIND,
  type Element,
  type MonsterBehaviour,
  type MonsterProto,
  type MonsterRarity,
  type SkillProto,
  type StatusProto,
} from "../types.ts";
import { lineOfSight, walkableAt } from "../world/maps.ts";
import {
  addIgnore,
  currentIntent,
  d2To,
  FIGHT_LINGER_TICKS,
  FIGHT_RANGE,
  isIgnored,
  LEAVE_FIGHT_RANGE,
  leaving,
  lifePct,
  moveTo,
  setIntent,
  setPlan,
  stopIntent,
  STUCK_TICKS,
  type AutoCtx,
} from "./util.ts";

const TILE = 256;

export interface Foe {
  e: Entity;
  x: number;
  y: number;
  /** Distance to the hero, sub. */
  dist: number;
  behaviour: MonsterBehaviour | "";
  rarity: MonsterRarity;
  /** Fights in melee (no keep-distance). */
  melee: boolean;
  name: string;
}

/** Awake, alive monster-team units within 12 tiles (with line of sight unless focused), ascending ids. */
export function scanFoes(c: AutoCtx): Foe[] {
  const { world, reg } = c;
  const out: Foe[] = [];
  for (const e of gridOf(world).query(c.hx, c.hy, FIGHT_RANGE)) {
    if (e === c.hero) continue;
    const f = world.get(e, Faction);
    if (!f || f.team !== "monster" || world.has(e, Dead)) continue;
    const life = world.get(e, Life);
    if (life && life.hp <= 0) continue;
    const ai = world.get(e, Ai);
    if (ai && ai.state === "sleep") continue;
    const p = world.get(e, Pos);
    if (!p) continue;
    if (e !== c.st.focus && !lineOfSight(c.map, c.hx, c.hy, p.x, p.y)) continue;
    const dist = isqrt(d2To(c, p.x, p.y));
    // Spots given up as unreachable, unless the enemy is close enough to hit us.
    if (dist > 2 * TILE && isIgnored(c.st, p.x >> 8, p.y >> 8)) continue;
    const m = world.get(e, Monster);
    const proto = m ? reg.get<MonsterProto>(KIND.monster, m.proto) : undefined;
    const behaviour = proto?.behaviour ?? "";
    out.push({
      e,
      x: p.x,
      y: p.y,
      dist,
      behaviour,
      rarity: m?.rarity ?? "normal",
      melee: proto ? proto.keepDistance === 0 && behaviour !== "totem" : true,
      name: m?.name ?? "enemy",
    });
  }
  addSummoners(c, out);
  return out;
}

/**
 * True when `e` is attacking the hero right now (striking or charging it).
 * A kiting foe steps away: chasing it would pull the hero off its route.
 */
function attackingHero(c: AutoCtx, e: Entity): boolean {
  const ai = c.world.get(e, Ai);
  if (!ai || ai.target !== c.hero) return false;
  return ai.state === "attack" || ai.state === "charge";
}

/**
 * The foes the hero engages. While it is leaving the level (descend, toTown:
 * see util.leaving) only those within LEAVE_FIGHT_RANGE or attacking it;
 * otherwise all of `foes`. Keeps the order of `foes`.
 */
export function engagedFoes(c: AutoCtx, foes: readonly Foe[]): readonly Foe[] {
  if (foes.length === 0 || !leaving(c)) return foes;
  return foes.filter((f) => f.dist <= LEAVE_FIGHT_RANGE || attackingHero(c, f.e));
}

/** Summoners are hunted this far (sub) behind their summons, even without line of sight. */
const SUMMONER_RANGE = 18 * TILE;

/**
 * Adds the living monster owner of every summon in `foes` (when it is not
 * there yet and within SUMMONER_RANGE): summons give no XP, and their
 * owner keeps raising more, so the summoner is the real target.
 */
function addSummoners(c: AutoCtx, foes: Foe[]): void {
  const { world, reg } = c;
  const n = foes.length;
  for (let i = 0; i < n; i++) {
    const f = foes[i]!;
    if (f.rarity !== "summon") continue;
    const owner = world.get(f.e, Summoned)?.owner ?? 0;
    if (owner === 0 || foes.some((x) => x.e === owner)) continue;
    if (!world.exists(owner) || world.has(owner, Dead)) continue;
    if (world.get(owner, Faction)?.team !== "monster") continue;
    const p = world.get(owner, Pos);
    const life = world.get(owner, Life);
    if (!p || (life && life.hp <= 0)) continue;
    const dist = isqrt(d2To(c, p.x, p.y));
    if (dist > SUMMONER_RANGE) continue;
    const m = world.get(owner, Monster);
    const proto = m ? reg.get<MonsterProto>(KIND.monster, m.proto) : undefined;
    foes.push({
      e: owner,
      x: p.x,
      y: p.y,
      dist,
      behaviour: proto?.behaviour ?? "summoner",
      rarity: m?.rarity ?? "normal",
      melee: proto ? proto.keepDistance === 0 : false,
      name: m?.name ?? "enemy",
    });
  }
}

/**
 * Target score (sub units, lowest wins): distance + 4 tiles for a summon
 * farther than 2 tiles (a boss's phase minion: + BOSS_SUMMON_PENALTY instead
 * when it fights in melee, - BOSS_SHOOTER_BONUS at any distance for a ranged hero
 * when it shoots) - 6 tiles for an exploder within 4 tiles - 3 for
 * casters/summoners - BOSS_BONUS for bosses (- 2 for uniques) - 2 for the
 * current focus. Ties go to the lower entity id.
 */
export function targetScore(c: AutoCtx, f: Foe): number {
  let s = f.dist;
  // Summons give no XP: only fight them when they are in the way.
  if (f.rarity === "summon") {
    const phaseMinion = bossSummon(c, f.e);
    // A melee phase minion within 2 tiles is fought like any foe: it body-blocks the way to
    // the boss, and walking past it only feeds the stuck detector.
    if (phaseMinion && f.melee) {
      if (f.dist > 2 * TILE) s += BOSS_SUMMON_PENALTY;
    } else if (phaseMinion && rangedHero(c)) s -= BOSS_SHOOTER_BONUS;
    else if (f.dist > 2 * TILE) s += 4 * TILE;
  }
  if (f.behaviour === "exploder" && f.dist <= 4 * TILE) s -= 6 * TILE;
  if (f.behaviour === "caster" || f.behaviour === "summoner") s -= 3 * TILE;
  if (f.rarity === "boss" || f.behaviour === "boss") s -= BOSS_BONUS;
  else if (f.rarity === "unique") s -= 2 * TILE;
  if (f.e === c.st.focus) s -= 2 * TILE;
  return s;
}

/**
 * Score bonus (sub) of a boss. Its body is wider than a minion's (its
 * centre is farther away at the same gap), and a melee hero that swung at
 * whatever stood closest spent half its swings on the boss's minions
 * (warrior vs Skarn: 147 of 484 swings hit the boss).
 */
export const BOSS_BONUS = 4 * TILE;
/**
 * Score penalty (sub) of a boss's melee phase minion (a summon whose owner
 * is a boss) farther than 2 tiles, in place of the normal summon's 4 tiles:
 * it gives no XP, dies with its timer, and every swing at it is one the
 * boss does not take. The hero still fights it when the boss is out of
 * reach, and like any foe when it is within 2 tiles (body-blocking).
 */
export const BOSS_SUMMON_PENALTY = 6 * TILE;
/**
 * Score bonus (sub) of a boss's ranged phase minion for a ranged hero: left
 * alone, Vessa's ash seers dealt a third of the damage that killed a
 * level-19 rogue with Vessa at 6 % life, and they die to one or two shots. A
 * melee hero keeps the normal summon rule (the casters flee from melee).
 */
export const BOSS_SHOOTER_BONUS = 8 * TILE;

/** True for a hero that fights at range: a projectile weapon, or a caster class. */
function rangedHero(c: AutoCtx): boolean {
  if ((c.world.get(c.hero, CombatStats)?.attackProjectile ?? "") !== "") return true;
  return (c.world.get(c.hero, HeroStats)?.primary ?? c.classProto?.primary) === "mag";
}

/** True for a summon whose owner is a living boss. */
function bossSummon(c: AutoCtx, e: Entity): boolean {
  const owner = c.world.get(e, Summoned)?.owner ?? 0;
  if (owner === 0 || c.world.has(owner, Dead)) return false;
  return c.world.get(owner, Monster)?.rarity === "boss";
}

export function pickTarget(c: AutoCtx, foes: readonly Foe[]): Foe {
  let best = foes[0]!;
  let bestS = targetScore(c, best);
  for (let i = 1; i < foes.length; i++) {
    const s = targetScore(c, foes[i]!);
    if (s < bestS) {
      best = foes[i]!;
      bestS = s;
    }
  }
  return best;
}

export interface SkillOption {
  id: string;
  proto: SkillProto;
  rank: number;
  cost: number;
  /** Cast range (sub); basic skills use CombatStats.attackRange. */
  range: number;
  ready: boolean;
  basic: boolean;
}

function isBasic(p: SkillProto): boolean {
  return p.ai.tags.includes("basic") || (p.shape === "melee" && p.range === 0);
}

/** Known skills of the bar (deduplicated, in slot order). */
export function barSkills(c: AutoCtx): SkillOption[] {
  const { world, reg } = c;
  const bar = world.get(c.hero, SkillBar);
  const book = world.get(c.hero, SkillBook);
  if (!bar || !book) return [];
  const stats = world.get(c.hero, CombatStats);
  const allSkills = world.get(c.hero, HeroStats)?.allSkills ?? 0;
  const out: SkillOption[] = [];
  for (const id of bar.slots) {
    if (id === null || out.some((o) => o.id === id)) continue;
    const known = book.ranks.find((r) => r.skill === id);
    if (!known || known.rank < 1) continue;
    const proto = reg.get<SkillProto>(KIND.skill, id);
    if (!proto) continue;
    const rank = effectiveRank(proto, known.rank, allSkills);
    const cd = book.cooldowns.find((x) => x.skill === id);
    out.push({
      id,
      proto,
      rank,
      // Wave A: talents change mana costs (skill modifiers).
      cost: effectiveManaCost(proto, rank, skillModsOf(world, reg, c.hero, id)),
      range: proto.range === 0 ? (stats?.attackRange ?? 400) : proto.range,
      ready: !cd || cd.readyAt <= c.tick,
      basic: isBasic(proto),
    });
  }
  return out;
}

/** A basic attack the hero knows even when it is not on the bar. */
function fallbackBasic(c: AutoCtx): SkillOption | null {
  const book = c.world.get(c.hero, SkillBook);
  if (!book) return null;
  const stats = c.world.get(c.hero, CombatStats);
  for (const r of book.ranks) {
    if (r.rank < 1) continue;
    const proto = c.reg.get<SkillProto>(KIND.skill, r.skill);
    if (!proto || proto.users !== "hero" || !isBasic(proto)) continue;
    return {
      id: r.skill,
      proto,
      rank: r.rank,
      cost: effectiveManaCost(proto, r.rank, skillModsOf(c.world, c.reg, c.hero, r.skill)),
      range: proto.range === 0 ? (stats?.attackRange ?? 400) : proto.range,
      ready: true,
      basic: true,
    };
  }
  return null;
}

export type FightAction =
  | { kind: "cast"; skill: string; target: Entity; x: number; y: number; why: string }
  | { kind: "move"; tx: number; ty: number; why: string };

function hasTag(o: SkillOption, ...tags: string[]): boolean {
  return o.proto.ai.tags.some((t) => tags.includes(t));
}

/** Perpendicular margin (sub) of a clear shot: projectiles must not clip wall corners. */
const SHOT_MARGIN = 64;

/** Line of sight wide enough for a projectile: the centre line and two parallel lines. */
export function clearShot(c: AutoCtx, tx: number, ty: number): boolean {
  if (!lineOfSight(c.map, c.hx, c.hy, tx, ty)) return false;
  const [ox, oy] = scaleTo(-(ty - c.hy), tx - c.hx, SHOT_MARGIN);
  return (
    lineOfSight(c.map, c.hx + ox, c.hy + oy, tx + ox, ty + oy) &&
    lineOfSight(c.map, c.hx - ox, c.hy - oy, tx - ox, ty - oy)
  );
}

function shoots(c: AutoCtx, o: SkillOption): boolean {
  if (o.proto.shape === "projectile") return true;
  return o.basic && (c.world.get(c.hero, CombatStats)?.attackProjectile ?? "") !== "";
}

/** Casts at the target, or steps toward it first when a projectile would hit a wall. */
function castOrLineUp(c: AutoCtx, o: SkillOption, t: Foe, why: string): FightAction {
  if (o.proto.target !== "self" && t.dist > 384 && shoots(c, o) && !clearShot(c, t.x, t.y))
    return { kind: "move", tx: t.x >> 8, ty: t.y >> 8, why: "line up" };
  return castAt(c, o, t, why);
}

function castAt(c: AutoCtx, o: SkillOption, t: Foe, why: string): FightAction {
  if (o.proto.target === "self")
    return { kind: "cast", skill: o.id, target: 0, x: c.hx, y: c.hy, why };
  // Attack shapes aimed at a point keep the target entity, so combat aims at
  // where it is when the skill fires (a point alone lets moving foes dodge).
  const aimed = o.proto.shape === "projectile" || o.proto.shape === "aoeTarget";
  if (o.proto.target === "point" && !aimed)
    return { kind: "cast", skill: o.id, target: 0, x: t.x, y: t.y, why };
  return { kind: "cast", skill: o.id, target: t.e, x: t.x, y: t.y, why };
}

function countWithin(foes: readonly Foe[], x: number, y: number, r: number): number {
  let n = 0;
  const r2 = r * r;
  for (const f of foes) {
    const dx = f.x - x;
    const dy = f.y - y;
    if (dx * dx + dy * dy <= r2) n++;
  }
  return n;
}

/** Enemies an area skill would hit when aimed at `t`. */
export function aoeCount(c: AutoCtx, o: SkillOption, foes: readonly Foe[], t: Foe): number {
  const p = o.proto;
  switch (p.shape) {
    case "nova":
    case "pulse":
      return countWithin(foes, c.hx, c.hy, p.radius ?? 2 * TILE);
    case "aoeTarget":
      return p.target === "self"
        ? countWithin(foes, c.hx, c.hy, p.radius ?? 2 * TILE)
        : countWithin(foes, t.x, t.y, p.radius ?? 2 * TILE);
    case "projectile": {
      const r = p.projectile?.explodeRadius ?? ((p.projectile?.count ?? 1) > 1 ? 3 * TILE : 0);
      return r > 0 ? countWithin(foes, t.x, t.y, r) : 1;
    }
    case "chain":
      return countWithin(foes, t.x, t.y, p.chain?.range ?? 4 * TILE);
    case "arc": {
      const aim = angleOf(t.x - c.hx, t.y - c.hy);
      const reach = o.range + 128;
      let n = 0;
      for (const f of foes) {
        if (f.dist > reach) continue;
        if (angleDiff(angleOf(f.x - c.hx, f.y - c.hy), aim) <= (p.arc ?? 8)) n++;
      }
      return n;
    }
    default:
      return countWithin(foes, t.x, t.y, p.radius ?? 2 * TILE);
  }
}

function statusActive(c: AutoCtx, status: string): boolean {
  const s = c.world.get(c.hero, Statuses);
  return s !== undefined && s.list.some((x) => x.id === status && x.until > c.tick);
}

/** True while the skill's status runs on `e` for more than a quarter of its duration. */
function dotRunning(c: AutoCtx, e: Entity, p: SkillProto): boolean {
  const st = p.status;
  if (!st) return false;
  const list = c.world.get(e, Statuses)?.list ?? [];
  return list.some((x) => x.id === st.id && x.until - c.tick > st.duration / 4);
}

function summonsAlive(c: AutoCtx, monster: string): number {
  let n = 0;
  for (const e of c.world.query(Summoned, Monster)) {
    if (c.world.read(e, Summoned).owner !== c.hero || c.world.has(e, Dead)) continue;
    if (c.world.read(e, Monster).proto === monster) n++;
  }
  return n;
}

/** A walkable tile about `len` sub away from (fx, fy) through the hero, with line of sight, or null. */
export function awayTile(
  c: AutoCtx,
  fx: number,
  fy: number,
  len: number,
): { x: number; y: number } | null {
  const base = fx === c.hx && fy === c.hy ? 0 : angleOf(c.hx - fx, c.hy - fy);
  for (const off of [0, 4, -4, 8, -8, 12, -12, 16, -16]) {
    const [dx, dy] = angleVec(base + off, len);
    const px = c.hx + dx;
    const py = c.hy + dy;
    const tx = px >> 8;
    const ty = py >> 8;
    if (!walkableAt(c.map, tx, ty)) continue;
    if (!lineOfSight(c.map, c.hx, c.hy, (tx << 8) + 128, (ty << 8) + 128)) continue;
    return { x: tx, y: ty };
  }
  return null;
}

/**
 * Element a skill's damage lands as: its own `damage` element when it has
 * one, else the hero's weapon element (weapon-percent skills and attacks).
 * Null for skills that deal no damage.
 */
function skillElement(c: AutoCtx, p: SkillProto): Element | null {
  const d = p.damage;
  if (d && (d.min > 0 || d.max > 0)) return d.element;
  if (p.weaponPct > 0) return c.world.get(c.hero, CombatStats)?.attackElement ?? "phys";
  return null;
}

/**
 * Priority points a resist costs a damage skill: one per 20 % (a fire bolt
 * into a 75 % fire-resistant boss drops 3 points), so a hero with an
 * unresisted skill of about the same priority uses that one instead.
 */
export function resistPenalty(c: AutoCtx, p: SkillProto, target: Entity): number {
  const el = skillElement(c, p);
  if (el === null || el === "phys") return 0;
  const cs = c.world.get(target, CombatStats);
  if (!cs) return 0;
  return Math.max(0, Math.floor(resistOf(cs, el) / 20));
}

/**
 * True while an area skill may be spent on a single target: it is tagged for
 * single targets or ranged use, the target is a boss (a boss fight wants
 * every point of damage), or the hero keeps at least half its mana after the
 * cast. Melee area skills (cleave, whirl) otherwise drain a small mana pool
 * that Rallying Cry and Mend need (warrior, 8 seeds x 36 000 ticks of Auto:
 * 34 -> 18 deaths with the mana kept). Champions and uniques do not count:
 * spending on them doubled the warrior's deaths again.
 */
function singleUseOk(o: SkillOption, t: Foe, mp: number, maxMp: number): boolean {
  if (!hasTag(o, "aoe") || hasTag(o, "single", "ranged") || t.rarity === "boss") return true;
  return (mp - o.cost) * 2 >= maxMp;
}

/** Decides what to do against `target` this tick (null = nothing usable). */
export function chooseAction(
  c: AutoCtx,
  foes: readonly Foe[],
  target: Foe,
  wasFighting = true,
): FightAction | null {
  const opts = barSkills(c).filter((o) => o.ready);
  const mana = c.world.get(c.hero, Mana);
  const mp = mana?.mp ?? 0;
  const reserve = mana ? pct(mana.max, c.cfg.manaReservePct) : 0;
  const afford = (o: SkillOption): boolean => o.cost === 0 || mp - o.cost >= reserve;
  const life = lifePct(c);
  const best = (list: SkillOption[]): SkillOption | null => {
    let b: SkillOption | null = null;
    let bp = 0;
    for (const o of list) {
      const p = o.proto.ai.priority - resistPenalty(c, o.proto, target.e);
      if (!b || p > bp) {
        b = o;
        bp = p;
      }
    }
    return b;
  };

  // Heal (emergency: may dip into the reserve).
  if (life < 60) {
    const heal = best(opts.filter((o) => hasTag(o, "heal") && mp >= o.cost));
    if (heal) return castAt(c, heal, target, "heal");
  }
  // Buff when not active and enemies are close.
  if (foes.some((f) => f.dist <= 6 * TILE)) {
    const buff = best(
      opts.filter(
        (o) =>
          hasTag(o, "buff") &&
          afford(o) &&
          (o.proto.buff === undefined || !statusActive(c, o.proto.buff.status)),
      ),
    );
    if (buff) return castAt(c, buff, target, "buff");
  }
  // Summon while below the cap.
  const summon = best(
    opts.filter(
      (o) =>
        hasTag(o, "summon") &&
        afford(o) &&
        o.proto.summon !== undefined &&
        summonsAlive(c, o.proto.summon.monster) < o.proto.summon.max,
    ),
  );
  if (summon) return castOrLineUp(c, summon, target, "summon");
  // Area skill when enough enemies are inside its area.
  const aoe = best(
    opts.filter(
      (o) =>
        hasTag(o, "aoe") &&
        !hasTag(o, "heal", "buff", "summon") &&
        afford(o) &&
        aoeCount(c, o, foes, target) >= (o.proto.ai.minTargets ?? 2),
    ),
  );
  if (aoe) return castOrLineUp(c, aoe, target, "aoe");

  // Best single-target skill (decides whether we fight at range). A damage-over-time
  // skill is skipped while its status still runs on the target (it does not stack).
  const single = best(
    opts.filter(
      (o) =>
        !o.basic &&
        afford(o) &&
        !hasTag(o, "heal", "buff", "summon", "mobility") &&
        !(hasTag(o, "dot") && dotRunning(c, target.e, o.proto)) &&
        (hasTag(o, "single", "ranged", "melee") || !hasTag(o, "aoe")) &&
        singleUseOk(o, target, mp, mana?.max ?? 0),
    ),
  );
  const basic = opts.find((o) => o.basic) ?? fallbackBasic(c);
  const attack = single ?? basic;
  const stats = c.world.get(c.hero, CombatStats);
  const ranged =
    (stats !== undefined && stats.attackProjectile !== "") ||
    (attack !== null && attack.range >= 4 * TILE);

  // Mobility: close the gap (melee) or escape when swarmed (ranged).
  const mobility = opts.filter((o) => hasTag(o, "mobility") && afford(o));
  if (!ranged && target.dist > 5 * TILE) {
    const dash = best(mobility.filter((o) => o.proto.target === "enemy" && target.dist <= o.range));
    if (dash) return castAt(c, dash, target, "close in");
  }
  if (ranged && life < 50) {
    const adjacent = foes.filter((f) => f.dist <= 384);
    if (adjacent.length >= 2) {
      const esc = best(mobility.filter((o) => o.proto.target === "point"));
      if (esc) {
        let sx = 0;
        let sy = 0;
        for (const f of adjacent) {
          sx += f.x;
          sy += f.y;
        }
        const away = awayTile(
          c,
          Math.trunc(sx / adjacent.length),
          Math.trunc(sy / adjacent.length),
          6 * TILE,
        );
        if (away) {
          return {
            kind: "cast",
            skill: esc.id,
            target: 0,
            x: (away.x << 8) + 128,
            y: (away.y << 8) + 128,
            why: "escape",
          };
        }
      }
    }
  }

  // Ranged heroes kite melee enemies that got within 2 tiles (at most every 20 ticks).
  if (ranged) {
    let near: Foe | null = null;
    for (const f of foes)
      if (f.melee && f.dist <= 4 * TILE && (!near || f.dist < near.dist)) near = f;
    const cur = currentIntent(c);
    if (
      near &&
      wasFighting &&
      cur &&
      cur.kind === "move" &&
      cur.source === "auto" &&
      c.tick - cur.at < 20
    ) {
      return { kind: "move", tx: cur.x, ty: cur.y, why: "kite" };
    }
    if (near && near.dist <= 2 * TILE) {
      const away = awayTile(c, near.x, near.y, 4 * TILE);
      if (away) return { kind: "move", tx: away.x, ty: away.y, why: "kite" };
    }
  }

  if (attack) return castOrLineUp(c, attack, target, attack === basic ? "attack" : "skill");
  return null;
}

/** True while a stun status is active on the hero. */
export function isStunned(c: AutoCtx): boolean {
  const s = c.world.get(c.hero, Statuses);
  if (!s) return false;
  for (const x of s.list) {
    if (x.until <= c.tick) continue;
    if (c.reg.get<StatusProto>(KIND.status, x.id)?.kind === "stun") return true;
  }
  return false;
}

/**
 * Step 5: fight the best of `targets` (default: every foe). `foes` is the
 * whole scan (area counts, buffs and kiting see every foe in range).
 */
export function fightStep(c: AutoCtx, foes: readonly Foe[], targets: readonly Foe[] = foes): void {
  const st = c.st;
  const wasFighting = st.plan === "fight";
  const target = pickTarget(c, targets);
  if (target.e !== st.focus || !wasFighting || st.lastTileX !== c.tx || st.lastTileY !== c.ty) {
    st.lastTileX = c.tx;
    st.lastTileY = c.ty;
    st.stuck = 0;
  } else if (++st.stuck >= STUCK_TICKS) {
    // Neither moving nor casting for a while: the target is unreachable. Ignore its spot.
    addIgnore(st, target.x >> 8, target.y >> 8);
    st.focus = 0;
    st.stuck = 0;
    // Given up: no fight hysteresis for it.
    st.foeAt = c.tick - FIGHT_LINGER_TICKS;
    stopIntent(c);
    return;
  }
  st.focus = target.e;
  setPlan(c, "fight", target.name);
  const act = chooseAction(c, foes, target, wasFighting);
  if (!act) return;
  if (act.kind === "move") moveTo(c, act.tx, act.ty);
  else
    setIntent(c, {
      kind: "skill",
      skill: act.skill,
      target: act.target,
      x: act.x,
      y: act.y,
      repeat: false,
    });
}

/**
 * Shared duel maths and helpers: stats, effectiveness, damage, one strike,
 * XP and level-ups, and creating creature entities. Integer arithmetic only
 * (percent units), so every client computes the same numbers.
 */
import {
  ActionError,
  type Entity,
  type FrozenRegistry,
  type SimContext,
  type World,
} from "@gamez/kernel";
import {
  MAX_LEVEL,
  Mon,
  type CreatureDef,
  type ElementDef,
  type MonState,
  type MoveDef,
} from "./schema.ts";

/** Stat of a species at a level: base scaled by 100% + 8% per level. */
export function statAt(base: number, level: number): number {
  return Math.floor((base * (100 + level * 8)) / 100);
}

export function maxHpAt(species: CreatureDef, level: number): number {
  return statAt(species.stats.hp, level);
}

/** XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  return level * 10;
}

/** Damage multiplier in percent for an attack of `attack` element hitting `defend`. */
export function effectiveness(reg: FrozenRegistry, attack: string, defend: string): 150 | 100 | 50 {
  const el = reg.require<ElementDef>("duel.element", attack);
  if (el.strong.includes(defend)) return 150;
  if (el.weak.includes(defend)) return 50;
  return 100;
}

/**
 * Gen-1 style damage with an integer roll (85..100) and effectiveness in
 * percent. The divisor keeps a typical hit at roughly a fifth of a starter's HP.
 */
export function damageFor(
  level: number,
  power: number,
  atk: number,
  def: number,
  multiplier: number,
  roll: number,
): number {
  const base = Math.floor(Math.floor(((2 * level + 10) * power * atk) / def) / 120) + 2;
  return Math.max(1, Math.floor((base * multiplier * roll) / 10000));
}

export function speciesOf(reg: FrozenRegistry, mon: MonState): CreatureDef {
  return reg.require<CreatureDef>("duel.creature", mon.species);
}

export function moveOf(reg: FrozenRegistry, moveId: string): MoveDef {
  return reg.require<MoveDef>("duel.move", moveId);
}

/** Creates a creature entity at full HP and PP. */
export function newMon(
  world: World,
  ctx: SimContext,
  speciesId: string,
  level: number,
  owner: MonState["owner"],
  team: boolean,
  slot: number,
): Entity {
  const species = ctx.registry.require<CreatureDef>("duel.creature", speciesId);
  const maxHp = maxHpAt(species, level);
  const e = world.create();
  world.add(e, Mon, {
    species: speciesId,
    level,
    xp: 0,
    hp: maxHp,
    maxHp,
    pp: species.moves.map((m) => moveOf(ctx.registry, m).pp),
    owner,
    team,
    slot,
  });
  return e;
}

/** Restores HP and PP of a creature entity. */
export function restore(world: World, ctx: SimContext, e: Entity): void {
  const m = world.read(e, Mon);
  const species = speciesOf(ctx.registry, m);
  m.hp = m.maxHp;
  m.pp = species.moves.map((id) => moveOf(ctx.registry, id).pp);
}

/** Moves the attacker's move id to a slot in `pp`, or null when the creature does not know it. */
export function moveSlot(reg: FrozenRegistry, mon: MonState, moveId: string): number | null {
  const idx = speciesOf(reg, mon).moves.indexOf(moveId);
  return idx < 0 ? null : idx;
}

/** A random move with PP left, drawn with ctx.rng; null when none is usable. */
export function pickUsableMove(world: World, ctx: SimContext, e: Entity): string | null {
  const mon = world.read(e, Mon);
  const usable = speciesOf(ctx.registry, mon).moves.filter((_, i) => (mon.pp[i] ?? 0) > 0);
  return usable.length === 0 ? null : ctx.rng.pick(usable);
}

/**
 * One creature strikes another with a known move. Spends PP, rolls accuracy
 * and variance, applies damage and drain, and emits every step.
 */
export function strike(
  world: World,
  ctx: SimContext,
  attacker: Entity,
  defender: Entity,
  moveId: string,
): void {
  const reg = ctx.registry;
  const a = world.read(attacker, Mon);
  const d = world.read(defender, Mon);
  const aSpecies = speciesOf(reg, a);
  const dSpecies = speciesOf(reg, d);
  const idx = moveSlot(reg, a, moveId);
  if (idx === null) throw new Error(`${aSpecies.name} does not know ${moveId}`);
  const move = moveOf(reg, moveId);
  const pp = a.pp[idx] ?? 0;
  if (pp <= 0) throw new ActionError("no_pp", `${move.name} has no PP left`);
  a.pp[idx] = pp - 1;

  const base = { side: a.owner, mon: attacker, name: aSpecies.name, moveId, move: move.name };
  ctx.emit({ type: "duel.moveUsed", ...base });
  if (!ctx.rng.chance(move.accuracy / 100)) {
    ctx.emit({ type: "duel.missed", ...base });
    return;
  }

  const multiplier = effectiveness(reg, move.element, dSpecies.element);
  if (multiplier !== 100) ctx.emit({ type: "duel.effectiveness", multiplier });
  const roll = ctx.rng.int(85, 100);
  const amount = damageFor(
    a.level,
    move.power,
    statAt(aSpecies.stats.atk, a.level),
    statAt(dSpecies.stats.def, d.level),
    multiplier,
    roll,
  );
  d.hp = Math.max(0, d.hp - amount);
  ctx.emit({
    type: "duel.damage",
    side: d.owner,
    target: defender,
    name: dSpecies.name,
    amount,
    hp: d.hp,
    maxHp: d.maxHp,
  });

  if (move.drain > 0) {
    const healed = Math.min(a.maxHp - a.hp, Math.floor((amount * move.drain) / 100));
    if (healed > 0) {
      a.hp += healed;
      ctx.emit({
        type: "duel.drained",
        mon: attacker,
        name: aSpecies.name,
        amount: healed,
        hp: a.hp,
        maxHp: a.maxHp,
      });
    }
  }

  if (d.hp === 0) {
    ctx.emit({ type: "duel.fainted", side: d.owner, mon: defender, name: dSpecies.name });
  }
}

/** Adds XP to a creature and applies any level-ups (HP grows by the max-HP difference). */
export function gainXp(world: World, ctx: SimContext, e: Entity, amount: number): void {
  const m = world.read(e, Mon);
  const species = speciesOf(ctx.registry, m);
  m.xp += amount;
  ctx.emit({ type: "duel.xpGained", mon: e, name: species.name, amount });
  while (m.level < MAX_LEVEL && m.xp >= xpToNext(m.level)) {
    m.xp -= xpToNext(m.level);
    m.level += 1;
    const maxHp = maxHpAt(species, m.level);
    m.hp += maxHp - m.maxHp;
    m.maxHp = maxHp;
    ctx.emit({ type: "duel.levelUp", mon: e, name: species.name, level: m.level });
  }
  if (m.level >= MAX_LEVEL) m.xp = 0;
}

/**
 * classic.progression.regen (post 300): hero life and mana regeneration.
 * HeroStats.lifeRegen / manaRegen are per second x10; each tick adds
 * value * 5 thousandths, and every whole point is paid out (docs §6.2).
 */
import type { SystemDef, World } from "@gamez/kernel";
import { Dead, HeroStats, Life, Mana } from "../components.ts";
import { SYSTEM } from "../ids.ts";
import { heroOf } from "../resources.ts";

/** Thousandths of a point per tick for a x10-per-second rate. */
const ACC_PER_RATE = 5;
const ACC_ONE = 1000;

function regenLife(world: World, hero: number, rate: number): void {
  const l = world.read(hero, Life);
  if (l.hp >= l.max) {
    if (l.acc !== 0) world.update(hero, Life, { acc: 0 });
    return;
  }
  let acc = l.acc + Math.max(0, rate) * ACC_PER_RATE;
  let hp = l.hp;
  while (acc >= ACC_ONE && hp < l.max) {
    acc -= ACC_ONE;
    hp++;
  }
  if (hp >= l.max) acc = 0;
  if (hp !== l.hp || acc !== l.acc) world.update(hero, Life, { hp, acc });
}

function regenMana(world: World, hero: number, rate: number): void {
  const m = world.read(hero, Mana);
  if (m.mp >= m.max) {
    if (m.acc !== 0) world.update(hero, Mana, { acc: 0 });
    return;
  }
  let acc = m.acc + Math.max(0, rate) * ACC_PER_RATE;
  let mp = m.mp;
  while (acc >= ACC_ONE && mp < m.max) {
    acc -= ACC_ONE;
    mp++;
  }
  if (mp >= m.max) acc = 0;
  if (mp !== m.mp || acc !== m.acc) world.update(hero, Mana, { mp, acc });
}

export const progressionRegen: SystemDef = {
  ...SYSTEM.progressionRegen,
  run(world) {
    const hero = heroOf(world);
    if (hero === 0 || world.has(hero, Dead) || !world.has(hero, HeroStats)) return;
    const sheet = world.read(hero, HeroStats);
    regenLife(world, hero, sheet.lifeRegen);
    regenMana(world, hero, sheet.manaRegen);
  },
};

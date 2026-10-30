/**
 * Shared setup for the classic melee benches (party.ts, melee.ts): a party
 * on Full Idle in its first dungeon level, topped up to 300 awake monsters
 * whose life is raised so none die. Bench code, not sim code.
 */
import { createSim, type Entity, type LoadedMode, type Sim } from "@gamez/kernel";
import * as classic from "@gamez/mode-classic";

export const CLASSES = ["classic.warrior", "classic.rogue", "classic.sorcerer", "classic.warrior"];
export const NAMES = ["Brannoc", "Ysolde", "Corvin", "Maelis"];
export const MONSTERS = 300;
const BIG = 1_000_000;

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(`${what} failed`);
}

function setPurse(sim: Sim, gold: number): void {
  sim.world.update(classic.purseOf(sim.world), classic.Wallet, { gold });
}

/** Founder + recruits (bought slots, cheat gold), Full Idle. */
export function party(loaded: LoadedMode, size: number, seed: number): Sim {
  const sim = createSim(loaded, { seed });
  must(
    sim.dispatch(classic.ACTION.newHero, { classId: CLASSES[0], name: NAMES[0] }, null).ok,
    "newHero",
  );
  sim.step(2);
  const gold = sim.world.read(classic.purseOf(sim.world), classic.Wallet).gold;
  for (let i = 1; i < size; i++) {
    setPurse(sim, 1_000_000);
    must(sim.dispatch(classic.ACTION.partyBuySlot, {}, null).ok, "buySlot");
    must(
      sim.dispatch(classic.ACTION.partyRecruit, { classId: CLASSES[i], name: NAMES[i] }, null).ok,
      "recruit",
    );
    sim.step(2);
  }
  setPurse(sim, gold);
  must(sim.dispatch(classic.ACTION.setControl, { mode: "idle" }, null).ok, "setControl");
  return sim;
}

export function areaMonsters(sim: Sim): Entity[] {
  const d = classic.currentDepth(sim.world);
  return sim.world
    .query(classic.Monster, classic.Faction, classic.AreaTag)
    .filter(
      (e) =>
        sim.world.read(e, classic.AreaTag).depth === d &&
        sim.world.read(e, classic.Faction).team === "monster" &&
        !sim.world.has(e, classic.Dead),
    );
}

/** The party Idle in its first dungeon level, topped up to MONSTERS awake monsters. */
export function fight(loaded: LoadedMode, size: number, seed = 31): Sim {
  const sim = party(loaded, size, seed);
  for (let i = 0; i < 8000 && classic.currentDepth(sim.world) === 0; i++) sim.step(1);
  if (classic.currentDepth(sim.world) === 0) throw new Error("never left town");
  sim.step(40);
  const depth = classic.currentDepth(sim.world);
  const map = classic.getAreaMap(sim.world, sim.loaded.registry);
  const lp = sim.world.read(classic.actingLeaderOf(sim.world), classic.Pos);
  const lx = lp.x >> 8;
  const ly = lp.y >> 8;
  const taken = new Set<number>();
  for (const e of sim.world.query(classic.Pos, classic.AreaTag)) {
    if (sim.world.read(e, classic.AreaTag).depth !== depth) continue;
    const p = sim.world.read(e, classic.Pos);
    taken.add((p.y >> 8) * map.width + (p.x >> 8));
  }
  const existing = areaMonsters(sim);
  const level = existing.length > 0 ? sim.world.read(existing[0]!, classic.Monster).level : 1;
  let need = MONSTERS - existing.length;
  const ids = ["classic.monster.husk", "classic.monster.gnawling", "classic.monster.bonefletcher"];
  for (let r = 4; r <= 30 && need > 0; r++) {
    for (let y = ly - r; y <= ly + r && need > 0; y++) {
      for (let x = lx - r; x <= lx + r && need > 0; x++) {
        if (Math.max(Math.abs(x - lx), Math.abs(y - ly)) !== r || (x + y) % 2 !== 0) continue;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        const k = y * map.width + x;
        if (map.walkable[k] !== 1 || taken.has(k)) continue;
        taken.add(k);
        classic.busOf(sim.world).spawns.push({
          monster: ids[need % ids.length]!,
          x: classic.tileCenter(x),
          y: classic.tileCenter(y),
          depth,
          level,
          rarity: "normal",
          mods: [],
          pack: 900_000 + need,
          name: "",
          owner: 0,
          team: "monster",
          until: 0,
          awake: true,
        });
        need--;
      }
    }
  }
  sim.step(1);
  for (const e of areaMonsters(sim)) sim.world.update(e, classic.Life, { hp: BIG, max: BIG });
  sim.step(60);
  return sim;
}

/** Heals every standing hero (outside the timed step, so nobody leaves the fight). */
export function healAll(sim: Sim): void {
  for (const e of classic.partyMembers(sim.world)) {
    const l = sim.world.read(e, classic.Life);
    if (!sim.world.has(e, classic.Dead) && l.hp < l.max)
      sim.world.update(e, classic.Life, { hp: l.max });
  }
}

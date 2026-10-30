/**
 * Module "arena.core" (OWNER: T-arena-sim): the deterministic 1-D auto-battle.
 *
 *   action  arena.start {attacker, defender}  clamps both builds, spawns the fighters
 *   system  arena.shield.decay (pre)           shields lose 5 % a second
 *   system  arena.fight (update)               each living fighter acts once per tick;
 *                                              even ticks: attacker first
 *   system  arena.end (post)                   a fighter at 0 hp loses (both: draw);
 *                                              at ARENA_MAX_TICKS the higher hp % wins
 *
 * Each fighter acts at most once per tick: move toward the other when out of
 * reach of its best ready skill (or of its basic attack's reach), else use the
 * first ready skill, else a basic attack. Skills and basics share one attack
 * slot (one basic every `interval` ticks), so a skill replaces an attack and
 * never adds damage on top of the basics. A caster's basic reach is its
 * longest damaging skill range (see basicReachOf). DECISION (arena.core 1.1.0):
 * see docs/bench/2026-10-arena-balance.md. Integers only; ctx.rng for every
 * roll (AGENTS.md §6).
 */
import {
  ActionError,
  defineComponent,
  defineModule,
  type ActionDef,
  type SimContext,
  type SystemDef,
  type World,
} from "@gamez/kernel";
import {
  ARENA_MAX_TICKS,
  ARENA_START_ATTACKER,
  ARENA_START_DEFENDER,
  BASIC_POWER,
  BASIC_REACH,
} from "./constants.ts";
import { basicInterval, decayShield, hpPercent, strikeDamage, percentOf } from "./combat.ts";
import {
  clampBuild,
  FIGHTER_COMPONENT,
  MATCH_RESOURCE,
  RESULT_RESOURCE,
  type ArenaResult,
  type ClampedBuild,
  type FighterState,
  type MatchRefs,
  type SkillState,
} from "./model.ts";

export const Fighter = defineComponent<FighterState>(FIGHTER_COMPONENT);

type Side = "attacker" | "defender";

interface StartPayload {
  attacker: ClampedBuild;
  defender: ClampedBuild;
}

function otherSide(side: Side): Side {
  return side === "attacker" ? "defender" : "attacker";
}

function fighterOf(side: Side, x: number, b: ClampedBuild): FighterState {
  return {
    side,
    x,
    hp: b.maxHp,
    maxHp: b.maxHp,
    shield: 0,
    dmgMin: b.dmgMin,
    dmgMax: b.dmgMax,
    armor: b.armor,
    resist: b.resist,
    critPct: b.critPct,
    moveSpeed: b.moveSpeed,
    interval: basicInterval(b.attackRate),
    nextBasic: 0,
    skills: b.skills.map((s): SkillState => ({ ...s, readyAt: 0 })),
  };
}

const startAction: ActionDef<StartPayload> = {
  name: "arena.start",
  parse(_world: World, payload: unknown): StartPayload {
    if (typeof payload !== "object" || payload === null) {
      throw new ActionError("bad_payload", "expected {attacker, defender}");
    }
    const p = payload as Record<string, unknown>;
    const attacker = clampBuild(p.attacker);
    const defender = clampBuild(p.defender);
    if (!attacker || !defender) throw new ActionError("bad_build", "both builds are required");
    return { attacker, defender };
  },
  apply(world: World, p: StartPayload, ctx: SimContext): void {
    if (world.getResource<MatchRefs>(MATCH_RESOURCE)) {
      throw new ActionError("already_started", "the fight has started");
    }
    const attacker = world.create();
    world.add(attacker, Fighter, fighterOf("attacker", ARENA_START_ATTACKER, p.attacker));
    const defender = world.create();
    world.add(defender, Fighter, fighterOf("defender", ARENA_START_DEFENDER, p.defender));
    world.setResource<MatchRefs>(MATCH_RESOURCE, { attacker, defender });
    ctx.emit({ type: "arena.started", attacker, defender });
  },
};

/** Self-cast skills (heal, shield) need a reason: missing hp or no shield up. */
function castable(f: FighterState, s: SkillState): boolean {
  if (s.kind === "heal") return f.hp < f.maxHp;
  if (s.kind === "shield") return f.shield === 0;
  return true;
}

function withReady(skills: SkillState[], idx: number, readyAt: number): SkillState[] {
  return skills.map((s, i) => (i === idx ? { ...s, readyAt } : s));
}

/** One hit from the attacker entity onto the target entity. */
function hit(
  world: World,
  ctx: SimContext,
  attacker: number,
  target: number,
  targetSide: Side,
  power: number,
): void {
  const a = world.read(attacker, Fighter);
  const t = world.read(target, Fighter);
  const roll = ctx.rng.int(a.dmgMin, a.dmgMax);
  const crit = ctx.rng.chance(a.critPct / 100);
  const after = strikeDamage(roll, power, crit, t.armor, t.resist);
  const absorbed = Math.min(t.shield, after);
  const hp = Math.max(0, t.hp - (after - absorbed));
  world.update(target, Fighter, { hp, shield: t.shield - absorbed });
  ctx.emit({ type: "arena.hit", side: targetSide, amount: after, crit, absorbed, hp });
}

function advance(
  world: World,
  ctx: SimContext,
  me: number,
  other: number,
  side: Side,
  reach: number,
): void {
  const f = world.read(me, Fighter);
  const o = world.read(other, Fighter);
  const gap = Math.abs(o.x - f.x) - reach;
  const step = Math.min(f.moveSpeed, gap);
  world.update(me, Fighter, { x: o.x > f.x ? f.x + step : f.x - step });
  ctx.emit({ type: "arena.act", side, name: "Advance", skill: false });
}

function castSelf(world: World, ctx: SimContext, me: number, side: Side, idx: number): void {
  const f = world.read(me, Fighter);
  const s = f.skills[idx];
  if (!s) return;
  const skills = withReady(f.skills, idx, ctx.tick + s.cooldown);
  // A cast takes the attack slot (see act): the next basic waits one interval.
  const nextBasic = ctx.tick + f.interval;
  ctx.emit({ type: "arena.act", side, name: s.name, skill: true });
  if (s.kind === "heal") {
    const hp = Math.min(f.maxHp, f.hp + percentOf(f.maxHp, s.power));
    world.update(me, Fighter, { hp, skills, nextBasic });
    ctx.emit({ type: "arena.heal", side, amount: hp - f.hp });
  } else {
    const amount = percentOf(f.maxHp, s.power);
    world.update(me, Fighter, { shield: amount, skills, nextBasic });
    ctx.emit({ type: "arena.shield", side, amount });
  }
}

function castStrike(
  world: World,
  ctx: SimContext,
  me: number,
  other: number,
  side: Side,
  idx: number,
): void {
  const f = world.read(me, Fighter);
  const s = f.skills[idx];
  if (!s) return;
  world.update(me, Fighter, {
    skills: withReady(f.skills, idx, ctx.tick + s.cooldown),
    nextBasic: ctx.tick + f.interval,
  });
  ctx.emit({ type: "arena.act", side, name: s.name, skill: true });
  hit(world, ctx, me, other, otherSide(side), s.power);
}

/**
 * Reach of a fighter's basic attack, in tenths of a tile. Ranged builds have
 * no bow or staff in the arena build, so a build's longest damaging skill
 * reach stands in for its weapon: a caster shoots from its bolt's range.
 */
function basicReachOf(f: FighterState): number {
  let reach = BASIC_REACH;
  for (const s of f.skills) {
    if (s.kind !== "projectile" && s.kind !== "nova") continue;
    reach = Math.max(reach, s.range * 10);
  }
  return reach;
}

function act(world: World, ctx: SimContext, me: number, other: number, side: Side): void {
  const f = world.read(me, Fighter);
  const o = world.read(other, Fighter);
  const dist = Math.abs(o.x - f.x);
  // Skills and basic attacks share one attack slot: a basic attack is due every
  // `interval` ticks, and a skill cast takes that slot instead of the basic.
  // Skills therefore replace attacks rather than adding damage on top of them.
  const slotFree = f.nextBasic <= ctx.tick;
  const idx = slotFree ? f.skills.findIndex((s) => s.readyAt <= ctx.tick && castable(f, s)) : -1;
  const pick = idx >= 0 ? f.skills[idx] : undefined;
  if (pick) {
    if (pick.kind === "heal" || pick.kind === "shield") {
      castSelf(world, ctx, me, side, idx);
    } else if (dist > pick.range * 10) {
      advance(world, ctx, me, other, side, pick.range * 10);
    } else {
      castStrike(world, ctx, me, other, side, idx);
    }
    return;
  }
  const reach = basicReachOf(f);
  if (dist > reach) {
    advance(world, ctx, me, other, side, reach);
    return;
  }
  if (slotFree) {
    world.update(me, Fighter, { nextBasic: ctx.tick + f.interval });
    ctx.emit({ type: "arena.act", side, name: "Attack", skill: false });
    hit(world, ctx, me, other, otherSide(side), BASIC_POWER);
  }
}

const shieldSystem: SystemDef = {
  id: "arena.shield.decay",
  stage: "pre",
  run(world: World): void {
    if (world.getResource<ArenaResult>(RESULT_RESOURCE)) return;
    for (const e of world.query(Fighter)) {
      const f = world.read(e, Fighter);
      if (f.shield > 0) world.update(e, Fighter, { shield: decayShield(f.shield) });
    }
  },
};

const fightSystem: SystemDef = {
  id: "arena.fight",
  stage: "update",
  run(world: World, ctx: SimContext): void {
    if (world.getResource<ArenaResult>(RESULT_RESOURCE)) return;
    const m = world.getResource<MatchRefs>(MATCH_RESOURCE);
    if (!m) return;
    // Both fighters act in the tick they were alive at its start: a blow that
    // kills in this tick still gets its answer (mutual kill = draw).
    const aliveA = world.read(m.attacker, Fighter).hp > 0;
    const aliveD = world.read(m.defender, Fighter).hp > 0;
    const attackerFirst = ctx.tick % 2 === 0;
    const order: [number, number, Side, boolean][] = attackerFirst
      ? [
          [m.attacker, m.defender, "attacker", aliveA],
          [m.defender, m.attacker, "defender", aliveD],
        ]
      : [
          [m.defender, m.attacker, "defender", aliveD],
          [m.attacker, m.defender, "attacker", aliveA],
        ];
    for (const [me, other, side, alive] of order) {
      if (alive) act(world, ctx, me, other, side);
    }
  },
};

const endSystem: SystemDef = {
  id: "arena.end",
  stage: "post",
  run(world: World, ctx: SimContext): void {
    if (world.getResource<ArenaResult>(RESULT_RESOURCE)) return;
    const m = world.getResource<MatchRefs>(MATCH_RESOURCE);
    if (!m) return;
    const a = world.read(m.attacker, Fighter);
    const d = world.read(m.defender, Fighter);
    const ticks = ctx.tick + 1;
    let winner: ArenaResult["winner"];
    if (a.hp <= 0 || d.hp <= 0) {
      winner = a.hp <= 0 && d.hp <= 0 ? "draw" : a.hp <= 0 ? "defender" : "attacker";
    } else if (ticks >= ARENA_MAX_TICKS) {
      const pa = hpPercent(a.hp, a.maxHp);
      const pd = hpPercent(d.hp, d.maxHp);
      winner = pa > pd ? "attacker" : pd > pa ? "defender" : "draw";
    } else {
      return;
    }
    world.setResource<ArenaResult>(RESULT_RESOURCE, { winner, ticks });
    ctx.emit({ type: "arena.end", winner, ticks });
  },
};

export const arenaCore = defineModule({
  id: "arena.core",
  version: "1.1.0",
  actions: [startAction],
  systems: [shieldSystem, fightSystem, endSystem],
});

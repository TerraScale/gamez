/**
 * Statuses runtime (docs/design/classic.md §7.3): applyStatus() and the
 * classic.combat.statuses system (update 600).
 *
 * - Statuses.list is kept sorted by status id; re-applying keeps the longer
 *   `until` and the higher `power`.
 * - dot: `power` is the total damage over the duration, dealt every
 *   StatusProto.every ticks as HitRequests with dot: true; whatever is left at
 *   expiry is dealt on the last tick, so the total always equals the power.
 * - Applying a stun interrupts the target's cast, dash and pending order.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { pushHit } from "../bus.ts";
import {
  AreaTag,
  CastOrder,
  Casting,
  Dash,
  Dead,
  Statuses,
  type StatusInstance,
} from "../components.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { currentDepth } from "../resources.ts";
import { statusProto } from "../core/units.ts";

function byId(a: StatusInstance, b: StatusInstance): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Applies (or refreshes) a status on `target`. Unknown status ids and
 * non-positive durations are ignored. Returns true when applied.
 */
export function applyStatus(
  world: World,
  ctx: SimContext,
  target: Entity,
  s: { id: string; duration: number; power: number },
  source: Entity,
): boolean {
  const proto = statusProto(ctx.registry, s.id);
  if (!proto || s.duration <= 0 || !world.exists(target)) return false;
  let st = world.get(target, Statuses);
  if (!st) {
    world.add(target, Statuses, { list: [] });
    st = world.read(target, Statuses);
  }
  const until = ctx.tick + s.duration;
  const power = Math.max(0, Math.floor(s.power));
  const every = Math.max(1, proto.every ?? 10);
  const cur = st.list.find((x) => x.id === s.id && x.until > ctx.tick);
  if (cur) {
    cur.until = Math.max(cur.until, until);
    if (power > cur.power) {
      if (proto.kind === "dot") cur.remaining = Math.max(cur.remaining, power);
      cur.power = power;
      cur.source = source;
    }
  } else {
    const list = st.list.filter((x) => x.id !== s.id);
    list.push({
      id: s.id,
      until,
      power,
      source,
      nextAt: proto.kind === "dot" ? ctx.tick + every : until,
      remaining: proto.kind === "dot" ? power : 0,
    });
    list.sort(byId);
    st.list = list;
  }
  if (proto.kind === "stun") {
    if (world.has(target, Casting)) world.remove(target, Casting);
    if (world.has(target, CastOrder)) world.remove(target, CastOrder);
    if (world.has(target, Dash)) world.remove(target, Dash);
  }
  const applied = st.list.find((x) => x.id === s.id)!;
  emit(ctx, { type: "classic.status", target, status: s.id, until: applied.until });
  return true;
}

function dotHit(world: World, s: StatusInstance, target: Entity, amount: number, element: string) {
  const damage = { phys: 0, fire: 0, cold: 0, lightning: 0, poison: 0 };
  damage[element as keyof typeof damage] = amount;
  pushHit(world, {
    source: s.source,
    target,
    skill: s.id,
    damage,
    canMiss: false,
    crit: false,
    dot: true,
    statuses: [],
    knockback: 0,
  });
}

export const statusesSystem: SystemDef = {
  ...SYSTEM.combatStatuses,
  run(world, ctx) {
    const units = world.query(Statuses, AreaTag);
    if (units.length === 0) return;
    const depth = currentDepth(world);
    const tick = ctx.tick;
    for (const e of units) {
      const st = world.read(e, Statuses);
      if (st.list.length === 0) continue;
      if (world.read(e, AreaTag).depth !== depth) continue;
      const dead = world.has(e, Dead);
      let expired = false;
      for (const s of st.list) {
        const proto = statusProto(ctx.registry, s.id);
        if (!dead && proto?.kind === "dot" && s.remaining > 0) {
          const every = Math.max(1, proto.every ?? 10);
          const element = proto.element ?? "phys";
          if (s.until <= tick) {
            dotHit(world, s, e, s.remaining, element);
            s.remaining = 0;
          } else if (tick >= s.nextAt) {
            const ticksLeft = Math.floor((s.until - s.nextAt) / every) + 1;
            const amount = Math.ceil(s.remaining / Math.max(1, ticksLeft));
            if (amount > 0) dotHit(world, s, e, amount, element);
            s.remaining -= amount;
            s.nextAt += every;
          }
        }
        if (s.until <= tick || dead || !proto) expired = true;
      }
      if (expired) {
        st.list = st.list.filter(
          (s) => s.until > tick && !dead && statusProto(ctx.registry, s.id) !== undefined,
        );
      }
    }
  },
};

/** Tiny test modules: an event-ticked "walk" mode and a fixed-ticked "swarm" mode. */
import { ActionError, defineComponent, defineMode, defineModule } from "../src/index.ts";
import type { ModuleSpec } from "../src/index.ts";

export const Pos = defineComponent<{ x: number; y: number }>("walk.pos");
export const Hp = defineComponent<{ hp: number }>("walk.hp");
export const Player = defineComponent<{ id: string }>("walk.player");

export const walkCore = defineModule({
  id: "walk.core",
  version: "1.0.0",
  data(reg) {
    reg.define("creature", "mossling", { hp: 5 });
  },
  setup(world, ctx) {
    for (let i = 0; i < 3; i++) {
      const e = world.create();
      world.add(e, Pos, { x: ctx.rng.int(0, 9), y: ctx.rng.int(0, 9) });
      world.add(e, Hp, { hp: ctx.registry.require<{ hp: number }>("creature", "mossling").hp });
    }
  },
  actions: [
    {
      name: "walk.join",
      parse: (_w, payload) => {
        if (typeof payload !== "object" || payload === null)
          throw new ActionError("bad_payload", "need {}");
        return null;
      },
      apply(world, _p, ctx) {
        const e = world.create();
        world.add(e, Player, { id: ctx.actor ?? "anon" });
        world.add(e, Pos, { x: 0, y: 0 });
        ctx.emit({ type: "walk.joined", entity: e });
      },
    },
    {
      name: "walk.move",
      parse(_w, payload) {
        const p = payload as { dx?: unknown; dy?: unknown };
        if (typeof p?.dx !== "number" || typeof p?.dy !== "number") {
          throw new ActionError("bad_payload", "dx and dy must be numbers");
        }
        return { dx: p.dx, dy: p.dy };
      },
      apply(world, p: { dx: number; dy: number }, ctx) {
        const me = world.query(Player, Pos).find((e) => world.read(e, Player).id === ctx.actor);
        if (me === undefined) throw new ActionError("not_joined", "join first");
        const pos = world.read(me, Pos);
        pos.x += p.dx;
        pos.y += p.dy;
        if (pos.x < 0) throw new ActionError("blocked", "wall");
        ctx.emit({ type: "walk.moved", x: pos.x, y: pos.y });
      },
    },
  ],
  systems: [
    {
      id: "walk.monsters.wander",
      run(world, ctx) {
        for (const e of world.query(Hp, Pos)) {
          const pos = world.read(e, Pos);
          pos.x += ctx.rng.int(-1, 1);
          pos.y += ctx.rng.int(-1, 1);
        }
      },
    },
    {
      id: "walk.monsters.explode",
      stage: "post",
      run(world) {
        if (world.getResource<boolean>("walk.explode")) throw new Error("kaboom");
      },
    },
  ],
});

export const walkMode = defineMode({
  id: "walk",
  name: "Walk",
  description: "test mode",
  world: null,
  modules: ["walk.*"],
  tick: { kind: "event" },
});

export const Spark = defineComponent<{ age: number }>("swarm.spark");

export const swarmCore = defineModule({
  id: "swarm.core",
  version: "1.0.0",
  systems: [
    {
      id: "swarm.spawn",
      run(world, ctx) {
        if (ctx.rng.chance(0.5)) {
          const e = world.create();
          world.add(e, Spark, { age: 0 });
          ctx.emit({ type: "swarm.spawned", entity: e, at: ctx.timeMs });
        }
      },
    },
    {
      id: "swarm.age",
      stage: "post",
      run(world) {
        for (const e of world.query(Spark)) {
          const s = world.read(e, Spark);
          s.age++;
          if (s.age > 3) world.destroy(e);
        }
      },
    },
  ],
  actions: [
    {
      name: "swarm.clear",
      parse: () => null,
      apply(world) {
        for (const e of world.query(Spark)) world.destroy(e);
      },
    },
  ],
});

export const swarmMode = defineMode({
  id: "swarm",
  name: "Swarm",
  description: "fixed test mode",
  world: null,
  modules: ["swarm.core"],
  tick: { kind: "fixed", hz: 20 },
});

/** Minimal module with only the given fields. */
export function mod(id: string, extra: Partial<ModuleSpec> = {}): ModuleSpec {
  return { id, version: "1.0.0", ...extra };
}

/** Mode over the given module patterns. */
export function modeOf(modules: string[], tick: "event" | "fixed" = "event") {
  return defineMode({
    id: "test",
    name: "Test",
    description: "test",
    world: null,
    modules,
    tick: tick === "event" ? { kind: "event" } : { kind: "fixed", hz: 10 },
  });
}

/**
 * Module "classic.combat" — OWNER: core+combat builder (T3, Opus).
 * docs/design/classic.md §7 (skills runtime), §10 (damage), §20.
 *
 * Systems (ids/stages/orders from SYSTEM):
 * - classic.combat.orders (update 250, ./orders.ts): CastOrder -> Casting.
 * - classic.combat.dashes (350, ./dashes.ts): dash movement + arrival hits.
 * - classic.combat.casting (400, ./casting.ts): fires every SkillShape.
 * - classic.combat.projectiles (500, ./projectiles.ts).
 * - classic.combat.effects (550, ./effects.ts): GroundEffect ticks.
 * - classic.combat.statuses (600, ./statuses.ts): expiry and dots.
 * - classic.combat.resolveHits (700, ./resolve.ts): damage, deaths.
 * Data-driven from SkillProto/StatusProto: every shape works for heroes and
 * monsters. No actions (casting is ordered through CastOrder).
 */
import { defineModule } from "@gamez/kernel";
import { MODULE } from "../ids.ts";
import { castingSystem } from "./casting.ts";
import { dashesSystem } from "./dashes.ts";
import { effectsSystem } from "./effects.ts";
import { ordersSystem } from "./orders.ts";
import { projectilesSystem } from "./projectiles.ts";
import { resolveSystem } from "./resolve.ts";
import { statusesSystem } from "./statuses.ts";

export const classicCombat = defineModule({
  id: MODULE.combat,
  version: "0.2.1",
  deps: [MODULE.core],
  optionalDeps: [MODULE.content],
  systems: [
    ordersSystem,
    dashesSystem,
    castingSystem,
    projectilesSystem,
    effectsSystem,
    statusesSystem,
    resolveSystem,
  ],
});

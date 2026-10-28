/**
 * classic.achievements.check (post 900, SYSTEM.achievementsCheck) — OWNER:
 * T-achievements. Every 20 ticks, in phase "play" with a hero: unlocks every
 * locked AchievementProto whose metric reached its target (registry order),
 * keeps AchievementState.unlocked sorted by id, emits
 * classic.achievement.unlocked and queues grantGold (reason "achievement")
 * for gold rewards. AchievementState is created lazily.
 */
import type { SystemDef } from "@gamez/kernel";
import { pushCommand } from "../bus.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import {
  achievementsOf,
  heroOf,
  RES,
  type AchievementState,
  type GameState,
} from "../resources.ts";
import { KIND, type AchievementProto } from "../types.ts";
import { metricValue } from "./metrics.ts";

export const ACHIEVEMENT_CHECK_EVERY = 20;

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const achievementsCheck: SystemDef = {
  ...SYSTEM.achievementsCheck,
  run(world, ctx) {
    if (ctx.tick % ACHIEVEMENT_CHECK_EVERY !== 0) return;
    const game = world.getResource<GameState>(RES.game);
    if (!game || game.phase !== "play") return;
    if (heroOf(world) === 0) return;
    const existing = achievementsOf(world);
    const state: AchievementState = existing ?? { unlocked: [], title: "" };
    if (!existing) world.setResource(RES.achievements, state);
    const all = ctx.registry.all<AchievementProto>(KIND.achievement);
    if (all.length === 0) return;

    const have = new Set(state.unlocked.map((u) => u.id));
    const fresh: { id: string; proto: Readonly<AchievementProto> }[] = [];
    for (const [id, proto] of all) {
      if (have.has(id)) continue;
      if (metricValue(world, ctx.registry, proto.metric) < proto.target) continue;
      fresh.push({ id, proto });
    }
    if (fresh.length === 0) return;

    const unlocked = [...state.unlocked, ...fresh.map((f) => ({ id: f.id, at: ctx.tick }))].sort(
      byId,
    );
    world.setResource(RES.achievements, { ...state, unlocked });
    for (const { id, proto } of fresh) {
      emit(ctx, {
        type: "classic.achievement.unlocked",
        id,
        name: proto.name,
        gold: proto.reward.gold,
        title: proto.reward.title,
      });
      if (proto.reward.gold > 0) {
        pushCommand(world, { op: "grantGold", amount: proto.reward.gold, reason: "achievement" });
      }
    }
  },
};

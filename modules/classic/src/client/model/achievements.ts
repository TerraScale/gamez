/**
 * Wave A HUD section: achievements (docs/design/wave-A.md §9) — OWNER: T-achievements.
 * Pure: reads the world, the registry and the achievement state; never throws.
 * Hidden locked achievements show "???" for name, description and reward (the
 * progress numbers stay visible).
 */
import { metricValue } from "../../achievements/metrics.ts";
import { KIND, type AchievementProto } from "../../types.ts";
import { achievementsOf } from "../../resources.ts";
import type { AchievementView, AchievementsView } from "../contract.ts";
import type { ModelContext } from "./context.ts";
import { fmtInt } from "../hud/format.ts";

/** Every achievement with progress; null when no AchievementProto exists. */
export function buildAchievementsView(c: ModelContext): AchievementsView | null {
  const all = c.registry.all<AchievementProto>(KIND.achievement);
  if (all.length === 0) return null;
  const state = achievementsOf(c.world);
  const at: Record<string, number> = {};
  for (const u of state?.unlocked ?? []) at[u.id] = u.at;

  const list: AchievementView[] = [];
  let unlockedCount = 0;
  for (const [id, proto] of all) {
    const unlockedAt = at[id];
    const unlocked = unlockedAt !== undefined;
    if (unlocked) unlockedCount++;
    const hiddenNow = proto.hidden && !unlocked;
    const value = metricValue(c.world, c.registry, proto.metric);
    list.push({
      id,
      name: hiddenNow ? "???" : proto.name,
      description: hiddenNow ? "A hidden achievement." : proto.description,
      icon: proto.icon,
      progress: Math.min(value, proto.target),
      target: proto.target,
      unlocked,
      at: unlocked ? unlockedAt : 0,
      rewardText: hiddenNow ? "???" : rewardText(proto),
    });
  }
  list.sort(
    (a, b) => orderOf(c, a.id) - orderOf(c, b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return {
    unlocked: unlockedCount,
    total: list.length,
    list,
    title: state?.title ?? "",
  };
}

function orderOf(c: ModelContext, id: string): number {
  return c.registry.get<AchievementProto>(KIND.achievement, id)?.order ?? 0;
}

function rewardText(p: AchievementProto): string {
  const parts: string[] = [];
  if (p.reward.gold > 0) parts.push(`${fmtInt(p.reward.gold)} gold`);
  if (p.reward.title) parts.push(`title "${p.reward.title}"`);
  return parts.length > 0 ? parts.join(", ") : "No reward";
}

/**
 * Classic admin-dashboard hooks (ModeAnalytics, docs/design/admin-dashboard.md §5).
 * OWNER: T-sim-analytics. Pure and server-side: reads the world, never changes it.
 *
 * Counters (metric, k1, k2) follow the §3 "sim.tally metrics" table. Every key is
 * bounded: registry ids, enums, level bands, depth bands and a fixed reason set.
 * No player names or account ids are ever used.
 *
 * Notes on the mapping:
 * - `death` depth: the last classic.area.changed before the death in the batch,
 *   else the world's current depth. A death followed by a respawn inside the same
 *   verified batch with no area change before it is attributed to town (documented
 *   limit: the batch does not carry the depth of the death).
 * - `gold` counts positive gains only (spending is an economy sink, not play).
 * - `quest.completed` does not add gold or xp: the reward already comes as
 *   classic.gold (reason "quest") and classic.xp (reason "quest").
 * - Commands tagged "debug" are not play and are skipped for xp and gold.
 *
 * The integrator adds `analytics: classicAnalytics` to the policy in platform/policy.ts (§11).
 */
import type { Entity, GameEvent, ModeAnalytics, World } from "@gamez/kernel";
import { Dead, Hero, Level, Monster } from "../components.ts";
import { currentDepth, heroOf, RES, type ControlState } from "../resources.ts";
import type { ClassicEvent } from "../events.ts";

/** Level band of a hero level: "1-9", "10-19", … "90+" (bounded). */
export function levelBand(level: number): string {
  const l = Math.max(1, Math.trunc(Number.isFinite(level) ? level : 1));
  if (l >= 90) return "90+";
  if (l < 10) return "1-9";
  const lo = Math.floor(l / 10) * 10;
  return `${lo}-${lo + 9}`;
}

/** Depth band: "town" (0), "1".."20", "21+". */
export function depthBand(depth: number): string {
  const d = Number.isFinite(depth) ? Math.trunc(depth) : 0;
  if (d <= 0) return "town";
  if (d > 20) return "21+";
  return String(d);
}

/** Reasons that count as play; anything else becomes "other". */
const PLAY_REASONS = new Set([
  "kill",
  "quest",
  "pickup",
  "achievement",
  "rift",
  "death",
  "left",
  "offline",
  "sold",
  "overflow",
  "vendor",
]);

/** Bounded key of a free-text reason ("overflow sold" reads as "overflow"). */
function reasonKey(reason: string): string {
  const head = (reason.split(":")[0] ?? "").trim();
  return PLAY_REASONS.has(head) ? head : "other";
}

function levelOf(world: World, hero: Entity): number {
  if (hero === 0) return 1;
  return world.get(hero, Level)?.level ?? 1;
}

function classIdOf(world: World, hero: Entity): string {
  if (hero === 0) return "unknown";
  return world.get(hero, Hero)?.classId ?? "unknown";
}

/** Monster proto id of a killer entity, or "unknown" when it is gone. */
function killerProto(world: World, killer: Entity): string {
  if (killer === 0 || !world.has(killer, Monster)) return "unknown";
  return world.read(killer, Monster).proto;
}

export const classicAnalytics: ModeAnalytics = {
  dims(world) {
    const control = world.getResource<ControlState>(RES.control)?.mode ?? "manual";
    const hero = heroOf(world);
    return { control, levelBand: levelBand(levelOf(world, hero)) };
  },

  fold(events, world, tally) {
    const tally1 = (metric: string, k1: string, k2: string): void => tally(metric, k1, k2, 1);
    const hero = heroOf(world);
    const band = levelBand(levelOf(world, hero));

    // The killer of the hero, from this batch (classic.death with isHero) when present.
    let heroKiller: Entity = 0;
    for (const raw of events) {
      const e = raw as ClassicEvent;
      if (e.type === "classic.death" && e.isHero) heroKiller = e.killer;
    }

    let areaDepth: number | null = null;
    for (const raw of events) {
      const e = raw as ClassicEvent;
      switch (e.type) {
        case "classic.area.changed":
          areaDepth = e.depth;
          break;
        case "classic.death":
          if (!e.isHero && e.monster !== "") tally1("kill", e.monster, e.rarity);
          break;
        case "classic.hero.died": {
          const depth = areaDepth ?? currentDepth(world);
          const killer =
            heroKiller !== 0
              ? killerProto(world, heroKiller)
              : killerProto(world, world.get(hero, Dead)?.killer ?? 0);
          tally1("death", depthBand(depth), killer);
          break;
        }
        case "classic.boss.spawned":
          tally1("boss.spawned", e.monster, depthBand(e.depth));
          break;
        case "classic.boss.killed":
          tally1("boss.killed", e.monster, depthBand(e.depth));
          break;
        case "classic.quest.accepted":
          tally1("quest.accepted", e.quest, "");
          break;
        case "classic.quest.done":
          tally1("quest.done", e.quest, "");
          break;
        case "classic.quest.completed":
          tally1("quest.completed", e.quest, "");
          break;
        case "classic.xp": {
          const reason = e.reason.split(":")[0]?.trim() ?? "";
          if (e.amount > 0 && reason !== "debug") {
            tally("xp", band, reasonKey(e.reason), e.amount);
          }
          break;
        }
        case "classic.gold": {
          const reason = e.reason.split(":")[0]?.trim() ?? "";
          if (e.amount > 0 && reason !== "debug") {
            tally("gold", band, reasonKey(e.reason), e.amount);
          }
          break;
        }
        case "classic.levelUp":
          tally1("level", levelBand(e.level), classIdOf(world, hero));
          break;
        case "classic.loot.dropped":
          tally1("drop", e.rarity, e.kind);
          break;
        case "classic.achievement.unlocked":
          tally1("achievement", e.id, "");
          break;
        case "classic.cast":
          if (hero !== 0 && e.caster === hero) tally1("cast", e.skill, "");
          break;
        case "classic.talent.learned":
          tally1("talent", e.node, "");
          break;
        case "classic.rift.completed":
          tally1("rift", "completed", levelBand(e.record.level));
          break;
        case "classic.rift.failed":
          tally1("rift", "failed", levelBand(e.record.level));
          break;
        case "classic.gem.socketed":
          tally1("gem", "socketed", "");
          break;
        case "classic.gems.combined":
          tally1("gem", "combined", "");
          break;
        default:
          break;
      }
    }
  },

  offline(events: readonly GameEvent[]) {
    for (const raw of events) {
      const e = raw as ClassicEvent;
      if (e.type !== "classic.offline.summary") continue;
      const out = { kills: e.kills, xp: e.xp, gold: e.gold, items: e.items, levels: e.levels };
      const any = out.kills + out.xp + out.gold + out.items + out.levels > 0 || e.ms > 0;
      return any ? out : null;
    }
    return null;
  },
};

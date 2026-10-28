/**
 * Live-level bookkeeping (classic.world.levelState, post 150; design §9.3).
 * Reads Bus.deaths: every non-summoned monster of the live level counts as a
 * kill; bosses are recorded in DungeonState.bossesKilled; the level is cleared
 * exactly once, when liveKilled reaches liveSpawned.
 */
import type { SystemDef } from "@gamez/kernel";
import { busOf } from "../bus.ts";
import { emit } from "../events.ts";
import { SYSTEM } from "../ids.ts";
import { dungeonOf } from "../resources.ts";

export const levelStateSystem: SystemDef = {
  ...SYSTEM.worldLevelState,
  run(world, ctx) {
    const bus = busOf(world);
    if (bus.deaths.length === 0) return;
    const dungeon = dungeonOf(world);
    const live = dungeon.live;
    if (live === 0) return;
    for (const d of bus.deaths) {
      if (d.isHero || d.team !== "monster" || d.rarity === "summon" || d.depth !== live) continue;
      const before = dungeon.liveKilled;
      dungeon.liveKilled = before + 1;
      if (d.rarity === "boss") {
        if (!dungeon.bossesKilled.includes(live)) {
          dungeon.bossesKilled = [...dungeon.bossesKilled, live].sort((a, b) => a - b);
        }
        dungeon.liveBossAlive = false;
        if (dungeon.bossWound?.depth === live) dungeon.bossWound = null;
        emit(ctx, { type: "classic.boss.killed", monster: d.monster, depth: live });
      }
      if (
        dungeon.liveSpawned > 0 &&
        before < dungeon.liveSpawned &&
        dungeon.liveKilled >= dungeon.liveSpawned
      ) {
        emit(ctx, { type: "classic.level.cleared", depth: live });
      }
    }
  },
};

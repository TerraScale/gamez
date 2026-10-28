/**
 * classic.progression.heroDeath (post 600): the death penalty, applied once on
 * the tick the hero died (Dead.at === tick). Respawn is a separate op/action.
 */
import type { SystemDef } from "@gamez/kernel";
import { Dead, Intent, Level, Monster, Wallet } from "../components.ts";
import { emit } from "../events.ts";
import { pct } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { heroOf, runStatsOf, RES } from "../resources.ts";
import { xpAtLevel } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../types.ts";
import { replace } from "./util.ts";

export const progressionHeroDeath: SystemDef = {
  ...SYSTEM.progressionHeroDeath,
  run(world, ctx) {
    const hero = heroOf(world);
    if (hero === 0) return;
    const dead = world.get(hero, Dead);
    if (!dead || dead.at !== ctx.tick) return;
    const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);

    let goldLost = 0;
    const wallet = world.get(hero, Wallet);
    if (wallet) {
      goldLost = pct(wallet.gold, bal.deathGoldLossPct);
      world.update(hero, Wallet, { gold: wallet.gold - goldLost });
    }

    // XP lost is a share of the XP earned inside the current level, never below its start.
    const lvl = world.read(hero, Level);
    const earned = Math.max(0, lvl.xp - xpAtLevel(bal, lvl.level));
    const xpLost = Math.min(earned, pct(earned, bal.deathXpLossPct));
    if (xpLost > 0) world.update(hero, Level, { xp: lvl.xp - xpLost });

    const stats = runStatsOf(world);
    stats.deaths++;
    world.setResource(RES.stats, stats);

    const intent = world.get(hero, Intent);
    replace(world, hero, Intent, {
      kind: "idle",
      source: intent?.source ?? "manual",
      at: ctx.tick,
    });

    const killer = dead.killer;
    const killerName = world.has(killer, Monster) ? world.read(killer, Monster).name : "";
    emit(ctx, { type: "classic.hero.died", goldLost, xpLost, killer: killerName });
  },
};

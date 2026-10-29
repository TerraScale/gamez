/**
 * classic.progression.heroDeath (post 600): the death penalty, applied once on
 * the tick a hero died (Dead.at === tick). Respawn is a separate op/action.
 *
 * A death inside a rift costs no gold: the rift fee was the stake, and the run
 * itself is lost (classic.rift.track fails it). The XP share is still lost.
 *
 * Party (docs/design/party.md §7.2): every member that died this tick (slot
 * order) loses its own XP share, goes idle and counts a death (RunStats and
 * PartyMember). Gold (the purse) is lost only when the deaths of this tick
 * wipe the party, once, on the first of them. classic.party emits the
 * downed / wiped events (post 610). Solo: exactly the old single-hero path.
 */
import type { Entity, SimContext, SystemDef, World } from "@gamez/kernel";
import { Dead, Intent, Level, Monster, PartyMember } from "../components.ts";
import { emit } from "../events.ts";
import { pct } from "../fixed.ts";
import { SYSTEM } from "../ids.ts";
import { heroTag, purseWallet, setPurseGold } from "../items/common.ts";
import { partyMembers, partyWiped } from "../party/shared.ts";
import { currentDepth, runStatsOf, RES } from "../resources.ts";
import { isRiftDepth, xpAtLevel } from "../rules.ts";
import { BALANCE_ID, KIND, type BalanceProto } from "../types.ts";
import { replace } from "./util.ts";

export const progressionHeroDeath: SystemDef = {
  ...SYSTEM.progressionHeroDeath,
  run(world, ctx) {
    let died: Entity[] | null = null;
    for (const e of partyMembers(world)) {
      const dead = world.get(e, Dead);
      if (!dead || dead.at !== ctx.tick) continue;
      (died ??= []).push(e);
    }
    if (died === null) return;
    const bal = ctx.registry.require<BalanceProto>(KIND.balance, BALANCE_ID);
    // Gold: only when this tick's deaths leave nobody standing (solo: always), never in a rift.
    let goldDue = partyWiped(world) && !isRiftDepth(currentDepth(world));
    for (const hero of died) {
      let goldLost = 0;
      if (goldDue) {
        const wallet = purseWallet(world);
        if (wallet) {
          goldLost = pct(wallet.gold, bal.deathGoldLossPct);
          setPurseGold(world, wallet.purse, wallet.gold - goldLost);
        }
        goldDue = false;
      }
      penalize(world, ctx, bal, hero, goldLost);
    }
  },
};

/** XP share, death counters, idle intent and classic.hero.died for one member. */
function penalize(
  world: World,
  ctx: SimContext,
  bal: BalanceProto,
  hero: Entity,
  goldLost: number,
): void {
  const dead = world.read(hero, Dead);
  // XP lost is a share of the XP earned inside the current level, never below its start.
  const lvl = world.read(hero, Level);
  const earned = Math.max(0, lvl.xp - xpAtLevel(bal, lvl.level));
  const xpLost = Math.min(earned, pct(earned, bal.deathXpLossPct));
  if (xpLost > 0) world.update(hero, Level, { xp: lvl.xp - xpLost });

  const stats = runStatsOf(world);
  stats.deaths++;
  world.setResource(RES.stats, stats);
  const pm = world.get(hero, PartyMember);
  if (pm) world.update(hero, PartyMember, { deaths: pm.deaths + 1 });

  const intent = world.get(hero, Intent);
  replace(world, hero, Intent, {
    kind: "idle",
    source: intent?.source ?? "manual",
    at: ctx.tick,
  });

  const killer = dead.killer;
  const killerName = world.has(killer, Monster) ? world.read(killer, Monster).name : "";
  emit(ctx, {
    type: "classic.hero.died",
    goldLost,
    xpLost,
    killer: killerName,
    ...heroTag(world, hero),
  });
}

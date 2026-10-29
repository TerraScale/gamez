/**
 * Events of the classic mode (CONTRACT). Events are for observers only (HUD,
 * renderer effects, combat log, later the network); systems never read them
 * (use the bus for sim-internal messages). Positions are sub units.
 *
 * Emit with `emit(ctx, {...})` for type checking. Keep payloads small: the
 * client receives every event of every tick.
 */
import type { Entity, SimContext } from "@gamez/kernel";
import type { ControlMode, RiftRecord, SimSpeed } from "./resources.ts";
import type { Element, EquipSlot, ItemCategory, ItemRarity, MonsterRarity } from "./types.ts";

export type ClassicEvent =
  // ---- classic.combat
  | {
      type: "classic.hit";
      source: Entity;
      target: Entity;
      skill: string;
      amount: number;
      /** Dominant element of the hit (for the damage number colour). */
      element: Element;
      crit: boolean;
      dot: boolean;
      heroHit: boolean;
      byHero: boolean;
      x: number;
      y: number;
    }
  | { type: "classic.miss"; source: Entity; target: Entity; blocked: boolean; x: number; y: number }
  | {
      type: "classic.cast";
      caster: Entity;
      skill: string;
      effect: string;
      x: number;
      y: number;
      tx: number;
      ty: number;
    }
  | { type: "classic.cast.failed"; caster: Entity; skill: string; code: string }
  /** One-shot visual (nova ring, explosion, chain segments, blink, heal...). */
  | {
      type: "classic.effect";
      effect: string;
      x: number;
      y: number;
      radius: number;
      /**
       * Sub units. Chain/beam: the polyline. Arc (cleave-like swings): one
       * point, the aim tip (caster + radius along the aim) to orient the
       * slash. Empty otherwise.
       */
      points: { x: number; y: number }[];
    }
  | { type: "classic.status"; target: Entity; status: string; until: number }
  | {
      type: "classic.death";
      entity: Entity;
      killer: Entity;
      isHero: boolean;
      monster: string;
      name: string;
      rarity: MonsterRarity | "hero";
      x: number;
      y: number;
    }
  | { type: "classic.heal"; target: Entity; amount: number; x: number; y: number }
  // ---- classic.progression
  | { type: "classic.xp"; amount: number; total: number; reason: string }
  | { type: "classic.levelUp"; level: number; statPoints: number; skillPoints: number }
  | { type: "classic.statAllocated"; attr: string; points: number }
  | { type: "classic.skillLearned"; skill: string; rank: number }
  | { type: "classic.hero.created"; hero: Entity; classId: string; name: string }
  | { type: "classic.hero.died"; goldLost: number; xpLost: number; killer: string }
  | { type: "classic.hero.respawned" }
  | { type: "classic.quest.accepted"; quest: string }
  | { type: "classic.quest.progress"; quest: string; progress: number; count: number }
  | { type: "classic.quest.done"; quest: string }
  | { type: "classic.quest.completed"; quest: string; gold: number; xp: number }
  // ---- classic.items
  | {
      type: "classic.loot.dropped";
      entity: Entity;
      kind: "item" | "gold" | "potion";
      name: string;
      rarity: ItemRarity;
      x: number;
      y: number;
    }
  | {
      type: "classic.loot.picked";
      kind: "item" | "gold" | "potion";
      name: string;
      rarity: ItemRarity;
      gold: number;
    }
  | { type: "classic.gold"; amount: number; total: number; reason: string }
  /** A potion was drunk. `lifeBefore`/`lifeAfter` (and mana) are the values around the drink (additive fields). */
  | {
      type: "classic.potion";
      base: string;
      kind: "life" | "mana" | "rejuv";
      amount: number;
      lifeBefore: number;
      lifeAfter: number;
      manaBefore: number;
      manaAfter: number;
    }
  | { type: "classic.item.equipped"; uid: number; slot: EquipSlot; name: string }
  | { type: "classic.item.unequipped"; uid: number; slot: EquipSlot }
  | { type: "classic.vendor.bought"; npc: string; name: string; price: number }
  | { type: "classic.vendor.sold"; npc: string; name: string; price: number }
  | { type: "classic.bag.full" }
  // ---- classic.world
  | { type: "classic.area.changed"; depth: number; theme: string; via: string; name: string }
  | { type: "classic.level.cleared"; depth: number }
  | { type: "classic.boss.spawned"; entity: Entity; monster: string; depth: number }
  | { type: "classic.boss.killed"; monster: string; depth: number }
  | { type: "classic.waypoint.unlocked"; depth: number }
  | { type: "classic.portal.opened"; depth: number }
  | { type: "classic.npc.opened"; npc: Entity; proto: string; role: string }
  | { type: "classic.stash.opened" }
  | { type: "classic.waypoint.opened" }
  // ---- classic.auto
  | { type: "classic.control"; mode: ControlMode; speed: SimSpeed }
  | { type: "classic.auto.plan"; plan: string; note: string }
  /** The controller changed course on its own (stash full, travel loop, kill drought). */
  | { type: "classic.auto.notice"; code: string; message: string }
  /**
   * One offline grant (docs/design/offline-idle.md §6). `ms` = credited time
   * (min(awayMs, capMs), whole minutes count); `awayMs` = the absence the
   * server (or the local client) measured; xp/gold/items are already scaled
   * by xpPct/goldPct/itemPct; `source` = "rate" (measured online Idle rate)
   * or "model" (fallback estimate); `levels` = levels gained by the XP.
   */
  | {
      type: "classic.offline.summary";
      ms: number;
      awayMs: number;
      capMs: number;
      depth: number;
      kills: number;
      xp: number;
      gold: number;
      items: number;
      levels: number;
      xpPct: number;
      goldPct: number;
      itemPct: number;
      source: "rate" | "model";
      /**
       * Upkeep gold already deducted from `gold` (rate path: potions, scrolls
       * and repairs at the measured rate; 0 for the model). Optional so older
       * emitters type-check; the sim always sets it.
       */
      upkeep?: number;
      /**
       * Gold found before upkeep (scaled by goldPct; equals `gold` for the
       * model). Optional so older emitters type-check; the sim always sets it.
       */
      found?: number;
    }
  // ---- any command owner
  | { type: "classic.command.failed"; op: string; code: string; message: string }
  // ======================= wave A (docs/design/wave-A.md) =======================
  // ---- classic.combat / classic.monsters (bosses)
  /**
   * A telegraph was placed: the danger zone fills for `ticks` and hits at
   * `fireAt`. Positions sub; angle 0..63 steps; radius/length/width sub.
   */
  | {
      type: "classic.telegraph";
      entity: Entity;
      caster: Entity;
      skill: string;
      effect: string;
      shape: "circle" | "cone" | "line";
      x: number;
      y: number;
      radius: number;
      angle: number;
      arc: number;
      length: number;
      width: number;
      ticks: number;
      fireAt: number;
    }
  /** A boss entered a phase (phase index 1-based into MonsterProto.phases). */
  | {
      type: "classic.boss.phase";
      entity: Entity;
      monster: string;
      phase: number;
      message: string;
      enraged: boolean;
    }
  // ---- classic.items (durability, gambling, sets, stash, loot filter)
  | { type: "classic.item.broken"; uid: number; slot: EquipSlot; name: string }
  /** Durability fell to 10 % or less (once per item until repaired). */
  | { type: "classic.item.worn"; uid: number; slot: EquipSlot; name: string }
  | {
      type: "classic.gambled";
      npc: string;
      category: ItemCategory;
      name: string;
      rarity: ItemRarity;
      price: number;
    }
  /** The number of equipped pieces of a set crossed a bonus threshold (up or down). */
  | { type: "classic.set.bonus"; set: string; name: string; pieces: number; active: number }
  | { type: "classic.stash.moved"; uid: number; tab: number }
  | { type: "classic.lootFilter.changed" }
  // ---- classic.crafting (smith services)
  | { type: "classic.repaired"; uids: number[]; cost: number }
  | {
      type: "classic.upgraded";
      uid: number;
      name: string;
      level: number;
      success: boolean;
      cost: number;
    }
  | { type: "classic.rerolled"; uid: number; name: string; cost: number }
  | { type: "classic.socket.added"; uid: number; sockets: number; cost: number }
  | { type: "classic.gem.socketed"; uid: number; gem: string; slot: number }
  | { type: "classic.gems.removed"; uid: number; gems: string[]; cost: number }
  | { type: "classic.gems.combined"; from: string; to: string; cost: number }
  // ---- classic.talents
  | { type: "classic.talent.points"; points: number; gained: number }
  | { type: "classic.talent.learned"; node: string; rank: number }
  | { type: "classic.talents.reset"; refunded: number; cost: number }
  // ---- classic.rift / classic.world
  /** The obelisk was used (manual): open the Rift panel. */
  | { type: "classic.rift.panel" }
  | { type: "classic.rift.unlocked" }
  | { type: "classic.rift.opened"; level: number; depth: number; fee: number; run: number }
  /** Progress crossed another 10 % (pct 10..100). */
  | { type: "classic.rift.progress"; pct: number }
  | { type: "classic.rift.guardian"; entity: Entity; monster: string; name: string }
  | { type: "classic.rift.completed"; record: RiftRecord; gold: number; items: number }
  | { type: "classic.rift.failed"; record: RiftRecord }
  // ---- classic.achievements
  | {
      type: "classic.achievement.unlocked";
      id: string;
      name: string;
      gold: number;
      title: string | null;
    };

export type ClassicEventType = ClassicEvent["type"];

/** Type-checked ctx.emit. */
export function emit(ctx: SimContext, ev: ClassicEvent): void {
  ctx.emit(ev);
}

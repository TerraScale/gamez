/**
 * Sim event fan-out of the classic client (docs/design/classic.md §12.3).
 * Pure: turns one GameEvent into a list of Visuals (float texts, renderer
 * effects, combat-log lines, toasts, panel openings). game.ts applies them to
 * the renderer and the stores. Positions in events are sub units; visuals use
 * fractional tiles.
 */
import type { Entity, FrozenRegistry, GameEvent, World } from "@gamez/kernel";
import type { EffectKind, EffectSpec } from "@gamez/ui-host";
import type { ClassicEvent } from "../events.ts";
import { Hero, Monster } from "../components.ts";
import { SUB } from "../fixed.ts";
import {
  KIND,
  type ClassProto,
  type MonsterProto,
  type SkillProto,
  type NpcProto,
} from "../types.ts";
import {
  ELEMENT_COLOR,
  GOLD_COLOR,
  MONSTER_COLOR,
  RARITY_COLOR,
  type LogKind,
  type PanelId,
  type Toast,
} from "./contract.ts";

/** What the planner needs from the outside (no DOM, no renderer). */
export interface EffectEnv {
  world: World;
  registry: FrozenRegistry;
  /** The hero entity (0 before creation). */
  hero: Entity;
  /** Hero position in fractional tiles (for events without a position). */
  heroX: number;
  heroY: number;
  showDamageNumbers: boolean;
  /** Manual mode: command failures are shown as errors (auto failures only log). */
  manual: boolean;
}

export type Visual =
  | { kind: "float"; x: number; y: number; text: string; color: number; size: "s" | "m" | "l" }
  | { kind: "effect"; spec: EffectSpec }
  | { kind: "log"; logKind: LogKind; text: string; color: number }
  | { kind: "toast"; toastKind: Toast["kind"]; title: string; body: string; ms: number }
  | { kind: "panel"; panel: PanelId }
  | { kind: "vendor"; npc: Entity }
  | { kind: "error"; code: string; message: string };

/**
 * Combat-log line for an auto plan change, or null for plans that would only
 * spam the log (exploring, fighting: their effects are logged anyway).
 */
export function planLogText(plan: string, note: string): string | null {
  switch (plan) {
    case "toTown":
      return note ? `Auto: heading to town (${note})` : "Auto: heading to town";
    case "town":
      return note ? `Auto: in town (${note})` : "Auto: in town";
    case "toDungeon":
      return "Auto: heading back to the dungeon";
    case "descend":
      return note ? `Auto: going to the ${note}` : "Auto: descending";
    case "recover":
      return "Auto: recovering";
    default:
      return null;
  }
}

export const LOG_COLOR = {
  combat: 0xe6e6e6,
  hurt: 0xff7a7a,
  level: 0xffd75e,
  quest: 0x9fe0a8,
  system: 0x9aa4b2,
  death: 0xff5a5a,
  gold: GOLD_COLOR,
} as const;

const TOAST_MS = 4000;
const TOAST_LONG_MS = 7000;

interface EffectRow {
  kind: EffectKind;
  color: number;
  radius: number;
}

/** Effect id -> renderer effect (docs/design/classic.md §12.3). */
export const EFFECT_TABLE: Readonly<Record<string, EffectRow>> = {
  "fx.frost_ring": { kind: "nova", color: ELEMENT_COLOR.cold, radius: 3 },
  "fx.cinder_orb": { kind: "explosion", color: ELEMENT_COLOR.fire, radius: 1.5 },
  "fx.arc_chain": { kind: "chain", color: ELEMENT_COLOR.lightning, radius: 0 },
  "fx.phase_step": { kind: "blink", color: 0xb8c4ff, radius: 0.5 },
  "fx.tumble": { kind: "blink", color: 0xd9d9d9, radius: 0.5 },
  "fx.mend": { kind: "heal", color: ELEMENT_COLOR.poison, radius: 0.8 },
  "fx.whirl": { kind: "nova", color: 0xe6e6e6, radius: 1.5 },
  "fx.slam": { kind: "nova", color: 0xc8873a, radius: 2 },
  "fx.burst": { kind: "explosion", color: ELEMENT_COLOR.poison, radius: 1.5 },
  "fx.rally": { kind: "levelup", color: GOLD_COLOR, radius: 1.5 },
  "fx.charge": { kind: "slash", color: 0xf2f2f2, radius: 1 },
  // Hero skills.
  "fx.attack": { kind: "slash", color: ELEMENT_COLOR.phys, radius: 0.8 },
  "fx.cleave": { kind: "slash", color: 0xffd28a, radius: 1.5 },
  "fx.multishot": { kind: "cast", color: 0xd9c08a, radius: 0.6 },
  "fx.venom_shot": { kind: "hit", color: ELEMENT_COLOR.poison, radius: 0.8 },
  "fx.spark_sentry": { kind: "cast", color: ELEMENT_COLOR.lightning, radius: 0.8 },
  "fx.ember_bolt": { kind: "explosion", color: ELEMENT_COLOR.fire, radius: 0.8 },
  // Monster and boss skills.
  "fx.claw": { kind: "slash", color: 0xd0d0d0, radius: 0.8 },
  "fx.bite": { kind: "slash", color: 0xc84040, radius: 0.6 },
  "fx.gore": { kind: "slash", color: 0xe0a060, radius: 1 },
  "fx.arrow": { kind: "hit", color: ELEMENT_COLOR.phys, radius: 0.5 },
  "fx.firebolt": { kind: "explosion", color: ELEMENT_COLOR.fire, radius: 0.8 },
  "fx.frostbolt": { kind: "nova", color: ELEMENT_COLOR.cold, radius: 1 },
  "fx.shadebolt": { kind: "hit", color: 0x9a7bd8, radius: 0.8 },
  "fx.raise": { kind: "portal", color: 0x8fbf7a, radius: 1 },
  "fx.ember_burst": { kind: "nova", color: ELEMENT_COLOR.fire, radius: 2 },
  "fx.sentry_bolt": { kind: "hit", color: ELEMENT_COLOR.lightning, radius: 0.6 },
  "fx.boss_slam": { kind: "nova", color: 0xc8873a, radius: 3 },
  "fx.boss_nova": { kind: "nova", color: ELEMENT_COLOR.fire, radius: 4 },
  "fx.boss_volley": { kind: "cast", color: 0xff9a5a, radius: 1 },
  "fx.boss_summon": { kind: "portal", color: 0x8a5a3a, radius: 1.5 },
};
const DEFAULT_EFFECT: EffectRow = { kind: "cast", color: 0xffffff, radius: 0.6 };

/** Renderer effect for an effect id at a fractional tile position. */
export function effectSpec(effect: string, x: number, y: number, radiusSub = 0): EffectSpec {
  const row = EFFECT_TABLE[effect] ?? DEFAULT_EFFECT;
  const radius = radiusSub > 0 ? radiusSub / SUB : row.radius;
  return {
    kind: row.kind,
    x,
    y,
    radius,
    color: row.color,
    sprite: effect,
  };
}

const tile = (sub: number): number => sub / SUB;

function nameOf(env: EffectEnv, e: Entity): string {
  if (e !== 0 && env.world.exists(e)) {
    const m = env.world.get(e, Monster);
    if (m) return m.name;
    const h = env.world.get(e, Hero);
    if (h) return h.name;
  }
  return "something";
}

function skillName(registry: FrozenRegistry, id: string): string {
  return registry.get<SkillProto>(KIND.skill, id)?.name ?? id;
}

/** Plans the visuals of one event. Unknown events produce no visuals. */
export function planEvent(raw: GameEvent, env: EffectEnv): Visual[] {
  const ev = raw as unknown as ClassicEvent;
  const out: Visual[] = [];
  const log = (logKind: LogKind, text: string, color: number): void => {
    out.push({ kind: "log", logKind, text, color });
  };
  const toast = (toastKind: Toast["kind"], title: string, body: string, ms = TOAST_MS): void => {
    out.push({ kind: "toast", toastKind, title, body, ms });
  };

  switch (ev.type) {
    case "classic.hit": {
      const x = tile(ev.x);
      const y = tile(ev.y);
      const color = ev.heroHit ? LOG_COLOR.hurt : ELEMENT_COLOR[ev.element];
      if (env.showDamageNumbers) {
        out.push({
          kind: "float",
          x,
          y,
          text: ev.crit ? `${ev.amount}!` : `${ev.amount}`,
          color,
          size: ev.crit ? "l" : ev.dot ? "s" : "m",
        });
      }
      if (!ev.dot) {
        out.push({
          kind: "effect",
          spec: { kind: "hit", x, y, radius: 0.35, color: ELEMENT_COLOR[ev.element] },
        });
      }
      if (!ev.dot && ev.byHero) {
        const target = nameOf(env, ev.target);
        log(
          "combat",
          ev.crit
            ? `Critical hit on ${target} for ${ev.amount}`
            : `You hit ${target} for ${ev.amount}`,
          ev.crit ? LOG_COLOR.gold : LOG_COLOR.combat,
        );
      } else if (ev.heroHit && !ev.dot) {
        log("combat", `${nameOf(env, ev.source)} hits you for ${ev.amount}`, LOG_COLOR.hurt);
      }
      return out;
    }
    case "classic.miss": {
      if (env.showDamageNumbers) {
        out.push({
          kind: "float",
          x: tile(ev.x),
          y: tile(ev.y),
          text: "miss",
          color: 0x9aa4b2,
          size: "s",
        });
      }
      return out;
    }
    case "classic.cast": {
      out.push({ kind: "effect", spec: effectSpec(ev.effect, tile(ev.x), tile(ev.y)) });
      return out;
    }
    case "classic.effect": {
      const spec = effectSpec(ev.effect, tile(ev.x), tile(ev.y), ev.radius);
      if (ev.points.length > 0)
        spec.points = ev.points.map((p) => ({ x: tile(p.x), y: tile(p.y) }));
      out.push({ kind: "effect", spec });
      return out;
    }
    case "classic.death": {
      const color = ev.rarity === "hero" ? LOG_COLOR.death : MONSTER_COLOR[ev.rarity];
      if (!ev.isHero) {
        if (ev.rarity === "champion" || ev.rarity === "unique" || ev.rarity === "boss") {
          out.push({
            kind: "effect",
            spec: { kind: "explosion", x: tile(ev.x), y: tile(ev.y), radius: 1, color },
          });
        }
        const killedByHero = ev.killer !== 0 && ev.killer === env.hero;
        log(
          killedByHero ? "combat" : "system",
          killedByHero ? `You slew ${ev.name}` : `${ev.name} dies`,
          color,
        );
      }
      return out;
    }
    case "classic.heal": {
      out.push({
        kind: "float",
        x: tile(ev.x),
        y: tile(ev.y),
        text: `+${ev.amount}`,
        color: ELEMENT_COLOR.poison,
        size: "m",
      });
      return out;
    }
    case "classic.xp": {
      return out;
    }
    case "classic.levelUp": {
      out.push({
        kind: "effect",
        spec: { kind: "levelup", x: env.heroX, y: env.heroY, radius: 2, color: LOG_COLOR.level },
      });
      toast(
        "levelUp",
        `Level ${ev.level}`,
        `+${ev.statPoints} attribute points, +${ev.skillPoints} skill points`,
        TOAST_LONG_MS,
      );
      log("level", `You reached level ${ev.level}`, LOG_COLOR.level);
      return out;
    }
    case "classic.skillLearned": {
      log(
        "level",
        `Learned ${skillName(env.registry, ev.skill)} (rank ${ev.rank})`,
        LOG_COLOR.level,
      );
      return out;
    }
    case "classic.hero.created": {
      const cls = env.registry.get<ClassProto>(KIND.class, ev.classId);
      log("system", `${ev.name} the ${cls?.name ?? ev.classId} enters the town`, LOG_COLOR.system);
      return out;
    }
    case "classic.hero.died": {
      toast(
        "death",
        "You have died",
        `Lost ${ev.goldLost} gold and ${ev.xpLost} XP. Respawning soon.`,
        TOAST_LONG_MS,
      );
      log(
        "death",
        `You died to ${ev.killer}. Lost ${ev.goldLost} gold, ${ev.xpLost} XP.`,
        LOG_COLOR.death,
      );
      return out;
    }
    case "classic.hero.respawned": {
      log("system", "You return to town.", LOG_COLOR.system);
      return out;
    }
    case "classic.quest.accepted": {
      const q = env.registry.get<{ name: string }>(KIND.quest, ev.quest);
      toast("quest", "Quest accepted", q?.name ?? ev.quest);
      log("quest", `Accepted: ${q?.name ?? ev.quest}`, LOG_COLOR.quest);
      return out;
    }
    case "classic.quest.progress": {
      const q = env.registry.get<{ name: string }>(KIND.quest, ev.quest);
      log("quest", `${q?.name ?? ev.quest}: ${ev.progress}/${ev.count}`, LOG_COLOR.quest);
      return out;
    }
    case "classic.quest.done": {
      const q = env.registry.get<{ name: string }>(KIND.quest, ev.quest);
      toast("quest", "Quest complete", q?.name ?? ev.quest);
      log("quest", `Complete: ${q?.name ?? ev.quest}`, LOG_COLOR.quest);
      return out;
    }
    case "classic.quest.completed": {
      toast("quest", "Reward", `+${ev.gold} gold, +${ev.xp} XP`);
      log("quest", `Reward: ${ev.gold} gold, ${ev.xp} XP`, LOG_COLOR.quest);
      return out;
    }
    case "classic.loot.dropped": {
      if (ev.kind !== "item") return out;
      if (ev.rarity === "unique") {
        toast("loot", "Unique item", ev.name, TOAST_LONG_MS);
      }
      if (ev.rarity !== "normal") log("loot", `Dropped: ${ev.name}`, RARITY_COLOR[ev.rarity]);
      return out;
    }
    case "classic.loot.picked": {
      if (ev.kind === "item") log("loot", `Picked up ${ev.name}`, RARITY_COLOR[ev.rarity]);
      return out;
    }
    case "classic.gold": {
      if (ev.amount > 0) {
        out.push({
          kind: "float",
          x: env.heroX,
          y: env.heroY,
          text: `+${ev.amount} gold`,
          color: GOLD_COLOR,
          size: "s",
        });
      }
      return out;
    }
    case "classic.item.equipped": {
      log("system", `Equipped ${ev.name}`, LOG_COLOR.system);
      return out;
    }
    case "classic.vendor.bought": {
      log("system", `Bought ${ev.name} for ${ev.price} gold`, LOG_COLOR.gold);
      return out;
    }
    case "classic.vendor.sold": {
      log("system", `Sold ${ev.name} for ${ev.price} gold`, LOG_COLOR.gold);
      return out;
    }
    case "classic.bag.full": {
      log("system", "Your bag is full.", LOG_COLOR.system);
      return out;
    }
    case "classic.area.changed": {
      toast("area", ev.name, ev.depth === 0 ? "Back in town" : `Depth ${ev.depth}`);
      log("system", `Entering ${ev.name}`, LOG_COLOR.system);
      return out;
    }
    case "classic.level.cleared": {
      toast("info", "Level cleared", `Depth ${ev.depth} is clear.`);
      log("level", `Depth ${ev.depth} cleared`, LOG_COLOR.level);
      return out;
    }
    case "classic.boss.spawned": {
      const m = env.registry.get<MonsterProto>(KIND.monster, ev.monster);
      toast("info", "A boss awakens", m?.name ?? ev.monster, TOAST_LONG_MS);
      log("system", `${m?.name ?? ev.monster} has awakened`, MONSTER_COLOR.boss);
      return out;
    }
    case "classic.boss.killed": {
      const m = env.registry.get<MonsterProto>(KIND.monster, ev.monster);
      toast("loot", "Boss slain", m?.name ?? ev.monster, TOAST_LONG_MS);
      log("level", `${m?.name ?? ev.monster} is slain`, LOG_COLOR.level);
      return out;
    }
    case "classic.waypoint.unlocked": {
      toast("info", "Waypoint unlocked", `Depth ${ev.depth}`);
      return out;
    }
    case "classic.portal.opened": {
      log("system", "A town portal opens.", LOG_COLOR.system);
      return out;
    }
    case "classic.npc.opened": {
      const npc = env.registry.get<NpcProto>(KIND.npc, ev.proto);
      if (ev.role === "smith" || ev.role === "alchemist" || ev.role === "junk") {
        out.push({ kind: "vendor", npc: ev.npc });
        out.push({ kind: "panel", panel: "vendor" });
      } else if (ev.role === "quest") {
        out.push({ kind: "panel", panel: "quests" });
      }
      if (npc) log("system", `${npc.name}: "${npc.greeting}"`, LOG_COLOR.system);
      return out;
    }
    case "classic.stash.opened": {
      out.push({ kind: "panel", panel: "stash" });
      return out;
    }
    case "classic.waypoint.opened": {
      out.push({ kind: "panel", panel: "waypoint" });
      return out;
    }
    case "classic.control": {
      const speed = ev.speed > 1 ? ` x${ev.speed}` : "";
      log("system", `Control: ${ev.mode}${speed}`, LOG_COLOR.system);
      return out;
    }
    case "classic.auto.plan": {
      const text = planLogText(ev.plan, ev.note);
      if (text) log("system", text, LOG_COLOR.system);
      return out;
    }
    case "classic.auto.notice": {
      log("system", ev.message, LOG_COLOR.system);
      return out;
    }
    case "classic.offline.summary": {
      const minutes = Math.floor(ev.ms / 60000);
      const body = `${minutes} min: ${ev.kills} kills, ${ev.xp} XP, ${ev.gold} gold, ${ev.items} items`;
      toast("offline", "While you were away", body, TOAST_LONG_MS);
      log("system", `Offline: ${body}`, LOG_COLOR.system);
      return out;
    }
    case "classic.command.failed": {
      if (env.manual) out.push({ kind: "error", code: ev.code, message: ev.message });
      log("system", ev.message, LOG_COLOR.system);
      return out;
    }
    default:
      return out;
  }
}

/** Display names for the hero class (used by tests and the vendor panel). */
export function classNameOf(registry: FrozenRegistry, id: string): string {
  return registry.get<ClassProto>(KIND.class, id)?.name ?? id;
}

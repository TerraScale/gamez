/**
 * Sim event fan-out of the classic client (docs/design/classic.md §12.3).
 * Pure: turns one GameEvent into a list of Visuals (float texts, renderer
 * effects, combat-log lines, toasts, panel openings). game.ts applies them to
 * the renderer and the stores. Positions in events are sub units; visuals use
 * fractional tiles.
 */
import type { Entity, FrozenRegistry, GameEvent, World } from "@gamez/kernel";
import type { EffectKind, EffectSpec, ParticleStyle } from "@gamez/ui-host";
import type { ClassicEvent } from "../events.ts";
import { ERR } from "../actions.ts";
import { Hero, Monster, Talents } from "../components.ts";
import { SUB } from "../fixed.ts";
import {
  KIND,
  type ClassProto,
  type ItemBaseProto,
  type MonsterProto,
  type SetProto,
  type SkillProto,
  type NpcProto,
  type TalentNodeProto,
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
import { depthLabel } from "./hud/format.ts";

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
  /** Sim speed (1, 2, 4 or 8). Telegraph fills last ticks x 50 / speed ms. Default 1. */
  speed?: number;
}

export type Visual =
  | { kind: "float"; x: number; y: number; text: string; color: number; size: "s" | "m" | "l" }
  | { kind: "effect"; spec: EffectSpec }
  | { kind: "log"; logKind: LogKind; text: string; color: number }
  | { kind: "toast"; toastKind: Toast["kind"]; title: string; body: string; ms: number }
  | { kind: "panel"; panel: PanelId }
  | { kind: "vendor"; npc: Entity }
  /** The gambler NPC opened: the gamble panel follows it (closed when the hero walks away). */
  | { kind: "gambler"; npc: Entity }
  /** Camera shake (renderer.shake?.(strength, ms)), e.g. boss phase changes. */
  | { kind: "shake"; strength: number; ms: number }
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

/** Healing numbers and heal effects: a white-green, distinct from poison. */
export const HEAL_COLOR = 0xb8ffcc;

interface EffectRow {
  kind: EffectKind;
  color: number;
  radius: number;
  /** Particle preset of the effect's burst (renderer style, wave A). */
  style: ParticleStyle;
}

/** Effect id -> renderer effect (docs/design/classic.md §12.3, wave-A.md §10.1). */
export const EFFECT_TABLE: Readonly<Record<string, EffectRow>> = {
  "fx.frost_ring": { kind: "nova", color: ELEMENT_COLOR.cold, radius: 3, style: "frost" },
  "fx.cinder_orb": { kind: "explosion", color: ELEMENT_COLOR.fire, radius: 1.5, style: "ember" },
  "fx.arc_chain": { kind: "chain", color: ELEMENT_COLOR.lightning, radius: 0, style: "spark" },
  "fx.phase_step": { kind: "blink", color: 0xb8c4ff, radius: 0.5, style: "arcane" },
  "fx.tumble": { kind: "blink", color: 0x8a6bd1, radius: 0.5, style: "shadow" },
  "fx.mend": { kind: "heal", color: HEAL_COLOR, radius: 0.8, style: "holy" },
  "fx.whirl": { kind: "nova", color: 0xb8d4ff, radius: 1.5, style: "dust" },
  "fx.slam": { kind: "nova", color: 0xc8873a, radius: 2, style: "dust" },
  "fx.burst": { kind: "explosion", color: ELEMENT_COLOR.poison, radius: 1.5, style: "poison" },
  "fx.rally": { kind: "nova", color: GOLD_COLOR, radius: 1.5, style: "gold" },
  "fx.charge": { kind: "slash", color: 0xffd27a, radius: 1, style: "dust" },
  // Hero skills.
  "fx.attack": { kind: "slash", color: ELEMENT_COLOR.phys, radius: 0.8, style: "dust" },
  "fx.cleave": { kind: "slash", color: 0xffd28a, radius: 1.5, style: "dust" },
  "fx.multishot": { kind: "cast", color: 0xd9c08a, radius: 0.6, style: "dust" },
  "fx.venom_shot": { kind: "hit", color: ELEMENT_COLOR.poison, radius: 0.8, style: "poison" },
  "fx.spark_sentry": { kind: "cast", color: ELEMENT_COLOR.lightning, radius: 0.8, style: "spark" },
  "fx.ember_bolt": { kind: "explosion", color: ELEMENT_COLOR.fire, radius: 0.8, style: "ember" },
  // Monster and boss skills.
  "fx.claw": { kind: "slash", color: 0xd9534f, radius: 0.8, style: "blood" },
  "fx.bite": { kind: "slash", color: 0xc84040, radius: 0.6, style: "blood" },
  "fx.gore": { kind: "slash", color: 0xe0a060, radius: 1, style: "blood" },
  "fx.arrow": { kind: "hit", color: ELEMENT_COLOR.phys, radius: 0.5, style: "dust" },
  "fx.firebolt": { kind: "explosion", color: ELEMENT_COLOR.fire, radius: 0.8, style: "ember" },
  "fx.frostbolt": { kind: "nova", color: ELEMENT_COLOR.cold, radius: 1, style: "frost" },
  "fx.shadebolt": { kind: "hit", color: 0x9a7bd8, radius: 0.8, style: "shadow" },
  "fx.raise": { kind: "portal", color: 0x8fbf7a, radius: 1, style: "poison" },
  "fx.ember_burst": { kind: "nova", color: ELEMENT_COLOR.fire, radius: 2, style: "ember" },
  "fx.sentry_bolt": { kind: "hit", color: ELEMENT_COLOR.lightning, radius: 0.6, style: "spark" },
  "fx.boss_slam": { kind: "nova", color: 0xc8873a, radius: 3, style: "dust" },
  "fx.boss_nova": { kind: "nova", color: ELEMENT_COLOR.fire, radius: 4, style: "ember" },
  "fx.boss_volley": { kind: "cast", color: 0xff9a5a, radius: 1, style: "ember" },
  "fx.boss_summon": { kind: "portal", color: 0x8a5a3a, radius: 1.5, style: "shadow" },
  // Wave A skills and boss moves (docs/design/wave-A.md §4, §6).
  "fx.quake_stomp": { kind: "nova", color: 0xb08a5a, radius: 2, style: "dust" },
  "fx.iron_skin": { kind: "aura", color: 0xcfd6dd, radius: 0.8, style: "gold" },
  "fx.sky_leap": { kind: "blink", color: 0x9fd3ff, radius: 0.8, style: "arcane" },
  "fx.piercing_shot": { kind: "hit", color: 0xf2f2f2, radius: 0.5, style: "spark" },
  "fx.caltrops": { kind: "aura", color: 0x8a7a5a, radius: 1.2, style: "blood" },
  "fx.night_volley": { kind: "cast", color: 0x6b5ba8, radius: 0.8, style: "shadow" },
  "fx.glacial_spike": { kind: "hit", color: 0x9fe6ff, radius: 0.7, style: "frost" },
  "fx.storm_call": {
    kind: "explosion",
    color: ELEMENT_COLOR.lightning,
    radius: 1.5,
    style: "spark",
  },
  "fx.falling_star": { kind: "explosion", color: ELEMENT_COLOR.fire, radius: 1.2, style: "ember" },
  "fx.boss_quake": { kind: "nova", color: 0xa0703a, radius: 4, style: "dust" },
  "fx.boss_cleave": { kind: "slash", color: 0xe0604a, radius: 2, style: "blood" },
  "fx.boss_rush": { kind: "slash", color: 0xd9a050, radius: 1.5, style: "dust" },
  "fx.boss_meteor": { kind: "explosion", color: 0xff6a3d, radius: 3, style: "ember" },
  "fx.boss_frost_nova": { kind: "nova", color: ELEMENT_COLOR.cold, radius: 4, style: "frost" },
  "fx.telegraph": { kind: "telegraph", color: 0xff5a3d, radius: 1, style: "arcane" },
};
const DEFAULT_EFFECT: EffectRow = { kind: "cast", color: 0xffffff, radius: 0.6, style: "dust" };

/** How float texts are thinned out at a sim speed (Full Idle x2-x8). */
export interface FloatPolicy {
  /** Drop small floats ("miss", damage over time). */
  dropMinor: boolean;
  /** Float lifetime (ms); undefined keeps the renderer default (900 ms). */
  ms: number | undefined;
  /** At most this many floats per simulated batch (one frame's ticks). */
  perBatch: number;
}

/**
 * Float volume by sim speed. At x1/x2 every float shows. From x4 the many
 * small floats ("miss", dots) are dropped, floats live shorter (they would
 * otherwise pile up around the hero) and each frame's batch is capped.
 */
export function floatPolicy(speed: number): FloatPolicy {
  if (speed >= 8) return { dropMinor: true, ms: 550, perBatch: 6 };
  if (speed >= 4) return { dropMinor: true, ms: 700, perBatch: 8 };
  return { dropMinor: false, ms: undefined, perBatch: Number.POSITIVE_INFINITY };
}

/** Dimmed grey for "miss" floats so they do not compete with damage numbers. */
const MISS_COLOR = 0x6b7380;

/** Human message for a failed cast, by ActionError / order code. */
export const CAST_FAIL_MESSAGE: Readonly<Record<string, string>> = {
  [ERR.noMana]: "Not enough mana",
  [ERR.cooldown]: "Not ready yet",
  [ERR.tooFar]: "Out of range",
  [ERR.busy]: "You are busy",
  [ERR.dead]: "You are dead",
  [ERR.badTarget]: "Invalid target",
  [ERR.notKnown]: "You have not learned this skill",
  [ERR.unknownId]: "Unknown skill",
};

/** Error text for a failed cast by the hero (falls back to naming the skill). */
export function castFailMessage(code: string, skillLabel: string): string {
  return CAST_FAIL_MESSAGE[code] ?? `Cannot cast ${skillLabel}`;
}

/** "1 skill point" / "5 skill points" (zero yields an empty string). */
function countOf(n: number, one: string): string {
  if (n <= 0) return "";
  return `+${n} ${n === 1 ? one : `${one}s`}`;
}

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
    style: row.style,
  };
}

/** One telegraph step (classic angles are 0..63 steps of a full turn) in radians. */
export const STEP_RAD = (2 * Math.PI) / 64;
/** Telegraph colour when the effect has no table row. */
export const TELEGRAPH_COLOR = 0xff5a3d;
/** Crafting and gambling floats and log colours (smith and gambler services). */
export const CRAFT_COLOR = 0x9fd8ff;
/** Durability warnings (worn items). */
export const WORN_COLOR = 0xffb84d;
/** Broken items and failed crafts. */
const BROKEN_COLOR = 0xff5a5a;

/**
 * Danger-zone effect of a telegraph (renderer kind "telegraph"): a circle
 * (radius), a cone (radius = length, angle, arc) or a line (angle, length,
 * width). Fill time = ticks x 50 ms / speed, so x8 fills in an eighth of the time.
 */
export function telegraphSpec(
  ev: Extract<ClassicEvent, { type: "classic.telegraph" }>,
  speed: number,
): EffectSpec {
  const row = EFFECT_TABLE[ev.effect];
  const sp = speed >= 1 ? speed : 1;
  const spec: EffectSpec = {
    kind: "telegraph",
    x: tile(ev.x),
    y: tile(ev.y),
    radius: tile(ev.radius),
    color: row?.color ?? TELEGRAPH_COLOR,
    durationMs: Math.round((Math.max(1, ev.ticks) * 50) / sp),
    sprite: "fx.telegraph",
    style: row?.style ?? "arcane",
  };
  if (ev.shape === "cone") {
    spec.radius = ev.length > 0 ? tile(ev.length) : tile(ev.radius);
    spec.angle = ev.angle * STEP_RAD;
    spec.arc = ev.arc * STEP_RAD;
  } else if (ev.shape === "line") {
    spec.angle = ev.angle * STEP_RAD;
    spec.length = tile(ev.length);
    spec.width = tile(ev.width);
  }
  return spec;
}

const tile = (sub: number): number => sub / SUB;

/** nameOf when the entity is gone or has no name. */
const UNKNOWN_NAME = "something";

function nameOf(env: EffectEnv, e: Entity): string {
  if (e !== 0 && env.world.exists(e)) {
    const m = env.world.get(e, Monster);
    if (m) return m.name;
    const h = env.world.get(e, Hero);
    if (h) return h.name;
  }
  return UNKNOWN_NAME;
}

function skillName(registry: FrozenRegistry, id: string): string {
  return registry.get<SkillProto>(KIND.skill, id)?.name ?? id;
}

/** True for arc-shape skills (cleave): their swing is drawn by classic.effect at fire time. */
function isArcSkill(registry: FrozenRegistry, id: string): boolean {
  return registry.get<SkillProto>(KIND.skill, id)?.shape === "arc";
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
  /** Short float above the hero (crafting results). */
  const floatAtHero = (text: string, color: number): void => {
    out.push({ kind: "float", x: env.heroX, y: env.heroY, text, color, size: "m" });
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
        // The source can be gone already (a projectile from a monster that died since).
        const who = nameOf(env, ev.source);
        log(
          "combat",
          who === UNKNOWN_NAME
            ? `You are hit for ${ev.amount}`
            : `${who} hits you for ${ev.amount}`,
          LOG_COLOR.hurt,
        );
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
          color: MISS_COLOR,
          size: "s",
        });
      }
      return out;
    }
    case "classic.cast": {
      // Arc swings (cleave) are drawn when they fire, oriented, by their
      // classic.effect; a real caster's cast event would only double them.
      if (ev.caster !== 0 && env.world.exists(ev.caster) && isArcSkill(env.registry, ev.skill))
        return out;
      const spec = effectSpec(ev.effect, tile(ev.x), tile(ev.y));
      // Slashes point at the aim (the renderer orients them from x,y toward x2,y2).
      if (spec.kind === "slash" && (ev.tx !== ev.x || ev.ty !== ev.y)) {
        spec.x2 = tile(ev.tx);
        spec.y2 = tile(ev.ty);
      }
      out.push({ kind: "effect", spec });
      return out;
    }
    case "classic.cast.failed": {
      // Only the hero's own failed casts are shown; monsters fail silently.
      if (ev.caster === env.hero && env.hero !== 0) {
        const label = skillName(env.registry, ev.skill);
        out.push({
          kind: "error",
          code: ev.code,
          message: castFailMessage(ev.code, label),
        });
      }
      return out;
    }
    case "classic.effect": {
      const spec = effectSpec(ev.effect, tile(ev.x), tile(ev.y), ev.radius);
      const tip = ev.points.length === 1 ? ev.points[0] : undefined;
      if (spec.kind === "slash" && tip !== undefined) {
        // Arc swing: one point = the aim tip; the slash sweeps around it.
        spec.x2 = tile(tip.x);
        spec.y2 = tile(tip.y);
      } else if (ev.points.length > 0) {
        spec.points = ev.points.map((p) => ({ x: tile(p.x), y: tile(p.y) }));
      }
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
      if (ev.amount > 0) {
        out.push({
          kind: "float",
          x: tile(ev.x),
          y: tile(ev.y),
          text: `+${ev.amount}`,
          color: HEAL_COLOR,
          size: "m",
        });
      }
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
      const points = [
        countOf(ev.statPoints, "attribute point"),
        countOf(ev.skillPoints, "skill point"),
      ].filter((p) => p !== "");
      toast("levelUp", `Level ${ev.level}`, points.join(", "), TOAST_LONG_MS);
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
      toast("area", ev.name, ev.depth === 0 ? "Back in town" : depthLabel(ev.depth));
      log("system", `Entering ${ev.name}`, LOG_COLOR.system);
      return out;
    }
    case "classic.level.cleared": {
      toast("info", "Level cleared", `${depthLabel(ev.depth)} is clear.`);
      log("level", `${depthLabel(ev.depth)} cleared`, LOG_COLOR.level);
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
      } else if (ev.role === "gambler") {
        out.push({ kind: "gambler", npc: ev.npc });
        out.push({ kind: "panel", panel: "gamble" });
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
    // ======================= wave A (docs/design/wave-A.md §10.1) =======================
    case "classic.telegraph": {
      out.push({ kind: "effect", spec: telegraphSpec(ev, env.speed ?? 1) });
      return out;
    }
    case "classic.boss.phase": {
      const m = env.registry.get<MonsterProto>(KIND.monster, ev.monster);
      const name = m?.name ?? ev.monster;
      const body = ev.message !== "" ? ev.message : `Phase ${ev.phase}`;
      toast("info", ev.enraged ? `${name} is enraged` : name, body, TOAST_LONG_MS);
      log("system", `${name}: ${body}`, MONSTER_COLOR.boss);
      out.push({ kind: "shake", strength: 6, ms: 400 });
      return out;
    }
    case "classic.item.broken": {
      log("death", `${ev.name} broke. Repair it at the smith.`, BROKEN_COLOR);
      out.push({ kind: "error", code: "broken", message: `${ev.name} broke` });
      return out;
    }
    case "classic.item.worn": {
      log("system", `${ev.name} is worn (10% durability or less)`, WORN_COLOR);
      return out;
    }
    case "classic.gambled": {
      log("loot", `Gambled: ${ev.name} for ${ev.price} gold`, RARITY_COLOR[ev.rarity]);
      if (ev.rarity === "unique" || ev.rarity === "set") {
        toast("loot", ev.rarity === "unique" ? "Unique item" : "Set item", ev.name, TOAST_LONG_MS);
      }
      return out;
    }
    case "classic.set.bonus": {
      const set = env.registry.get<SetProto>(KIND.set, ev.set);
      const name = set?.name ?? ev.name;
      toast("loot", "Set bonus", `${name}: ${ev.active} pieces worn`);
      log("loot", `${name} set: ${ev.active} pieces worn`, RARITY_COLOR.set);
      return out;
    }
    case "classic.repaired": {
      const n = ev.uids.length;
      floatAtHero("Repaired", CRAFT_COLOR);
      log(
        "system",
        `Repaired ${n === 1 ? "an item" : `${n} items`} for ${ev.cost} gold`,
        CRAFT_COLOR,
      );
      return out;
    }
    case "classic.upgraded": {
      if (ev.success) {
        floatAtHero(`+${ev.level}!`, GOLD_COLOR);
        log("system", `${ev.name} upgraded to +${ev.level} for ${ev.cost} gold`, CRAFT_COLOR);
      } else {
        floatAtHero("Upgrade failed", BROKEN_COLOR);
        log("death", `Upgrade of ${ev.name} failed (${ev.cost} gold)`, BROKEN_COLOR);
      }
      return out;
    }
    case "classic.rerolled": {
      floatAtHero("Rerolled", CRAFT_COLOR);
      log("system", `Rerolled ${ev.name} for ${ev.cost} gold`, CRAFT_COLOR);
      return out;
    }
    case "classic.socket.added": {
      floatAtHero("Socket added", CRAFT_COLOR);
      log("system", `Socket added (${ev.sockets} total) for ${ev.cost} gold`, CRAFT_COLOR);
      return out;
    }
    case "classic.gem.socketed": {
      const gem = env.registry.get<ItemBaseProto>(KIND.itemBase, ev.gem)?.name ?? ev.gem;
      floatAtHero("Socketed", CRAFT_COLOR);
      log("system", `Socketed ${gem}`, CRAFT_COLOR);
      return out;
    }
    case "classic.gems.removed": {
      floatAtHero("Gems removed", CRAFT_COLOR);
      log("system", `Removed ${ev.gems.length} gem(s) for ${ev.cost} gold`, CRAFT_COLOR);
      return out;
    }
    case "classic.gems.combined": {
      const from = env.registry.get<ItemBaseProto>(KIND.itemBase, ev.from)?.name ?? ev.from;
      const to = env.registry.get<ItemBaseProto>(KIND.itemBase, ev.to)?.name ?? ev.to;
      floatAtHero("Combined!", GOLD_COLOR);
      log("system", `Combined three ${from} into ${to} (${ev.cost} gold)`, CRAFT_COLOR);
      return out;
    }
    case "classic.talent.points": {
      // Auto/Idle may spend the point in the same step: toast only what is still unspent.
      const t = env.hero !== 0 ? env.world.get(env.hero, Talents) : undefined;
      const left = t ? t.points : ev.points;
      if (left > 0) toast("info", `Talent point (${left})`, "Press N to spend it");
      return out;
    }
    case "classic.talent.learned": {
      const node = env.registry.get<TalentNodeProto>(KIND.talent, ev.node);
      log("level", `Learned ${node?.name ?? ev.node} (rank ${ev.rank})`, LOG_COLOR.level);
      return out;
    }
    case "classic.talents.reset": {
      log(
        "system",
        `Talents reset: ${ev.refunded} points refunded for ${ev.cost} gold`,
        LOG_COLOR.system,
      );
      return out;
    }
    case "classic.rift.panel": {
      out.push({ kind: "panel", panel: "rift" });
      return out;
    }
    case "classic.rift.unlocked": {
      toast("info", "Rift unlocked", "Use the obelisk in town to open a rift level", TOAST_LONG_MS);
      log("system", "The Rift is unlocked", LOG_COLOR.level);
      return out;
    }
    case "classic.rift.opened": {
      toast("info", `Rift level ${ev.level}`, "Slay monsters to draw out the guardian");
      log("system", `Entered rift level ${ev.level}`, LOG_COLOR.system);
      return out;
    }
    case "classic.rift.progress": {
      log("system", `Rift ${ev.pct}% cleared`, LOG_COLOR.system);
      return out;
    }
    case "classic.rift.guardian": {
      toast("info", "Guardian awakened", ev.name, TOAST_LONG_MS);
      log("system", `${ev.name} guards the rift exit`, MONSTER_COLOR.boss);
      return out;
    }
    case "classic.rift.completed": {
      toast(
        "loot",
        "Rift complete",
        `Score ${ev.record.score}: +${ev.gold} gold, ${ev.items} items`,
        TOAST_LONG_MS,
      );
      log(
        "level",
        `Rift level ${ev.record.level} complete (score ${ev.record.score})`,
        LOG_COLOR.level,
      );
      return out;
    }
    case "classic.rift.failed": {
      const why = ev.record.reason === "death" ? "You fell in the rift" : "You left the rift";
      toast("death", "Rift failed", why, TOAST_LONG_MS);
      log("death", `Rift level ${ev.record.level} failed: ${why.toLowerCase()}`, LOG_COLOR.death);
      return out;
    }
    case "classic.achievement.unlocked": {
      const title = ev.title !== null ? ` - title "${ev.title}"` : "";
      toast("loot", `Achievement: ${ev.name}`, `+${ev.gold} gold${title}`, TOAST_LONG_MS);
      log("quest", `Achievement unlocked: ${ev.name}`, LOG_COLOR.quest);
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

/**
 * Scene sync of the classic client (docs/design/classic.md §12.3): maps the
 * current area of the sim to ArpgRenderEntity values, interpolates positions
 * between the last two ticks, upserts only what changed, removes what is gone,
 * keeps the map, lighting and camera in step, and picks entities near a
 * pointer. Pure apart from the renderer calls; tests use a fake renderer.
 */
import type { Entity, FrozenRegistry, World } from "@gamez/kernel";
import type { ArpgRenderEntity, EntityAction, Facing } from "@gamez/ui-host";
import type { TileMap } from "@gamez/world";
import {
  AreaTag,
  CombatStats,
  Dead,
  Hero,
  HeroStats,
  Interactable,
  Level,
  Life,
  Loot,
  Monster,
  Mover,
  Npc,
  Pos,
  Projectile,
  Reviving,
  Statuses,
  Summoned,
  Casting,
  Dash,
} from "../components.ts";
import { isPartyHero, partyMembers, partySize } from "../party/shared.ts";
import { SUB, facingOf } from "../fixed.ts";
import { lootFilterOf, RES, type AreaState, type QuestState } from "../resources.ts";
import { lootVisible } from "../loot.ts";
import {
  BALANCE_ID,
  KIND,
  type BalanceProto,
  type ClassProto,
  type GemKind,
  type ItemBaseProto,
  type ItemRarity,
  type MonsterModProto,
  type MonsterProto,
  type MonsterRarity,
  type NpcProto,
  type QuestProto,
  type SkillProto,
  type StatusProto,
  type ThemeProto,
} from "../types.ts";
import { getAreaMap, type ClassicMap } from "../world/maps.ts";
import { ELEMENT_COLOR, GOLD_COLOR, MONSTER_LABEL_COLOR, RARITY_COLOR } from "./contract.ts";
import {
  BOTTOM_BAR_HEIGHT,
  HUD_EDGE,
  minimapBlockHeight,
  TARGET_TOP,
  topRightInset,
  type HudLayout,
} from "./hud/layout.ts";

/** The renderer calls the scene needs (ArpgWorldRenderer satisfies this). */
export interface SceneRenderer {
  upsertEntity(e: ArpgRenderEntity): void;
  removeEntity(id: string): void;
  setMap(map: TileMap): void;
  snapCamera(x: number, y: number): void;
  setLighting(opts: { darkness: number; radius: number }): void;
  follow(x: number, y: number): void;
  /** Optional (the pixi renderer has it): tile point to CSS px, for the QA lookups in debug.ts. */
  tileToClient?(x: number, y: number): { x: number; y: number } | null;
}

/**
 * QA only: the renderer of the most recent SceneSync (debug.ts projects NPCs
 * to screen pixels through it). Never read by the sim or the HUD.
 */
let qaRenderer: SceneRenderer | null = null;

/** Screen point (CSS px) of a tile point on the current renderer, or null (no renderer / no lookup). */
export function qaTileToClient(x: number, y: number): { x: number; y: number } | null {
  return qaRenderer?.tileToClient?.(x, y) ?? null;
}

/**
 * "ally" (party, docs/design/party.md §10.4): a DOWNED party member; a tap
 * on it is an interact (classic.interact -> revive). Standing members are
 * never picks (clicks pass through them to the ground / monsters).
 */
export type PickKind = "unit" | "loot" | "npc" | "interactable" | "ally";

export interface Pick {
  kind: PickKind;
  entity: Entity;
  /** Rendered (interpolated) fractional tile position. */
  x: number;
  y: number;
}

export interface SceneInput {
  world: World;
  registry: FrozenRegistry;
  /** Render alpha 0..1 (interpolation between the last two ticks). */
  alpha: number;
  /** Monster under the pointer (0 = none): highlighted and shows its bar. */
  hovered: Entity;
  /** Monster the hero is engaged with (0 = none): shows its bar. */
  targeted: Entity;
  showLootLabels: boolean;
  lighting: boolean;
  /** Identity outline ("self") around the played hero; default true. */
  outlineHero?: boolean;
  /**
   * sim.tick at render time (ticks processed so far). The render time used for
   * hit flashes, swing progress and corpse fades is `tick - 1 + alpha`.
   */
  tick: number;
  /** Coarse pointer (touch): interact hints say "tap" instead of "click". */
  touch?: boolean;
}

export interface SceneStats {
  entities: number;
  monsters: number;
  /** Hero position (interpolated, tiles) or null. */
  heroX: number | null;
  heroY: number | null;
}

/** Positions further apart than this (sub) are not interpolated (teleports). */
export const TELEPORT_SUB = 3 * SUB;

/**
 * A control switch to a hero further than this (tiles) from the camera snaps
 * the view instead of panning across the map (docs/design/party.md §10.6).
 */
export const SWITCH_SNAP_TILES = 12;

const HERO_NAME_FALLBACK = "Hero";

function tintOf(v: number | undefined): number {
  return v === undefined || v === 0 ? 0xffffff : v;
}

/** Per-channel multiply of two 0xRRGGBB tints. */
export function multiplyTint(a: number, b: number): number {
  const ch = (shift: number): number =>
    Math.floor((((a >> shift) & 0xff) * ((b >> shift) & 0xff)) / 255);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Interpolated sub position between `prev` and `cur` (no interpolation over teleports). */
export function interpolate(
  prev: { x: number; y: number } | undefined,
  cur: { x: number; y: number },
  alpha: number,
): { x: number; y: number } {
  if (prev === undefined) return cur;
  const dx = cur.x - prev.x;
  const dy = cur.y - prev.y;
  if (Math.abs(dx) > TELEPORT_SUB || Math.abs(dy) > TELEPORT_SUB) return cur;
  if (dx === 0 && dy === 0) return cur;
  const a = Math.min(1, Math.max(0, alpha));
  return { x: prev.x + dx * a, y: prev.y + dy * a };
}

/** True when two render entities are equal in every field (cheap diff for upserts). */
export function sameEntity(a: ArpgRenderEntity, b: ArpgRenderEntity): boolean {
  const ka = Object.keys(a) as (keyof ArpgRenderEntity)[];
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Client-only animation timing. Everything below is keyed on sim ticks (the
// render time is `tick - 1 + alpha`), never on the wall clock, so speed x8
// plays the same sequence faster and a paused sim freezes it.
// ---------------------------------------------------------------------------

/** Ticks a hit flash (and the "hit" pose of an idle unit) lasts: 200 ms at 20 Hz. */
export const HIT_TICKS = 4;
/** A finished swing is held (last frame) this long, so back-to-back attacks never flash idle. */
export const SWING_HOLD_TICKS = 2;
/**
 * Clip progress at the cast's hit tick. Progress runs 0 -> HIT_PROGRESS from
 * startedAt to hitAt, then HIT_PROGRESS -> 1 from hitAt to the end of the
 * lock. The renderer shows frame floor(p * n), so the blow lands on frame
 * floor(n / 2): frame 2 of the 4-frame swings (lean [0, 6, 12, 4] px, frame 2
 * = the peak). The whole clip stretches with attack/cast speed and slows.
 */
export const HIT_PROGRESS = 0.5;
/** Monsters hit this recently (ticks, ~3 s) show their nameplate. */
export const RECENT_HIT_TICKS = 60;
/** Corpses (and expiring summons) fade out over their last ticks before removal. */
export const FADE_TICKS = 10;
/** Walk cycles are authored for the hero's base move speed (sub per tick). */
export const WALK_REF_SPEED = 51;
/** Interactables: labels for portal and stash within this range (tiles); the use hint within HINT_RANGE. */
export const STATION_LABEL_RANGE = 5;
export const HINT_RANGE = 3;
/** Closer than this (tiles) the hero stands on or next to the station: the use hint is dropped. */
export const HINT_NEAR = 1.5;

/** Nameplate de-overlap priority of monsters: bosses keep their place, then uniques, then champions. */
export const MONSTER_LABEL_PRIORITY: Readonly<Record<MonsterRarity, number>> = {
  boss: 3,
  unique: 2,
  champion: 1,
  normal: 0,
  minion: 0,
  summon: 0,
};

/** Monster rarities whose names get a dark backing plate. */
function platedRarity(r: MonsterRarity): boolean {
  return r === "champion" || r === "unique" || r === "boss";
}

/** Screen insets (CSS px) that keep world labels out from under the HUD chrome. */
export interface LabelInsetsPx {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * World label insets for a HUD layout (ArpgWorldRenderer.setLabelInsets),
 * from the HUD layout constants: the top region (area header, mode bar) down
 * to the target bar line, the bottom bar of the phone layouts, and, when the
 * minimap block reaches below that top line on a phone layout, the minimap
 * column on the right. The desktop minimap is left out: a 186 px column over
 * the whole height would hide too many labels on a wide screen.
 */
export function labelInsetsFor(layout: HudLayout, minimapShown: boolean): LabelInsetsPx {
  const top = TARGET_TOP[layout];
  const minimapBottom = HUD_EDGE + minimapBlockHeight(layout);
  const right =
    layout !== "desktop" && minimapShown && minimapBottom > top ? topRightInset(layout) : 0;
  return { top, right, bottom: BOTTOM_BAR_HEIGHT[layout], left: 0 };
}

/** Rounds v to 1/steps (keeps upserts from firing every frame for invisible changes). */
function quantize(v: number, steps: number): number {
  return Math.round(v * steps) / steps;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Swing/cast clip progress 0..1 at render time `t` (see HIT_PROGRESS). The
 * Casting component is removed at endAt - 1, so the clip ends there (at least
 * one tick after the hit).
 */
export function castProgress(t: number, startedAt: number, hitAt: number, endAt: number): number {
  if (t < hitAt && hitAt > startedAt) {
    return HIT_PROGRESS * clamp01((t - startedAt) / (hitAt - startedAt));
  }
  const end = Math.max(hitAt + 1, endAt - 1);
  return HIT_PROGRESS + (1 - HIT_PROGRESS) * clamp01((t - hitAt) / (end - hitAt));
}

/** Hit flash strength 1 -> 0 over HIT_TICKS after the hit tick (0 when none or over). */
export function hitFlashAt(t: number, hitTick: number | undefined): number {
  if (hitTick === undefined) return 0;
  const age = Math.max(0, t - hitTick);
  if (age >= HIT_TICKS) return 0;
  return quantize(1 - age / HIT_TICKS, 8);
}

/** Opacity of something removed at tick `removeAt`: 1, then a ramp to 0 over FADE_TICKS. */
export function fadeAlpha(t: number, removeAt: number): number {
  const left = removeAt - t;
  if (left >= FADE_TICKS) return 1;
  return quantize(clamp01(left / FADE_TICKS), 20);
}

/**
 * Render scale of a monster (percent). The art build already sizes each
 * monster (cairn brute, bosses...), so MonsterProto.scale is not applied a
 * second time; elites get a small bump so they stand out beyond their tint.
 */
export function monsterScale(rarity: MonsterRarity): number {
  if (rarity === "champion") return 110;
  if (rarity === "unique") return 115;
  return 100;
}

/** Walk clip speed for a move speed (sub/tick): speed / WALK_REF_SPEED, clamped 0.6..1.8. */
export function walkRate(speed: number): number {
  if (!(speed > 0)) return 1;
  const r = speed / WALK_REF_SPEED;
  return quantize(r < 0.6 ? 0.6 : r > 1.8 ? 1.8 : r, 20);
}

/** Loot label priority: rarer items keep their place, the rest stack above them. */
export const LOOT_PRIORITY: Readonly<Record<ItemRarity | "gold" | "potion", number>> = {
  unique: 6,
  set: 5,
  rare: 4,
  magic: 3,
  normal: 2,
  potion: 1,
  gold: 0,
};

/**
 * Quest marker of a quest-giver NPC (proto id `npc`): "?" when one of its
 * active quests is done (turn in), else "!" when one of its quests can be
 * accepted (level and chain met, not completed, not active), else null.
 * Same rules as the quest panel and the auto controller.
 */
export function questMarker(
  registry: FrozenRegistry,
  quests: QuestState | undefined,
  npc: string,
  level: number,
): "!" | "?" | null {
  let available = false;
  const completed = quests?.completed ?? [];
  const active = quests?.active ?? [];
  for (const [id, q] of registry.all<QuestProto>(KIND.quest)) {
    if (q.giver !== npc || completed.includes(id)) continue;
    const a = active.find((x) => x.id === id);
    if (a) {
      if (a.done) return "?";
      continue;
    }
    if (q.reqLevel <= level && (q.after === "" || completed.includes(q.after))) available = true;
  }
  return available ? "!" : null;
}

/** Move speed (sub/tick) a unit walks at right now: base x move speed % x (100 - slow)%. */
function moveSpeedOf(world: World, registry: FrozenRegistry, e: Entity, base: number): number {
  const pct = world.get(e, CombatStats)?.moveSpeed ?? 100;
  let slow = 0;
  for (const st of world.get(e, Statuses)?.list ?? []) {
    const proto = registry.get<StatusProto>(KIND.status, st.id);
    if (proto?.kind === "slow" && st.power > slow) slow = st.power;
  }
  if (slow > 90) slow = 90;
  return Math.floor((Math.floor((base * pct) / 100) * (100 - slow)) / 100);
}

/** Adds the optional animation fields of a unit (progress, hit flash, walk rate). */
function decorateUnit(
  ent: ArpgRenderEntity,
  a: UnitAnim,
  world: World,
  registry: FrozenRegistry,
  e: Entity,
  baseSpeed: number,
): void {
  if (a.progress !== undefined) ent.actionProgress = a.progress;
  if (a.flash > 0) {
    ent.hitFlash = a.flash;
    // The hit flash is white (additive overlay), the old red multiply tint is gone.
    ent.hitFlashColor = 0xffffff;
  }
  if (a.glow > 0) {
    ent.castGlow = a.glow;
    ent.glowColor = a.glowColor;
  }
  if (a.action === "walk" && baseSpeed > 0) {
    const rate = walkRate(moveSpeedOf(world, registry, e, baseSpeed));
    if (rate !== 1) ent.animRate = rate;
  }
}

function castAction(registry: FrozenRegistry, skill: string): EntityAction {
  const s = registry.get<SkillProto>(KIND.skill, skill);
  return s?.ai.tags.includes("basic") ? "attack" : "cast";
}

function statusTintOf(world: World, registry: FrozenRegistry, e: Entity): number {
  const list = world.get(e, Statuses)?.list ?? [];
  for (const s of list) {
    const proto = registry.get<StatusProto>(KIND.status, s.id);
    if (proto && proto.tint !== 0) return proto.tint;
  }
  return 0;
}

export function itemSprite(
  registry: FrozenRegistry,
  base: string,
): { appearance: string; color: number } {
  const b = registry.get<ItemBaseProto>(KIND.itemBase, base);
  if (!b) return { appearance: "loot.item", color: RARITY_COLOR.normal };
  if (b.category === "potion") {
    // Tiered id (loot.potion.life.3); resolves to loot.potion.<kind> until the tier art exists.
    const kind = b.potion?.kind ?? "life";
    const tier = b.potion?.tier ?? 0;
    const appearance = tier > 0 ? `loot.potion.${kind}.${tier}` : `loot.potion.${kind}`;
    return { appearance, color: RARITY_COLOR.normal };
  }
  return { appearance: `loot.item.${b.weaponClass ?? b.category}`, color: RARITY_COLOR.normal };
}

/** Gem tint on the ground (multiplied over loot.item.gem), by gem kind. */
export const GEM_COLOR: Readonly<Record<GemKind, number>> = {
  ruby: 0xe0405a,
  sapphire: 0x4a7bff,
  topaz: 0xf2c744,
  emerald: 0x3fbf6a,
  amethyst: 0xa86bd6,
  diamond: 0xeaf6ff,
};

/** Ground tint of a loot item: gems take their kind's colour, everything else stays white. */
export function lootTintOf(registry: FrozenRegistry, base: string): number {
  const b = registry.get<ItemBaseProto>(KIND.itemBase, base);
  if (b?.category === "gem" && b.gem) return GEM_COLOR[b.gem.kind];
  return 0xffffff;
}

/** Glow colour of a cast: the skill's damage element, the white of plain weapon skills otherwise. */
export function skillGlowColor(registry: FrozenRegistry, skill: string): number {
  const s = registry.get<SkillProto>(KIND.skill, skill);
  if (!s) return 0xffffff;
  if (s.damage) return ELEMENT_COLOR[s.damage.element];
  return 0xffffff;
}

/** Cast glow strength (0..1) while a unit is casting or swinging. */
export const CAST_GLOW = 0.8;
/** Loot hidden by the loot filter is still drawn, but this faded. */
export const HIDDEN_LOOT_ALPHA = 0.35;

export const STATION_APPEARANCE = {
  stairsDown: "prop.stairs.down",
  stairsUp: "prop.stairs.up",
  waypoint: "prop.waypoint",
  portal: "fx.portal",
  stash: "prop.stash",
  riftObelisk: "prop.rift.obelisk",
  riftExit: "fx.rift.exit",
} as const;
export const STATION_NAME = {
  stairsDown: "Stairs down",
  stairsUp: "Stairs up",
  waypoint: "Waypoint",
  portal: "Town portal",
  stash: "Stash",
  riftObelisk: "Rift obelisk",
  riftExit: "Rift exit",
} as const;

/** Action and clip progress of one unit this frame (scratch, reused). */
interface UnitAnim {
  action: EntityAction;
  progress: number | undefined;
  flash: number;
  /** 0 = no cast glow. */
  glow: number;
  glowColor: number;
}

export class SceneSync {
  private readonly drawn = new Map<string, ArpgRenderEntity>();
  /** Sub positions before the last step(), for interpolation. */
  private prev = new Map<Entity, { x: number; y: number }>();
  private map: ClassicMap | null = null;
  private lightingKey = "";
  private picks: Pick[] = [];
  private stats: SceneStats = { entities: 0, monsters: 0, heroX: null, heroY: null };
  /** Client-only: last tick each entity took a (non-dot) hit. */
  private readonly hits = new Map<Entity, number>();
  /** Champion packs whose nameplate is already shown this sync (one plate per pack). */
  private readonly packPlates = new Set<number>();
  /** Client-only: the last swing of each unit and the render time it was last seen. */
  private readonly swings = new Map<Entity, { action: EntityAction; at: number }>();
  /** The hero the camera last followed (a change is a control switch) and the camera's tile target. */
  private focusHero: Entity = 0;
  private camera: { x: number; y: number } | null = null;
  /** Subtitle "Reviving N%" of every member being revived this frame (rebuilt each render). */
  private readonly reviving = new Map<Entity, string>();
  private readonly anim: UnitAnim = {
    action: "idle",
    progress: undefined,
    flash: 0,
    glow: 0,
    glowColor: 0xffffff,
  };

  constructor(private readonly target: SceneRenderer) {
    qaRenderer = target;
  }

  /** Forgets everything drawn (new sim or renderer reset). */
  reset(): void {
    for (const id of this.drawn.keys()) this.target.removeEntity(id);
    this.drawn.clear();
    this.prev.clear();
    this.map = null;
    this.lightingKey = "";
    this.picks = [];
    this.hits.clear();
    this.swings.clear();
    this.focusHero = 0;
    this.camera = null;
    this.reviving.clear();
  }

  /**
   * A unit took a direct hit at sim tick `tick` (game.ts calls this for every
   * non-dot classic.hit). Drives the hit flash, the idle "hit" pose and the
   * nameplate of recently damaged monsters.
   */
  noteHit(target: Entity, tick: number): void {
    if (target !== 0) this.hits.set(target, tick);
  }

  /**
   * Action, clip progress and hit flash of a unit at render time t. Casting ->
   * attack/cast with progress; a swing that just ended is held at its last
   * frame for SWING_HOLD_TICKS instead of dropping to idle; an idle unit that
   * was just hit plays "hit".
   */
  private unitAnim(
    world: World,
    registry: FrozenRegistry,
    e: Entity,
    moving: boolean,
    dead: boolean,
    t: number,
  ): UnitAnim {
    const out = this.anim;
    out.progress = undefined;
    out.flash = hitFlashAt(t, this.hits.get(e));
    out.glow = 0;
    out.glowColor = 0xffffff;
    if (dead) {
      out.action = "death";
      this.swings.delete(e);
      return out;
    }
    const cast = world.get(e, Casting);
    if (cast) {
      out.action = castAction(registry, cast.skill);
      out.progress = quantize(castProgress(t, cast.startedAt, cast.hitAt, cast.endAt), 32);
      out.glow = CAST_GLOW;
      out.glowColor = skillGlowColor(registry, cast.skill);
      const rec = this.swings.get(e);
      if (rec) {
        rec.action = out.action;
        rec.at = t;
      } else {
        this.swings.set(e, { action: out.action, at: t });
      }
      return out;
    }
    out.action = moving || world.has(e, Dash) ? "walk" : "idle";
    if (out.action === "idle") {
      const rec = this.swings.get(e);
      if (rec && t - rec.at <= SWING_HOLD_TICKS) {
        out.action = rec.action;
        out.progress = 1;
        return out;
      }
      if (out.flash > 0) out.action = "hit";
    }
    this.swings.delete(e);
    return out;
  }

  /** Remembers the sim positions before a step(), so the next render can interpolate. */
  capture(world: World): void {
    this.prev.clear();
    const depth = currentDepthOf(world);
    for (const e of world.query(Pos, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const p = world.read(e, Pos);
      this.prev.set(e, { x: p.x, y: p.y });
    }
  }

  /** Draws the current area. Returns counts and the interpolated hero position. */
  render(input: SceneInput): SceneStats {
    const { world, registry } = input;
    const depth = currentDepthOf(world);
    const hero = heroEntityOf(world);
    const heroPos = hero !== 0 ? interpolatedHero(world, hero, this.prev, input.alpha) : null;
    /** Render time in ticks: the last processed tick plus the interpolation alpha. */
    const t = input.tick - 1 + Math.min(1, Math.max(0, input.alpha));
    const corpseTicks = registry.get<BalanceProto>(KIND.balance, BALANCE_ID)?.corpseTicks ?? 40;

    this.updateMap(input, hero, heroPos);
    this.updateLighting(input);

    // Revive channels (docs/design/party.md §7.3): progress shown on the downed target.
    this.reviving.clear();
    for (const r of world.query(Reviving)) {
      const rv = world.read(r, Reviving);
      const span = Math.max(1, rv.until - rv.startedAt);
      const frac = clamp01((input.tick - rv.startedAt) / span);
      this.reviving.set(rv.target, `Reviving ${Math.floor(frac * 20) * 5}%`);
    }
    // Summon ownership ink only matters with a party (solo output stays identical).
    const partyTinted = partySize(world) > 1;

    const seen = new Set<string>();
    const picks: Pick[] = [];
    let monsters = 0;
    const put = (entity: Entity, e: ArpgRenderEntity, pick: PickKind | null): void => {
      const id = e.id;
      seen.add(id);
      const prevDrawn = this.drawn.get(id);
      if (!prevDrawn || !sameEntity(prevDrawn, e)) {
        this.target.upsertEntity(e);
        this.drawn.set(id, e);
      }
      if (pick !== null) picks.push({ kind: pick, entity, x: e.x, y: e.y });
    };

    // Hero.
    if (hero !== 0 && heroPos !== null) {
      const m = world.get(hero, Mover);
      const heroComp = world.get(hero, Hero);
      const proto = heroComp ? registry.get<ClassProto>(KIND.class, heroComp.classId) : undefined;
      const a = this.unitAnim(world, registry, hero, m?.moving ?? false, world.has(hero, Dead), t);
      const ent: ArpgRenderEntity = {
        id: `c${hero}`,
        name: heroComp?.name ?? HERO_NAME_FALLBACK,
        appearance: proto?.appearance ?? "unit.hero",
        fallbackAppearance: "unit.hero",
        kind: "unit",
        x: heroPos.x / SUB,
        y: heroPos.y / SUB,
        facing: (m?.facing ?? "s") as Facing,
        moving: m?.moving ?? false,
        isSelf: true,
        action: a.action,
        tint: tintOf(proto?.tint),
        scale: 100,
        highlight: input.outlineHero === false ? null : "self",
        statusTint: statusTintOf(world, registry, hero),
      };
      const reviving = this.reviving.get(hero);
      if (reviving !== undefined) ent.subtitle = reviving;
      decorateUnit(ent, a, world, registry, hero, m?.speed ?? 0);
      put(hero, ent, null);
    }

    // Party followers: every other member, slot order. Name plate and the "party" outline;
    // a downed member takes the dead pose and is a pick ("ally": a tap revives it).
    for (const m of partyMembers(world)) {
      if (m === hero) continue;
      const cur = world.get(m, Pos);
      if (cur === undefined || world.get(m, AreaTag)?.depth !== depth) continue;
      const pos = interpolate(this.prev.get(m), cur, input.alpha);
      const mover = world.get(m, Mover);
      const heroComp = world.get(m, Hero);
      const proto = heroComp ? registry.get<ClassProto>(KIND.class, heroComp.classId) : undefined;
      const dead = world.has(m, Dead);
      const a = this.unitAnim(world, registry, m, mover?.moving ?? false, dead, t);
      const ent: ArpgRenderEntity = {
        id: `c${m}`,
        name: heroComp?.name ?? HERO_NAME_FALLBACK,
        appearance: proto?.appearance ?? "unit.hero",
        fallbackAppearance: "unit.hero",
        kind: "unit",
        x: pos.x / SUB,
        y: pos.y / SUB,
        facing: (mover?.facing ?? "s") as Facing,
        moving: mover?.moving ?? false,
        isSelf: false,
        action: a.action,
        tint: tintOf(proto?.tint),
        scale: 100,
        highlight: "party",
        showLabel: true,
        statusTint: statusTintOf(world, registry, m),
      };
      const reviving = this.reviving.get(m);
      if (reviving !== undefined) ent.subtitle = reviving;
      else if (dead) ent.subtitle = "Downed";
      decorateUnit(ent, a, world, registry, m, mover?.speed ?? 0);
      put(m, ent, dead ? "ally" : null);
    }

    // Monsters.
    this.packPlates.clear();
    for (const e of world.query(Monster, Pos, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const mon = world.read(e, Monster);
      const proto = registry.get<MonsterProto>(KIND.monster, mon.proto);
      const life = world.get(e, Life);
      const dead = world.has(e, Dead);
      const cur = world.read(e, Pos);
      const pos = interpolate(this.prev.get(e), cur, input.alpha);
      const mod = mon.mods.reduce<number>((acc, id) => {
        const mp = registry.get<MonsterModProto>(KIND.monsterMod, id);
        return mp && mp.tint !== 0 ? mp.tint : acc;
      }, 0);
      const tint = mod !== 0 ? multiplyTint(tintOf(proto?.tint), mod) : tintOf(proto?.tint);
      // A summon owned by any party member wears the party ink (cyan), unless hovered.
      const owner = world.get(e, Summoned)?.owner ?? 0;
      const partyOwned = partyTinted && owner !== 0 && isPartyHero(world, owner);
      const damaged = life !== undefined && life.hp < life.max;
      const targeted = e === input.targeted || e === input.hovered;
      const mover = world.get(e, Mover);
      const a = this.unitAnim(world, registry, e, mover?.moving ?? false, dead, t);
      const lastHit = this.hits.get(e);
      const recentlyHit = lastHit !== undefined && t - lastHit <= RECENT_HIT_TICKS;
      // Uniques and bosses always show their plate. A champion pack (same name) shows one
      // plate, on its lowest entity id (query order), so a pack's names do not stack.
      let elite = mon.rarity === "unique" || mon.rarity === "boss";
      if (mon.rarity === "champion" && !dead) {
        if (mon.pack === 0 || !this.packPlates.has(mon.pack)) {
          elite = true;
          if (mon.pack !== 0) this.packPlates.add(mon.pack);
        }
      }
      const ent: ArpgRenderEntity = {
        id: `c${e}`,
        name: mon.name,
        appearance: proto?.appearance ?? "unit.monster",
        fallbackAppearance: proto?.fallbackAppearance ?? "unit.hero",
        kind: "unit",
        x: pos.x / SUB,
        y: pos.y / SUB,
        facing: (mover?.facing ?? "s") as Facing,
        moving: mover?.moving ?? false,
        isSelf: false,
        action: a.action,
        tint,
        scale: monsterScale(mon.rarity),
        labelColor: MONSTER_LABEL_COLOR[mon.rarity],
        highlight: e === input.hovered ? true : partyOwned && !dead ? "party" : false,
        statusTint: statusTintOf(world, registry, e),
      };
      decorateUnit(ent, a, world, registry, e, mover?.speed ?? 0);
      if (dead) ent.dead = true;
      if (!dead && (elite || targeted || recentlyHit)) {
        ent.showLabel = true;
        if (platedRarity(mon.rarity)) ent.labelPlate = true;
        const priority = MONSTER_LABEL_PRIORITY[mon.rarity];
        if (priority !== 0) ent.labelPriority = priority;
      }
      // Corpses fade before removal; summons fade before they expire.
      let removeAt = dead ? world.read(e, Dead).at + corpseTicks : Number.POSITIVE_INFINITY;
      const summon = world.get(e, Summoned);
      if (summon && summon.until > 0 && summon.until < removeAt) removeAt = summon.until;
      const fade = fadeAlpha(t, removeAt);
      if (fade < 1) ent.alpha = fade;
      if (life && (damaged || targeted) && !dead) ent.bar = life.hp / Math.max(1, life.max);
      if (!dead) monsters++;
      put(e, ent, dead ? null : "unit");
    }

    // Projectiles (drawn above the ground).
    for (const e of world.query(Projectile, Pos, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const pr = world.read(e, Projectile);
      const pos = interpolate(this.prev.get(e), world.read(e, Pos), input.alpha);
      put(
        e,
        {
          id: `c${e}`,
          name: "",
          appearance: pr.sprite,
          kind: "projectile",
          x: pos.x / SUB,
          y: pos.y / SUB,
          facing: facingOf(pr.vx, pr.vy, "e"),
          moving: true,
          isSelf: false,
          vx: pr.vx,
          vy: pr.vy,
          zLift: 24,
          tint: 0xffffff,
          scale: 100,
        },
        null,
      );
    }

    // NPCs: name, title line and quest marker.
    const quests = world.getResource<QuestState>(RES.quests);
    const heroLevel = hero !== 0 ? (world.get(hero, Level)?.level ?? 1) : 1;
    for (const e of world.query(Npc, Pos, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const n = world.read(e, Npc);
      const proto = registry.get<NpcProto>(KIND.npc, n.proto);
      const pos = interpolate(this.prev.get(e), world.read(e, Pos), input.alpha);
      const ent: ArpgRenderEntity = {
        id: `c${e}`,
        name: proto?.name ?? "Townsfolk",
        appearance: proto?.appearance ?? "unit.npc",
        fallbackAppearance: proto?.fallbackAppearance ?? "unit.hero",
        kind: "npc",
        x: pos.x / SUB,
        y: pos.y / SUB,
        facing: "s",
        moving: false,
        isSelf: false,
        tint: tintOf(proto?.tint),
        scale: 100,
        labelColor: GOLD_COLOR,
        showLabel: true,
        highlight: e === input.hovered,
      };
      if (proto?.title) ent.subtitle = proto.title;
      if (proto?.role === "quest") {
        const marker = questMarker(registry, quests, n.proto, heroLevel);
        if (marker !== null) ent.marker = marker;
      }
      put(e, ent, "npc");
    }

    // Loot. The loot filter hides labels and fades the drop (a click still picks it up).
    const filter = lootFilterOf(world);
    for (const e of world.query(Loot, Pos, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const loot = world.read(e, Loot);
      const pos = interpolate(this.prev.get(e), world.read(e, Pos), input.alpha);
      let appearance = "loot.gold";
      let name = `${loot.gold} gold`;
      let color = GOLD_COLOR;
      let priority = LOOT_PRIORITY.gold;
      let tint = 0xffffff;
      if (loot.kind === "item" && loot.item) {
        const s = itemSprite(registry, loot.item.base);
        appearance = s.appearance;
        name = loot.item.name;
        color = RARITY_COLOR[loot.item.rarity];
        priority = LOOT_PRIORITY[loot.item.rarity];
        tint = lootTintOf(registry, loot.item.base);
      } else if (loot.kind === "potion") {
        const s = itemSprite(registry, loot.potion);
        appearance = s.appearance;
        name = registry.get<ItemBaseProto>(KIND.itemBase, loot.potion)?.name ?? "Potion";
        color = RARITY_COLOR.normal;
        priority = LOOT_PRIORITY.potion;
      }
      const visible = lootVisible(filter, registry, loot);
      const ent: ArpgRenderEntity = {
        id: `c${e}`,
        name,
        appearance,
        fallbackAppearance: "loot.item",
        kind: "loot",
        x: pos.x / SUB,
        y: pos.y / SUB,
        facing: "s",
        moving: false,
        isSelf: false,
        tint,
        scale: 100,
        labelColor: color,
        showLabel: input.showLootLabels && visible,
        labelPriority: priority,
        highlight: e === input.hovered,
      };
      if (!visible) ent.alpha = HIDDEN_LOOT_ALPHA;
      put(e, ent, "loot");
    }

    // Interactables: stairs, waypoint, town portal, stash. Stairs and the
    // waypoint are always labelled; portal and stash near the hero; the
    // nearest one within reach also says how to use it.
    const stations: {
      e: Entity;
      kind: keyof typeof STATION_NAME;
      x: number;
      y: number;
      d: number;
    }[] = [];
    let nearest = -1;
    for (const e of world.query(Interactable, Pos, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const it = world.read(e, Interactable);
      const pos = interpolate(this.prev.get(e), world.read(e, Pos), input.alpha);
      const d =
        heroPos !== null
          ? Math.hypot(pos.x - heroPos.x, pos.y - heroPos.y) / SUB
          : Number.POSITIVE_INFINITY;
      if (d <= HINT_RANGE && (nearest < 0 || d < stations[nearest]!.d)) nearest = stations.length;
      stations.push({ e, kind: it.kind, x: pos.x / SUB, y: pos.y / SUB, d });
    }
    const hint = input.touch ? "tap to use" : "click to use";
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i]!;
      // Stairs, the waypoint and the rift stations are always labelled (wave A: obelisk and rift exit).
      const always =
        st.kind === "stairsDown" ||
        st.kind === "stairsUp" ||
        st.kind === "waypoint" ||
        st.kind === "riftObelisk" ||
        st.kind === "riftExit";
      const ent: ArpgRenderEntity = {
        id: `c${st.e}`,
        name: STATION_NAME[st.kind],
        appearance: STATION_APPEARANCE[st.kind],
        kind: "prop",
        x: st.x,
        y: st.y,
        facing: "s",
        moving: false,
        isSelf: false,
        tint: 0xffffff,
        scale: 100,
        highlight: st.e === input.hovered,
      };
      if (always || st.d <= STATION_LABEL_RANGE || i === nearest) ent.showLabel = true;
      // No hint once the hero stands on or right next to it (the name alone is enough there).
      if (i === nearest && st.d > HINT_NEAR) ent.subtitle = hint;
      put(st.e, ent, "interactable");
    }

    for (const id of this.drawn.keys()) {
      if (!seen.has(id)) {
        this.target.removeEntity(id);
        this.drawn.delete(id);
      }
    }
    this.picks = picks;
    this.prune(t);
    if (heroPos !== null) this.focusCamera(hero, heroPos.x / SUB, heroPos.y / SUB);
    this.stats = {
      entities: seen.size,
      monsters,
      heroX: heroPos !== null ? heroPos.x / SUB : null,
      heroY: heroPos !== null ? heroPos.y / SUB : null,
    };
    return this.stats;
  }

  /**
   * Camera follow of the controlled hero. A control switch pans smoothly
   * (follow) unless the new hero is more than SWITCH_SNAP_TILES away from the
   * current view, then the camera snaps to it.
   */
  private focusCamera(hero: Entity, x: number, y: number): void {
    if (hero !== this.focusHero) {
      this.focusHero = hero;
      const c = this.camera;
      if (c !== null && Math.hypot(x - c.x, y - c.y) > SWITCH_SNAP_TILES)
        this.target.snapCamera(x, y);
    }
    this.target.follow(x, y);
    this.camera = { x, y };
  }

  /** Drops hit and swing records nobody can see any more (small maps, cheap). */
  private prune(t: number): void {
    for (const [e, at] of this.hits) if (t - at > RECENT_HIT_TICKS) this.hits.delete(e);
    for (const [e, rec] of this.swings)
      if (t - rec.at > SWING_HOLD_TICKS + 1) this.swings.delete(e);
  }

  /** Counts and hero position of the last render. */
  lastStats(): SceneStats {
    return this.stats;
  }

  /**
   * Nearest pickable entity to a fractional tile within `radius` tiles.
   * Units win over other entities; ties break on distance, then entity id.
   */
  pickAt(x: number, y: number, radius = 0.8): Pick | null {
    let best: Pick | null = null;
    let bestTier = 2;
    let bestD = Infinity;
    const r2 = radius * radius;
    for (const p of this.picks) {
      const dx = p.x - x;
      const dy = p.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const tier = p.kind === "unit" ? 0 : 1;
      if (
        tier < bestTier ||
        (tier === bestTier &&
          (d2 < bestD || (d2 === bestD && best !== null && p.entity < best.entity)))
      ) {
        best = p;
        bestTier = tier;
        bestD = d2;
      }
    }
    return best;
  }

  /** Last pickable list (for tests and the minimap). */
  pickables(): readonly Pick[] {
    return this.picks;
  }

  private updateMap(
    input: SceneInput,
    hero: Entity,
    heroPos: { x: number; y: number } | null,
  ): void {
    let map: ClassicMap;
    try {
      map = getAreaMap(input.world, input.registry);
    } catch {
      return;
    }
    if (map === this.map) return;
    this.map = map;
    // A new area: hit and swing timers belong to entities that are gone.
    this.hits.clear();
    this.swings.clear();
    this.target.setMap(map);
    this.lightingKey = "";
    if (heroPos !== null) {
      this.target.snapCamera(heroPos.x / SUB, heroPos.y / SUB);
    } else if (hero === 0) {
      this.target.snapCamera(map.spawn.x + 0.5, map.spawn.y + 0.5);
    }
  }

  private updateLighting(input: SceneInput): void {
    const map = this.map;
    if (!map) return;
    const theme = input.registry.get<ThemeProto>(KIND.theme, map.theme);
    const radius = heroRadius(input.world);
    const darkness = input.lighting && map.depth > 0 ? (theme?.darkness ?? 0) / 100 : 0;
    const key = `${darkness}|${radius}`;
    if (key === this.lightingKey) return;
    this.lightingKey = key;
    this.target.setLighting({ darkness, radius });
  }
}

function currentDepthOf(world: World): number {
  return world.getResource<AreaState>(RES.area)?.depth ?? 0;
}

/** The hero entity (0 when none). */
function heroEntityOf(world: World): Entity {
  const g = world.getResource<{ hero: Entity }>(RES.game);
  if (!g || g.hero === 0 || !world.exists(g.hero)) return 0;
  return g.hero;
}

function interpolatedHero(
  world: World,
  hero: Entity,
  prev: Map<Entity, { x: number; y: number }>,
  alpha: number,
): { x: number; y: number } | null {
  const p = world.get(hero, Pos);
  if (!p) return null;
  return interpolate(prev.get(hero), p, alpha);
}

function heroRadius(world: World): number {
  const hero = heroEntityOf(world);
  if (hero === 0) return 8;
  const s = world.get(hero, HeroStats);
  return s?.lightRadius ?? 8;
}

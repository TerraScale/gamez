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
  Dead,
  Hero,
  HeroStats,
  Interactable,
  Life,
  Loot,
  Monster,
  Mover,
  Npc,
  Pos,
  Projectile,
  Statuses,
  Casting,
  Dash,
} from "../components.ts";
import { SUB, facingOf } from "../fixed.ts";
import { RES, type AreaState } from "../resources.ts";
import {
  KIND,
  type ClassProto,
  type ItemBaseProto,
  type MonsterModProto,
  type MonsterProto,
  type NpcProto,
  type SkillProto,
  type StatusProto,
  type ThemeProto,
} from "../types.ts";
import { getAreaMap, type ClassicMap } from "../world/maps.ts";
import { GOLD_COLOR, MONSTER_COLOR, RARITY_COLOR } from "./contract.ts";

/** The renderer calls the scene needs (ArpgWorldRenderer satisfies this). */
export interface SceneRenderer {
  upsertEntity(e: ArpgRenderEntity): void;
  removeEntity(id: string): void;
  setMap(map: TileMap): void;
  snapCamera(x: number, y: number): void;
  setLighting(opts: { darkness: number; radius: number }): void;
  follow(x: number, y: number): void;
}

export type PickKind = "unit" | "loot" | "npc" | "interactable";

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

function heroAction(
  world: World,
  registry: FrozenRegistry,
  e: Entity,
  moving: boolean,
): EntityAction {
  if (world.has(e, Dead)) return "death";
  const cast = world.get(e, Casting);
  if (cast) return castAction(registry, cast.skill);
  if (moving || world.has(e, Dash)) return "walk";
  return "idle";
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

function itemSprite(registry: FrozenRegistry, base: string): { appearance: string; color: number } {
  const b = registry.get<ItemBaseProto>(KIND.itemBase, base);
  if (!b) return { appearance: "loot.item", color: RARITY_COLOR.normal };
  if (b.category === "potion") {
    const kind = b.potion?.kind ?? "life";
    return { appearance: `loot.potion.${kind}`, color: RARITY_COLOR.normal };
  }
  return { appearance: `loot.item.${b.weaponClass ?? b.category}`, color: RARITY_COLOR.normal };
}

const STATION_APPEARANCE = {
  stairsDown: "prop.stairs.down",
  stairsUp: "prop.stairs.up",
  waypoint: "prop.waypoint",
  portal: "fx.portal",
  stash: "prop.stash",
} as const;
const STATION_NAME = {
  stairsDown: "Stairs down",
  stairsUp: "Stairs up",
  waypoint: "Waypoint",
  portal: "Town portal",
  stash: "Stash",
} as const;

export class SceneSync {
  private readonly drawn = new Map<string, ArpgRenderEntity>();
  /** Sub positions before the last step(), for interpolation. */
  private prev = new Map<Entity, { x: number; y: number }>();
  private map: ClassicMap | null = null;
  private lightingKey = "";
  private picks: Pick[] = [];
  private stats: SceneStats = { entities: 0, monsters: 0, heroX: null, heroY: null };

  constructor(private readonly target: SceneRenderer) {}

  /** Forgets everything drawn (new sim or renderer reset). */
  reset(): void {
    for (const id of this.drawn.keys()) this.target.removeEntity(id);
    this.drawn.clear();
    this.prev.clear();
    this.map = null;
    this.lightingKey = "";
    this.picks = [];
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

    this.updateMap(input, hero, heroPos);
    this.updateLighting(input);

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
        action: heroAction(world, registry, hero, m?.moving ?? false),
        tint: tintOf(proto?.tint),
        scale: 100,
        highlight: false,
        statusTint: statusTintOf(world, registry, hero),
      };
      put(hero, ent, null);
    }

    // Monsters.
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
      const damaged = life !== undefined && life.hp < life.max;
      const targeted = e === input.targeted || e === input.hovered;
      const ent: ArpgRenderEntity = {
        id: `c${e}`,
        name: mon.name,
        appearance: proto?.appearance ?? "unit.monster",
        fallbackAppearance: proto?.fallbackAppearance ?? "unit.hero",
        kind: "unit",
        x: pos.x / SUB,
        y: pos.y / SUB,
        facing: (world.get(e, Mover)?.facing ?? "s") as Facing,
        moving: world.get(e, Mover)?.moving ?? false,
        isSelf: false,
        action: dead
          ? "death"
          : world.get(e, Casting)
            ? castAction(registry, world.read(e, Casting).skill)
            : world.get(e, Mover)?.moving
              ? "walk"
              : "idle",
        tint,
        scale: proto?.scale ?? 100,
        labelColor: MONSTER_COLOR[mon.rarity],
        highlight: e === input.hovered,
        statusTint: statusTintOf(world, registry, e),
      };
      if (dead) ent.dead = true;
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
          zLift: 24,
          tint: 0xffffff,
          scale: 100,
        },
        null,
      );
    }

    // NPCs.
    for (const e of world.query(Npc, Pos, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const n = world.read(e, Npc);
      const proto = registry.get<NpcProto>(KIND.npc, n.proto);
      const pos = interpolate(this.prev.get(e), world.read(e, Pos), input.alpha);
      put(
        e,
        {
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
        },
        "npc",
      );
    }

    // Loot.
    for (const e of world.query(Loot, Pos, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const loot = world.read(e, Loot);
      const pos = interpolate(this.prev.get(e), world.read(e, Pos), input.alpha);
      let appearance = "loot.gold";
      let name = `${loot.gold} gold`;
      let color = GOLD_COLOR;
      if (loot.kind === "item" && loot.item) {
        const s = itemSprite(registry, loot.item.base);
        appearance = s.appearance;
        name = loot.item.name;
        color = RARITY_COLOR[loot.item.rarity];
      } else if (loot.kind === "potion") {
        const s = itemSprite(registry, loot.potion);
        appearance = s.appearance;
        name = registry.get<ItemBaseProto>(KIND.itemBase, loot.potion)?.name ?? "Potion";
        color = RARITY_COLOR.normal;
      }
      put(
        e,
        {
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
          tint: 0xffffff,
          scale: 100,
          labelColor: color,
          showLabel: input.showLootLabels,
          highlight: e === input.hovered,
        },
        "loot",
      );
    }

    // Interactables: stairs, waypoint, town portal, stash.
    for (const e of world.query(Interactable, Pos, AreaTag)) {
      if (world.read(e, AreaTag).depth !== depth) continue;
      const it = world.read(e, Interactable);
      const pos = interpolate(this.prev.get(e), world.read(e, Pos), input.alpha);
      put(
        e,
        {
          id: `c${e}`,
          name: STATION_NAME[it.kind],
          appearance: STATION_APPEARANCE[it.kind],
          kind: "prop",
          x: pos.x / SUB,
          y: pos.y / SUB,
          facing: "s",
          moving: false,
          isSelf: false,
          tint: 0xffffff,
          scale: 100,
          highlight: e === input.hovered,
        },
        "interactable",
      );
    }

    for (const id of this.drawn.keys()) {
      if (!seen.has(id)) {
        this.target.removeEntity(id);
        this.drawn.delete(id);
      }
    }
    this.picks = picks;
    if (heroPos !== null) this.target.follow(heroPos.x / SUB, heroPos.y / SUB);
    this.stats = {
      entities: seen.size,
      monsters,
      heroX: heroPos !== null ? heroPos.x / SUB : null,
      heroY: heroPos !== null ? heroPos.y / SUB : null,
    };
    return this.stats;
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

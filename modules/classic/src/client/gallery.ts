/**
 * QA gallery of the classic mode (`?qa=gallery`, tools/qa). Not reachable from
 * the normal UI and never touches gameplay: a static scene on the real Pixi
 * renderer that lays out every unit appearance of the classic registry (hero
 * classes, monsters and bosses, champion/unique/status tints, NPCs) in every
 * action, cycling all 8 facings; every loot sprite with its rarity label; every
 * skill effect and projectile, float texts and event effects (through the real
 * effects.ts planner); and every tile, prop and station sign. Captions show
 * what each logical id resolved to.
 *
 * window.__gamez.gallery: { ready, sections, current, show(id, page), next(),
 * prev(), setFacing(f | null), shown(), report(), summary }.
 */
import { createSim, loadMode, type FrozenRegistry, type GameEvent } from "@gamez/kernel";
import {
  isArpgRenderer,
  type ArpgRenderEntity,
  type ArpgWorldRenderer,
  type ClientModeView,
  type EntityAction,
  type EntityHighlight,
  type Facing,
} from "@gamez/ui-host";
import type { TileMap } from "@gamez/world";
import { mode, modules } from "../index.ts";
import { SUB } from "../fixed.ts";
import {
  ITEM_CATEGORIES,
  KIND,
  type ClassProto,
  type ItemBaseProto,
  type ItemRarity,
  type MonsterModProto,
  type MonsterProto,
  type MonsterRarity,
  type NpcProto,
  type SkillProto,
  type StatusProto,
  type ThemeProto,
  type UniqueProto,
} from "../types.ts";
import { mapFor } from "../world/maps.ts";
import { ELEMENT_COLOR, GOLD_COLOR, MONSTER_COLOR, RARITY_COLOR } from "./contract.ts";
import { EFFECT_TABLE, planEvent, type EffectEnv } from "./effects.ts";
import { itemSprite, lootTintOf, multiplyTint, STATION_APPEARANCE, STATION_NAME } from "./scene.ts";

export const GALLERY_ACTIONS: readonly EntityAction[] = [
  "idle",
  "walk",
  "attack",
  "cast",
  "hit",
  "death",
];
export const GALLERY_FACINGS: readonly Facing[] = ["s", "sw", "w", "nw", "n", "ne", "e", "se"];

/** Depths whose generated maps feed the tile/prop sections (town + every tier, boss levels). */
const MAP_DEPTHS = [0, 1, 4, 5, 8, 9, 12, 13, 16];
const MAP_SEED = 12345;
const FACING_MS = 1500;
const REPLAY_MS = 1700;
const MARGIN = 3;
/** Largest radius (tiles) an area effect is drawn with in its gallery cell (the game uses the real one). */
const GALLERY_EFFECT_RADIUS = 1;
/** Screen px per tile step of row offset (iso: a row moves both x and y, so the screen moves 32 px down). */
const ROW_PX = 32;
/** QA estimate of a scale-100 unit's height above its feet. Taller units (bosses) scale it. */
const UNIT_TOP_PX = 150;
/**
 * Extra head room (percent) for units drawn above scale 100: big sprites carry
 * wide effects above the head (the Choir of Cinders' flames spilled into the row above).
 */
const BIG_UNIT_HEADROOM_PCT = 125;
/** Caption space under the feet (two 10 px lines). */
const CAPTION_BELOW_PX = 56;
/** Room above a unit's head for its nameplate (the renderer draws it just above the head). */
const NAMEPLATE_PX = 26;
/** Head room of a loot drop: its renderer nameplate sits above the sprite. */
const LOOT_TOP_PX = 80;
/** Captions never grow past this many lines (the cell height is planned for it). */
const CAPTION_MAX_LINES = 3;
/** Toolbar height (px) the camera keeps clear, one row of buttons. */
const TOOLBAR_PX = 56;
/** Row header baseline above its row's feet (px): a 3-line header ends just above the captions. */
const ROW_HEADER_DY = -44;
/** Effect cells: the caption sits below a fixed-size effect box, not on it. */
const EFFECT_CAPTION_DY = 48;
const EFFECT_CAPTION_BELOW_PX = 92;
/** A two or three line row header to the left of the row, rising above its feet. */
const ROW_HEADER_PX = 64;
const COL_HEADER_PX = 24;
const ROW_GAP_PX = 14;
/** Coverage the gallery keeps even when no generated map or skill names it (art agent adds them). */
export const COVERAGE_TILES: readonly string[] = ["tile.dungeon.floor"];
export const COVERAGE_PROJECTILES: readonly string[] = ["fx.volley"];

type Template = Omit<ArpgRenderEntity, "id" | "x" | "y" | "facing" | "action">;

export type CellKind =
  | "unit"
  | "loot"
  | "projectile"
  | "station"
  | "effect"
  | "float"
  | "tile"
  | "prop";

export interface GalleryCell {
  key: string;
  kind: CellKind;
  /** First caption line. */
  title: string;
  /** The logical id under test (appearance, sprite, tile, effect id). */
  ref: string;
  action?: EntityAction;
  entity?: Template;
  /** Ground id under the cell (tile section). */
  tile?: string;
  /** Map object id on the cell (prop section). */
  object?: string;
  /** Replayed through effects.ts planEvent (positions in sub units). */
  event?: (x: number, y: number) => GameEvent;
  /** Effect sprite id the event uses (reported as sprite vs procedural). */
  effectId?: string;
  /** Other ids worth reporting (icons, projectiles). */
  extra?: Record<string, string>;
}

export interface GallerySection {
  id: string;
  title: string;
  cols: number;
  /** Tile steps between columns (screen-right) and rows (screen-down). */
  colStep: number;
  rowStep: number;
  rowsPerPage: number;
  ground: string;
  /** Header per row (unit sections) or null. */
  rowHeaders: string[] | null;
  colHeaders: string[] | null;
  cells: GalleryCell[];
}

const tintOf = (v: number | undefined): number => (v === undefined || v === 0 ? 0xffffff : v);
const hexOf = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;
const short = (id: string): string => id.slice(id.lastIndexOf(".") + 1);

function unitRow(
  out: GalleryCell[],
  headers: string[],
  section: string,
  id: string,
  header: string,
  t: Template,
): void {
  headers.push(header);
  for (const action of GALLERY_ACTIONS) {
    const entity: Template = {
      ...t,
      moving: action === "walk",
      showLabel: action === "idle",
    };
    if (action === "death") entity.dead = true;
    if (action === "hit") entity.bar = 0.55;
    if (action === "attack") entity.highlight = true;
    out.push({
      key: `${section}:${id}:${action}`,
      kind: "unit",
      title: action,
      ref: t.appearance,
      action,
      entity,
    });
  }
}

function heroesSection(reg: FrozenRegistry): GallerySection {
  const cells: GalleryCell[] = [];
  const headers: string[] = [];
  for (const [id, p] of reg.all<ClassProto>(KIND.class)) {
    unitRow(cells, headers, "heroes", id, `${p.name}\n${p.appearance}`, {
      name: p.name,
      appearance: p.appearance,
      fallbackAppearance: "unit.hero",
      kind: "unit",
      moving: false,
      isSelf: false,
      tint: tintOf(p.tint),
      scale: 100,
      labelColor: 0xffffff,
    });
  }
  return unitSection("heroes", "Heroes", headers, cells, 4, 4);
}

/** Identity outline kinds shown by the outlines section, in row order. */
export const GALLERY_OUTLINES: readonly EntityHighlight[] = ["self", "party", "ally"];

/**
 * Identity outlines (highlight "self" | "party" | "ally"): one row per kind on
 * the first hero class, every action, so the outline can be checked against
 * each clip and facing (death fades it out). Two sections: the light town
 * grass and a dark dungeon floor, where the outline must read on both.
 */
function outlinesSection(
  reg: FrozenRegistry,
  id: string,
  title: string,
  ground: string,
): GallerySection {
  const cells: GalleryCell[] = [];
  const headers: string[] = [];
  const first = reg.all<ClassProto>(KIND.class)[0];
  if (first) {
    const [, p] = first;
    for (const kind of GALLERY_OUTLINES) {
      headers.push(`${kind} outline\n${p.appearance}`);
      for (const action of GALLERY_ACTIONS) {
        const entity: Template = {
          name: `${p.name} (${kind})`,
          appearance: p.appearance,
          fallbackAppearance: "unit.hero",
          kind: "unit",
          moving: action === "walk",
          isSelf: kind === "self",
          tint: tintOf(p.tint),
          scale: 100,
          highlight: kind,
          showLabel: action === "idle",
        };
        if (action === "death") entity.dead = true;
        if (action === "hit") {
          entity.bar = 0.55;
          entity.hitFlash = 0.6;
        }
        cells.push({
          key: `${id}:${kind}:${action}`,
          kind: "unit",
          title: `${kind} ${action}`,
          ref: p.appearance,
          action,
          entity,
        });
      }
    }
  }
  return { ...unitSection(id, title, headers, cells, 4, 3), ground };
}

/** Summon of a party member (the hero summon of Spark Sentry) drawn in the party ink. */
export const GALLERY_PARTY_SUMMON = "classic.monster.sentry";

/**
 * Party identity on the town grass (docs/design/party.md §10.6): the controlled
 * hero ("self", gold), a follower ("party", cyan), a downed follower (the dead
 * pose, "party"), another player in town ("ally", green) and a summon owned by a
 * party member ("party"). Every action, so each outline reads on every clip.
 */
function partySection(reg: FrozenRegistry): GallerySection {
  const cells: GalleryCell[] = [];
  const headers: string[] = [];
  const classes = reg.all<ClassProto>(KIND.class);
  if (classes.length > 0) {
    const cls = (i: number): ClassProto => classes[i % classes.length]![1];
    const summon = reg.get<MonsterProto>(KIND.monster, GALLERY_PARTY_SUMMON);
    const rows: {
      header: string;
      name: string;
      appearance: string;
      tint: number;
      highlight: EntityHighlight;
      isSelf: boolean;
      dead: boolean;
    }[] = [
      {
        header: "self (controlled)",
        ...member(cls(0)),
        highlight: "self",
        isSelf: true,
        dead: false,
      },
      {
        header: "party follower",
        ...member(cls(1)),
        highlight: "party",
        isSelf: false,
        dead: false,
      },
      {
        header: "downed (dead pose)",
        ...member(cls(2)),
        highlight: "party",
        isSelf: false,
        dead: true,
      },
      {
        header: "other player (ally)",
        ...member(cls(3)),
        highlight: "ally",
        isSelf: false,
        dead: false,
      },
      {
        header: "summon of a party member",
        name: summon?.name ?? "Summon",
        appearance: summon?.appearance ?? "unit.monster",
        tint: tintOf(summon?.tint),
        highlight: "party",
        isSelf: false,
        dead: false,
      },
    ];
    for (const row of rows) {
      headers.push(`${row.header}\n${row.appearance}`);
      for (const action of GALLERY_ACTIONS) {
        // A downed member is in the death clip for good (unitAnim), so every column shows it.
        const act: EntityAction = row.dead ? "death" : action;
        const entity: Template = {
          name: `${row.name} (${row.highlight})`,
          appearance: row.appearance,
          fallbackAppearance: "unit.hero",
          kind: "unit",
          moving: act === "walk",
          isSelf: row.isSelf,
          tint: row.tint,
          scale: 100,
          highlight: row.highlight,
          showLabel: true,
        };
        if (act === "death") entity.dead = true;
        if (act === "hit") {
          entity.bar = 0.55;
          entity.hitFlash = 0.6;
        }
        if (row.dead) entity.subtitle = "Downed";
        cells.push({
          key: `party:${row.highlight}:${row.header}:${action}`,
          kind: "unit",
          title: act,
          ref: row.appearance,
          action: act,
          entity,
        });
      }
    }
  }
  return { ...unitSection("party", "Party", headers, cells, 4, 3), ground: "tile.grass" };
}

/** Name, appearance and tint of a class row (party section). */
function member(p: ClassProto): { name: string; appearance: string; tint: number } {
  return { name: p.name, appearance: p.appearance, tint: tintOf(p.tint) };
}

function unitSection(
  id: string,
  title: string,
  headers: string[],
  cells: GalleryCell[],
  rowStep: number,
  rowsPerPage: number,
): GallerySection {
  return {
    id,
    title,
    cols: GALLERY_ACTIONS.length,
    // Wide pitch: neighbouring nameplates (up to ~170 px) must not run together.
    colStep: 3,
    rowStep,
    rowsPerPage,
    ground: "tile.stone",
    rowHeaders: headers,
    colHeaders: [...GALLERY_ACTIONS],
    cells,
  };
}

/** Bosses and rift guardians: tall units that get their own two-row pages. */
function isBigMonster(m: Readonly<MonsterProto>): boolean {
  return !!m.boss || m.guardian === true;
}

/**
 * Regular monsters (four rows a page), or bosses and rift guardians (`big`,
 * two rows a page, so their tall sprites never run into the next row and the
 * camera fits the page).
 */
function monstersSection(reg: FrozenRegistry, big: boolean): GallerySection {
  const cells: GalleryCell[] = [];
  const headers: string[] = [];
  for (const [id, m] of reg.all<MonsterProto>(KIND.monster)) {
    if (isBigMonster(m) !== big) continue;
    const boss = m.boss ? ` (boss, d${m.boss.depth})` : m.guardian ? " (rift guardian)" : "";
    unitRow(cells, headers, "monsters", id, `${m.name}${boss}\n${m.appearance}`, {
      name: m.name,
      appearance: m.appearance,
      fallbackAppearance: m.fallbackAppearance,
      kind: "unit",
      moving: false,
      isSelf: false,
      tint: tintOf(m.tint),
      scale: m.scale,
      labelColor: MONSTER_COLOR[big ? "boss" : "normal"],
    });
  }
  return big
    ? unitSection("bosses", "Bosses", headers, cells, 5, 2)
    : unitSection("monsters", "Monsters", headers, cells, 5, 4);
}

function npcsSection(reg: FrozenRegistry): GallerySection {
  const cells: GalleryCell[] = [];
  const headers: string[] = [];
  for (const [id, n] of reg.all<NpcProto>(KIND.npc)) {
    unitRow(cells, headers, "npcs", id, `${n.name} (${n.role})\n${n.appearance}`, {
      name: n.name,
      appearance: n.appearance,
      fallbackAppearance: n.fallbackAppearance,
      kind: "npc",
      moving: false,
      isSelf: false,
      tint: tintOf(n.tint),
      scale: 100,
      labelColor: GOLD_COLOR,
    });
  }
  return unitSection("npcs", "NPCs", headers, cells, 4, 5);
}

function variantsSection(reg: FrozenRegistry): GallerySection {
  const monsters = reg.all<MonsterProto>(KIND.monster);
  const sample = monsters.find(([id]) => id === "classic.monster.husk") ?? monsters[0] ?? null;
  const cells: GalleryCell[] = [];
  if (sample) {
    const [sid, m] = sample;
    const base: Template = {
      name: m.name,
      appearance: m.appearance,
      fallbackAppearance: m.fallbackAppearance,
      kind: "unit",
      moving: false,
      isSelf: false,
      tint: tintOf(m.tint),
      scale: m.scale,
      showLabel: true,
    };
    for (const [id, mod] of reg.all<MonsterModProto>(KIND.monsterMod)) {
      const tint = mod.tint !== 0 ? multiplyTint(tintOf(m.tint), mod.tint) : tintOf(m.tint);
      cells.push({
        key: `variants:${id}`,
        kind: "unit",
        title: `${mod.name} (${hexOf(mod.tint)})`,
        ref: m.appearance,
        action: "idle",
        entity: {
          ...base,
          name: `${mod.name} ${m.name}`,
          tint,
          labelColor: MONSTER_COLOR.champion,
        },
      });
    }
    for (const rarity of Object.keys(MONSTER_COLOR) as MonsterRarity[]) {
      cells.push({
        key: `variants:rarity:${rarity}`,
        kind: "unit",
        title: `rarity ${rarity}`,
        ref: m.appearance,
        action: "idle",
        entity: {
          ...base,
          name: `${rarity} ${m.name}`,
          labelColor: MONSTER_COLOR[rarity],
          bar: 0.7,
        },
      });
    }
    for (const [id, st] of reg.all<StatusProto>(KIND.status)) {
      cells.push({
        key: `variants:status:${id}`,
        kind: "unit",
        title: `status ${st.name}`,
        ref: m.appearance,
        action: "idle",
        entity: { ...base, name: st.name, statusTint: st.tint, labelColor: st.tint || 0xffffff },
      });
    }
    cells.push({
      key: `variants:${sid}:highlight`,
      kind: "unit",
      title: "hover highlight",
      ref: m.appearance,
      action: "idle",
      entity: { ...base, highlight: true, bar: 0.4 },
    });
  }
  return {
    id: "variants",
    title: "Tints & labels",
    // Wide pitch: the renderer's nameplates of neighbouring variants must not overlap.
    cols: 4,
    colStep: 4,
    rowStep: 4,
    rowsPerPage: 4,
    ground: "tile.stone",
    rowHeaders: null,
    colHeaders: null,
    cells,
  };
}

const RARITY_CYCLE: ItemRarity[] = ["normal", "magic", "rare", "unique"];

function lootSection(reg: FrozenRegistry): GallerySection {
  const cells: GalleryCell[] = [];
  cells.push({
    key: "loot:gold",
    kind: "loot",
    title: "gold",
    ref: "loot.gold",
    entity: {
      name: "37 gold",
      appearance: "loot.gold",
      fallbackAppearance: "loot.item",
      kind: "loot",
      moving: false,
      isSelf: false,
      labelColor: GOLD_COLOR,
      showLabel: true,
    },
  });
  const bases = reg.all<ItemBaseProto>(KIND.itemBase);
  const potions = bases.filter(([, b]) => b.category === "potion");
  const gear = bases.filter(([, b]) => b.category !== "potion");
  const ordered = [...potions, ...gear];
  ordered.forEach(([id, b], i) => {
    const s = itemSprite(reg, id);
    const rarity: ItemRarity =
      b.category === "potion" ? "normal" : (RARITY_CYCLE[i % RARITY_CYCLE.length] ?? "normal");
    cells.push({
      key: `loot:${id}`,
      kind: "loot",
      title: `${short(id)} [${rarity}]`,
      ref: s.appearance,
      entity: {
        name: b.name,
        appearance: s.appearance,
        fallbackAppearance: "loot.item",
        kind: "loot",
        moving: false,
        isSelf: false,
        // Gems are tinted by their kind (the ground look of a socketable gem).
        tint: lootTintOf(reg, id),
        labelColor: RARITY_COLOR[rarity],
        showLabel: true,
      },
      extra: { icon: b.icon },
    });
  });
  // Set rarity label (set pieces are rolled from SetItemProto; this shows the colour on a gear sample).
  const setSample = gear.find(([, b]) => b.category !== "gem") ?? gear[0];
  if (setSample) {
    const [sid, sb] = setSample;
    const s = itemSprite(reg, sid);
    cells.push({
      key: "loot:set-sample",
      kind: "loot",
      title: `${short(sid)} [set]`,
      ref: s.appearance,
      entity: {
        name: `${sb.name} (set)`,
        appearance: s.appearance,
        fallbackAppearance: "loot.item",
        kind: "loot",
        moving: false,
        isSelf: false,
        labelColor: RARITY_COLOR.set,
        showLabel: true,
      },
      extra: { icon: sb.icon },
    });
  }
  for (const [id, u] of reg.all<UniqueProto>(KIND.unique)) {
    const s = itemSprite(reg, u.base);
    const icon = reg.get<ItemBaseProto>(KIND.itemBase, u.base)?.icon ?? "";
    cells.push({
      key: `loot:${id}`,
      kind: "loot",
      title: `${short(id)} [unique]`,
      ref: s.appearance,
      entity: {
        name: u.name,
        appearance: s.appearance,
        fallbackAppearance: "loot.item",
        kind: "loot",
        moving: false,
        isSelf: false,
        labelColor: RARITY_COLOR.unique,
        showLabel: true,
      },
      extra: { icon },
    });
  }
  return {
    id: "loot",
    title: "Loot",
    cols: 6,
    // Item names are long: the pitch keeps neighbouring nameplates apart.
    colStep: 3,
    rowStep: 3,
    rowsPerPage: 5,
    ground: "tile.stone",
    rowHeaders: null,
    colHeaders: null,
    cells,
  };
}

/** The sim event a skill emits for its look (classic.effect for area shapes, classic.cast otherwise). */
function skillEvent(s: SkillProto, id: string): (x: number, y: number) => GameEvent {
  const area = s.shape === "nova" || s.shape === "aoeTarget" || s.shape === "pulse";
  if (s.shape === "chain") {
    return (x, y) => ({
      type: "classic.effect",
      effect: s.effect,
      x,
      y,
      radius: 0,
      points: [
        { x, y },
        { x: x + SUB, y: y - SUB },
        { x: x + 2 * SUB, y },
        { x: x + 2 * SUB, y: y + SUB },
      ],
    });
  }
  if (area) {
    // Drawn at most one tile wide so every effect stays inside its fixed-size cell.
    // Event radii are in sub units (SkillProto.radius = tiles(n)).
    const radius = Math.min(s.radius ?? 0, GALLERY_EFFECT_RADIUS * SUB);
    return (x, y) => ({
      type: "classic.effect",
      effect: s.effect,
      x,
      y,
      radius,
      points: [],
    });
  }
  return (x, y) => ({
    type: "classic.cast",
    caster: 0,
    skill: id,
    effect: s.effect,
    x,
    y,
    tx: x + SUB,
    ty: y,
  });
}

function skillsSection(reg: FrozenRegistry): GallerySection {
  const cells: GalleryCell[] = [];
  const skills = reg.all<SkillProto>(KIND.skill);
  const ordered = [
    ...skills.filter(([, s]) => s.users === "hero"),
    ...skills.filter(([, s]) => s.users !== "hero"),
  ];
  const projectiles = new Set<string>();
  for (const [id, s] of ordered) {
    const sprite = s.projectile?.sprite;
    if (sprite) projectiles.add(sprite);
    const cell: GalleryCell = {
      key: `skills:${id}`,
      kind: "effect",
      title: `${s.name}${s.users === "hero" ? "" : " (m)"}`,
      ref: s.effect,
      effectId: s.effect,
      event: skillEvent(s, id),
      extra: { icon: s.icon, shape: s.shape },
    };
    if (sprite) {
      cell.extra = { ...cell.extra, projectile: sprite };
      cell.entity = {
        name: "",
        appearance: sprite,
        kind: "projectile",
        moving: true,
        isSelf: false,
        zLift: 24,
      };
    }
    cells.push(cell);
  }
  for (const [id, b] of reg.all<ItemBaseProto>(KIND.itemBase)) {
    const sprite = b.projectile;
    if (!sprite || projectiles.has(sprite)) continue;
    projectiles.add(sprite);
    cells.push({
      key: `skills:weapon:${sprite}`,
      kind: "projectile",
      title: `weapon (${short(id)})`,
      ref: sprite,
      entity: {
        name: "",
        appearance: sprite,
        kind: "projectile",
        moving: true,
        isSelf: false,
        zLift: 24,
      },
    });
  }
  for (const sprite of COVERAGE_PROJECTILES) {
    cells.push({
      key: `skills:coverage:${sprite}`,
      kind: "projectile",
      title: `projectile ${short(sprite)}`,
      ref: sprite,
      entity: {
        name: "",
        appearance: sprite,
        kind: "projectile",
        moving: true,
        isSelf: false,
        zLift: 24,
      },
    });
  }
  return {
    id: "skills",
    title: "Skills & projectiles",
    cols: 6,
    colStep: 2,
    rowStep: 3,
    rowsPerPage: 5,
    ground: "tile.crypt.floor",
    rowHeaders: null,
    colHeaders: null,
    cells,
  };
}

function floatsSection(): GallerySection {
  const cells: GalleryCell[] = [];
  const add = (key: string, title: string, event: (x: number, y: number) => GameEvent): void => {
    cells.push({ key: `fx:${key}`, kind: "float", title, ref: key, event });
  };
  for (const element of Object.keys(ELEMENT_COLOR) as (keyof typeof ELEMENT_COLOR)[]) {
    add(`hit.${element}`, `hit ${element}`, (x, y) => ({
      type: "classic.hit",
      source: 0,
      target: 0,
      skill: "",
      amount: 42,
      element,
      crit: false,
      dot: false,
      heroHit: false,
      byHero: false,
      x,
      y,
    }));
  }
  add("hit.crit", "crit", (x, y) => ({
    type: "classic.hit",
    source: 0,
    target: 0,
    skill: "",
    amount: 187,
    element: "phys",
    crit: true,
    dot: false,
    heroHit: false,
    byHero: false,
    x,
    y,
  }));
  add("hit.dot", "damage over time", (x, y) => ({
    type: "classic.hit",
    source: 0,
    target: 0,
    skill: "",
    amount: 6,
    element: "poison",
    crit: false,
    dot: true,
    heroHit: false,
    byHero: false,
    x,
    y,
  }));
  add("hit.hero", "hero hurt", (x, y) => ({
    type: "classic.hit",
    source: 0,
    target: 0,
    skill: "",
    amount: 13,
    element: "phys",
    crit: false,
    dot: false,
    heroHit: true,
    byHero: false,
    x,
    y,
  }));
  add("miss", "miss", (x, y) => ({
    type: "classic.miss",
    source: 0,
    target: 0,
    blocked: false,
    x,
    y,
  }));
  add("heal", "heal", (x, y) => ({ type: "classic.heal", target: 0, amount: 35, x, y }));
  add("gold", "gold pickup", () => ({
    type: "classic.gold",
    amount: 25,
    total: 100,
    reason: "pickup",
  }));
  add("levelup", "level up", () => ({
    type: "classic.levelUp",
    level: 2,
    statPoints: 5,
    skillPoints: 1,
  }));
  for (const rarity of ["champion", "unique", "boss"] as const) {
    add(`death.${rarity}`, `${rarity} death`, (x, y) => ({
      type: "classic.death",
      entity: 0,
      killer: 0,
      isHero: false,
      monster: "",
      name: rarity,
      rarity,
      x,
      y,
    }));
  }
  return {
    id: "floats",
    title: "Floats & event fx",
    cols: 6,
    colStep: 2,
    rowStep: 3,
    rowsPerPage: 4,
    ground: "tile.crypt.floor",
    rowHeaders: null,
    colHeaders: null,
    cells,
  };
}

/** Chain polyline for a gallery cell (same shape the chain skills emit). */
function chainPoints(x: number, y: number): { x: number; y: number }[] {
  return [
    { x, y },
    { x: x + SUB, y: y - SUB },
    { x: x + 2 * SUB, y },
    { x: x + 2 * SUB, y: y + SUB },
  ];
}

/**
 * Every EFFECT_TABLE row, played through the real planner with its particle
 * style (kind and colour in the caption), then the three telegraph shapes
 * (circle, cone, line) at a boss-sized timing.
 */
function effectsSection(): GallerySection {
  const cells: GalleryCell[] = [];
  for (const [fx, row] of Object.entries(EFFECT_TABLE)) {
    if (row.kind === "telegraph") continue;
    const radius = Math.min(row.radius, GALLERY_EFFECT_RADIUS) * SUB;
    cells.push({
      key: `effect:${fx}`,
      kind: "effect",
      title: `${short(fx)} ${row.kind}/${row.style}`,
      ref: fx,
      effectId: fx,
      event: (x, y) => ({
        type: "classic.effect",
        effect: fx,
        x,
        y,
        radius,
        points: row.kind === "chain" ? chainPoints(x, y) : [],
      }),
    });
  }
  const telegraph = (
    key: string,
    title: string,
    shape: "circle" | "cone" | "line",
    extra: Record<string, number>,
  ): void => {
    cells.push({
      key: `telegraph:${key}`,
      kind: "effect",
      title,
      ref: "fx.telegraph",
      effectId: "fx.telegraph",
      event: (x, y) => ({
        type: "classic.telegraph",
        entity: 0,
        caster: 0,
        skill: "",
        effect: "fx.boss_quake",
        shape,
        x,
        y,
        radius: 0,
        angle: 0,
        arc: 0,
        length: 0,
        width: 0,
        ticks: 20,
        fireAt: 0,
        ...extra,
      }),
    });
  };
  telegraph("circle", "telegraph circle", "circle", { radius: SUB });
  telegraph("cone", "telegraph cone", "cone", { length: SUB, angle: 16, arc: 6 });
  telegraph("line", "telegraph line", "line", { angle: 0, length: SUB, width: SUB / 2 });
  return {
    id: "effects",
    title: "Effects & telegraphs",
    cols: 6,
    colStep: 2,
    rowStep: 3,
    rowsPerPage: 4,
    ground: "tile.crypt.floor",
    rowHeaders: null,
    colHeaders: null,
    cells,
  };
}

/** Every ground and object id the maps, themes and manifest use. */
function collectIds(
  reg: FrozenRegistry,
  manifestKeys: readonly string[],
): { tiles: string[]; props: string[] } {
  const tiles = new Set<string>();
  const props = new Set<string>();
  for (const depth of MAP_DEPTHS) {
    try {
      const m = mapFor(reg, MAP_SEED, depth);
      for (const g of m.ground) if (g) tiles.add(g);
      for (const o of m.objects) if (o) props.add(o);
    } catch {
      // A depth that does not generate is simply skipped.
    }
  }
  for (const [, t] of reg.all<ThemeProto>(KIND.theme)) {
    for (const f of t.floor) tiles.add(f);
    for (const p of [t.wall, t.door, t.stairsDown, t.stairsUp, t.waypoint, ...t.decor]) {
      if (p) props.add(p);
    }
  }
  for (const k of manifestKeys) {
    if (k.startsWith("tile.")) tiles.add(k);
    else if (k.startsWith("prop.") || k.startsWith("wall.")) props.add(k);
  }
  for (const k of COVERAGE_TILES) tiles.add(k);
  return { tiles: [...tiles].sort(), props: [...props].sort() };
}

function tilesSection(tiles: string[]): GallerySection {
  return {
    id: "tiles",
    title: "Tiles",
    cols: 8,
    colStep: 2,
    rowStep: 2,
    rowsPerPage: 6,
    ground: "tile.void",
    rowHeaders: null,
    colHeaders: null,
    cells: tiles.map((id) => ({ key: `tiles:${id}`, kind: "tile", title: id, ref: id, tile: id })),
  };
}

function propsSection(props: string[]): GallerySection {
  const cells: GalleryCell[] = props.map((id) => ({
    key: `props:${id}`,
    kind: "prop",
    title: id,
    ref: id,
    object: id,
  }));
  for (const k of Object.keys(STATION_APPEARANCE) as (keyof typeof STATION_APPEARANCE)[]) {
    const appearance = STATION_APPEARANCE[k];
    cells.push({
      key: `props:station:${k}`,
      kind: "station",
      title: `sign: ${STATION_NAME[k]}`,
      ref: appearance,
      entity: {
        name: STATION_NAME[k],
        appearance,
        kind: "prop",
        moving: false,
        isSelf: false,
        showLabel: true,
      },
    });
  }
  return {
    id: "props",
    title: "Props & signs",
    // Wide pitch so prop captions never sit under a neighbouring sign label.
    cols: 6,
    colStep: 3,
    rowStep: 3,
    rowsPerPage: 5,
    ground: "tile.stone",
    rowHeaders: null,
    colHeaders: null,
    cells,
  };
}

/** All gallery sections for a registry (pure apart from map generation, which is memoised). */
export function buildGallerySections(
  reg: FrozenRegistry,
  manifestKeys: readonly string[],
): GallerySection[] {
  const { tiles, props } = collectIds(reg, manifestKeys);
  return [
    heroesSection(reg),
    outlinesSection(reg, "outlines", "Outlines (town)", "tile.grass"),
    outlinesSection(reg, "outlines-dungeon", "Outlines (dungeon)", "tile.crypt.floor"),
    partySection(reg),
    monstersSection(reg, false),
    monstersSection(reg, true),
    npcsSection(reg),
    variantsSection(reg),
    lootSection(reg),
    skillsSection(reg),
    floatsSection(),
    effectsSection(),
    tilesSection(tiles),
    propsSection(props),
  ];
}

export function pageCount(s: GallerySection): number {
  const rows = Math.ceil(s.cells.length / s.cols);
  return Math.max(1, Math.ceil(rows / s.rowsPerPage));
}

interface Placed {
  cell: GalleryCell;
  x: number;
  y: number;
  row: number;
  col: number;
}

interface PageLayout {
  map: TileMap;
  placed: Placed[];
  /** Captions: tile position, pixel offset, text, class. */
  headers: { x: number; y: number; dy: number; text: string; kind: "row" | "col" }[];
  centre: { x: number; y: number };
  /** Page extent in unzoomed screen px. */
  widthPx: number;
  heightPx: number;
  /** Caption width of one cell column (screen px). */
  pitchPx: number;
  /** Row offset of every row in tile steps (rows are not evenly spaced when units differ in height). */
  rowOff: number[];
}

/** Head height above the feet of one cell (screen px at zoom 1). */
export function cellTopPx(cell: GalleryCell): number {
  switch (cell.kind) {
    case "unit": {
      const scale = cell.entity?.scale ?? 100;
      const top = (UNIT_TOP_PX * scale) / 100;
      return (scale > 100 ? (top * BIG_UNIT_HEADROOM_PCT) / 100 : top) + NAMEPLATE_PX;
    }
    case "station":
      return 110;
    case "prop":
      return 72;
    case "loot":
      return LOOT_TOP_PX;
    case "projectile":
      return 48;
    case "effect":
      return 56;
    case "float":
      return 40;
    default:
      return 0;
  }
}

/** Caption space under the feet of one cell (screen px). */
export function cellBelowPx(cell: GalleryCell): number {
  return cell.kind === "effect" ? EFFECT_CAPTION_BELOW_PX : CAPTION_BELOW_PX;
}

/** Caption offset below the feet of one cell (screen px). */
export function captionDy(cell: GalleryCell): number {
  return cell.kind === "effect" ? EFFECT_CAPTION_DY : 10;
}

/**
 * Row offsets (tile steps, integers) of the cells on one page. Each row sits
 * far enough below the previous one that its tallest head clears the captions
 * above it, so a boss (scale 170) gets a taller row than a scale-100 unit, and
 * the first row clears the column header. Never closer than `rowStep`.
 */
export function rowOffsets(s: GallerySection, cells: readonly GalleryCell[]): number[] {
  const rows = Math.max(1, Math.ceil(cells.length / s.cols));
  const below = cells.reduce((m, c) => Math.max(m, cellBelowPx(c)), CAPTION_BELOW_PX);
  const offs: number[] = [];
  let off = 0;
  for (let r = 0; r < rows; r++) {
    let top = 0;
    for (const c of cells.slice(r * s.cols, (r + 1) * s.cols)) top = Math.max(top, cellTopPx(c));
    if (s.rowHeaders) top = Math.max(top, ROW_HEADER_PX);
    if (r === 0) {
      off = Math.ceil((top + (s.colHeaders ? COL_HEADER_PX : 8)) / ROW_PX);
    } else {
      off += Math.max(s.rowStep, Math.ceil((top + below + ROW_GAP_PX) / ROW_PX));
    }
    offs.push(off);
  }
  return offs;
}

/** Lays out one page: cell (col, row) sits at tile (OX + c*cs + off, OY - c*cs + off), off = rowOff[row]. */
export function layoutPage(s: GallerySection, page: number): PageLayout {
  const perPage = s.cols * s.rowsPerPage;
  const cells = s.cells.slice(page * perPage, (page + 1) * perPage);
  const rows = Math.max(1, Math.ceil(cells.length / s.cols));
  const cs = s.colStep;
  const rowOff = rowOffsets(s, cells);
  const last = rowOff[rows - 1] ?? 0;
  const ox = MARGIN + cs;
  const oy = MARGIN + (s.cols - 1) * cs;
  const at = (c: number, off: number): { x: number; y: number } => ({
    x: ox + c * cs + off,
    y: oy - c * cs + off,
  });
  const width = ox + (s.cols - 1) * cs + last + MARGIN + 1;
  const height = oy + cs + last + MARGIN + 1;
  const n = width * height;
  const ground: string[] = Array.from({ length: n }, () => s.ground);
  const objects: (string | null)[] = Array.from({ length: n }, () => null);
  const placed: Placed[] = cells.map((cell, i) => {
    const col = i % s.cols;
    const row = Math.floor(i / s.cols);
    const p = at(col, rowOff[row] ?? 0);
    const idx = p.y * width + p.x;
    if (cell.tile) ground[idx] = cell.tile;
    if (cell.object) objects[idx] = cell.object;
    return { cell, x: p.x, y: p.y, row, col };
  });
  const headers: PageLayout["headers"] = [];
  if (s.rowHeaders) {
    for (let r = 0; r < rows; r++) {
      const text = s.rowHeaders[page * s.rowsPerPage + r];
      if (text === undefined) continue;
      const p = at(-1, rowOff[r] ?? 0);
      headers.push({ x: p.x, y: p.y, dy: ROW_HEADER_DY, text, kind: "row" });
    }
  }
  if (s.colHeaders) {
    s.colHeaders.forEach((text, c) => {
      const p = at(c, 0);
      headers.push({ x: p.x, y: p.y, dy: 0, text, kind: "col" });
    });
  }
  const a = at(-1, rowOff[0] ?? 0);
  const b = at(s.cols - 1, last);
  return {
    map: {
      id: `gallery.${s.id}.${page}`,
      width,
      height,
      ground,
      objects,
      walkable: Array.from({ length: n }, () => 1),
      spawn: { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) },
    },
    placed,
    headers,
    // Feet sit on the tile centre; lift the view a little so tall sprites fit.
    centre: { x: (a.x + b.x) / 2 - 0.6, y: (a.y + b.y) / 2 - 0.6 },
    widthPx: s.cols * cs * 64 + 96,
    heightPx: last * ROW_PX + 300,
    pitchPx: cs * 64,
    rowOff,
  };
}

/**
 * Whether the game ever plays an action on this unit. NPCs stand still and
 * talk (scene.ts sets moving:false), so only idle is reachable for them.
 */
export function isReachable(
  entityKind: string | undefined,
  action: EntityAction | undefined,
): boolean {
  if (action === undefined) return true;
  if (entityKind === "npc") return action === "idle";
  return true;
}

/**
 * A fallback is accepted when a cast or hit plays the attack clip instead
 * (the renderer's cast/hit -> attack chain). Anything else is a real gap.
 */
export function refineKind(
  kind: string,
  action: EntityAction | undefined,
  key: string | null,
  appearance: string,
): string {
  if (kind !== "action-fallback") return kind;
  if ((action === "cast" || action === "hit") && key !== null) {
    if (key.startsWith(`${appearance}.attack`)) return "attack-fallback";
  }
  return kind;
}

/**
 * Counts the report cells: byKind by worst resolution, the real gaps (problems:
 * generic or worse; actionFallbacks: an action that plays idle or another clip),
 * accepted attack fallbacks and actions the game never plays ("static", never a gap).
 */
export function tallyCells(cells: readonly CellReport[]): CellTally {
  const byKind: Record<string, number> = {};
  const problems: string[] = [];
  const actionFallbacks: string[] = [];
  let attackFallbacks = 0;
  let notPlayed = 0;
  for (const c of cells) {
    const w = c.worst;
    byKind[w] = (byKind[w] ?? 0) + 1;
    const label = `${c.section}: ${c.title} ${c.ref}${c.action ? ` [${c.action}]` : ""}`;
    const resolved =
      (typeof c.resolved === "string" ? c.resolved : JSON.stringify(c.resolved)) +
      (c.projectile ? `; projectile ${c.projectile}` : "");
    if (w === "static" || w === "n/a") notPlayed++;
    else if (w === "attack-fallback") attackFallbacks++;
    else if ((KIND_RANK[w] ?? 0) >= 2) problems.push(`${label} -> ${resolved}`);
    else if (w === "action-fallback") actionFallbacks.push(`${label} -> ${resolved}`);
  }
  return { byKind, problems, actionFallbacks, attackFallbacks, notPlayed };
}

export interface CellTally {
  byKind: Record<string, number>;
  problems: string[];
  actionFallbacks: string[];
  attackFallbacks: number;
  notPlayed: number;
}

/** Caption colour by resolution kind. */
const KIND_COLOUR: Record<string, string> = {
  exact: "#7fe08a",
  "attack-fallback": "#c4e27a",
  "n/a": "#7d8594",
  static: "#7d8594",
  "action-fallback": "#ffd75e",
  generic: "#ffa64d",
  fallback: "#ff7a7a",
  primitive: "#ff4d4d",
  missing: "#ff4d4d",
  sprite: "#7fe08a",
  procedural: "#9ec3ff",
  text: "#cfd6e0",
};

/** Problem ranking of a resolution kind (higher is worse). */
const KIND_RANK: Record<string, number> = {
  exact: 0,
  sprite: 0,
  text: 0,
  "n/a": 0,
  static: 0,
  "attack-fallback": 0.5,
  procedural: 1,
  "action-fallback": 1,
  generic: 2,
  fallback: 3,
  primitive: 4,
  missing: 4,
};

/** One gallery cell in report(): what it shows and how it resolved. */
export interface CellReport {
  key: string;
  section: string;
  kind: CellKind;
  title: string;
  ref: string;
  action?: EntityAction;
  fallback?: string;
  /** "key (kind)", or per facing when the facings differ. */
  resolved: string | Record<string, string>;
  projectile?: string;
  extra?: Record<string, string>;
  /** Worst resolution kind across facings, projectile and effect ("static" for an unreachable action). */
  worst: string;
  /** False for an action the game never plays on this kind (NPC walk, attack, ...): static, not animated. */
  reachable: boolean;
}

interface Resolution {
  key: string | null;
  kind: string;
}

function resolveCell(r: ArpgWorldRenderer, cell: GalleryCell, facing: Facing): Resolution {
  const dbg = r.debug;
  if (!dbg) return { key: null, kind: "missing" };
  switch (cell.kind) {
    case "tile":
    case "prop": {
      const s = dbg.resolveSprite(cell.ref);
      return { key: s.key, kind: s.kind };
    }
    case "float":
      return { key: null, kind: "text" };
    case "effect": {
      const id = cell.effectId ?? cell.ref;
      return { key: id, kind: dbg.hasExactSprite(id) ? "sprite" : "procedural" };
    }
    default: {
      const e = cell.entity;
      if (!e) return { key: null, kind: "missing" };
      const action = cell.action ?? (e.moving ? "walk" : "idle");
      const res = dbg.resolveAppearance(e.appearance, action, facing, e.fallbackAppearance, e.kind);
      return {
        key: res.key,
        kind: refineKind(res.kind, action, res.key, e.appearance),
      };
    }
  }
}

/** The kind a cell shows and counts as: "static" for an action the game never plays. */
function displayKind(cell: GalleryCell, res: Resolution): string {
  return displayWorst(cellReachable(cell), res.kind);
}

/** The worst kind a cell counts as: unreachable actions (static NPC cells) are "static", never a gap. */
export function displayWorst(reachable: boolean, worst: string): string {
  return reachable ? worst : "static";
}

/**
 * Glyph-backed icon ids: the HUD draws these as inline SVG (hud/icons.tsx), so
 * they need no manifest art. An item icon is drawn by its category (every
 * ITEM_CATEGORIES entry has a glyph in ITEM_PATHS); a skill icon is always drawn
 * (its own glyph, else the tag glyph).
 */
export function iconGlyphIds(reg: FrozenRegistry): Set<string> {
  const out = new Set<string>();
  for (const [, b] of reg.all<ItemBaseProto>(KIND.itemBase)) {
    if (ITEM_CATEGORIES.includes(b.category)) out.add(b.icon);
  }
  for (const [, s] of reg.all<SkillProto>(KIND.skill)) out.add(s.icon);
  return out;
}

/** How one icon id is covered: a HUD glyph wins (that is what the player sees), then manifest art. */
export type IconStatus = "glyph" | "art" | "missing";

export function classifyIcon(glyph: boolean, art: boolean): IconStatus {
  if (glyph) return "glyph";
  return art ? "art" : "missing";
}

export function cellReachable(cell: GalleryCell): boolean {
  if (cell.kind !== "unit") return true;
  return isReachable(cell.entity?.kind, cell.action);
}

function captionText(cell: GalleryCell, res: Resolution, kind: string): string {
  const key = res.key ?? "-";
  const shown =
    cell.kind === "unit" && cell.entity && key.startsWith(`${cell.entity.appearance}.`)
      ? `…${key.slice(cell.entity.appearance.length)}`
      : key;
  if (cell.kind === "unit") return `${shown} (${kind})`;
  if (cell.kind === "tile" || cell.kind === "prop") return `${cell.title}\n→ ${key} (${kind})`;
  if (cell.kind === "effect") {
    const proj = cell.extra?.projectile;
    return `${cell.title}\n${cell.ref} (${kind})${proj ? `\nproj ${proj}` : ""}`;
  }
  if (cell.kind === "float") return cell.title;
  return `${cell.title}\n${key} (${kind})`;
}

export const classicGalleryView: ClientModeView = {
  modeId: "classic.gallery",
  async mount(host, services) {
    const worldLayer = document.createElement("div");
    worldLayer.style.cssText = "position:absolute;inset:0";
    const capLayer = document.createElement("div");
    capLayer.style.cssText =
      "position:absolute;inset:0;pointer-events:none;overflow:hidden;font:10px/1.2 system-ui,sans-serif";
    const bar = document.createElement("div");
    bar.setAttribute("data-qa", "gallery-bar");
    bar.style.cssText =
      "position:absolute;left:8px;top:8px;right:96px;display:flex;flex-wrap:wrap;gap:4px;" +
      "align-items:center;pointer-events:auto;font:13px system-ui,sans-serif;color:#e8e2d0";
    host.append(worldLayer, capLayer, bar);

    const created = services.createWorldRenderer();
    if (!isArpgRenderer(created)) {
      created.destroy();
      throw new Error("the gallery needs the ARPG renderer");
    }
    const renderer = created;
    await renderer.init(worldLayer, services.manifest, services.assetBaseUrl);
    renderer.debug?.enable();

    const loaded = loadMode(mode, modules);
    const reg = loaded.registry;
    const manifestKeys = Object.keys(services.manifest.sprites);
    const sections = buildGallerySections(reg, manifestKeys);
    const envWorld = createSim(loaded, { seed: 1 }).world;

    let section = sections[0]!;
    let page = 0;
    let facingIdx = 0;
    let frozen = false;
    let layout: PageLayout = layoutPage(section, 0);
    /** Id of the map last sent to the renderer (setMap only when it changes). */
    let mappedId = "";
    let drawn: string[] = [];
    let deathPending = false;
    let capKey = "";
    const capEls: { el: HTMLDivElement; x: number; y: number; dy: number }[] = [];
    const cellCaps = new Map<string, HTMLDivElement>();
    /** Cell captions only: their font and width follow the camera zoom (see restyleCaptions). */
    const cellCapEls: HTMLDivElement[] = [];
    let zoom = 1;

    const facing = (): Facing => GALLERY_FACINGS[facingIdx] ?? "s";

    const entityOf = (p: Placed, actionOverride?: EntityAction): ArpgRenderEntity | null => {
      const t = p.cell.entity;
      if (!t) return null;
      const e: ArpgRenderEntity = {
        ...t,
        id: `g:${p.cell.key}`,
        x: p.x,
        y: p.y,
        facing: facing(),
      };
      const action = actionOverride ?? p.cell.action;
      if (action) e.action = action;
      return e;
    };

    const upsertAll = (beforeDeath: boolean): void => {
      for (const p of layout.placed) {
        const over = beforeDeath && p.cell.action === "death" ? "idle" : undefined;
        const e = entityOf(p, over);
        if (e) renderer.upsertEntity(e);
      }
    };

    const replay = (): void => {
      for (const p of layout.placed) {
        const make = p.cell.event;
        if (!make) continue;
        const env: EffectEnv = {
          world: envWorld,
          registry: reg,
          hero: 0,
          heroX: p.x,
          heroY: p.y,
          showDamageNumbers: true,
          manual: false,
        };
        let visuals: ReturnType<typeof planEvent>;
        try {
          visuals = planEvent(make(p.x * SUB, p.y * SUB), env);
        } catch (err) {
          console.error(`gallery: planEvent failed for ${p.cell.key}`, err);
          continue;
        }
        for (const v of visuals) {
          if (v.kind === "float") {
            renderer.floatText({ x: v.x, y: v.y, text: v.text, color: v.color, size: v.size });
          } else if (v.kind === "effect") {
            renderer.playEffect(v.spec);
          }
        }
      }
    };

    const refreshCaptions = (): void => {
      const f = facing();
      for (const p of layout.placed) {
        const el = cellCaps.get(p.cell.key);
        if (!el) continue;
        const res = resolveCell(renderer, p.cell, f);
        const kind = displayKind(p.cell, res);
        el.textContent = captionText(p.cell, res, kind);
        el.style.color = KIND_COLOUR[kind] ?? "#fff";
      }
      facingEl.textContent = `facing ${f}${frozen ? " (frozen)" : ""}`;
    };

    /**
     * Cell captions keep the column pitch on screen: the pitch shrinks with the
     * zoom, so the font and the wrap width shrink with it (never below 8 px).
     */
    const restyleCaptions = (): void => {
      const fontPx = Math.min(12, Math.max(8, 10 * zoom));
      const maxPx = Math.max(48, layout.pitchPx * zoom - 6);
      for (const el of cellCapEls) {
        el.style.fontSize = `${fontPx.toFixed(1)}px`;
        el.style.maxWidth = `${maxPx.toFixed(0)}px`;
      }
    };

    const buildCaptions = (): void => {
      capLayer.textContent = "";
      capEls.length = 0;
      cellCapEls.length = 0;
      cellCaps.clear();
      capKey = "";
      const mk = (text: string, css: string): HTMLDivElement => {
        const el = document.createElement("div");
        el.textContent = text;
        // A dark plate under every caption keeps it readable on any ground (beige floors included).
        el.style.cssText =
          "position:absolute;left:0;top:0;white-space:pre-line;text-align:center;" +
          "background:rgba(12,9,6,0.8);border-radius:3px;padding:1px 4px;" +
          "text-shadow:0 0 2px #000;color:#fff;" +
          css;
        capLayer.appendChild(el);
        return el;
      };
      for (const h of layout.headers) {
        const el = mk(
          h.text,
          h.kind === "row"
            ? "font-weight:600;font-size:11px;color:#f0e2b6;max-width:150px"
            : "font-weight:700;font-size:12px;color:#f0e2b6;text-transform:uppercase",
        );
        capEls.push({ el, x: h.x, y: h.y, dy: h.dy });
      }
      // Captions wrap inside their own column (never wider than the pitch) and stop at a fixed line count.
      const wrap =
        "line-height:1.2;overflow-wrap:anywhere;overflow:hidden;" +
        `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${CAPTION_MAX_LINES}`;
      for (const p of layout.placed) {
        const el = mk("", wrap);
        el.setAttribute("data-cell", p.cell.key);
        cellCaps.set(p.cell.key, el);
        capEls.push({ el, x: p.x, y: p.y, dy: captionDy(p.cell) });
        cellCapEls.push(el);
      }
      restyleCaptions();
      refreshCaptions();
    };

    /** Moves captions with the camera (only when the projection changed). */
    const placeCaptions = (): void => {
      const dbg = renderer.debug;
      if (!dbg) return;
      const o = dbg.tileToClient(0, 0);
      const u = dbg.tileToClient(1, 0);
      if (!o || !u) return;
      const key = `${o.x.toFixed(1)},${o.y.toFixed(1)},${u.x.toFixed(1)},${u.y.toFixed(1)}`;
      if (key === capKey) return;
      capKey = key;
      const v = dbg.tileToClient(0, 1) ?? o;
      const host0 = capLayer.getBoundingClientRect();
      for (const c of capEls) {
        const x = o.x + (u.x - o.x) * c.x + (v.x - o.x) * c.y - host0.left;
        const y = o.y + (u.y - o.y) * c.x + (v.y - o.y) * c.y - host0.top + c.dy;
        c.el.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px) translate(-50%,0)`;
      }
    };

    const fitCamera = (): void => {
      const w = worldLayer.clientWidth || window.innerWidth;
      const h = worldLayer.clientHeight || window.innerHeight;
      // Fit the page between the toolbar (top) and a small bottom margin.
      const z = Math.max(
        0.5,
        Math.min((w - 16) / layout.widthPx, (h - TOOLBAR_PX * 3) / layout.heightPx, 1.25),
      );
      renderer.setZoom(z);
      zoom = z;
      restyleCaptions();
      // Push the content down clear of the toolbar (32 screen px per diagonal tile step): the column headers sit at the top.
      const lift = 80 / z / 32;
      renderer.snapCamera(layout.centre.x - lift, layout.centre.y - lift);
    };

    const show = (id: string, p = 0): boolean => {
      const next = sections.find((s) => s.id === id);
      if (!next) return false;
      const pages = pageCount(next);
      section = next;
      page = Math.max(0, Math.min(pages - 1, Math.floor(p)));
      for (const eid of drawn) renderer.removeEntity(eid);
      layout = layoutPage(section, page);
      // The same page re-shown (a facing change, a replay) keeps its built chunks.
      if (layout.map.id !== mappedId) {
        renderer.setMap(layout.map);
        mappedId = layout.map.id;
      }
      fitCamera();
      upsertAll(false);
      drawn = layout.placed.filter((x) => x.cell.entity).map((x) => `g:${x.cell.key}`);
      buildCaptions();
      replay();
      updateBar();
      return true;
    };

    // ---- toolbar ----------------------------------------------------------------
    const btnCss =
      "min-height:36px;min-width:44px;padding:4px 10px;border-radius:6px;border:1px solid #6b5a3a;" +
      "background:#221b12;color:#e8e2d0;font:inherit;cursor:pointer";
    const sectionBtns = new Map<string, HTMLButtonElement>();
    for (const s of sections) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = s.title;
      b.style.cssText = btnCss;
      b.addEventListener("click", () => show(s.id, 0));
      bar.appendChild(b);
      sectionBtns.set(s.id, b);
    }
    const mkBtn = (label: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = btnCss;
      b.addEventListener("click", fn);
      bar.appendChild(b);
      return b;
    };
    mkBtn("Prev page", () => show(section.id, page - 1));
    const pageEl = document.createElement("span");
    pageEl.style.cssText = "padding:0 6px;text-shadow:0 0 3px #000";
    bar.appendChild(pageEl);
    mkBtn("Next page", () => show(section.id, page + 1));
    mkBtn("Freeze facing", () => {
      frozen = !frozen;
      refreshCaptions();
    });
    const facingEl = document.createElement("span");
    facingEl.style.cssText = "padding:0 6px;text-shadow:0 0 3px #000";
    bar.appendChild(facingEl);

    function updateBar(): void {
      for (const [id, b] of sectionBtns) {
        b.style.background = id === section.id ? "#5a4320" : "#221b12";
      }
      pageEl.textContent = `${section.title} ${page + 1}/${pageCount(section)}`;
    }

    // ---- timers -----------------------------------------------------------------
    renderer.onFrame(() => {
      if (deathPending) {
        deathPending = false;
        upsertAll(false);
      }
      placeCaptions();
    });
    const facingTimer = window.setInterval(() => {
      if (frozen) return;
      facingIdx = (facingIdx + 1) % GALLERY_FACINGS.length;
      upsertAll(true);
      deathPending = true;
      refreshCaptions();
    }, FACING_MS);
    const replayTimer = window.setInterval(replay, REPLAY_MS);
    const onResize = (): void => fitCamera();
    window.addEventListener("resize", onResize);

    // ---- QA surface ---------------------------------------------------------------
    const cellReport = (cell: GalleryCell, s: GallerySection): CellReport => {
      const out: CellReport = {
        key: cell.key,
        section: s.id,
        kind: cell.kind,
        title: cell.title,
        ref: cell.ref,
        resolved: "",
        worst: "exact",
        reachable: true,
      };
      if (cell.action) out.action = cell.action;
      if (cell.entity?.fallbackAppearance) out.fallback = cell.entity.fallbackAppearance;
      const perFacing: Record<string, string> = {};
      let worst = "exact";
      const facings =
        cell.entity && cell.kind !== "loot" && cell.kind !== "station"
          ? GALLERY_FACINGS
          : ["s" as Facing];
      for (const f of facings) {
        const res = resolveCell(renderer, cell, f);
        perFacing[f] = `${res.key ?? "-"} (${res.kind})`;
        if ((KIND_RANK[res.kind] ?? 0) > (KIND_RANK[worst] ?? 0)) worst = res.kind;
      }
      if (
        cell.kind !== "effect" &&
        cell.kind !== "float" &&
        cell.kind !== "tile" &&
        cell.kind !== "prop"
      ) {
        const values = new Set(Object.values(perFacing));
        out.resolved = values.size === 1 ? ([...values][0] ?? "") : perFacing;
      } else {
        out.resolved = perFacing.s ?? "";
      }
      if (cell.kind === "effect" && cell.entity) {
        const res = renderer.debug?.resolveAppearance(
          cell.entity.appearance,
          "walk",
          "e",
          undefined,
          "projectile",
        );
        out.projectile = `${cell.entity.appearance} -> ${res?.key ?? "-"} (${res?.kind ?? "?"})`;
        if ((KIND_RANK[res?.kind ?? "missing"] ?? 0) > (KIND_RANK[worst] ?? 0))
          worst = res?.kind ?? "missing";
      }
      if (cell.extra) {
        const extra: Record<string, string> = {};
        for (const [k, id] of Object.entries(cell.extra)) {
          if (k === "shape" || k === "projectile") {
            extra[k] = id;
            continue;
          }
          const s2 = renderer.debug?.resolveSprite(id);
          extra[k] = `${id} -> ${s2?.key ?? "-"} (${s2?.kind ?? "?"})`;
        }
        out.extra = extra;
      }
      out.reachable = cellReachable(cell);
      // Actions the game never plays (NPC walk, attack, ...) are static and never counted as gaps.
      out.worst = displayWorst(out.reachable, worst);
      return out;
    };

    const report = (): Record<string, unknown> => {
      const cells = sections.flatMap((s) => s.cells.map((c) => cellReport(c, s)));
      const { byKind, problems, actionFallbacks, attackFallbacks, notPlayed } = tallyCells(cells);
      // Icons are drawn as inline SVG glyphs by the HUD, so a glyph-backed id is never missing.
      const iconIds = new Set<string>();
      for (const s of sections) {
        for (const c of s.cells) {
          const icon = c.extra?.icon;
          if (icon) iconIds.add(icon);
        }
      }
      const glyphIds = iconGlyphIds(reg);
      const icons = { ids: iconIds.size, art: 0, glyph: 0, missing: 0, missingIds: [] as string[] };
      for (const id of [...iconIds].sort()) {
        const art = (renderer.debug?.resolveSprite(id).kind ?? "missing") !== "missing";
        const status = classifyIcon(glyphIds.has(id), art);
        icons[status]++;
        if (status === "missing") icons.missingIds.push(id);
      }
      const referenced = new Set<string>();
      for (const s of sections) {
        for (const c of s.cells) {
          referenced.add(c.ref);
          if (c.entity) referenced.add(c.entity.appearance);
        }
      }
      const unusedArt = manifestKeys.filter(
        (k) => /^(tile|prop|wall|loot|fx)\./.test(k) && !referenced.has(k),
      );
      return {
        sections: sections.map((s) => ({
          id: s.id,
          title: s.title,
          pages: pageCount(s),
          cells: s.cells.length,
        })),
        summary: {
          cells: cells.length,
          byWorstKind: byKind,
          problems,
          actionFallbacks,
          unusedArt,
          attackFallbacks,
          notPlayed,
          icons,
        },
        cells,
      };
    };

    const g = globalThis as { __gamez?: Record<string, unknown> };
    g.__gamez ??= {};
    const root = g.__gamez;
    const gallery = {
      ready: true,
      sections: sections.map((s) => ({
        id: s.id,
        title: s.title,
        pages: pageCount(s),
        cells: s.cells.length,
      })),
      get current() {
        return { section: section.id, page, pages: pageCount(section), facing: facing(), frozen };
      },
      show,
      next(): boolean {
        if (page + 1 < pageCount(section)) return show(section.id, page + 1);
        const i = sections.indexOf(section);
        const s = sections[i + 1];
        return s ? show(s.id, 0) : false;
      },
      prev(): boolean {
        return show(section.id, page - 1);
      },
      /** Freezes every unit on one facing (null resumes the cycle). */
      setFacing(f: Facing | null): void {
        if (f === null) {
          frozen = false;
        } else {
          const i = GALLERY_FACINGS.indexOf(f);
          if (i < 0) return;
          facingIdx = i;
          frozen = true;
          upsertAll(true);
          deathPending = true;
        }
        refreshCaptions();
      },
      /** Replays the effects and floats of the current page now. */
      replay,
      shown: () =>
        layout.placed.map((p) => ({
          ...cellReport(p.cell, section),
          now: resolveCell(renderer, p.cell, facing()),
        })),
      report,
      get summary() {
        return report().summary;
      },
    };
    root.mode = "classic.gallery";
    root.gallery = gallery;

    show(section.id, 0);

    return () => {
      window.clearInterval(facingTimer);
      window.clearInterval(replayTimer);
      window.removeEventListener("resize", onResize);
      if (root.gallery === gallery) {
        delete root.gallery;
        delete root.mode;
      }
      renderer.destroy();
      worldLayer.remove();
      capLayer.remove();
      bar.remove();
    };
  },
};

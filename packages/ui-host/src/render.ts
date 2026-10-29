import type { AssetManifest } from "@gamez/assets";
import type { TileMap } from "@gamez/world";

/**
 * Rendering contract for the isometric world view. The net/game layer owns
 * all state and calls into the renderer every frame; the renderer owns Pixi.
 */
export interface WorldRenderer {
  /** Creates the Pixi app inside `host` and loads the atlases in `manifest`. */
  init(host: HTMLElement, manifest: AssetManifest, baseUrl: string): Promise<void>;
  /** (Re)draws the static map layers. */
  setMap(map: TileMap): void;
  /**
   * Adds or updates an avatar at a fractional tile position. `facing` is one
   * of the 8 iso directions; `moving` picks the walk vs idle animation.
   */
  upsertEntity(e: RenderEntity): void;
  removeEntity(id: string): void;
  /** Keeps the camera centred on a fractional tile position (smoothed). */
  follow(x: number, y: number): void;
  /** Called with the integer tile under a click/tap (only for in-bounds tiles). */
  onTileTap(cb: (x: number, y: number) => void): void;
  /** Marks the tap target briefly (feedback for tap-to-move). */
  showTapMarker(x: number, y: number): void;
  /** Registers a per-frame callback (dt in ms) driven by the Pixi ticker. */
  onFrame(cb: (dtMs: number) => void): void;
  destroy(): void;
}

export type Facing = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface RenderEntity {
  id: string;
  name: string;
  /** Logical appearance id, e.g. "unit.hero"; resolved as `${appearance}.${walk|idle}.${facing}` with fallback. */
  appearance: string;
  x: number;
  y: number;
  facing: Facing;
  moving: boolean;
  isSelf: boolean;
}

// ---------------------------------------------------------------------------
// ARPG extension (phase 2a, docs/design/classic.md §12). Optional capability:
// the Pixi renderer implements it; modes feature-detect with isArpgRenderer()
// so simple fakes of WorldRenderer stay valid.
// ---------------------------------------------------------------------------

export type EntityKind = "unit" | "npc" | "loot" | "projectile" | "prop";

/**
 * Identity outline of a unit (docs: "ink" around who is who). "self" is the
 * hero the player controls (bright gold-white); "party" (cyan) and "ally"
 * (soft green) are dimmer, for party members and other players.
 */
export type EntityHighlight = "self" | "party" | "ally";
export type EntityAction = "idle" | "walk" | "attack" | "cast" | "hit" | "death";

/** RenderEntity plus ARPG presentation. Every extra field is optional; omitted = default. */
export interface ArpgRenderEntity extends RenderEntity {
  /** Default "unit". Projectiles have no shadow/label and draw `zLift` px above the ground. */
  kind?: EntityKind;
  /**
   * Animation key; overrides `moving`. Resolution order (first hit wins), for
   * each prefix p of `appearance` (a.b.c -> a.b.c, a.b, a):
   * `${p}.${action}.${facing}`, `${p}.${action}`, then the action's stand-ins
   * (cast -> `${p}.attack.${facing}`, `${p}.attack`; other actions have none),
   * then `${p}.idle.${facing}`, `${p}.idle`, `${p}`; then the same for
   * `fallbackAppearance`; then the primitive shape. A "hit" without its own
   * clip shows idle; `hitFlash` still makes the hit read.
   *
   * Units (and NPCs) whose resolved key has no facing suffix are mirrored for
   * the screen-left facings (sw, w, nw): the base art faces screen-right.
   */
  action?: EntityAction;
  /**
   * Manual clip position 0..1 for attack/cast (and their stand-in clips): the
   * renderer stops autoplay and shows frame min(n - 1, floor(p * n)). Omitted =
   * autoplay. The classic scene maps the sim cast so the hit tick lands at 0.5
   * (frame 2 of a 4-frame swing), which stretches the clip with attack speed.
   */
  actionProgress?: number;
  /** Clip speed multiplier (walk cycles follow the real move speed). Default 1. */
  animRate?: number;
  /** 0..1 strength of the "just got hit" flash (red tint + 1-2 px knockback). 0/omitted = none. */
  hitFlash?: number;
  /**
   * Projectile travel direction in tile space (any length). The renderer
   * rotates the sprite (whose art points screen-right) along the screen
   * projection of this vector.
   */
  vx?: number;
  vy?: number;
  fallbackAppearance?: string;
  /** 0xRRGGBB multiply tint (0xffffff = none). */
  tint?: number;
  /** Scale percent (100 = native). */
  scale?: number;
  /** 0..1 */
  alpha?: number;
  /** Health fraction 0..1 drawn as a bar above the unit; null/undefined = no bar. */
  bar?: number | null;
  barColor?: number;
  /** Label colour (loot rarity, champion/unique names). */
  labelColor?: number;
  /** Always show the label (loot); otherwise labels show only for isSelf/highlight. */
  showLabel?: boolean;
  /** Second, smaller muted line under the name (NPC titles, "click to use" hints). Shown with the label. */
  subtitle?: string;
  /** Quest marker drawn above the name ("!" quest available, "?" ready to turn in). */
  marker?: "!" | "?" | null;
  /**
   * Loot label stacking priority (higher keeps its place; lower ones are
   * pushed up when they overlap). Default 0.
   */
  labelPriority?: number;
  /**
   * Dark backing plate behind the name (elite monsters), so tinted names stay
   * readable on dark, fogged or light floors. Default false.
   */
  labelPlate?: boolean;
  /**
   * Two channels share this field:
   * - `true`: hover/target highlight (brightened body and a thin gold ring), as before.
   * - "self" | "party" | "ally": identity outline that follows the sprite's
   *   silhouette on every frame, plus a soft pulsing ground ring (see EntityHighlight).
   * - `false` / `null`: neither.
   * - omitted: "self" when `isSelf`, else nothing (so plain isSelf avatars keep their outline).
   * Identity kinds also show the name label, like `true`.
   */
  highlight?: boolean | EntityHighlight | null;
  /** Dead units fade and squash (used when no death animation resolves). */
  dead?: boolean;
  /** Pixel lift above the ground (projectiles ~24). */
  zLift?: number;
  /** Status tint pulse (e.g. chilled blue, poisoned green); 0 = none. */
  statusTint?: number;
  // ---- wave A (docs/design/wave-A.md §Art and effects) ----
  /** 0..1 strength of a cast glow (additive halo + slight lift) while casting/attacking. 0/omitted = none. */
  castGlow?: number;
  /** Glow colour (element of the skill); default 0xffffff. */
  glowColor?: number;
  /**
   * Colour of the hit flash: white (0xffffff, an additive overlay, the
   * default from wave A) or any tint. The old red multiply tint is gone.
   */
  hitFlashColor?: number;
}

export interface FloatTextSpec {
  /** Fractional tile position. */
  x: number;
  y: number;
  text: string;
  color: number;
  size?: "s" | "m" | "l";
  /** Lifetime, default 900 ms; rises ~40 px and fades. */
  ms?: number;
}

export type EffectKind =
  | "nova"
  | "explosion"
  | "chain"
  | "beam"
  | "heal"
  | "blink"
  | "hit"
  | "cast"
  | "levelup"
  | "portal"
  | "aoe"
  | "slash"
  // ---- wave A
  /**
   * Ground danger zone that fills over `durationMs` and flashes when it fires
   * (boss telegraphs): circle (`radius`), cone (`angle`, `arc`, `radius` =
   * length) or line (`angle`, `length`, `width`). Drawn under units.
   */
  | "telegraph"
  /** Lingering ring/aura on the ground around a point (buffs, caltrops, iron skin). */
  | "aura"
  /** Particle burst only (impacts, loot sparkle, level-up confetti). */
  | "burst";

/** Particle look presets (procedural; sprite textures "fx.particle.<style>" are used when present). */
export type ParticleStyle =
  | "spark"
  | "ember"
  | "frost"
  | "poison"
  | "arcane"
  | "holy"
  | "shadow"
  | "blood"
  | "dust"
  | "gold";

export type GraphicsQualityLevel = "low" | "medium" | "high";

/** One-shot visual drawn with Pixi Graphics (sprites optional via `sprite`). Positions in fractional tiles. */
export interface EffectSpec {
  kind: EffectKind;
  x: number;
  y: number;
  /** End point for beams. */
  x2?: number;
  y2?: number;
  /** Polyline for chains. */
  points?: { x: number; y: number }[];
  /** Radius in tiles (nova/explosion/aoe). */
  radius?: number;
  color: number;
  durationMs?: number;
  /**
   * Optional logical sprite id (e.g. "fx.frost_ring"); ignored when missing.
   * Wave A: when the manifest has the animation `${sprite}.burst`, the
   * renderer plays it once (scaled so 64 px = 1 tile of `radius`) on top of
   * the procedural shape.
   */
  sprite?: string;
  // ---- wave A (all optional) ----
  /** Aim angle in radians in TILE space (x right-down, y left-down); telegraph cones/lines, slashes. */
  angle?: number;
  /** Cone half-width in radians (telegraph cone). */
  arc?: number;
  /** Line length and width in tiles (telegraph line). */
  length?: number;
  width?: number;
  /** Particle preset for the effect's particles (default by kind and colour). */
  style?: ParticleStyle;
  /** 0..1 particle amount multiplier (also scaled down by quality). Default 1. */
  intensity?: number;
}

/** HUD chrome insets (CSS px) for ArpgWorldRenderer.setLabelInsets. */
export interface LabelInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PointerInfo {
  kind: "down" | "move" | "up" | "tap" | "hold";
  /** Fractional tile coordinates under the pointer (may be outside the map). */
  x: number;
  y: number;
  button: number;
  shift: boolean;
  pointerType: "mouse" | "touch" | "pen";
}

export interface RendererStats {
  fps: number;
  entities: number;
  chunks: number;
  props: number;
  drawMs: number;
}

/**
 * Renderer capabilities for big ARPG maps. Requirements on the implementation:
 * - setMap() builds ground chunks (16x16 tiles) and object sprites LAZILY:
 *   only chunks within the camera view plus one chunk margin exist; chunks
 *   leaving the margin are destroyed. A 128x128 map must stay at 60 fps.
 * - upsertEntity() accepts ArpgRenderEntity; positions are fractional tiles,
 *   called every frame for moving units (no allocations when nothing changed).
 * - Entities outside the view are not drawn (culled).
 */
export interface ArpgWorldRenderer extends WorldRenderer {
  readonly arpg: true;
  upsertEntity(e: ArpgRenderEntity): void;
  floatText(spec: FloatTextSpec): void;
  playEffect(spec: EffectSpec): void;
  /** All pointer activity in fractional tile coordinates (tap = short press without drag, hold = >350 ms). */
  onPointer(cb: (p: PointerInfo) => void): void;
  /** Moves the camera instantly (area change, respawn). */
  snapCamera(x: number, y: number): void;
  /** Zoom factor 0.5..2 (default 1). */
  setZoom(z: number): void;
  getZoom(): number;
  /**
   * Optional: screen (CSS px) insets of HUD chrome per edge. World labels are
   * clamped inside the view minus these insets, and labels whose entity
   * stands under the chrome are hidden. Cheap; call it on resize or layout
   * change only. Default all 0.
   */
  setLabelInsets?(insets: LabelInsets): void;
  /** Darkness 0..1 outside a light circle of `radius` tiles around the followed point (0 = off). */
  setLighting(opts: { darkness: number; radius: number }): void;
  /**
   * Optional (wave A): rendering quality. low = no particles, simple lighting,
   * resolution 1; medium = reduced particles, resolution <= 1.5; high = full
   * particles and glow, resolution <= 2. Default high.
   */
  setQuality?(q: GraphicsQualityLevel): void;
  /** Optional (wave A): brief camera shake (boss slams), strength in px, decays over `ms`. */
  shake?(strength: number, ms: number): void;
  /** Fractional tile under a client (CSS px) point, or null before init. */
  tileAtClient(clientX: number, clientY: number): { x: number; y: number } | null;
  stats(): RendererStats;
  /**
   * QA introspection (optional; fakes may omit it). Lookups work at any time;
   * per-frame tracking (frame times, animations seen, effects seen) only runs
   * after enable(), which the app calls for `?debug=1` (window.__gamez.render).
   */
  readonly debug?: RendererDebug;
}

// ---------------------------------------------------------------------------
// QA introspection (tools/qa). Never used for gameplay; zero cost until enabled.
// ---------------------------------------------------------------------------

/** Label kinds counted by RendererDebugInfo.labelsVisible. */
export type LabelKind =
  | "nameplate"
  | "npc"
  | "loot"
  | "sign"
  | "damage"
  | "healthbar"
  | "marker"
  | "subtitle";

/**
 * How an appearance resolved for one (action, facing):
 * - exact: own appearance with the requested action (`a.b.walk[.dir]`, or `a.b` for idle)
 * - action-fallback: own appearance, another action (usually `.idle`)
 * - generic: a shorter prefix of the appearance (`unit.monster` for `unit.monster.x`)
 * - fallback: the fallbackAppearance chain
 * - primitive: nothing resolved; drawn as a Graphics shape
 */
export type ResolutionKind = "exact" | "action-fallback" | "generic" | "fallback" | "primitive";

export interface AppearanceResolution {
  /** Manifest key that resolved (animation or sprite), null when primitive. */
  key: string | null;
  visual: "anim" | "still" | "prim";
  kind: ResolutionKind;
  /** Animation frame count (1 for stills, 0 for primitives). */
  frames: number;
}

export interface SpriteResolution {
  id: string;
  /** Manifest key after segment fallback (resolveId), or null when nothing (not even "missing") exists. */
  key: string | null;
  /** exact = the id itself; generic = a shorter prefix; missing = the "missing" sprite or nothing. */
  kind: "exact" | "generic" | "missing";
}

export interface RendererDebugInfo {
  fps: number;
  /** Wall-clock frame-to-frame time (ms) over the last ~240 frames (not clamped like Pixi's deltaMS). */
  frameMs: { avg: number; p95: number; max: number };
  /** Time spent inside the renderer tick (ms), same window. */
  tickMs: { avg: number; p95: number };
  zoom: number;
  /** Entity views alive / visible after culling / drawn as primitives (visible ones). */
  entities: number;
  entitiesDrawn: number;
  primitivesDrawn: number;
  /** Live ground chunks and how many were built since enable(). */
  chunks: number;
  chunksBuilt: number;
  props: number;
  /** Logical ids (tiles, props, entity appearances) that fell back to "missing" or a primitive. Sorted. */
  missingIds: string[];
  /** "appearance|action|facing" -> "resolvedKey (kind)", for every combination drawn since enable(). */
  animationsSeen: Record<string, string>;
  /** Visible labels by kind (in view, right now); damage = live float texts. */
  labelsVisible: Record<LabelKind, number>;
  /** "effectKind|spriteId" -> "sprite" | "procedural", for every effect played since enable(). */
  effectsSeen: Record<string, string>;
  effectsPlayed: number;
  floatsShown: number;
  /** Camera shake requests since enable() (counted even when the quality setting turns shake off). */
  shakes?: number;
  /** Identity outlines drawn right now (visible, not faded out), by kind. */
  outlines?: Record<EntityHighlight, number>;
  /**
   * Camera centre and its follow target, in tile coordinates (the values passed to
   * follow()). QA uses it to check that the camera follows the controlled hero.
   */
  camera?: { x: number; y: number; targetX: number; targetY: number };
  activeEffects: number;
}

export interface RendererDebug {
  readonly enabled: boolean;
  /** Starts per-frame tracking. Idempotent. */
  enable(): void;
  info(): RendererDebugInfo;
  /**
   * The renderer's own resolution of an entity appearance (same chain as
   * upsertEntity). `kind` (default "unit") only affects the classification:
   * single-sprite kinds (loot, projectile, prop) count their bare sprite as exact.
   */
  resolveAppearance(
    appearance: string,
    action: EntityAction,
    facing: Facing,
    fallbackAppearance?: string,
    kind?: EntityKind,
  ): AppearanceResolution;
  /** Resolution of a tile/prop/sprite id (the path ground chunks and props use). */
  resolveSprite(id: string): SpriteResolution;
  /** True when the manifest has this exact sprite key (effects use exact ids only). */
  hasExactSprite(id: string): boolean;
  /** Client (CSS px) position of a fractional tile, or null before init. */
  tileToClient(x: number, y: number): { x: number; y: number } | null;
}

export function isArpgRenderer(r: WorldRenderer): r is ArpgWorldRenderer {
  return (r as Partial<ArpgWorldRenderer>).arpg === true;
}

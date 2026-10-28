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
export type EntityAction = "idle" | "walk" | "attack" | "cast" | "hit" | "death";

/** RenderEntity plus ARPG presentation. Every extra field is optional; omitted = default. */
export interface ArpgRenderEntity extends RenderEntity {
  /** Default "unit". Projectiles have no shadow/label and draw `zLift` px above the ground. */
  kind?: EntityKind;
  /**
   * Animation key; overrides `moving`. Resolution order (first hit wins), for
   * each prefix p of `appearance` (a.b.c -> a.b.c, a.b, a):
   * `${p}.${action}.${facing}`, `${p}.${action}`, `${p}.idle.${facing}`, `${p}.idle`, `${p}`;
   * then the same for `fallbackAppearance`; then the primitive shape.
   */
  action?: EntityAction;
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
  /** Hover/target highlight outline. */
  highlight?: boolean;
  /** Dead units lie down/fade (used when no death animation resolves). */
  dead?: boolean;
  /** Pixel lift above the ground (projectiles ~24). */
  zLift?: number;
  /** Status tint pulse (e.g. chilled blue, poisoned green); 0 = none. */
  statusTint?: number;
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
  | "slash";

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
  /** Optional logical sprite id (e.g. "fx.frost_ring"); ignored when missing. */
  sprite?: string;
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
  /** Darkness 0..1 outside a light circle of `radius` tiles around the followed point (0 = off). */
  setLighting(opts: { darkness: number; radius: number }): void;
  /** Fractional tile under a client (CSS px) point, or null before init. */
  tileAtClient(clientX: number, clientY: number): { x: number; y: number } | null;
  stats(): RendererStats;
}

export function isArpgRenderer(r: WorldRenderer): r is ArpgWorldRenderer {
  return (r as Partial<ArpgWorldRenderer>).arpg === true;
}

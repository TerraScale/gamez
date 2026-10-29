import { Application, Container, Graphics, GraphicsContext, type Ticker } from "pixi.js";
import { DEFAULT_ISO, screenToTile, tileToScreen, type TileMap } from "@gamez/world";
import type {
  AppearanceResolution,
  ArpgRenderEntity,
  ArpgWorldRenderer,
  EffectSpec,
  EntityAction,
  EntityKind,
  Facing,
  FloatTextSpec,
  GraphicsQualityLevel,
  LabelInsets,
  PointerInfo,
  RendererDebug,
  RendererDebugInfo,
  RendererStats,
  SpriteResolution,
  WorldRenderer,
} from "@gamez/ui-host";
import { resolveId, type AssetManifest } from "@gamez/assets";
import {
  CHUNK_TILES,
  chunkInRange,
  chunkKey,
  chunkRange,
  inViewRect,
  visibleTileRect,
  type ViewRect,
} from "./chunks.ts";
import { clampZoom, smoothToward, wheelZoom } from "./camera.ts";
import { buildChunk, destroyChunk, type ChunkView } from "./ground.ts";
import {
  diamondPoints,
  buildPrimitives,
  destroyPrimitives,
  type Primitives,
} from "./primitives.ts";
import { loadVisuals, type Visuals } from "./visuals.ts";
import { EntityLayer } from "./entity-view.ts";
import { FxLayer, type EffectArt } from "./fx.ts";
import { floatOrigin } from "./fx-plan.ts";
import { isPickupFloat, PICKUP_LIFT } from "./float-layout.ts";
import { burstKeyIn, frameDeltaMs, shakeOffset } from "./fx-math.ts";
import { glowEnabled, lightTextureSize, qualityResolution, shakeEnabled } from "./quality.ts";
import { insetRect } from "./label-layout.ts";
import { LightingOverlay } from "./lighting.ts";
import { GestureTracker, type GestureEvent } from "./gestures.ts";
import { FrameStats } from "./stats.ts";
import { classifyResolution, debugRequested, DebugTracker, sortedRecord } from "./debug.ts";

const CAMERA_RATE = 8;
const MARKER_MS = 600;
/** Entities this far (world px) outside the view are culled. */
const CULL_PAD = 96;
/** Chunks are built within one chunk of the view and destroyed beyond two. */
const CHUNK_MARGIN = 1;
const CHUNK_KEEP_MARGIN = 2;
/** Chunk builds per frame, so a camera jump never costs one long frame. */
const CHUNK_BUILDS_PER_FRAME = 2;
/** Light radius floor, in tiles. */
const LIGHT_MIN_TILES = 3;
/** Light radius per tile in screen px (half the tile width). */
const LIGHT_PX_PER_TILE = DEFAULT_ISO.tileWidth / 2;

/**
 * Pixi-backed isometric world view. Implements the plain WorldRenderer contract
 * (steps, duel and town) and the ARPG extension (ArpgWorldRenderer).
 *
 * Coordinates: entity and effect positions are tile indices; a unit at (x, y)
 * is drawn at the centre of tile (x, y), which is tileToScreen(x + 0.5, y + 0.5).
 * PointerInfo x/y use the same index space: the tile under a point is
 * Math.floor(x + 0.5).
 */
class PixiWorldRenderer implements ArpgWorldRenderer {
  readonly arpg = true as const;

  private app: Application | null = null;
  private ticker: Ticker | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private visuals: Visuals | null = null;
  private prims: Primitives | null = null;
  private entities: EntityLayer | null = null;
  private fx: FxLayer | null = null;
  private lighting: LightingOverlay | null = null;
  private map: TileMap | null = null;
  private ready = false;
  private destroyed = false;

  /** Zoomed world. Children: ground chunks, tap marker, depth-sorted world, labels, effects. */
  private readonly view = new Container();
  private readonly ground = new Container();
  private readonly marker = new Graphics();
  /** Depth-sorted: chunk objects (props) and entities, ordered by depthOf. */
  private readonly world = new Container();
  /** Names, subtitles, quest markers and health bars: above every sprite, below effects. */
  private readonly labels = new Container();
  /** Stage-space overlay (darkness), above the view. */
  private readonly lightLayer = new Container();

  private readonly chunks = new Map<number, ChunkView>();
  private readonly walls = new Map<number, GraphicsContext>();
  private chunkCols = 0;
  private propCount = 0;
  private chunkDirty = true;
  private centreX = Number.NaN;
  private centreY = Number.NaN;
  private viewW = 0;
  private viewH = 0;

  private readonly pending = new Map<string, ArpgRenderEntity>();
  private readonly tapHandlers: ((x: number, y: number) => void)[] = [];
  private readonly frameHandlers: ((dtMs: number) => void)[] = [];
  private readonly pointerHandlers: ((p: PointerInfo) => void)[] = [];
  private readonly gestures = new GestureTracker();
  private readonly frameStats = new FrameStats();

  /** Camera target and smoothed position, both in iso screen px. */
  private hasTarget = false;
  private targetX = 0;
  private targetY = 0;
  private hasCam = false;
  private camX = 0;
  private camY = 0;
  private zoom = 1;
  private readonly rect: ViewRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /** `rect` minus the HUD label insets (setLabelInsets), written in place every frame. */
  private readonly labelRect: ViewRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private readonly labelInsets: LabelInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private markerMs = 0;
  private timeMs = 0;
  private lightDarkness = 0;
  private lightRadius = 0;
  /** Graphics quality (setQuality); high until the game says otherwise. */
  private quality: GraphicsQualityLevel = "high";
  /** Camera base position (before shake), in view px. */
  private baseX = 0;
  private baseY = 0;
  /** Camera shake: strength (px), total duration and elapsed time (ms), current offset (px). */
  private shakeStrength = 0;
  private shakeMs = 0;
  private shakeElapsed = 0;
  private shakeX = 0;
  private shakeY = 0;

  /** QA: ids that resolved to "missing" or nothing (filled once per id by the sprite cache). */
  private readonly missingIds = new Set<string>();
  private manifest: AssetManifest | null = null;
  /** QA tracking; null until debug.enable(). */
  private tracker: DebugTracker | null = null;
  private lastFrameAt = 0;
  private readonly renderGetter = (): RendererDebugInfo => this.debugInfo();
  readonly debug: RendererDebug = new DebugApi(this);

  constructor() {
    this.world.sortableChildren = true;
    this.view.addChild(this.ground, this.marker, this.world, this.labels);
    this.marker.visible = false;
  }

  async init(host: HTMLElement, manifest: AssetManifest, baseUrl: string): Promise<void> {
    const app = new Application();
    const resolution = Math.min(window.devicePixelRatio || 1, 2);
    const [, visuals] = await Promise.all([
      app.init({
        resizeTo: host,
        antialias: false,
        resolution,
        autoDensity: true,
        background: "#10131a",
      }),
      loadVisuals(manifest, baseUrl, (id) => this.missingIds.add(id)),
    ]);
    if (this.destroyed) {
      app.destroy({ removeView: true });
      return;
    }
    this.app = app;
    this.ticker = app.ticker;
    this.visuals = visuals;
    this.manifest = manifest;
    const prims = buildPrimitives();
    this.prims = prims;
    this.entities = new EntityLayer(this.world, visuals, prims, this.labels);
    this.entities.debug = this.tracker;
    this.entities.setOutlineZoom(this.zoom);
    // Exact ids only: an effect without art is drawn procedurally, never as the "missing" sprite.
    this.fx = new FxLayer(
      (id) => visuals.spriteExact(id)?.texture ?? null,
      () => null,
      (style) => visuals.spriteExact(`fx.particle.${style}`)?.texture ?? null,
    );
    // Effects above the name labels, float texts above everything in the view.
    this.view.addChild(this.fx.layer, this.fx.floatLayer);
    this.lighting = new LightingOverlay(this.lightLayer);
    this.applyQuality();

    const canvas = app.canvas;
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    host.appendChild(canvas);
    this.canvas = canvas;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });

    app.stage.addChild(this.view, this.lightLayer);
    app.ticker.add(this.tick);

    this.ready = true;
    this.chunkDirty = true;
    for (const e of this.pending.values()) this.entities?.upsert(e);
    this.pending.clear();
  }

  setMap(map: TileMap): void {
    this.map = map;
    this.chunkCols = Math.ceil(map.width / CHUNK_TILES);
    if (!this.hasTarget) this.follow(map.spawn.x, map.spawn.y);
    this.clearChunks();
    this.chunkDirty = true;
    this.centreX = Number.NaN;
  }

  upsertEntity(e: ArpgRenderEntity): void {
    if (!this.ready) {
      this.pending.set(e.id, { ...e });
      return;
    }
    this.entities?.upsert(e);
  }

  removeEntity(id: string): void {
    if (!this.ready) {
      this.pending.delete(id);
      return;
    }
    this.entities?.remove(id);
  }

  follow(x: number, y: number): void {
    const s = tileToScreen(x + 0.5, y + 0.5);
    this.targetX = s.sx;
    this.targetY = s.sy;
    this.hasTarget = true;
  }

  snapCamera(x: number, y: number): void {
    this.follow(x, y);
    // updateCamera places the camera on the target at the next frame.
    this.hasCam = false;
  }

  onTileTap(cb: (x: number, y: number) => void): void {
    this.tapHandlers.push(cb);
  }

  onPointer(cb: (p: PointerInfo) => void): void {
    this.pointerHandlers.push(cb);
  }

  showTapMarker(x: number, y: number): void {
    if (!this.ready) return;
    this.marker.clear();
    this.marker
      .poly(diamondPoints(Math.floor(x), Math.floor(y)))
      .fill({ color: 0xffd166, alpha: 0.5 });
    this.marker.alpha = 1;
    this.marker.visible = true;
    this.markerMs = MARKER_MS;
  }

  onFrame(cb: (dtMs: number) => void): void {
    this.frameHandlers.push(cb);
  }

  floatText(spec: FloatTextSpec): void {
    if (!this.ready) return;
    if (this.tracker) this.tracker.floatsShown++;
    const fx = this.fx;
    if (!fx) return;
    const s = tileToScreen(spec.x + 0.5, spec.y + 0.5);
    const layer = this.entities;
    const origin = floatOrigin(spec, layer ? layer.headTopNear(s.sx, s.sy) : Number.NaN);
    // Pickup texts ("+10 gold") rise from above the sprites of their tile.
    if (isPickupFloat(spec.text)) origin.sy -= PICKUP_LIFT;
    if (layer) origin.sy = layer.clearOfLabels(origin.sx, origin.sy);
    fx.float(spec, origin);
  }

  playEffect(spec: EffectSpec): void {
    if (!this.ready) return;
    // `${sprite}.burst` plays once when the manifest has that exact animation.
    const visuals = this.visuals;
    const key = visuals ? burstKeyIn(spec.sprite, (k) => visuals.hasExactAnimation(k)) : null;
    const burst = key && visuals ? visuals.animationExact(key) : null;
    const s = tileToScreen(spec.x + 0.5, spec.y + 0.5);
    const art: EffectArt =
      this.fx?.effect(spec, { sx: s.sx, sy: s.sy }, burst?.frames ?? null) ?? "procedural";
    if (this.tracker) this.tracker.effect(spec.kind, spec.sprite, art);
  }

  /**
   * Graphics quality (wave A). low: no particles or glow, a smaller light texture,
   * resolution 1, no shake. medium: half the particles, resolution <= 1.5. high:
   * full particles and glow, resolution <= 2 (the device pixel ratio, at most).
   */
  setQuality(q: GraphicsQualityLevel): void {
    if (q !== "low" && q !== "medium" && q !== "high") return;
    if (q === this.quality && this.ready) return;
    this.quality = q;
    this.applyQuality();
  }

  /** Brief camera shake (boss slams): `strength` px, decays over `ms`. Off on low quality. */
  shake(strength: number, ms: number): void {
    if (!(strength > 0) || !(ms > 0)) return;
    if (this.tracker) this.tracker.shakes++;
    if (!this.ready || !shakeEnabled(this.quality)) return;
    // A stronger shake replaces a weaker one still running; a weaker one never cuts a stronger one short.
    const left = this.shakeStrength * remainingShare(this.shakeMs, this.shakeElapsed);
    if (strength < left) return;
    this.shakeStrength = strength;
    this.shakeMs = ms;
    this.shakeElapsed = 0;
  }

  setZoom(z: number): void {
    const next = clampZoom(z);
    if (next === this.zoom) return;
    this.zoom = next;
    this.view.scale.set(next);
    this.entities?.setOutlineZoom(next);
    this.chunkDirty = true;
  }

  getZoom(): number {
    return this.zoom;
  }

  setLabelInsets(insets: LabelInsets): void {
    const clean = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
    this.labelInsets.top = clean(insets.top);
    this.labelInsets.right = clean(insets.right);
    this.labelInsets.bottom = clean(insets.bottom);
    this.labelInsets.left = clean(insets.left);
  }

  setLighting(opts: { darkness: number; radius: number }): void {
    this.lightDarkness = Number.isFinite(opts.darkness)
      ? Math.min(1, Math.max(0, opts.darkness))
      : 0;
    this.lightRadius = Number.isFinite(opts.radius) ? Math.max(0, opts.radius) : 0;
  }

  tileAtClient(clientX: number, clientY: number): { x: number; y: number } | null {
    const app = this.app;
    const canvas = this.canvas;
    if (!app || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // Pixi's logical size is CSS px, so mapping through the rect gives stage-local
    // coordinates. Resolution only changes the backing store and cancels out here.
    const px = (clientX - rect.left) * (app.screen.width / rect.width);
    const py = (clientY - rect.top) * (app.screen.height / rect.height);
    const wx = (px - this.baseX) / this.zoom;
    const wy = (py - this.baseY) / this.zoom;
    const t = screenToTile(wx, wy);
    return { x: t.x - 0.5, y: t.y - 0.5 };
  }

  tileToClient(x: number, y: number): { x: number; y: number } | null {
    const app = this.app;
    const canvas = this.canvas;
    if (!app || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (app.screen.width === 0 || app.screen.height === 0) return null;
    const s = tileToScreen(x + 0.5, y + 0.5);
    const px = this.baseX + s.sx * this.zoom;
    const py = this.baseY + s.sy * this.zoom;
    return {
      x: rect.left + px * (rect.width / app.screen.width),
      y: rect.top + py * (rect.height / app.screen.height),
    };
  }

  stats(): RendererStats {
    return {
      fps: this.frameStats.fps,
      entities: this.entities?.size ?? 0,
      chunks: this.chunks.size,
      props: this.propCount,
      drawMs: this.frameStats.drawMs,
    };
  }

  // ---- QA introspection (ArpgWorldRenderer.debug) ----------------------------

  debugEnabled(): boolean {
    return this.tracker !== null;
  }

  /** Starts tracking and publishes window.__gamez.render (a live getter). */
  enableDebug(): void {
    if (this.tracker || this.destroyed) return;
    this.tracker = new DebugTracker();
    if (this.entities) this.entities.debug = this.tracker;
    const root = debugRoot();
    if (root) {
      Object.defineProperty(root, "render", {
        get: this.renderGetter,
        enumerable: true,
        configurable: true,
      });
    }
  }

  debugInfo(): RendererDebugInfo {
    const t = this.tracker;
    const census = this.entities?.census() ?? {
      drawn: 0,
      primitives: 0,
      labels: {
        nameplate: 0,
        npc: 0,
        loot: 0,
        sign: 0,
        damage: 0,
        healthbar: 0,
        marker: 0,
        subtitle: 0,
      },
    };
    census.labels.damage = this.fx?.activeFloats ?? 0;
    const missing = new Set(this.missingIds);
    if (t) for (const id of t.entityMissing) missing.add(id);
    return {
      fps: this.frameStats.fps,
      frameMs: t ? t.frameMs() : { avg: 0, p95: 0, max: 0 },
      tickMs: t ? t.tickMs() : { avg: 0, p95: 0 },
      zoom: this.zoom,
      entities: this.entities?.size ?? 0,
      entitiesDrawn: census.drawn,
      primitivesDrawn: census.primitives,
      chunks: this.chunks.size,
      chunksBuilt: t?.chunksBuilt ?? 0,
      props: this.propCount,
      missingIds: [...missing].sort(),
      animationsSeen: t ? sortedRecord(t.anims) : {},
      labelsVisible: census.labels,
      effectsSeen: t ? sortedRecord(t.effects) : {},
      effectsPlayed: t?.effectsPlayed ?? 0,
      floatsShown: t?.floatsShown ?? 0,
      shakes: t?.shakes ?? 0,
      outlines: this.entities?.outlineCensus() ?? { self: 0, party: 0, ally: 0 },
      activeEffects: this.fx?.activeEffects ?? 0,
    };
  }

  resolveAppearance(
    appearance: string,
    action: EntityAction,
    facing: Facing,
    fallback?: string,
    entityKind?: EntityKind,
  ): AppearanceResolution {
    const hit = this.entities?.lookup(appearance, action, facing, fallback) ?? null;
    const key = hit ? hit.key : null;
    const kind = classifyResolution(appearance, action, facing, key, entityKind);
    if (!hit) return { key, visual: "prim", kind, frames: 0 };
    const v = hit.value;
    if (v.kind === "anim") return { key, visual: "anim", kind, frames: v.anim.frames.length };
    return { key, visual: "still", kind, frames: 1 };
  }

  resolveSprite(id: string): SpriteResolution {
    const m = this.manifest;
    if (!m || !this.visuals) return { id, key: null, kind: "missing" };
    const key = resolveId(m.sprites, id);
    const has = Object.prototype.hasOwnProperty.call(m.sprites, key);
    const real = has && this.visuals.sprite(id) !== null;
    if (!real) return { id, key: has ? key : null, kind: "missing" };
    if (key === "missing" && id !== "missing") return { id, key, kind: "missing" };
    return { id, key, kind: key === id ? "exact" : "generic" };
  }

  hasExactSprite(id: string): boolean {
    return this.visuals?.spriteExact(id) != null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const root = debugRoot();
    if (root && Object.getOwnPropertyDescriptor(root, "render")?.get === this.renderGetter) {
      delete root.render;
    }
    const app = this.app;
    if (app && this.ticker) this.ticker.remove(this.tick);
    if (this.canvas) {
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("pointermove", this.onPointerMove);
      this.canvas.removeEventListener("pointerup", this.onPointerUp);
      this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
      this.canvas.removeEventListener("wheel", this.onWheel);
    }
    this.clearChunks();
    for (const w of this.walls.values()) w.destroy();
    this.walls.clear();
    this.entities?.clear();
    this.entities = null;
    this.fx?.destroy();
    this.fx = null;
    this.lighting?.destroy();
    this.lighting = null;
    this.lightLayer.destroy({ children: true });
    this.pending.clear();
    this.tapHandlers.length = 0;
    this.frameHandlers.length = 0;
    this.pointerHandlers.length = 0;
    this.view.destroy({ children: true });
    if (this.prims) destroyPrimitives(this.prims);
    this.prims = null;
    if (app) app.destroy({ removeView: true });
    this.app = null;
    this.ticker = null;
    this.canvas = null;
  }

  /** Applies the quality to every layer and the renderer resolution. */
  private applyQuality(): void {
    const q = this.quality;
    this.fx?.setQuality(q);
    if (this.entities) {
      this.entities.glowOn = glowEnabled(q);
      this.entities.setOutlineQuality(q);
    }
    this.lighting?.setTextureSize(lightTextureSize(q));
    const app = this.app;
    if (!app) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    const res = qualityResolution(q, dpr);
    if (app.renderer.resolution === res) return;
    app.renderer.resize(app.screen.width, app.screen.height, res);
  }

  private clearChunks(): void {
    for (const c of this.chunks.values()) destroyChunk(c);
    this.chunks.clear();
    this.propCount = 0;
  }

  private readonly tick = (t: Ticker): void => {
    const start = performance.now();
    // Wall-clock step (clamped at FRAME_DELTA_MAX_MS): Pixi's deltaMS is clamped at 100 ms, so slow frames lose sim time.
    const real = this.lastFrameAt > 0 ? start - this.lastFrameAt : t.deltaMS;
    const dt = frameDeltaMs(start, this.lastFrameAt, t.deltaMS);
    this.timeMs += dt;
    for (const ev of this.gestures.tick(start)) this.emitGesture(ev);
    for (const h of this.frameHandlers) h(dt);
    this.updateCamera(dt);
    this.updateChunks();
    this.updateEntities();
    // The hero's nameplate is read after this frame's label layout, before the floats move.
    this.fx?.update(dt, this.entities?.selfLabelBand() ?? null);
    this.updateLighting();
    if (this.markerMs > 0) {
      this.markerMs -= dt;
      if (this.markerMs <= 0) this.marker.visible = false;
      else this.marker.alpha = this.markerMs / MARKER_MS;
    }
    const spent = performance.now() - start;
    this.frameStats.frame(real, spent);
    if (this.tracker) this.tracker.frame(real, spent);
    this.lastFrameAt = start;
  };

  private updateCamera(dt: number): void {
    const app = this.app;
    if (!app) return;
    this.updateShake(dt);
    if (!this.hasTarget) return;
    if (!this.hasCam) {
      this.camX = this.targetX;
      this.camY = this.targetY;
      this.hasCam = true;
    } else {
      this.camX = smoothToward(this.camX, this.targetX, dt, CAMERA_RATE);
      this.camY = smoothToward(this.camY, this.targetY, dt, CAMERA_RATE);
    }
    const sw = app.screen.width;
    const sh = app.screen.height;
    this.baseX = sw / 2 - this.camX * this.zoom;
    this.baseY = sh / 2 - this.camY * this.zoom;
    this.view.position.set(this.baseX + this.shakeX, this.baseY + this.shakeY);
    // Written in place: this runs every frame.
    const hw = sw / (2 * this.zoom);
    const hh = sh / (2 * this.zoom);
    this.rect.x0 = this.camX - hw;
    this.rect.x1 = this.camX + hw;
    this.rect.y0 = this.camY - hh;
    this.rect.y1 = this.camY + hh;
    insetRect(this.rect, this.labelInsets, this.zoom, this.labelRect);
  }

  /** Advances the camera shake and writes its offset (zero when none runs). */
  private updateShake(dt: number): void {
    if (this.shakeMs <= 0) {
      if (this.shakeX !== 0 || this.shakeY !== 0) {
        this.shakeX = 0;
        this.shakeY = 0;
        if (this.hasTarget) this.view.position.set(this.baseX, this.baseY);
      }
      return;
    }
    this.shakeElapsed += dt;
    if (this.shakeElapsed >= this.shakeMs) {
      this.shakeMs = 0;
      this.shakeStrength = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    } else {
      const o = shakeOffset(this.shakeStrength, this.shakeMs, this.shakeElapsed);
      this.shakeX = o.dx;
      this.shakeY = o.dy;
    }
    if (this.hasTarget) this.view.position.set(this.baseX + this.shakeX, this.baseY + this.shakeY);
  }

  /**
   * Builds ground chunks inside the view plus one chunk of margin and destroys
   * those beyond two chunks. Only runs when the camera enters another chunk, the
   * zoom or the screen size changes, or a previous frame left builds unfinished.
   */
  private updateChunks(): void {
    const map = this.map;
    const visuals = this.visuals;
    const prims = this.prims;
    const app = this.app;
    if (!map || !visuals || !prims || !app || !this.hasCam) return;

    const sw = app.screen.width;
    const sh = app.screen.height;
    if (sw !== this.viewW || sh !== this.viewH) {
      this.viewW = sw;
      this.viewH = sh;
      this.chunkDirty = true;
    }
    const centre = screenToTile(this.camX, this.camY);
    const cxC = Math.floor(Math.floor(centre.x) / CHUNK_TILES);
    const cyC = Math.floor(Math.floor(centre.y) / CHUNK_TILES);
    if (cxC !== this.centreX || cyC !== this.centreY) {
      this.centreX = cxC;
      this.centreY = cyC;
      this.chunkDirty = true;
    }
    if (!this.chunkDirty) return;

    const tiles = visibleTileRect(this.rect);
    const want = chunkRange(tiles, map.width, map.height, CHUNK_MARGIN);
    const keep = chunkRange(tiles, map.width, map.height, CHUNK_KEEP_MARGIN);
    for (const [key, c] of this.chunks) {
      if (chunkInRange(keep, c.cx, c.cy)) continue;
      destroyChunk(c);
      this.propCount -= c.props.length;
      this.chunks.delete(key);
    }
    let built = 0;
    let unfinished = false;
    const ctx = { map, visuals, prims, walls: this.walls };
    for (let cy = want.cy0; cy <= want.cy1; cy++) {
      for (let cx = want.cx0; cx <= want.cx1; cx++) {
        const key = chunkKey(cx, cy, this.chunkCols);
        if (this.chunks.has(key)) continue;
        if (built >= CHUNK_BUILDS_PER_FRAME) {
          unfinished = true;
          continue;
        }
        const c = buildChunk(ctx, cx, cy, this.ground, this.world);
        if (this.tracker) this.tracker.chunksBuilt++;
        this.chunks.set(key, c);
        this.propCount += c.props.length;
        built++;
      }
    }
    this.chunkDirty = unfinished;
  }

  private updateEntities(): void {
    const layer = this.entities;
    if (!layer) return;
    const cull = this.hasCam;
    const ticker = this.ticker;
    for (const v of layer.all()) {
      const inView = !cull || inViewRect(v.sx, v.sy, this.rect, CULL_PAD);
      if (v.root.visible !== inView) {
        v.root.visible = inView;
        layer.syncTag(v);
      }
      if (inView && ticker && v.anim && v.anim.visible) v.anim.update(ticker);
    }
    layer.tickPulse(this.timeMs);
    if (cull) layer.layoutLabels(this.rect, this.labelRect);
  }

  private updateLighting(): void {
    const app = this.app;
    const lighting = this.lighting;
    if (!app || !lighting || !this.hasTarget) return;
    const sw = app.screen.width;
    const sh = app.screen.height;
    const cx = sw / 2 + (this.targetX - this.camX) * this.zoom;
    const cy = sh / 2 + (this.targetY - this.camY) * this.zoom;
    const tiles = Math.max(LIGHT_MIN_TILES, this.lightRadius);
    lighting.update(this.lightDarkness, tiles * LIGHT_PX_PER_TILE * this.zoom, cx, cy, sw, sh);
  }

  private emitGesture(ev: GestureEvent): void {
    if (ev.kind === "pinch") {
      this.setZoom(this.zoom * ev.scale);
      return;
    }
    const tile = this.tileAtClient(ev.clientX, ev.clientY);
    if (!tile) return;
    const info: PointerInfo = {
      kind: ev.kind,
      x: tile.x,
      y: tile.y,
      button: ev.button,
      shift: ev.shift,
      pointerType: ev.pointerType,
    };
    for (const h of this.pointerHandlers) h(info);
    if (ev.kind === "tap") {
      const map = this.map;
      const tx = Math.floor(tile.x + 0.5);
      const ty = Math.floor(tile.y + 0.5);
      if (map && tx >= 0 && ty >= 0 && tx < map.width && ty < map.height) {
        for (const h of this.tapHandlers) h(tx, ty);
      }
    }
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const type = pointerType(e.pointerType);
    for (const ev of this.gestures.down(
      e.pointerId,
      e.clientX,
      e.clientY,
      performance.now(),
      e.button,
      e.shiftKey,
      type,
    )) {
      this.emitGesture(ev);
    }
    this.canvas?.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const type = pointerType(e.pointerType);
    for (const ev of this.gestures.move(
      e.pointerId,
      e.clientX,
      e.clientY,
      performance.now(),
      type,
    )) {
      this.emitGesture(ev);
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    for (const ev of this.gestures.up(e.pointerId, e.clientX, e.clientY, performance.now())) {
      this.emitGesture(ev);
    }
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    this.gestures.cancel(e.pointerId);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.setZoom(wheelZoom(this.zoom, e.deltaY));
  };
}

/** The renderer's QA surface (ArpgWorldRenderer.debug); forwards to the renderer. */
class DebugApi implements RendererDebug {
  private readonly r: PixiWorldRenderer;
  constructor(r: PixiWorldRenderer) {
    this.r = r;
  }
  get enabled(): boolean {
    return this.r.debugEnabled();
  }
  enable(): void {
    this.r.enableDebug();
  }
  info(): RendererDebugInfo {
    return this.r.debugInfo();
  }
  resolveAppearance(
    appearance: string,
    action: EntityAction,
    facing: Facing,
    fallbackAppearance?: string,
    kind?: EntityKind,
  ): AppearanceResolution {
    return this.r.resolveAppearance(appearance, action, facing, fallbackAppearance, kind);
  }
  resolveSprite(id: string): SpriteResolution {
    return this.r.resolveSprite(id);
  }
  hasExactSprite(id: string): boolean {
    return this.r.hasExactSprite(id);
  }
  tileToClient(x: number, y: number): { x: number; y: number } | null {
    return this.r.tileToClient(x, y);
  }
}

/** Share of a shake's amplitude still to come (quadratic decay, 0..1). */
function remainingShare(durationMs: number, elapsedMs: number): number {
  if (!(durationMs > 0)) return 0;
  const left = 1 - elapsedMs / durationMs;
  return left > 0 ? left * left : 0;
}

function pointerType(t: string): "mouse" | "touch" | "pen" {
  if (t === "touch") return "touch";
  if (t === "pen") return "pen";
  return "mouse";
}

/** The shared QA object window.__gamez (created on first use). */
function debugRoot(): Record<string, unknown> | null {
  const g = globalThis as { __gamez?: Record<string, unknown> };
  if (typeof g !== "object") return null;
  g.__gamez ??= {};
  return g.__gamez;
}

export function createWorldRenderer(): WorldRenderer {
  const r = new PixiWorldRenderer();
  if (debugRequested()) r.enableDebug();
  return r;
}

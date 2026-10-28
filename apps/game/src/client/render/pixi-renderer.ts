import { Application, Container, Graphics, GraphicsContext, type Ticker } from "pixi.js";
import type { AssetManifest } from "@gamez/assets";
import { DEFAULT_ISO, screenToTile, tileToScreen, type TileMap } from "@gamez/world";
import type {
  ArpgRenderEntity,
  ArpgWorldRenderer,
  EffectSpec,
  FloatTextSpec,
  PointerInfo,
  RendererStats,
  WorldRenderer,
} from "@gamez/ui-host";
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
import { FxLayer } from "./fx.ts";
import { floatOrigin } from "./fx-plan.ts";
import { LightingOverlay } from "./lighting.ts";
import { GestureTracker, type GestureEvent } from "./gestures.ts";
import { FrameStats } from "./stats.ts";

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

  /** Zoomed world. Children: ground chunks, tap marker, depth-sorted world, effects. */
  private readonly view = new Container();
  private readonly ground = new Container();
  private readonly marker = new Graphics();
  /** Depth-sorted: chunk objects (props) and entities, ordered by depthOf. */
  private readonly world = new Container();
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
  private markerMs = 0;
  private timeMs = 0;
  private lightDarkness = 0;
  private lightRadius = 0;

  constructor() {
    this.world.sortableChildren = true;
    this.view.addChild(this.ground, this.marker, this.world);
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
      loadVisuals(manifest, baseUrl),
    ]);
    if (this.destroyed) {
      app.destroy({ removeView: true });
      return;
    }
    this.app = app;
    this.ticker = app.ticker;
    this.visuals = visuals;
    const prims = buildPrimitives();
    this.prims = prims;
    this.entities = new EntityLayer(this.world, visuals, prims);
    // Exact ids only: an effect without art is drawn procedurally, never as the "missing" sprite.
    this.fx = new FxLayer((id) => visuals.spriteExact(id)?.texture ?? null);
    this.view.addChild(this.fx.layer);
    this.lighting = new LightingOverlay(this.lightLayer);

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
    this.fx?.float(spec, floatOrigin(spec));
  }

  playEffect(spec: EffectSpec): void {
    if (!this.ready) return;
    const s = tileToScreen(spec.x + 0.5, spec.y + 0.5);
    this.fx?.effect(spec, { sx: s.sx, sy: s.sy });
  }

  setZoom(z: number): void {
    const next = clampZoom(z);
    if (next === this.zoom) return;
    this.zoom = next;
    this.view.scale.set(next);
    this.chunkDirty = true;
  }

  getZoom(): number {
    return this.zoom;
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
    const wx = (px - this.view.x) / this.zoom;
    const wy = (py - this.view.y) / this.zoom;
    const t = screenToTile(wx, wy);
    return { x: t.x - 0.5, y: t.y - 0.5 };
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
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

  private clearChunks(): void {
    for (const c of this.chunks.values()) destroyChunk(c);
    this.chunks.clear();
    this.propCount = 0;
  }

  private readonly tick = (t: Ticker): void => {
    const start = performance.now();
    const dt = t.deltaMS;
    this.timeMs += dt;
    for (const ev of this.gestures.tick(start)) this.emitGesture(ev);
    for (const h of this.frameHandlers) h(dt);
    this.updateCamera(dt);
    this.updateChunks();
    this.updateEntities();
    this.fx?.update(dt);
    this.updateLighting();
    if (this.markerMs > 0) {
      this.markerMs -= dt;
      if (this.markerMs <= 0) this.marker.visible = false;
      else this.marker.alpha = this.markerMs / MARKER_MS;
    }
    this.frameStats.frame(dt, performance.now() - start);
  };

  private updateCamera(dt: number): void {
    const app = this.app;
    if (!app || !this.hasTarget) return;
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
    this.view.position.set(sw / 2 - this.camX * this.zoom, sh / 2 - this.camY * this.zoom);
    // Written in place: this runs every frame.
    const hw = sw / (2 * this.zoom);
    const hh = sh / (2 * this.zoom);
    this.rect.x0 = this.camX - hw;
    this.rect.x1 = this.camX + hw;
    this.rect.y0 = this.camY - hh;
    this.rect.y1 = this.camY + hh;
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
      if (v.root.visible !== inView) v.root.visible = inView;
      if (inView && ticker && v.anim && v.anim.visible) v.anim.update(ticker);
    }
    layer.tickPulse(this.timeMs);
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

function pointerType(t: string): "mouse" | "touch" | "pen" {
  if (t === "touch") return "touch";
  if (t === "pen") return "pen";
  return "mouse";
}

export function createWorldRenderer(): WorldRenderer {
  return new PixiWorldRenderer();
}

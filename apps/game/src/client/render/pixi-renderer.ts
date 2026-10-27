import {
  AnimatedSprite,
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  type Texture,
  type Ticker,
} from "pixi.js";
import type { AssetManifest } from "@gamez/assets";
import { DEFAULT_ISO, depthOf, tileToScreen, type TileMap } from "@gamez/world";
import { pickTile, smoothToward } from "./camera.ts";
import {
  buildPrimitives,
  destroyPrimitives,
  diamondPoints,
  groundFallbackColour,
  type Primitives,
} from "./primitives.ts";
import { loadVisuals, type AnimVisual, type Visuals } from "./visuals.ts";
import type { RenderEntity, WorldRenderer } from "./types.ts";

/** Ground is cached in CHUNK x CHUNK tile blocks to stay under mobile texture limits. */
const CHUNK = 8;
const CAMERA_RATE = 8;
const TAP_SLACK_PX = 8;
const MARKER_MS = 600;
const LABEL_GAP = 4;
/** Height of the fallback hero shape above its feet. */
const PRIM_HEIGHT = 21;

interface EntityView {
  root: Container;
  prim: Graphics;
  label: Text;
  sprite: AnimatedSprite | null;
  name: string;
  isSelf: boolean;
  visualKey: string;
  frames: Texture[] | null;
}

/** Pixi-backed isometric world view. Positions use tileToScreen; a tile's centre is tileToScreen(x + 0.5, y + 0.5). */
class PixiWorldRenderer implements WorldRenderer {
  private app: Application | null = null;
  private ticker: Ticker | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private visuals: Visuals | null = null;
  private prims: Primitives | null = null;
  private map: TileMap | null = null;
  private ready = false;
  private destroyed = false;

  private readonly view = new Container();
  private readonly ground = new Container();
  private readonly marker = new Graphics();
  /** Sortable: props and avatars, ordered by depthOf. */
  private readonly world = new Container();
  private chunks: Container[] = [];
  private props: Container[] = [];
  private readonly entities = new Map<string, EntityView>();
  private readonly pending = new Map<string, RenderEntity>();
  private readonly tapHandlers: ((x: number, y: number) => void)[] = [];
  private readonly frameHandlers: ((dtMs: number) => void)[] = [];

  /** Camera target and smoothed position, both in iso screen px. */
  private hasTarget = false;
  private targetX = 0;
  private targetY = 0;
  private hasCam = false;
  private camX = 0;
  private camY = 0;
  private markerMs = 0;
  private pointer: { id: number; x: number; y: number; dragged: boolean } | null = null;

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
    this.prims = buildPrimitives();

    const canvas = app.canvas;
    canvas.style.display = "block";
    canvas.style.touchAction = "none";
    host.appendChild(canvas);
    this.canvas = canvas;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);

    app.stage.addChild(this.view);
    app.ticker.add(this.tick);

    this.ready = true;
    if (this.map) this.buildMap(this.map);
    for (const e of this.pending.values()) this.applyEntity(e);
    this.pending.clear();
  }

  setMap(map: TileMap): void {
    this.map = map;
    if (!this.hasTarget) this.follow(map.spawn.x, map.spawn.y);
    if (this.ready) this.buildMap(map);
  }

  upsertEntity(e: RenderEntity): void {
    if (!this.ready) {
      this.pending.set(e.id, e);
      return;
    }
    this.applyEntity(e);
  }

  removeEntity(id: string): void {
    if (!this.ready) {
      this.pending.delete(id);
      return;
    }
    const v = this.entities.get(id);
    if (!v) return;
    this.entities.delete(id);
    v.root.destroy({ children: true });
  }

  follow(x: number, y: number): void {
    const s = tileToScreen(x + 0.5, y + 0.5);
    this.targetX = s.sx;
    this.targetY = s.sy;
    this.hasTarget = true;
  }

  onTileTap(cb: (x: number, y: number) => void): void {
    this.tapHandlers.push(cb);
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
    }
    for (const c of this.chunks) c.cacheAsTexture(false);
    this.entities.clear();
    this.pending.clear();
    this.props = [];
    this.chunks = [];
    this.tapHandlers.length = 0;
    this.frameHandlers.length = 0;
    this.view.destroy({ children: true });
    if (this.prims) destroyPrimitives(this.prims);
    this.prims = null;
    if (app) app.destroy({ removeView: true });
    this.app = null;
    this.ticker = null;
  }

  private buildMap(map: TileMap): void {
    const visuals = this.visuals;
    const prims = this.prims;
    if (!visuals || !prims) return;

    for (const c of this.ground.removeChildren()) {
      c.cacheAsTexture(false);
      c.destroy({ children: true });
    }
    this.chunks = [];
    for (const p of this.props) p.destroy({ children: true });
    this.props = [];

    const { width, height, ground, objects } = map;
    for (let cy = 0; cy < height; cy += CHUNK) {
      for (let cx = 0; cx < width; cx += CHUNK) {
        const chunk = new Container();
        let fallback: Graphics | null = null;
        for (let y = cy; y < Math.min(cy + CHUNK, height); y++) {
          for (let x = cx; x < Math.min(cx + CHUNK, width); x++) {
            const id = ground[y * width + x];
            if (!id) continue;
            const vis = visuals.sprite(id);
            if (vis) {
              const sp = new Sprite(vis.texture);
              sp.anchor.set(vis.anchor?.x ?? 0.5, vis.anchor?.y ?? 0);
              const s = tileToScreen(x, y);
              sp.position.set(s.sx, s.sy);
              sp.scale.set(DEFAULT_ISO.tileWidth / vis.texture.width);
              chunk.addChild(sp);
            } else {
              if (!fallback) fallback = new Graphics();
              fallback.poly(diamondPoints(x, y)).fill(groundFallbackColour(id));
            }
          }
        }
        if (fallback) chunk.addChild(fallback);
        if (chunk.children.length > 0) {
          chunk.cacheAsTexture(true);
          this.ground.addChild(chunk);
          this.chunks.push(chunk);
        } else {
          chunk.destroy();
        }
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = objects[y * width + x];
        if (!id) continue;
        const vis = visuals.sprite(id);
        const node: Container = vis
          ? new Sprite({
              texture: vis.texture,
              anchor: { x: vis.anchor?.x ?? 0.5, y: vis.anchor?.y ?? 1 },
            })
          : new Graphics(id.includes("tree") ? prims.tree : prims.box);
        const s = tileToScreen(x + 0.5, y + 0.5);
        node.position.set(s.sx, s.sy);
        node.zIndex = depthOf(x, y);
        this.world.addChild(node);
        this.props.push(node);
      }
    }
  }

  private applyEntity(e: RenderEntity): void {
    const prims = this.prims;
    if (!prims) return;
    let v = this.entities.get(e.id);
    if (!v) {
      v = this.createEntity(e);
      this.entities.set(e.id, v);
    }
    const s = tileToScreen(e.x + 0.5, e.y + 0.5);
    v.root.position.set(s.sx, s.sy);
    v.root.zIndex = depthOf(e.x, e.y);

    if (v.isSelf !== e.isSelf) {
      v.isSelf = e.isSelf;
      v.prim.context = e.isSelf ? prims.hero.self : prims.hero.other;
      v.label.style.fill = labelColour(e.isSelf);
    }
    if (v.name !== e.name) {
      v.name = e.name;
      v.label.text = e.name;
    }
    const key = `${e.appearance}.${e.moving ? "walk" : "idle"}.${e.facing}`;
    if (key !== v.visualKey) this.applyVisual(v, key);
  }

  private createEntity(e: RenderEntity): EntityView {
    const prims = this.prims;
    const root = new Container();
    const prim = new Graphics(e.isSelf ? prims!.hero.self : prims!.hero.other);
    const label = new Text({
      text: e.name,
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 12,
        fill: labelColour(e.isSelf),
        stroke: { color: 0x000000, width: 3 },
      },
    });
    label.anchor.set(0.5, 1);
    label.y = -PRIM_HEIGHT - LABEL_GAP;
    root.addChild(prim, label);
    this.world.addChild(root);
    return {
      root,
      prim,
      label,
      sprite: null,
      name: e.name,
      isSelf: e.isSelf,
      visualKey: "",
      frames: null,
    };
  }

  /** Switches between the animated sprite and the primitive fallback for a resolved visual key. */
  private applyVisual(v: EntityView, key: string): void {
    v.visualKey = key;
    const anim: AnimVisual | null = this.visuals ? this.visuals.animation(key) : null;
    if (!anim) {
      v.frames = null;
      if (v.sprite) {
        v.sprite.stop();
        v.sprite.visible = false;
      }
      v.prim.visible = true;
      v.label.y = -PRIM_HEIGHT - LABEL_GAP;
      return;
    }
    if (!v.sprite) {
      v.sprite = new AnimatedSprite(anim.frames, false);
      v.root.addChildAt(v.sprite, 0);
    }
    const sp = v.sprite;
    v.prim.visible = false;
    sp.visible = true;
    if (v.frames !== anim.frames) {
      v.frames = anim.frames;
      sp.textures = anim.frames;
      sp.animationSpeed = anim.fps / 60;
      sp.loop = anim.loop;
      sp.gotoAndPlay(0);
    }
    const a = anim.anchor ?? { x: 0.5, y: 1 };
    sp.anchor.set(a.x, a.y);
    const h = anim.frames[0]?.height ?? PRIM_HEIGHT;
    v.label.y = -a.y * h - LABEL_GAP;
  }

  private readonly tick = (t: Ticker): void => {
    const dt = t.deltaMS;
    for (const h of this.frameHandlers) h(dt);
    this.updateCamera(dt);
    this.entities.forEach(this.stepAnimation);
    if (this.markerMs > 0) {
      this.markerMs -= dt;
      if (this.markerMs <= 0) this.marker.visible = false;
      else this.marker.alpha = this.markerMs / MARKER_MS;
    }
  };

  private readonly stepAnimation = (v: EntityView): void => {
    if (v.sprite && v.sprite.visible && this.ticker) v.sprite.update(this.ticker);
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
    this.view.position.set(app.screen.width / 2 - this.camX, app.screen.height / 2 - this.camY);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.pointer) {
      // A second finger turns the gesture into a pinch, not a tap.
      this.pointer.dragged = true;
      return;
    }
    this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, dragged: false };
    this.canvas?.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const p = this.pointer;
    if (!p || p.id !== e.pointerId || p.dragged) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLACK_PX) p.dragged = true;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const p = this.pointer;
    if (!p || p.id !== e.pointerId) return;
    this.pointer = null;
    if (p.dragged || Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLACK_PX) return;
    const tile = this.tileAt(e.clientX, e.clientY);
    if (!tile) return;
    for (const h of this.tapHandlers) h(tile.x, tile.y);
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.pointer?.id === e.pointerId) this.pointer = null;
  };

  /** Converts a client point to the tile under it, or null when outside the map. */
  private tileAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const app = this.app;
    const canvas = this.canvas;
    const map = this.map;
    if (!app || !canvas || !map) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // Pixi's logical size is CSS px, so mapping through the rect gives stage-local
    // coordinates. Resolution only changes the backing store and cancels out here.
    const px = (clientX - rect.left) * (app.screen.width / rect.width);
    const py = (clientY - rect.top) * (app.screen.height / rect.height);
    return pickTile(px, py, this.view.x, this.view.y, map.width, map.height);
  }
}

function labelColour(isSelf: boolean): number {
  return isSelf ? 0xffd166 : 0xe8ecf4;
}

export function createWorldRenderer(): WorldRenderer {
  return new PixiWorldRenderer();
}

import {
  AnimatedSprite,
  ColorMatrixFilter,
  Container,
  Graphics,
  GraphicsContext,
  Sprite,
  Text,
  type Texture,
} from "pixi.js";
import { depthOf, tileToScreen } from "@gamez/world";
import type {
  ArpgRenderEntity,
  EntityAction,
  EntityHighlight,
  EntityKind,
  Facing,
  GraphicsQualityLevel,
  LabelKind,
} from "@gamez/ui-host";
import {
  clampAnimRate,
  frameFromProgress,
  hitKnockback,
  projectileAngle,
  visibleHeight,
} from "./anim-math.ts";
import {
  appearanceCandidates,
  firstMatch,
  isDeathKey,
  resolveAction,
  shouldFlip,
} from "./appearance.ts";
import type { DebugTracker } from "./debug.ts";
import { clamp01, entityTint, barFill, flashMatrix, flashMix, pulseAmount } from "./fx-math.ts";
import {
  clampOffset,
  labelOffView,
  deoverlapLabels,
  estimateLabelWidth,
  labelRank,
  underChrome,
  type LabelBox,
} from "./label-layout.ts";
import { labelColour } from "./palette.ts";
import {
  fadeToward,
  outlineTarget,
  localRadius,
  OUTLINE_PX,
  OUTLINE_TAPS,
  outlineOffsets,
  outlineRim,
  outlineStyle,
  outlineTaps,
  resolveHighlight,
  RIM_EXTRA_PX,
  ringAlpha,
  ringPulse,
  ringScale,
  solidMatrix,
  tapShown,
} from "./outline-math.ts";
import type { Primitives } from "./primitives.ts";
import type { ViewRect } from "./chunks.ts";
import type { AnimVisual, SpriteVisual, Visuals } from "./visuals.ts";

/** Height used for label and bar placement when the unit is drawn with primitives. */
const PRIM_HEIGHT = 21;
const BAR_W = 28;
const BAR_H = 4;
/** Dead units without a death clip: faded and squashed instead of lying on their side. */
const CORPSE_ALPHA = 0.55;
const CORPSE_SQUASH = 0.72;
/** Label stack line heights (px, world-local). */
const NAME_LINE = 15;
const NAME_FONT_PX = 12;
const SUB_FONT_PX = 10;
const SUB_LINE = 12;
const MARKER_LINE = 22;
const SUBTITLE_COLOUR = 0xb3b9c6;
const MARKER_COLOUR = 0xffd166;
/** Name backing plate (labelPlate): colour, opacity, padding (px). */
const PLATE_COLOUR = 0x05070b;
const PLATE_ALPHA = 0.62;
const PLATE_PAD_X = 3;
/** Floats snap to a unit whose feet are this close (world px) to the float's tile centre. */
const FLOAT_SNAP_X = 26;
const FLOAT_SNAP_Y = 18;
/** Approximate float text box (px) for clearOfLabels. */
const FLOAT_W = 24;
const FLOAT_H = 18;
/** Labels stay this far (px) inside the view edges. */
const VIEW_PAD = 4;
/** Marker bob: amplitude (px) and period factor (ms per radian). */
const BOB_PX = 2.5;
const BOB_MS = 230;
/** Cast glow: the unit rises this much (px) at full glow. */
const GLOW_LIFT_PX = 3;
/** Hit flash colour mix is quantised to this many steps (so the filter only changes a few times per flash). */
const FLASH_STEPS = 16;

/**
 * Identity outline of one view (outline-math.ts explains the stamping). The
 * stamps live in `root`, the first child of the body, so they follow the
 * flip, squash, lift and knockback; the ground ring lives in the view root.
 * Created on first use, then only re-pointed at the current frame texture.
 */
export interface OutlineView {
  readonly root: Container;
  /** Dark rim copies (multiply tint 0 = black), behind `fill`. */
  readonly rim: Container;
  /** Coloured copies, painted solid by `filter`. */
  readonly fill: Container;
  readonly rimStamps: Sprite[];
  readonly fillStamps: Sprite[];
  /** Solid-colour filter of `fill` (null without WebGL, e.g. tests: the copies are tinted instead). */
  readonly filter: ColorMatrixFilter | null;
  readonly ring: Graphics;
  kind: EntityHighlight;
  /** Frame texture the stamps show and its anchor. */
  tex: Texture | null;
  ax: number;
  ay: number;
  /** Stamp radius in body-local px. */
  radius: number;
  /** Opacity 0..1 (fades out on death) and where it is heading. */
  fade: number;
  target: number;
}

export type Resolved =
  | { kind: "anim"; anim: AnimVisual }
  | { kind: "still"; sprite: SpriteVisual }
  | { kind: "prim" };

/**
 * One entity's containers. Created once and kept until removed. Optional parts
 * (sprites, bar, labels, highlight ring) are created the first time they are
 * needed and then only shown or hidden.
 *
 * The body lives in `root` (depth-sorted world layer). Bars, names, subtitles
 * and quest markers live in `tag`, a container in a separate label layer above
 * every sprite, so names are never hidden behind other units or walls.
 */
export interface EntityView {
  readonly id: string;
  readonly root: Container;
  readonly shadow: Graphics;
  /** Body parts: primitive shape, static sprite and animated sprite. Only one is visible. */
  readonly body: Container;
  readonly prim: Graphics;
  still: Sprite | null;
  anim: AnimatedSprite | null;
  ring: Graphics | null;
  /** Identity outline (highlight "self" | "party" | "ally"), created on first use. */
  outline: OutlineView | null;
  /** Identity outline kind wanted this upsert (null = none). */
  outlineKind: EntityHighlight | null;
  /** Label-layer container at the entity's feet (bar + texts). */
  tag: Container | null;
  /** Texts inside `tag`, shifted as one by de-overlap and the view clamp. */
  texts: Container | null;
  bar: Graphics | null;
  label: Text | null;
  /** Dark plate behind the name (labelPlate), inside `texts`. */
  plate: Graphics | null;
  plateOn: boolean;
  subtitle: Text | null;
  marker: Text | null;
  /** Screen position of the tile centre, world-local iso px. */
  sx: number;
  sy: number;
  kind: EntityKind;
  isSelf: boolean;
  name: string;
  appearance: string;
  fallback: string;
  action: EntityAction;
  facing: Facing;
  resolved: Resolved["kind"];
  resolvedKey: string;
  framesRef: Texture[] | null;
  height: number;
  tint: number;
  paintedTint: number;
  highlight: boolean;
  statusTint: number;
  hitFlash: number;
  /** Colour of the white hit flash (0xffffff by default). */
  flashColour: number;
  /** Quantised flash mix currently applied (0 = none). */
  flashK: number;
  /** Colour filter on the body during a hit flash; created on first flash. */
  flashFilter: ColorMatrixFilter | null;
  flashOn: boolean;
  /** Additive cast-glow halo (created on first glow) and its state. */
  glow: Graphics | null;
  glowColour: number;
  glowAmt: number;
  /** Lift from zLift (projectiles) and from the cast glow; body.y = -(zLift + glow lift). */
  zLift: number;
  /** Dead without a death clip (faded and squashed). */
  corpse: boolean;
  flip: boolean;
  rotation: number;
  knock: number;
  lift: number;
  scale: number;
  /** Manual frame control (actionProgress) is active. */
  manual: boolean;
  /** Clip speed of the resolved animation at rate 1, and the rate applied. */
  baseSpeed: number;
  animRate: number;
  barValue: number;
  barColour: number;
  labelColour: number;
  subtitleText: string;
  markerText: string;
  labelPriority: number;
  topY: number;
  /** Name/subtitle/marker visibility wanted this upsert (before culling). */
  labelOn: boolean;
  subtitleOn: boolean;
  markerOn: boolean;
  /** Bottom of the name line, of the whole text stack, and its top, relative to the feet. */
  nameBottom: number;
  textBottom: number;
  stackTop: number;
  /** Marker resting position (bottom edge) before the bob. */
  markerY: number;
  labelW: number;
  /** De-overlap shift and view clamp offsets of `texts`. */
  labelDy: number;
  clampX: number;
  clampY: number;
  /** Hidden as a duplicate name by the de-overlap pass. */
  dupHidden: boolean;
  box: LabelBox | null;
}

export class EntityLayer {
  private readonly views = new Map<string, EntityView>();
  /** Cast glow halos on or off (graphics quality low turns them off). */
  glowOn = true;
  /**
   * Makes the hit-flash colour filter (created on the first hit of a view). A
   * seam for tests: the default needs a WebGL context, and a null result draws
   * no flash.
   */
  makeFlashFilter: () => ColorMatrixFilter | null = () => new ColorMatrixFilter();
  /** Entities with a status tint; their tint pulses every frame. */
  private readonly pulsing = new Set<EntityView>();
  /** Entities with an identity outline: frame sync, ring pulse and death fade every frame. */
  private readonly outlined = new Set<EntityView>();
  /** Outline quality (taps and rim) and the camera zoom (constant on-screen width). */
  private outlineQ: GraphicsQualityLevel = "high";
  private zoom = 1;
  private lastPulseMs = Number.NaN;
  /** Ground ring shapes, one per outline kind, shared by every view. */
  private readonly ringShapes = new Map<EntityHighlight, GraphicsContext>();
  /** Reused stamp offsets (x, y pairs). */
  private readonly offsets = new Float32Array(OUTLINE_TAPS * 2);
  /**
   * Makes the solid-colour filter of an outline. A seam for tests like
   * makeFlashFilter; a null result tints the copies with the colour instead.
   */
  makeOutlineFilter: () => ColorMatrixFilter | null = () => {
    try {
      return new ColorMatrixFilter();
    } catch {
      return null;
    }
  };
  /** Entities with a quest marker; it bobs every frame. */
  private readonly bobbing = new Set<EntityView>();
  /** Entities with any visible text (name, subtitle, marker); kept inside the view. */
  private readonly labelled = new Set<EntityView>();
  /** Reused list of label boxes for the de-overlap pass. */
  private readonly boxes: LabelBox[] = [];
  /**
   * A labelled entity was shown, hidden, moved or changed its stack: re-run
   * the de-overlap pass. Every visible label takes part; the hero's own name
   * ranks +Infinity (never moved), so signs, names and loot step aside.
   */
  private layoutDirty = false;
  /** A labelled entity moved or changed its stack: re-run the view clamp. */
  private clampDirty = false;
  private readonly lastRect: ViewRect = { x0: NaN, y0: NaN, x1: NaN, y1: NaN };
  private readonly lastInner: ViewRect = { x0: NaN, y0: NaN, x1: NaN, y1: NaN };
  /** QA tracking (null unless the renderer's debug is enabled). */
  debug: DebugTracker | null = null;

  constructor(
    private readonly world: Container,
    private readonly visuals: Visuals,
    private readonly prims: Primitives,
    /** Label layer drawn above the world (names, bars, markers). */
    readonly labels: Container = new Container(),
  ) {}

  get size(): number {
    return this.views.size;
  }

  all(): IterableIterator<EntityView> {
    return this.views.values();
  }

  upsert(e: ArpgRenderEntity): void {
    let v = this.views.get(e.id);
    if (!v) {
      v = this.create(e);
      this.views.set(e.id, v);
    }
    this.apply(v, e);
  }

  remove(id: string): void {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    this.forget(v);
    v.flashFilter?.destroy();
    v.outline?.filter?.destroy();
    v.root.destroy({ children: true });
    v.tag?.destroy({ children: true });
  }

  clear(): void {
    for (const v of this.views.values()) {
      v.flashFilter?.destroy();
      v.outline?.filter?.destroy();
      v.root.destroy({ children: true });
      v.tag?.destroy({ children: true });
    }
    this.views.clear();
    this.pulsing.clear();
    this.bobbing.clear();
    this.labelled.clear();
    this.outlined.clear();
    this.boxes.length = 0;
    this.layoutDirty = false;
  }

  /**
   * Outline quality: 8 stamp directions and a dark rim on medium/high, the 4
   * cardinal stamps and no rim on low. Cheap; re-lays existing outlines.
   */
  setOutlineQuality(q: GraphicsQualityLevel): void {
    if (q === this.outlineQ) return;
    this.outlineQ = q;
    for (const v of this.outlined) if (v.outline) this.layoutStamps(v.outline, true);
  }

  /** Camera zoom, so the outline keeps its on-screen width (applied on the next frame). */
  setOutlineZoom(z: number): void {
    if (Number.isFinite(z) && z > 0) this.zoom = z;
  }

  /** QA: identity outlines drawn right now (in view and not faded out), by kind. */
  outlineCensus(): Record<EntityHighlight, number> {
    const out: Record<EntityHighlight, number> = { self: 0, party: 0, ally: 0 };
    for (const v of this.outlined) {
      const o = v.outline;
      if (!o || !v.root.visible || o.fade <= 0) continue;
      out[o.kind]++;
    }
    return out;
  }

  /** Per-frame work for visible entities: outlines, status tint pulse and quest marker bob. */
  tickPulse(timeMs: number): void {
    const dt = Number.isFinite(this.lastPulseMs) ? Math.max(0, timeMs - this.lastPulseMs) : 0;
    this.lastPulseMs = timeMs;
    if (this.outlined.size > 0) this.tickOutlines(timeMs, dt);
    if (this.pulsing.size > 0) {
      const k = pulseAmount(timeMs);
      for (const v of this.pulsing) {
        if (!v.root.visible) continue;
        const want = bodyTint(v, k);
        if (want !== v.paintedTint) paint(v, want);
      }
    }
    if (this.bobbing.size > 0) {
      const bob = Math.round(Math.sin(timeMs / BOB_MS) * BOB_PX * 2) / 2;
      for (const v of this.bobbing) {
        const m = v.marker;
        if (!m || !v.root.visible) continue;
        const y = v.markerY + bob;
        if (m.y !== y) m.y = y;
      }
    }
  }

  /**
   * Outlines, once per frame after the clips advanced: point the stamps at the
   * current frame (only when it changed), keep the on-screen width, fade on
   * death and pulse the ground ring. No allocation.
   */
  private tickOutlines(timeMs: number, dt: number): void {
    const pulse = ringPulse(timeMs);
    const ringK = ringScale(pulse);
    for (const v of this.outlined) {
      const o = v.outline;
      if (!o) continue;
      if (o.fade !== o.target) o.fade = fadeToward(o.fade, o.target, dt);
      const on = o.fade > 0;
      if (!on) {
        if (o.root.visible) o.root.visible = false;
        if (o.ring.visible) o.ring.visible = false;
        continue;
      }
      if (!v.root.visible) continue;
      this.syncStamps(v, o);
      if (o.root.alpha !== o.fade) o.root.alpha = o.fade;
      if (!o.ring.visible) o.ring.visible = true;
      o.ring.alpha = ringAlpha(outlineStyle(o.kind), pulse) * o.fade;
      o.ring.scale.set(ringK * v.scale);
    }
  }

  /** Points the stamps at the body's current frame and keeps their radius. */
  private syncStamps(v: EntityView, o: OutlineView): void {
    const src = v.resolved === "anim" ? v.anim : v.resolved === "still" ? v.still : null;
    if (!src) {
      // Primitive bodies keep only the ground ring.
      if (o.root.visible) o.root.visible = false;
      return;
    }
    if (!o.root.visible) o.root.visible = true;
    const tex = src.texture;
    if (o.tex !== tex) {
      o.tex = tex;
      for (const s of o.fillStamps) s.texture = tex;
      for (const s of o.rimStamps) s.texture = tex;
    }
    const ax = src.anchor.x;
    const ay = src.anchor.y;
    if (o.ax !== ax || o.ay !== ay) {
      o.ax = ax;
      o.ay = ay;
      for (const s of o.fillStamps) s.anchor.set(ax, ay);
      for (const s of o.rimStamps) s.anchor.set(ax, ay);
    }
    const r = localRadius(OUTLINE_PX, this.zoom, v.scale);
    if (o.radius !== r) {
      o.radius = r;
      this.layoutStamps(o, false);
    }
  }

  /** Stamp positions (from the radius) and, with `quality`, which stamps and rim show. */
  private layoutStamps(o: OutlineView, quality: boolean): void {
    const off = this.offsets;
    outlineOffsets(o.radius, off);
    for (let i = 0; i < o.fillStamps.length; i++) {
      o.fillStamps[i]!.position.set(off[i * 2]!, off[i * 2 + 1]!);
    }
    // Same zoom and unit scale as the fill radius, RIM_EXTRA_PX further out.
    outlineOffsets((o.radius * (OUTLINE_PX + RIM_EXTRA_PX)) / OUTLINE_PX, off);
    for (let i = 0; i < o.rimStamps.length; i++) {
      o.rimStamps[i]!.position.set(off[i * 2]!, off[i * 2 + 1]!);
    }
    if (!quality) return;
    const taps = outlineTaps(this.outlineQ);
    for (let i = 0; i < o.fillStamps.length; i++) o.fillStamps[i]!.visible = tapShown(i, taps);
    o.rim.visible = outlineRim(this.outlineQ);
  }

  /** Culling of the label layer: a tag shows only when its entity is in view and has content. */
  syncTag(v: EntityView): void {
    const tag = v.tag;
    if (!tag) return;
    const want = v.root.visible && (v.labelOn || v.markerOn || !!v.bar?.visible);
    if (tag.visible !== want) {
      tag.visible = want;
      this.clampDirty = true;
      if (this.labelled.has(v)) this.layoutDirty = true;
    }
  }

  /** The label of `v` at its natural place lies wholly outside the view (label-layout labelOffView). */
  private offView(v: EntityView, rect: ViewRect): boolean {
    const w = Math.max(v.labelW, v.markerOn ? 12 : 0);
    return labelOffView(
      v.sx,
      w,
      v.sy + v.stackTop + v.labelDy,
      v.sy + v.nameBottom + v.labelDy,
      rect,
    );
  }

  /**
   * Label layout, run once per frame after culling. De-overlaps every visible
   * label (when a labelled entity changed or moved), then keeps each label
   * inside `inner` (the view minus the HUD insets; only when the camera or a
   * labelled entity moved). Labels whose entity stands under HUD chrome
   * (outside `inner` on an inset edge), labels wholly outside the view (an
   * off-screen entity) and duplicate names are hidden.
   */
  layoutLabels(rect: ViewRect, inner: ViewRect = rect): void {
    const r = this.lastRect;
    const q = this.lastInner;
    if (
      r.x0 !== rect.x0 ||
      r.x1 !== rect.x1 ||
      r.y0 !== rect.y0 ||
      r.y1 !== rect.y1 ||
      q.x0 !== inner.x0 ||
      q.x1 !== inner.x1 ||
      q.y0 !== inner.y0 ||
      q.y1 !== inner.y1
    ) {
      r.x0 = rect.x0;
      r.x1 = rect.x1;
      r.y0 = rect.y0;
      r.y1 = rect.y1;
      q.x0 = inner.x0;
      q.x1 = inner.x1;
      q.y0 = inner.y0;
      q.y1 = inner.y1;
      // Clamped x and the labels under the HUD chrome change with the view.
      this.layoutDirty = true;
    }
    if (this.layoutDirty) {
      this.layoutDirty = false;
      this.clampDirty = true;
      const boxes = this.boxes;
      let n = 0;
      for (const v of this.labelled) {
        const b = v.box;
        if (!b) continue;
        b.dy = 0;
        b.hidden = false;
        if (!v.root.visible) continue;
        if (!v.isSelf && (underChrome(v.sx, v.sy, rect, inner) || this.offView(v, rect))) continue;
        b.x = v.sx + v.clampX;
        b.bottom = v.sy + v.textBottom;
        b.w = Math.max(v.labelW, v.markerOn ? 12 : 0);
        b.h = v.textBottom - v.stackTop;
        b.rank = labelRank(v.kind, v.isSelf, v.labelPriority);
        // Same-name monsters standing together (a champion pack, two husks) show one name.
        b.group = v.kind === "unit" && !v.isSelf && v.labelOn ? v.name : "";
        if (n < boxes.length) boxes[n] = b;
        else boxes.push(b);
        n++;
      }
      // No truncation: the array keeps its backing store (stale tail slots are
      // ignored by deoverlapLabels and overwritten next time).
      deoverlapLabels(boxes, n);
      for (const v of this.labelled) {
        const b = v.box;
        v.labelDy = b ? b.dy : 0;
        v.dupHidden = b ? !!b.hidden : false;
      }
    }
    if (!this.clampDirty) return;
    this.clampDirty = false;
    for (const v of this.labelled) {
      const texts = v.texts;
      if (!texts) continue;
      if (!v.root.visible) continue;
      const hide =
        v.dupHidden ||
        (!v.isSelf && (underChrome(v.sx, v.sy, rect, inner) || this.offView(v, rect)));
      if (texts.visible === hide) texts.visible = !hide;
      if (hide) continue;
      const w = Math.max(v.labelW, v.markerOn ? 12 : 0);
      const cx = clampOffset(v.sx, w, inner.x0, inner.x1, VIEW_PAD);
      // Vertical: the whole stack (top = stackTop) stays below the top edge,
      // the name's bottom stays above the bottom edge.
      const top = v.sy + v.stackTop + v.labelDy;
      const bottom = v.sy + v.nameBottom + v.labelDy;
      let cy = 0;
      if (top < inner.y0 + VIEW_PAD) cy = inner.y0 + VIEW_PAD - top;
      else if (bottom > inner.y1 - VIEW_PAD) cy = inner.y1 - VIEW_PAD - bottom;
      // The de-overlap pass uses the clamped x: re-run it when that moved.
      if (v.clampX !== cx) this.layoutDirty = true;
      v.clampX = cx;
      v.clampY = cy;
      const ty = v.labelDy + cy;
      if (texts.x !== cx) texts.x = cx;
      if (texts.y !== ty) texts.y = ty;
    }
  }

  /**
   * Lifts a float text start (bottom-centre anchor at sx, sy; about FLOAT_H
   * px tall) above every visible label stack it would cover, e.g. the name a
   * pack shows for a member whose own name is hidden as a duplicate. A few
   * passes at most; once per float text, never per frame.
   */
  clearOfLabels(sx: number, sy: number): number {
    let y = sy;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const v of this.labelled) {
        if (!v.root.visible || !v.labelOn || v.texts?.visible === false || !v.tag?.visible) {
          continue;
        }
        const shift = v.labelDy + v.clampY;
        const top = v.sy + v.stackTop + shift;
        const bottom = v.sy + v.textBottom + shift;
        if (Math.abs(v.sx + v.clampX - sx) * 2 >= v.labelW + FLOAT_W) continue;
        if (y <= top || y - FLOAT_H >= bottom) continue;
        y = top - 1;
        moved = true;
      }
      if (!moved) break;
    }
    return y;
  }

  /**
   * World-local y of the top of what is drawn above the unit nearest to
   * (sx, sy) (feet within FLOAT_SNAP px): its visible label stack, else its
   * health bar, else its head. NaN when no visible unit is that close. Called
   * once per float text (not per frame); floats start above this line so
   * damage numbers never cover a nameplate.
   */
  headTopNear(sx: number, sy: number): number {
    let best: EntityView | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const v of this.views.values()) {
      if (v.kind !== "unit" || !v.root.visible || v.corpse) continue;
      const dx = Math.abs(v.sx - sx);
      const dy = Math.abs(v.sy - sy);
      if (dx > FLOAT_SNAP_X || dy > FLOAT_SNAP_Y) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        best = v;
        bestD = d;
      }
    }
    if (!best) return Number.NaN;
    const v = best;
    if ((v.labelOn || v.markerOn) && v.texts?.visible !== false && v.tag?.visible) {
      return v.sy + v.stackTop + v.labelDy + v.clampY;
    }
    if (v.bar?.visible) return v.sy + v.topY;
    return v.sy + v.topY + 4;
  }

  private forget(v: EntityView): void {
    this.outlined.delete(v);
    this.pulsing.delete(v);
    this.bobbing.delete(v);
    if (this.labelled.delete(v)) this.layoutDirty = true;
  }

  private create(e: ArpgRenderEntity): EntityView {
    const root = new Container();
    const shadow = new Graphics(this.prims.shadow);
    const body = new Container();
    const prim = new Graphics(
      primShape(this.prims, e.kind ?? "unit", e.isSelf, e.kind !== undefined),
    );
    body.addChild(prim);
    root.addChild(shadow, body);
    this.world.addChild(root);
    return {
      id: e.id,
      root,
      shadow,
      body,
      prim,
      still: null,
      anim: null,
      ring: null,
      outline: null,
      outlineKind: null,
      tag: null,
      texts: null,
      bar: null,
      label: null,
      plate: null,
      plateOn: false,
      subtitle: null,
      marker: null,
      sx: 0,
      sy: 0,
      kind: e.kind ?? "unit",
      isSelf: e.isSelf,
      name: e.name,
      appearance: "",
      fallback: "",
      action: "idle",
      facing: "s",
      resolved: "prim",
      resolvedKey: "",
      framesRef: null,
      height: PRIM_HEIGHT,
      tint: 0xffffff,
      paintedTint: -1,
      highlight: false,
      statusTint: 0,
      hitFlash: 0,
      flashColour: 0xffffff,
      flashK: 0,
      flashFilter: null,
      flashOn: false,
      glow: null,
      glowColour: -1,
      glowAmt: 0,
      zLift: 0,
      corpse: false,
      flip: false,
      rotation: 0,
      knock: 0,
      lift: 0,
      scale: 1,
      manual: false,
      baseSpeed: 0,
      animRate: 1,
      barValue: -1,
      barColour: -1,
      labelColour: -1,
      subtitleText: "",
      markerText: "",
      labelPriority: 0,
      topY: 0,
      labelOn: false,
      subtitleOn: false,
      markerOn: false,
      nameBottom: 0,
      textBottom: 0,
      stackTop: 0,
      markerY: 0,
      labelW: 0,
      labelDy: 0,
      clampX: 0,
      clampY: 0,
      dupHidden: false,
      box: null,
    };
  }

  private apply(v: EntityView, e: ArpgRenderEntity): void {
    // Position and depth: every call, but the z order is only written when it changes.
    const s = tileToScreen(e.x + 0.5, e.y + 0.5);
    const moved = v.sx !== s.sx || v.sy !== s.sy;
    v.sx = s.sx;
    v.sy = s.sy;
    v.root.position.set(s.sx, s.sy);
    if (v.tag && moved) v.tag.position.set(s.sx, s.sy);
    const depth = depthOf(e.x, e.y);
    if (v.root.zIndex !== depth) v.root.zIndex = depth;

    const kind = e.kind ?? "unit";
    const projectile = kind === "projectile";
    if (v.kind !== kind || v.isSelf !== e.isSelf) {
      v.kind = kind;
      v.isSelf = e.isSelf;
      const shape = primShape(this.prims, kind, e.isSelf, e.kind !== undefined);
      if (v.prim.context !== shape) v.prim.context = shape;
    }
    v.shadow.visible = !projectile;

    let textChanged = false;
    if (v.name !== e.name) {
      v.name = e.name;
      if (v.label) {
        v.label.text = e.name;
        textChanged = true;
      }
    }

    const action = resolveAction(e.action, e.dead, e.moving);
    const fallback = e.fallbackAppearance ?? "";
    if (
      v.appearance !== e.appearance ||
      v.fallback !== fallback ||
      v.action !== action ||
      v.facing !== e.facing
    ) {
      v.appearance = e.appearance;
      v.fallback = fallback;
      v.action = action;
      v.facing = e.facing;
      this.resolve(v);
    }
    this.updateClip(v, action, e);

    // Corpses without a death clip fade and squash (no sideways rotation:
    // upright art lying on its side reads as a glitch).
    const corpse = !!e.dead && !(v.resolved === "anim" && isDeathKey(v.resolvedKey));
    const corpseChanged = v.corpse !== corpse;
    v.corpse = corpse;
    const alpha = (e.alpha ?? 1) * (corpse ? CORPSE_ALPHA : 1);
    if (v.root.alpha !== alpha) v.root.alpha = alpha;
    if (v.tag && v.tag.alpha !== alpha) v.tag.alpha = alpha;

    const rotation = projectile ? projectileAngle(e.vx ?? 0, e.vy ?? 0) : 0;
    if (v.rotation !== rotation) {
      v.rotation = rotation;
      v.body.rotation = rotation;
    }

    const scale = (e.scale ?? 100) / 100;
    const flip = shouldFlip(v.resolvedKey, e.facing, kind);
    if (v.scale !== scale || v.flip !== flip || corpseChanged) {
      v.scale = scale;
      v.flip = flip;
      v.body.scale.set(flip ? -scale : scale, corpse ? scale * CORPSE_SQUASH : scale);
      v.shadow.scale.set(scale);
    }
    v.zLift = e.zLift ?? 0;
    this.updateGlow(v, e.castGlow ?? 0, e.glowColor ?? 0xffffff);

    const hitFlash = e.hitFlash !== undefined && e.hitFlash > 0 ? Math.min(1, e.hitFlash) : 0;
    v.hitFlash = hitFlash;
    this.updateFlash(v, hitFlash, e.hitFlashColor ?? 0xffffff);
    const knock = hitKnockback(hitFlash, flip);
    if (v.knock !== knock) {
      v.knock = knock;
      v.body.x = knock;
    }

    const tint = e.tint ?? 0xffffff;
    // `true` is the hover channel; identity kinds ("self" ...) are the outline below.
    const highlight = e.highlight === true;
    const statusTint = e.statusTint ?? 0;
    v.tint = tint;
    v.highlight = highlight;
    v.statusTint = statusTint;
    if (statusTint !== 0) this.pulsing.add(v);
    else this.pulsing.delete(v);
    const want = bodyTint(v, 0);
    if (want !== v.paintedTint) paint(v, want);

    this.updateRing(v, highlight);
    const outlineKind = kind === "unit" ? resolveHighlight(e.highlight, e.isSelf) : null;
    this.updateOutline(v, outlineKind, action === "death" || !!e.dead);
    const topChanged = this.updateLayout(v);
    this.updateBar(v, projectile ? null : (e.bar ?? null), e.barColor ?? 0x4caf50);
    this.updateTexts(v, e, projectile, topChanged || textChanged, moved);
    this.syncTag(v);
  }

  /** First animation or sprite of the documented fallback chain, or null (primitive). */
  lookup(
    appearance: string,
    action: EntityAction,
    facing: Facing,
    fallback: string | undefined,
  ): { key: string; value: Resolved } | null {
    const candidates = appearanceCandidates(appearance, action, facing, fallback || undefined);
    return firstMatch<Resolved>(candidates, (key) => {
      const anim = this.visuals.animationExact(key);
      if (anim) return { kind: "anim", anim };
      const sprite = this.visuals.spriteExact(key);
      if (sprite) return { kind: "still", sprite };
      return null;
    });
  }

  /** QA: visible entities and labels by kind, right now. */
  census(): { drawn: number; primitives: number; labels: Record<LabelKind, number> } {
    const labels: Record<LabelKind, number> = {
      nameplate: 0,
      npc: 0,
      loot: 0,
      sign: 0,
      damage: 0,
      healthbar: 0,
      marker: 0,
      subtitle: 0,
    };
    let drawn = 0;
    let primitives = 0;
    for (const v of this.views.values()) {
      if (!v.root.visible) continue;
      drawn++;
      if (v.resolved === "prim") primitives++;
      if (v.bar?.visible) labels.healthbar++;
      if (v.texts?.visible === false) continue;
      if (v.marker?.visible) labels.marker++;
      if (v.subtitle?.visible) labels.subtitle++;
      if (!v.label?.visible) continue;
      if (v.kind === "npc") labels.npc++;
      else if (v.kind === "loot") labels.loot++;
      else if (v.kind === "prop") labels.sign++;
      else labels.nameplate++;
    }
    return { drawn, primitives, labels };
  }

  /** Picks the animation or sprite for the new key, with the documented fallback chain. */
  private resolve(v: EntityView): void {
    const hit = this.lookup(v.appearance, v.action, v.facing, v.fallback);
    this.debug?.resolved(
      v.appearance,
      v.action,
      v.facing,
      v.fallback,
      hit ? hit.key : null,
      v.kind,
    );
    const r: Resolved = hit ? hit.value : { kind: "prim" };
    v.resolved = r.kind;
    v.resolvedKey = hit ? hit.key : "";
    v.paintedTint = -1;

    if (r.kind === "anim") {
      const frames = r.anim.frames;
      if (!v.anim) {
        v.anim = new AnimatedSprite(frames, false);
        v.body.addChild(v.anim);
      }
      const sp = v.anim;
      if (v.framesRef !== frames) {
        v.framesRef = frames;
        sp.textures = frames;
        v.baseSpeed = r.anim.fps / 60;
        sp.animationSpeed = v.baseSpeed * v.animRate;
        sp.loop = r.anim.loop;
        sp.gotoAndPlay(0);
        v.manual = false;
      }
      const a = r.anim.anchor ?? { x: 0.5, y: 1 };
      sp.anchor.set(a.x, a.y);
      v.height = frames[0] ? headHeight(frames[0], a.y) : PRIM_HEIGHT;
      sp.visible = true;
      if (v.still) hideSprite(v.still);
      v.prim.visible = false;
    } else if (r.kind === "still") {
      if (!v.still) {
        v.still = new Sprite(r.sprite.texture);
        v.body.addChild(v.still);
      }
      const sp = v.still;
      sp.texture = r.sprite.texture;
      const a = r.sprite.anchor ?? { x: 0.5, y: 1 };
      sp.anchor.set(a.x, a.y);
      v.height = headHeight(r.sprite.texture, a.y);
      sp.visible = true;
      if (v.anim) hideSprite(v.anim);
      v.prim.visible = false;
    } else {
      v.height = PRIM_HEIGHT;
      v.prim.visible = true;
      if (v.anim) hideSprite(v.anim);
      if (v.still) hideSprite(v.still);
    }
    v.framesRef = r.kind === "anim" ? r.anim.frames : null;
  }

  /**
   * Clip playback: manual frames from actionProgress for attack/cast, else
   * autoplay; the clip speed follows animRate. Only writes what changed.
   */
  private updateClip(v: EntityView, action: EntityAction, e: ArpgRenderEntity): void {
    const sp = v.anim;
    if (!sp || v.resolved !== "anim") return;
    const rate = clampAnimRate(e.animRate);
    if (v.animRate !== rate) {
      v.animRate = rate;
      sp.animationSpeed = v.baseSpeed * rate;
    }
    const progress = e.actionProgress;
    const manual = progress !== undefined && (action === "attack" || action === "cast");
    if (manual) {
      const f = frameFromProgress(progress, sp.totalFrames);
      if (!v.manual || sp.playing || sp.currentFrame !== f) sp.gotoAndStop(f);
      v.manual = true;
    } else if (v.manual) {
      v.manual = false;
      sp.gotoAndPlay(0);
    }
  }

  /**
   * Cast glow: an additive halo in the skill's colour at the feet and around the
   * head, and a slight lift, while `castGlow` > 0. The halo is drawn once per
   * colour; changing the strength only changes alpha and lift.
   */
  private updateGlow(v: EntityView, castGlow: number, colour: number): void {
    const amt = this.glowOn ? clamp01(castGlow) : 0;
    if (amt > 0) {
      if (!v.glow) {
        const g = new Graphics();
        g.blendMode = "add";
        v.root.addChildAt(g, 1);
        v.glow = g;
        v.glowColour = -1;
      }
      if (v.glowColour !== colour) {
        v.glowColour = colour;
        v.glow
          .clear()
          .ellipse(0, 0, 15, 6)
          .fill({ color: colour, alpha: 0.3 })
          .ellipse(0, -12, 18, 14)
          .fill({ color: colour, alpha: 0.18 })
          .ellipse(0, -12, 11, 9)
          .fill({ color: colour, alpha: 0.28 })
          .ellipse(0, -12, 18, 14)
          .stroke({ width: 1.5, color: colour, alpha: 0.7 });
      }
      v.glow.visible = true;
      v.glow.alpha = amt;
    } else if (v.glow) {
      v.glow.visible = false;
    }
    v.glowAmt = amt;
    const lift = v.zLift + GLOW_LIFT_PX * amt;
    if (v.lift !== lift) {
      v.lift = lift;
      // No -0: a zero lift leaves the body at exactly 0.
      v.body.y = lift === 0 ? 0 : -lift;
    }
  }

  /**
   * White (or coloured) hit flash: a colour-matrix filter on the body that mixes
   * it towards `colour`, keeping alpha. The filter exists only while flashing;
   * the mix is quantised so the matrix changes a few times per flash.
   */
  private updateFlash(v: EntityView, flash: number, colour: number): void {
    const k = Math.round(flashMix(flash) * FLASH_STEPS) / FLASH_STEPS;
    if (k <= 0) {
      if (v.flashOn) {
        v.body.filters = null;
        v.flashOn = false;
        v.flashK = 0;
      }
      return;
    }
    if (!v.flashFilter) v.flashFilter = this.makeFlashFilter();
    if (!v.flashFilter) return;
    if (!v.flashOn) {
      v.body.filters = [v.flashFilter];
      v.flashOn = true;
    }
    if (v.flashK !== k || v.flashColour !== colour) {
      v.flashK = k;
      v.flashColour = colour;
      v.flashFilter.matrix = flashMatrix(colour, k);
    }
  }

  private updateRing(v: EntityView, highlight: boolean): void {
    if (!highlight) {
      if (v.ring) v.ring.visible = false;
      return;
    }
    if (!v.ring) {
      v.ring = new Graphics()
        .ellipse(0, 0, 14, 7)
        .stroke({ width: 2, color: 0xffd166, alpha: 0.9 });
      v.root.addChildAt(v.ring, 1);
    }
    v.ring.visible = true;
  }

  /**
   * Identity outline on or off, its kind (colour) and whether it is fading
   * (death: self and party dim to DOWNED_OUTLINE_ALPHA, ally fades out). The
   * per-frame part (frame sync, pulse, fade) is tickOutlines.
   */
  private updateOutline(v: EntityView, kind: EntityHighlight | null, dead: boolean): void {
    if (kind === null) {
      if (v.outlineKind !== null) {
        v.outlineKind = null;
        this.outlined.delete(v);
        const o = v.outline;
        if (o) {
          o.root.visible = false;
          o.ring.visible = false;
        }
      }
      return;
    }
    const target = outlineTarget(kind, dead);
    let o = v.outline;
    const fresh = v.outlineKind === null;
    if (!o) {
      o = this.createOutline(v, kind);
      v.outline = o;
      this.paintOutline(o, kind);
    } else if (o.kind !== kind) {
      this.paintOutline(o, kind);
    }
    v.outlineKind = kind;
    // Appearing (spawn, setting turned on) is instant; only death and revive fade.
    if (fresh) o.fade = target;
    o.target = target;
    this.outlined.add(v);
    this.syncStamps(v, o);
    const on = o.fade > 0;
    if (o.ring.visible !== on) o.ring.visible = on;
    if (!on && o.root.visible) o.root.visible = false;
    o.root.alpha = o.fade;
  }

  private createOutline(v: EntityView, kind: EntityHighlight): OutlineView {
    const root = new Container();
    const rim = new Container();
    const fill = new Container();
    const rimStamps: Sprite[] = [];
    const fillStamps: Sprite[] = [];
    for (let i = 0; i < OUTLINE_TAPS; i++) {
      const r = new Sprite();
      r.tint = 0x000000;
      rim.addChild(r);
      rimStamps.push(r);
      const f = new Sprite();
      fill.addChild(f);
      fillStamps.push(f);
    }
    const filter = this.makeOutlineFilter();
    if (filter) fill.filters = [filter];
    root.addChild(rim, fill);
    // Behind every body part (prim, still, anim).
    v.body.addChildAt(root, 0);
    const ring = new Graphics(this.ringShape(kind));
    // Above the shadow, below the body.
    v.root.addChildAt(ring, 1);
    const o: OutlineView = {
      root,
      rim,
      fill,
      rimStamps,
      fillStamps,
      filter,
      ring,
      kind,
      tex: null,
      ax: Number.NaN,
      ay: Number.NaN,
      radius: localRadius(OUTLINE_PX, this.zoom, v.scale),
      fade: 1,
      target: 1,
    };
    this.layoutStamps(o, true);
    return o;
  }

  /** Colours an outline for its kind (filter matrix or tint, rim opacity, ring shape). */
  private paintOutline(o: OutlineView, kind: EntityHighlight): void {
    o.kind = kind;
    const st = outlineStyle(kind);
    if (o.filter) o.filter.matrix = solidMatrix(st.colour, st.alpha);
    else for (const s of o.fillStamps) s.tint = st.colour;
    for (const s of o.rimStamps) s.alpha = st.rimAlpha;
    const shape = this.ringShape(kind);
    if (o.ring.context !== shape) o.ring.context = shape;
  }

  /** The soft ground ellipse of an outline kind (built once per kind). */
  private ringShape(kind: EntityHighlight): GraphicsContext {
    let g = this.ringShapes.get(kind);
    if (!g) {
      const c = outlineStyle(kind).ringColour;
      g = new GraphicsContext()
        .ellipse(0, 0, 19, 9.5)
        .fill({ color: c, alpha: 0.16 })
        .ellipse(0, 0, 19, 9.5)
        .stroke({ width: 2, color: c, alpha: 0.95 })
        .ellipse(0, 0, 13, 6.5)
        .stroke({ width: 1, color: c, alpha: 0.45 });
      this.ringShapes.set(kind, g);
    }
    return g;
  }

  /** Sets the feet-to-head offset used by the bar and the labels. True when it changed. */
  private updateLayout(v: EntityView): boolean {
    const top = -(v.height * v.scale * (v.corpse ? CORPSE_SQUASH : 1) + v.lift) - 4;
    if (top === v.topY) return false;
    v.topY = top;
    return true;
  }

  /** The label-layer container, created on first use. */
  private ensureTag(v: EntityView): Container {
    if (v.tag) return v.tag;
    const tag = new Container();
    tag.position.set(v.sx, v.sy);
    tag.alpha = v.root.alpha;
    const texts = new Container();
    tag.addChild(texts);
    this.labels.addChild(tag);
    v.tag = tag;
    v.texts = texts;
    return tag;
  }

  private updateBar(v: EntityView, bar: number | null, colour: number): void {
    if (bar === null) {
      if (v.bar) v.bar.visible = false;
      return;
    }
    if (!v.bar) {
      v.bar = new Graphics();
      this.ensureTag(v).addChildAt(v.bar, 0);
    }
    const fill = barFill(bar);
    if (v.barValue !== fill || v.barColour !== colour || !v.bar.visible) {
      v.barValue = fill;
      v.barColour = colour;
      const g = v.bar.clear();
      g.rect(-BAR_W / 2, 0, BAR_W, BAR_H).fill({ color: 0x000000, alpha: 0.6 });
      if (fill > 0) g.rect(-BAR_W / 2, 0, BAR_W * fill, BAR_H).fill(colour);
    }
    v.bar.visible = true;
    if (v.bar.y !== v.topY) v.bar.y = v.topY;
  }

  /**
   * Name, subtitle and quest marker. Stack, bottom-up from the head: bar
   * (hangs from topY), subtitle, name, marker. Texts are created on first use
   * and then only re-laid out when their content or the head height changes.
   */
  private updateTexts(
    v: EntityView,
    e: ArpgRenderEntity,
    projectile: boolean,
    relayout: boolean,
    moved: boolean,
  ): void {
    const labelOn = !projectile && (!!e.showLabel || e.isSelf || !!e.highlight);
    const subtitle = labelOn && !projectile ? (e.subtitle ?? "") : "";
    const subtitleOn = subtitle !== "";
    const markerText = !projectile && e.marker ? e.marker : "";
    const markerOn = markerText !== "";
    const plateOn = labelOn && !!e.labelPlate;
    let changed = relayout;
    if (plateOn !== v.plateOn) {
      v.plateOn = plateOn;
      changed = true;
    }

    if (labelOn !== v.labelOn || subtitleOn !== v.subtitleOn || markerOn !== v.markerOn) {
      changed = true;
    }
    v.labelOn = labelOn;
    v.subtitleOn = subtitleOn;
    v.markerOn = markerOn;

    if (labelOn) {
      if (!v.label) {
        const label = new Text({
          text: e.name,
          style: {
            fontFamily: "system-ui, sans-serif",
            fontSize: NAME_FONT_PX,
            fill: labelColour(e.isSelf),
            stroke: { color: 0x000000, width: 3 },
          },
        });
        label.anchor.set(0.5, 1);
        this.ensureTag(v);
        v.texts!.addChild(label);
        v.label = label;
        v.labelColour = -1;
        changed = true;
      }
      const colour = e.labelColor ?? labelColour(e.isSelf);
      if (v.labelColour !== colour) {
        v.labelColour = colour;
        v.label.style.fill = colour;
      }
      v.label.visible = true;
    } else if (v.label) {
      v.label.visible = false;
    }

    if (subtitleOn) {
      if (!v.subtitle) {
        const sub = new Text({
          text: subtitle,
          style: {
            fontFamily: "system-ui, sans-serif",
            fontSize: SUB_FONT_PX,
            fontStyle: "italic",
            fill: SUBTITLE_COLOUR,
            stroke: { color: 0x000000, width: 3 },
          },
        });
        sub.anchor.set(0.5, 1);
        this.ensureTag(v);
        v.texts!.addChild(sub);
        v.subtitle = sub;
        v.subtitleText = subtitle;
        changed = true;
      } else if (v.subtitleText !== subtitle) {
        v.subtitle.text = subtitle;
        v.subtitleText = subtitle;
        changed = true;
      }
      v.subtitle.visible = true;
    } else if (v.subtitle) {
      v.subtitle.visible = false;
    }

    if (markerOn) {
      if (!v.marker) {
        const m = new Text({
          text: markerText,
          style: {
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: 22,
            fontWeight: "900",
            fill: MARKER_COLOUR,
            stroke: { color: 0x1a1206, width: 4 },
          },
        });
        m.anchor.set(0.5, 1);
        this.ensureTag(v);
        v.texts!.addChild(m);
        v.marker = m;
        v.markerText = markerText;
        changed = true;
      } else if (v.markerText !== markerText) {
        v.marker.text = markerText;
        v.markerText = markerText;
      }
      v.marker.visible = true;
      this.bobbing.add(v);
    } else {
      if (v.marker) v.marker.visible = false;
      this.bobbing.delete(v);
    }

    const priority = e.labelPriority ?? 0;
    if (v.labelPriority !== priority) {
      v.labelPriority = priority;
      changed = true;
    }

    if (changed) {
      // Bottom-up from just above the bar line.
      let y = v.topY - 2;
      v.textBottom = y;
      if (v.subtitle && subtitleOn) {
        v.subtitle.y = y;
        y -= SUB_LINE;
      }
      v.nameBottom = y;
      if (v.label && labelOn) {
        v.label.y = y;
        y -= NAME_LINE;
      }
      v.stackTop = y;
      if (v.marker && markerOn) {
        v.marker.y = y;
        v.markerY = y;
        v.stackTop = y - MARKER_LINE;
      }
      // Estimated widths: measuring Pixi text here would force a canvas layout per change.
      const nameW = labelOn ? estimateLabelWidth(v.name, NAME_FONT_PX) : 0;
      v.labelW = subtitleOn ? Math.max(nameW, estimateLabelWidth(subtitle, SUB_FONT_PX)) : nameW;
      this.updatePlate(v, nameW);
    }

    const visible = labelOn || markerOn;
    if (visible) {
      if (!this.labelled.has(v)) {
        this.labelled.add(v);
        changed = true;
      }
    } else if (this.labelled.delete(v)) {
      changed = true;
    }
    if (visible && !v.box) {
      v.box = {
        id: v.id,
        x: 0,
        bottom: 0,
        w: 0,
        h: NAME_LINE,
        rank: 0,
        dy: 0,
        group: "",
        hidden: false,
      };
    }
    if (!visible) {
      if (v.labelDy !== 0) v.labelDy = 0;
      v.dupHidden = false;
    }
    if (changed || (moved && visible)) {
      this.clampDirty = true;
      this.layoutDirty = true;
    }
  }

  /** The dark plate behind the name (labelPlate), drawn only when the layout changes. */
  private updatePlate(v: EntityView, nameW: number): void {
    if (!v.plateOn) {
      if (v.plate) v.plate.visible = false;
      return;
    }
    if (!v.plate) {
      v.plate = new Graphics();
      this.ensureTag(v);
      // Behind the texts of the stack.
      v.texts!.addChildAt(v.plate, 0);
    }
    const w = Math.max(8, nameW - 4) + PLATE_PAD_X * 2;
    v.plate
      .clear()
      .roundRect(-w / 2, v.nameBottom - NAME_LINE, w, NAME_LINE, 3)
      .fill({ color: PLATE_COLOUR, alpha: PLATE_ALPHA });
    v.plate.visible = true;
  }
}

/** Feet-to-visible-top height of a (possibly trimmed) texture drawn with anchor y. */
function headHeight(t: Texture, anchorY: number): number {
  const orig = t.orig ?? t.frame;
  return visibleHeight(anchorY, orig?.height ?? t.height, t.trim?.y ?? 0);
}

function hideSprite(s: { visible: boolean }): void {
  s.visible = false;
}

/** Body tint: base, highlight, status pulse. The hit flash is a filter (updateFlash), not a tint. */
function bodyTint(v: EntityView, pulse01: number): number {
  return entityTint(v.tint, v.highlight, v.statusTint, pulse01);
}

function paint(v: EntityView, colour: number): void {
  v.paintedTint = colour;
  if (v.anim) v.anim.tint = colour;
  if (v.still) v.still.tint = colour;
  v.prim.tint = colour;
}

/** Primitive shape for an entity. Plain RenderEntity (no kind) keeps the hero-style shape. */
function primShape(
  p: Primitives,
  kind: EntityKind,
  isSelf: boolean,
  explicit = true,
): GraphicsContext {
  if (isSelf) return p.hero.self;
  switch (kind) {
    case "npc":
      return p.npc;
    case "loot":
      return p.loot;
    case "projectile":
      return p.projectile;
    case "prop":
      return p.box;
    case "unit":
      return explicit ? p.monster : p.hero.other;
  }
}

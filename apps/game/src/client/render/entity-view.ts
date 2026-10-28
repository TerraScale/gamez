import {
  AnimatedSprite,
  Container,
  Graphics,
  GraphicsContext,
  Sprite,
  Text,
  type Texture,
} from "pixi.js";
import { depthOf, tileToScreen } from "@gamez/world";
import type { ArpgRenderEntity, EntityAction, EntityKind, Facing } from "@gamez/ui-host";
import { appearanceCandidates, firstMatch, isDeathKey, resolveAction } from "./appearance.ts";
import { entityTint, barFill, pulseAmount } from "./fx-math.ts";
import { labelColour } from "./palette.ts";
import type { Primitives } from "./primitives.ts";
import type { AnimVisual, SpriteVisual, Visuals } from "./visuals.ts";

/** Height used for label and bar placement when the unit is drawn with primitives. */
const PRIM_HEIGHT = 21;
const BAR_W = 28;
const BAR_H = 4;
const LYING_ALPHA = 0.55;

type Resolved =
  | { kind: "anim"; anim: AnimVisual }
  | { kind: "still"; sprite: SpriteVisual }
  | { kind: "prim" };

/**
 * One entity's containers. Created once and kept until removed. Optional parts
 * (sprites, bar, label, highlight ring) are created the first time they are
 * needed and then only shown or hidden.
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
  bar: Graphics | null;
  label: Text | null;
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
  lying: boolean;
  lift: number;
  scale: number;
  barValue: number;
  barColour: number;
  labelColour: number;
  topY: number;
}

export class EntityLayer {
  private readonly views = new Map<string, EntityView>();
  /** Entities with a status tint; their tint pulses every frame. */
  private readonly pulsing = new Set<EntityView>();

  constructor(
    private readonly world: Container,
    private readonly visuals: Visuals,
    private readonly prims: Primitives,
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
    this.pulsing.delete(v);
    v.root.destroy({ children: true });
  }

  clear(): void {
    for (const v of this.views.values()) v.root.destroy({ children: true });
    this.views.clear();
    this.pulsing.clear();
  }

  /** Re-tints status-affected entities for the pulse. Visible units only. */
  tickPulse(timeMs: number): void {
    if (this.pulsing.size === 0) return;
    const k = pulseAmount(timeMs);
    for (const v of this.pulsing) {
      if (!v.root.visible) continue;
      const want = entityTint(v.tint, v.highlight, v.statusTint, k);
      if (want !== v.paintedTint) paint(v, want);
    }
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
      bar: null,
      label: null,
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
      lying: false,
      lift: 0,
      scale: 1,
      barValue: -1,
      barColour: -1,
      labelColour: -1,
      topY: 0,
    };
  }

  private apply(v: EntityView, e: ArpgRenderEntity): void {
    // Position and depth: every call, but the z order is only written when it changes.
    const s = tileToScreen(e.x + 0.5, e.y + 0.5);
    v.sx = s.sx;
    v.sy = s.sy;
    v.root.position.set(s.sx, s.sy);
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

    if (v.name !== e.name) {
      v.name = e.name;
      if (v.label) v.label.text = e.name;
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

    const lying = !!e.dead && !(v.resolved === "anim" && isDeathKey(v.resolvedKey));
    v.lying = lying;
    const rotation = lying ? Math.PI / 2 : 0;
    if (v.body.rotation !== rotation) v.body.rotation = rotation;
    const alpha = (e.alpha ?? 1) * (lying ? LYING_ALPHA : 1);
    if (v.root.alpha !== alpha) v.root.alpha = alpha;

    const scale = (e.scale ?? 100) / 100;
    if (v.scale !== scale) {
      v.scale = scale;
      v.body.scale.set(scale);
      v.shadow.scale.set(scale);
    }
    const lift = e.zLift ?? 0;
    if (v.lift !== lift) {
      v.lift = lift;
      v.body.y = -lift;
    }

    const tint = e.tint ?? 0xffffff;
    const highlight = !!e.highlight;
    const statusTint = e.statusTint ?? 0;
    v.tint = tint;
    v.highlight = highlight;
    v.statusTint = statusTint;
    if (statusTint !== 0) this.pulsing.add(v);
    else this.pulsing.delete(v);
    const want = entityTint(tint, highlight, statusTint, 0);
    if (want !== v.paintedTint) paint(v, want);

    this.updateRing(v, highlight);
    this.updateLayout(v);
    this.updateBar(v, projectile ? null : (e.bar ?? null), e.barColor ?? 0x4caf50);
    this.updateLabel(v, e, projectile);
  }

  /** Picks the animation or sprite for the new key, with the documented fallback chain. */
  private resolve(v: EntityView): void {
    const candidates = appearanceCandidates(
      v.appearance,
      v.action,
      v.facing,
      v.fallback || undefined,
    );
    const hit = firstMatch<Resolved>(candidates, (key) => {
      const anim = this.visuals.animationExact(key);
      if (anim) return { kind: "anim", anim };
      const sprite = this.visuals.spriteExact(key);
      if (sprite) return { kind: "still", sprite };
      return null;
    });
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
        sp.animationSpeed = r.anim.fps / 60;
        sp.loop = r.anim.loop;
        sp.gotoAndPlay(0);
      }
      const a = r.anim.anchor ?? { x: 0.5, y: 1 };
      sp.anchor.set(a.x, a.y);
      v.height = frames[0]?.height ?? PRIM_HEIGHT;
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
      v.height = r.sprite.texture.height;
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

  /** Sets the feet-to-head offset used by the bar and the label. */
  private updateLayout(v: EntityView): void {
    const top = -(v.height * v.scale + v.lift) - 4;
    if (top !== v.topY) v.topY = top;
  }

  private updateBar(v: EntityView, bar: number | null, colour: number): void {
    if (bar === null) {
      if (v.bar) v.bar.visible = false;
      return;
    }
    if (!v.bar) {
      v.bar = new Graphics();
      v.root.addChild(v.bar);
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

  private updateLabel(v: EntityView, e: ArpgRenderEntity, projectile: boolean): void {
    const wanted = !projectile && (!!e.showLabel || e.isSelf || !!e.highlight);
    if (!wanted) {
      if (v.label) v.label.visible = false;
      return;
    }
    if (!v.label) {
      v.label = new Text({
        text: e.name,
        style: {
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          fill: labelColour(e.isSelf),
          stroke: { color: 0x000000, width: 3 },
        },
      });
      v.label.anchor.set(0.5, 1);
      v.root.addChild(v.label);
      v.labelColour = -1;
    }
    const colour = e.labelColor ?? labelColour(e.isSelf);
    if (v.labelColour !== colour) {
      v.labelColour = colour;
      v.label.style.fill = colour;
    }
    // The label sits just above the bar line (the bar hangs from topY).
    if (v.label.y !== v.topY - 2) v.label.y = v.topY - 2;
    v.label.visible = true;
  }
}

function hideSprite(s: { visible: boolean }): void {
  s.visible = false;
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

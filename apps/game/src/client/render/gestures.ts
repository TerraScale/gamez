/**
 * Pure pointer gesture recognition for the renderer. Client coordinates in,
 * events out, no DOM. The renderer converts client points to tiles and
 * forwards the events; pinch events carry the distance ratio for zoom.
 */

/** A press shorter than this without drag is a tap; a press held this long fires `hold` once. */
export const TAP_MS = 350;
/** Movement beyond this (CSS px) turns a press into a drag. */
export const TAP_SLACK_PX = 8;

export type GestureKind = "down" | "move" | "up" | "tap" | "hold" | "pinch";

export interface GestureEvent {
  kind: GestureKind;
  clientX: number;
  clientY: number;
  /** Mouse button of the press (-1 for moves without a press). */
  button: number;
  shift: boolean;
  pointerType: "mouse" | "touch" | "pen";
  /** Pinch only: new distance / previous distance. 1 otherwise. */
  scale: number;
}

interface Tracked {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  startMs: number;
  button: number;
  shift: boolean;
  pointerType: "mouse" | "touch" | "pen";
  dragged: boolean;
  held: boolean;
}

export class GestureTracker {
  private readonly pts: Tracked[] = [];
  private pinchDist = 0;

  /** Number of pointers currently pressed. */
  get pressed(): number {
    return this.pts.length;
  }

  down(
    id: number,
    clientX: number,
    clientY: number,
    nowMs: number,
    button: number,
    shift: boolean,
    pointerType: "mouse" | "touch" | "pen",
  ): GestureEvent[] {
    const out: GestureEvent[] = [];
    this.pts.push({
      id,
      startX: clientX,
      startY: clientY,
      x: clientX,
      y: clientY,
      startMs: nowMs,
      button,
      shift,
      pointerType,
      dragged: false,
      held: false,
    });
    if (this.pts.length >= 2) {
      // A second pointer turns the gesture into a pinch: nothing here is a tap.
      for (const p of this.pts) p.dragged = true;
      this.pinchDist = this.spread();
    }
    out.push(this.event("down", this.pts[this.pts.length - 1]!));
    return out;
  }

  move(
    id: number,
    clientX: number,
    clientY: number,
    _nowMs: number,
    pointerType: "mouse" | "touch" | "pen",
  ): GestureEvent[] {
    const p = this.pts.find((q) => q.id === id);
    if (!p) {
      // Hover without a press: only mice report it.
      if (pointerType !== "mouse") return [];
      return [
        {
          kind: "move",
          clientX,
          clientY,
          button: -1,
          shift: false,
          pointerType,
          scale: 1,
        },
      ];
    }
    p.x = clientX;
    p.y = clientY;
    if (Math.hypot(clientX - p.startX, clientY - p.startY) > TAP_SLACK_PX) p.dragged = true;
    if (this.pts.length >= 2) {
      const dist = this.spread();
      if (this.pinchDist > 0 && dist > 0) {
        const scale = dist / this.pinchDist;
        this.pinchDist = dist;
        return [{ ...this.event("pinch", p), scale }];
      }
      this.pinchDist = dist;
      return [];
    }
    return [this.event("move", p)];
  }

  up(id: number, clientX: number, clientY: number, nowMs: number): GestureEvent[] {
    const idx = this.pts.findIndex((q) => q.id === id);
    if (idx < 0) return [];
    const p = this.pts[idx]!;
    p.x = clientX;
    p.y = clientY;
    if (Math.hypot(clientX - p.startX, clientY - p.startY) > TAP_SLACK_PX) p.dragged = true;
    this.pts.splice(idx, 1);
    if (this.pts.length < 2) this.pinchDist = 0;
    const out: GestureEvent[] = [this.event("up", p)];
    const isTap = !p.dragged && !p.held && this.pts.length === 0 && nowMs - p.startMs < TAP_MS;
    if (isTap) out.push(this.event("tap", p));
    return out;
  }

  cancel(id: number): void {
    const idx = this.pts.findIndex((q) => q.id === id);
    if (idx >= 0) this.pts.splice(idx, 1);
    if (this.pts.length < 2) this.pinchDist = 0;
  }

  /** Emits `hold` once for a single, undragged press held for TAP_MS. Call every frame. */
  tick(nowMs: number): GestureEvent[] {
    const out: GestureEvent[] = [];
    if (this.pts.length !== 1) return out;
    const p = this.pts[0]!;
    if (!p.dragged && !p.held && nowMs - p.startMs >= TAP_MS) {
      p.held = true;
      out.push(this.event("hold", p));
    }
    return out;
  }

  private spread(): number {
    if (this.pts.length < 2) return 0;
    const a = this.pts[0]!;
    const b = this.pts[1]!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private event(kind: GestureKind, p: Tracked): GestureEvent {
    return {
      kind,
      clientX: p.x,
      clientY: p.y,
      button: p.button,
      shift: p.shift,
      pointerType: p.pointerType,
      scale: 1,
    };
  }
}

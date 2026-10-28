/**
 * Input bindings of the classic client (docs/design/classic.md §12.4). The
 * key map, mode cycling and speed steps are pure functions. PointerInput is a
 * small state machine over renderer PointerInfo events (tap, hold, move, up)
 * with a hold-repeat timer driven by update(dtMs), so tests need no DOM.
 * bindKeyboard() is the only DOM code (window keydown).
 */
import type { Entity } from "@gamez/kernel";
import type { PointerInfo } from "@gamez/ui-host";
import type { ControlMode, SimSpeed } from "../resources.ts";
import { SUB } from "../fixed.ts";
import type { PanelId } from "./contract.ts";

export type KeyCommand =
  | { kind: "cast"; slot: number }
  | { kind: "drink"; slot: number }
  | { kind: "panel"; panel: PanelId }
  | { kind: "closeAll" }
  | { kind: "portal" }
  | { kind: "cycleMode" }
  | { kind: "speed"; delta: 1 | -1 }
  | { kind: "minimap" }
  | { kind: "automap" };

/** Panel keys (letters are case-insensitive). N = talents, Y = achievements (wave A; no clash with the bindings below). */
const PANEL_KEYS: Readonly<Record<string, PanelId>> = {
  c: "character",
  i: "inventory",
  s: "skills",
  l: "quests",
  n: "talents",
  y: "achievements",
};
const DRINK_KEYS: Readonly<Record<string, number>> = { q: 0, w: 1, e: 2, r: 3 };

/** The command bound to a KeyboardEvent.key value, or null. Letters are case-insensitive. */
export function keyCommand(key: string): KeyCommand | null {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k >= "1" && k <= "6" && k.length === 1) return { kind: "cast", slot: Number(k) - 1 };
  if (k in DRINK_KEYS) return { kind: "drink", slot: DRINK_KEYS[k]! };
  if (k in PANEL_KEYS) return { kind: "panel", panel: PANEL_KEYS[k]! };
  switch (k) {
    case "Escape":
      return { kind: "closeAll" };
    case "m":
      return { kind: "minimap" };
    case "Tab":
      return { kind: "automap" };
    case "t":
      return { kind: "portal" };
    case " ":
    case "Spacebar":
      return { kind: "cycleMode" };
    case "+":
    case "=":
      return { kind: "speed", delta: 1 };
    case "-":
    case "_":
      return { kind: "speed", delta: -1 };
    default:
      return null;
  }
}

/** Manual -> Auto -> Full Idle -> Manual. */
export function nextMode(mode: ControlMode): ControlMode {
  return mode === "manual" ? "auto" : mode === "auto" ? "idle" : "manual";
}

export const SPEEDS: readonly SimSpeed[] = [1, 2, 4, 8];

/** The next idle speed up (+1) or down (-1), clamped to 1..8. */
export function stepSpeed(speed: SimSpeed, delta: 1 | -1): SimSpeed {
  const i = SPEEDS.indexOf(speed);
  const at = i < 0 ? 0 : i;
  const next = Math.min(SPEEDS.length - 1, Math.max(0, at + delta));
  return SPEEDS[next]!;
}

/** True for form fields and editable content: keys belong to the text there. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const t = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable === true;
}

/** Keydown listener on `win` that forwards bound keys (no Ctrl/Meta/Alt, not while typing). Returns the unbind function. */
export function bindKeyboard(
  win: Pick<Window, "addEventListener" | "removeEventListener">,
  onKey: (cmd: KeyCommand) => void,
): () => void {
  const listener = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const cmd = keyCommand(e.key);
    if (cmd === null) return;
    e.preventDefault();
    onKey(cmd);
  };
  win.addEventListener("keydown", listener as EventListener);
  return () => win.removeEventListener("keydown", listener as EventListener);
}

/** What the pointer asked for. Tile coordinates are integers; `x`/`y` of casts are sub units. */
export type PointerCommand =
  | { kind: "move"; x: number; y: number }
  | { kind: "attack"; entity: Entity; repeat: boolean }
  | {
      kind: "cast";
      slot: number;
      entity: Entity;
      x: number;
      y: number;
      repeat: boolean;
      stand: boolean;
    }
  | { kind: "pickup"; entity: Entity }
  | { kind: "interact"; entity: Entity };

/** What is under a fractional tile position (see SceneSync.pickAt). */
export interface PointerPick {
  kind: "unit" | "loot" | "npc" | "interactable";
  entity: Entity;
}

export interface PointerEnv {
  /** Entity under a fractional tile position (within reach), or null. */
  pick(x: number, y: number): PointerPick | null;
}

/** Hold-to-move / hold-to-attack repeat period (ms). */
export const HOLD_REPEAT_MS = 250;

/**
 * Pointer state machine. Left tap: attack monster / pick loot / interact with
 * NPC or stairs / walk. Shift+tap: stand and cast slot 1 at the point. Right
 * tap: cast slot 2 at the monster or point. Hold (left): repeat every 250 ms
 * (walk toward the pointer, or keep attacking the monster under it).
 */
export class PointerInput {
  private held: { x: number; y: number } | null = null;
  private heldMs = 0;
  private hoverEntity: Entity = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly env: PointerEnv,
    private readonly emit: (cmd: PointerCommand) => void,
    private readonly onHover: (entity: Entity, x: number, y: number) => void = () => {},
    private readonly repeatMs = HOLD_REPEAT_MS,
  ) {}

  /** Processes one renderer pointer event. */
  handle(p: PointerInfo): void {
    this.lastX = p.x;
    this.lastY = p.y;
    switch (p.kind) {
      case "move": {
        if (this.held) this.held = { x: p.x, y: p.y };
        const hit = this.env.pick(p.x, p.y);
        const entity = hit?.kind === "unit" ? hit.entity : 0;
        if (entity !== this.hoverEntity) {
          this.hoverEntity = entity;
          this.onHover(entity, p.x, p.y);
        }
        return;
      }
      case "tap":
        this.tap(p);
        return;
      case "hold":
        if (p.button !== 0 || this.held) return;
        this.held = { x: p.x, y: p.y };
        this.heldMs = 0;
        this.groundOrAttack(p.x, p.y);
        return;
      case "up":
        this.held = null;
        this.heldMs = 0;
        return;
      default:
        return;
    }
  }

  /** Advances the hold timer; re-issues the held command every repeatMs. */
  update(dtMs: number): void {
    if (!this.held) return;
    this.heldMs += Math.max(0, dtMs);
    while (this.heldMs >= this.repeatMs) {
      this.heldMs -= this.repeatMs;
      if (!this.held) return;
      this.groundOrAttack(this.held.x, this.held.y);
    }
  }

  /** True while a left-button hold is active. */
  get holding(): boolean {
    return this.held !== null;
  }

  /** Monster currently under the pointer (0 = none). */
  get hovered(): Entity {
    return this.hoverEntity;
  }

  /** Last pointer position in fractional tiles. */
  get pointer(): { x: number; y: number } {
    return { x: this.lastX, y: this.lastY };
  }

  /** Clears a hold (panel opened, mode switched, unmount). */
  cancel(): void {
    this.held = null;
    this.heldMs = 0;
  }

  private tap(p: PointerInfo): void {
    const hit = this.env.pick(p.x, p.y);
    const point = { x: Math.round(p.x * SUB), y: Math.round(p.y * SUB) };
    if (p.button === 2) {
      const entity = hit?.kind === "unit" ? hit.entity : 0;
      this.emit({
        kind: "cast",
        slot: 1,
        entity,
        x: point.x,
        y: point.y,
        repeat: false,
        stand: false,
      });
      return;
    }
    if (p.button !== 0) return;
    if (p.shift) {
      this.emit({
        kind: "cast",
        slot: 0,
        entity: 0,
        x: point.x,
        y: point.y,
        repeat: false,
        stand: true,
      });
      return;
    }
    if (!hit) {
      this.emit({ kind: "move", x: Math.floor(p.x), y: Math.floor(p.y) });
      return;
    }
    if (hit.kind === "unit") this.emit({ kind: "attack", entity: hit.entity, repeat: true });
    else if (hit.kind === "loot") this.emit({ kind: "pickup", entity: hit.entity });
    else this.emit({ kind: "interact", entity: hit.entity });
  }

  private groundOrAttack(x: number, y: number): void {
    const hit = this.env.pick(x, y);
    if (hit?.kind === "unit") {
      this.emit({ kind: "attack", entity: hit.entity, repeat: true });
      return;
    }
    this.emit({ kind: "move", x: Math.floor(x), y: Math.floor(y) });
  }
}
